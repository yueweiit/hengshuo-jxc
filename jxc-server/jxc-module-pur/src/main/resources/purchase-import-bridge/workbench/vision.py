"""Local DINOv2 embeddings and immutable, explicitly mapped Faiss galleries."""
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shutil
import threading
import io
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

DEMO_ROOT = Path(__file__).resolve().parent.parent
MODEL_NAME = 'dinov2_vits14'
WEIGHT_SHA256 = 'b938bf1bc15cd2ec0feacfe3a1bb553fe8ea9ca46a7e1d8d00217f29aef60cd9'
MAX_IMAGE_BYTES = 24 * 1024 * 1024
MAX_IMAGES = 100000
MAX_ZIP_BYTES = 2 * 1024**3
MAX_UNPACKED_BYTES = 8 * 1024**3


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def pixel_hash(source):
    with Image.open(io.BytesIO(source) if isinstance(source, bytes) else source) as image:
        image = ImageOps.exif_transpose(image).convert('RGB')
        return hashlib.sha256(str(image.size).encode() + image.tobytes()).hexdigest()


def read_image(path):
    path = Path(path)
    if not path.is_file() or path.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError('图片不存在或超过24MiB上限')
    try:
        with Image.open(path) as source:
            if source.format not in ('JPEG', 'PNG', 'WEBP'):
                raise ValueError('图片仅支持JPEG、PNG、WebP')
            if source.width * source.height > 40_000_000:
                raise ValueError('图片像素超过4000万上限')
            extension = {'JPEG': '.jpg', 'PNG': '.png', 'WEBP': '.webp'}[source.format]
            result = ImageOps.exif_transpose(source).convert('RGB')
            result.load()
        return result, extension
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise ValueError('图片无法解码：' + str(exc)) from None


class DinoEncoder:
    def __init__(self, demo_root=DEMO_ROOT):
        self.source = Path(demo_root) / 'third_party/dinov2'
        self.weights = Path(demo_root) / 'models/dinov2_vits14_pretrain.pth'
        self.signature = MODEL_NAME + ':' + WEIGHT_SHA256 + ':exif-rgb-short256-center224-imagenet-v1'
        self._model = None
        self._lock = threading.RLock()

    def status(self):
        missing = [name for name in ('torch', 'faiss') if importlib.util.find_spec(name) is None]
        ready = not missing and self.weights.is_file() and (self.source / 'hubconf.py').is_file()
        return dict(status='ready' if ready else 'unavailable', model=MODEL_NAME,
                    device='cpu', signature=self.signature, loaded=self._model is not None,
                    weights_present=self.weights.is_file(), missing_dependencies=missing,
                    note='本机提取特征，不需要DeepSeek Key；模型完整性在首次加载时核对')

    def _load(self):
        if self._model is not None:
            return self._model
        status = self.status()
        if status['status'] != 'ready':
            raise ValueError('图片模型尚未准备好，请先运行 setup-vision.ps1：' + json.dumps(status, ensure_ascii=False))
        if sha256(self.weights) != WEIGHT_SHA256:
            raise ValueError('DINOv2权重校验失败，未使用不完整或不匹配的模型')
        import torch
        os.environ['XFORMERS_DISABLED'] = '1'
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        model = torch.hub.load(str(self.source), MODEL_NAME, source='local', pretrained=False)
        model.load_state_dict(torch.load(self.weights, map_location='cpu', weights_only=True), strict=True)
        self._model = model.eval().to('cpu')
        return self._model

    def encode(self, paths, event=None):
        import torch
        paths = list(paths)
        if not paths:
            raise ValueError('没有可提取特征的图片')
        with self._lock, torch.inference_mode():
            model = self._load()
            result = []
            mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)[:, None, None]
            std = np.array([0.229, 0.224, 0.225], dtype=np.float32)[:, None, None]
            for start in range(0, len(paths), 8):
                batch = []
                for path in paths[start:start + 8]:
                    image, _ = read_image(path)
                    width, height = image.size
                    if width < height:
                        size = (256, int(256 * height / width))
                    else:
                        size = (int(256 * width / height), 256)
                    image = image.resize(size, Image.Resampling.BICUBIC)
                    left, top = round((size[0] - 224) / 2), round((size[1] - 224) / 2)
                    image = image.crop((left, top, left + 224, top + 224))
                    array = np.asarray(image, dtype=np.float32).transpose(2, 0, 1) / 255.0
                    batch.append(torch.from_numpy((array - mean) / std))
                result.append(model(torch.stack(batch)).cpu().numpy().astype('float32'))
                if event:
                    event(dict(tool='DINOv2', status='running', completed=min(start + 8, len(paths)), total=len(paths), detail=f'已提取 {min(start + 8, len(paths))}/{len(paths)} 张图片特征'))
            return np.concatenate(result)


def normalized(vectors):
    vectors = np.ascontiguousarray(vectors, dtype='float32')
    if vectors.ndim != 2 or not len(vectors) or not np.isfinite(vectors).all():
        raise ValueError('图片特征结构无效或包含非有限值')
    lengths = np.linalg.norm(vectors, axis=1, keepdims=True)
    if np.any(lengths <= 1e-12):
        raise ValueError('图片特征为空，无法比较相似度')
    return np.ascontiguousarray(vectors / lengths)


def write_vector_index(path, vectors, feature_ids, allow_zero=False):
    """Build one normalized HNSW index with stable demo or database-owned IDs."""
    import faiss
    vectors = normalized(vectors)
    ids = list(feature_ids)
    minimum = 0 if allow_zero else 1
    if len(ids) != len(vectors) or len(set(ids)) != len(ids) or any(type(i) is not int or not minimum <= i <= 9007199254740991 for i in ids):
        raise ValueError('稳定特征编号无效或重复')
    base = faiss.IndexHNSWFlat(vectors.shape[1], 32, faiss.METRIC_INNER_PRODUCT)
    base.hnsw.efConstruction = 200
    base.hnsw.efSearch = 256
    index = faiss.IndexIDMap2(base)
    index.add_with_ids(vectors, np.asarray(ids, dtype='int64'))
    faiss.write_index(index, str(path))
    return dict(indexFormat='IDMAP2_FLOAT32_IP', dimension=int(index.d), featureIds=ids, indexSha256=sha256(path))


def read_vector_index(path, manifest, allow_legacy=False):
    import faiss
    digest = manifest.get('indexSha256', manifest.get('index_sha256'))
    if not isinstance(digest, str) or sha256(path) != digest:
        raise ValueError('图库索引校验失败，不能当成无匹配')
    try:
        index = faiss.read_index(str(path))
        ids = manifest.get('featureIds')
        count = len(ids) if isinstance(ids, list) else manifest.get('image_count')
        if index.d != manifest.get('dimension') or index.ntotal != count:
            raise ValueError('图库索引维度或数量与清单不一致')
        if isinstance(index, faiss.IndexIDMap2):
            if ids is None or faiss.vector_to_array(index.id_map).tolist() != ids or len(ids) != len(set(ids)):
                raise ValueError('图库索引稳定编号与清单不一致')
        elif not allow_legacy or ids is not None or not isinstance(index, faiss.IndexFlatIP):
            raise ValueError('图库索引格式不兼容，请重建')
        return index
    except RuntimeError as error:
        raise ValueError('图库索引读取失败') from error


def search_vector_index(index, vectors, top_k):
    query = normalized(vectors)
    if query.shape != (1, index.d):
        raise ValueError('查询图片特征与图库维度不一致')
    if type(top_k) is not int or not 1 <= top_k <= MAX_IMAGES:
        raise ValueError('候选数量无效')
    scores, ids = index.search(query, min(top_k, index.ntotal))
    return [dict(featureId=int(ident), score=round(float(np.clip(score, -1, 1)), 6))
            for score, ident in zip(scores[0], ids[0]) if ident >= 0]


class GalleryStore:
    def __init__(self, root, encoder=None):
        self.root = Path(root).resolve()
        self.encoder = encoder or DinoEncoder()
        self._lock = threading.RLock()
        self._cached = None

    def _folder(self, ident):
        if not isinstance(ident, str) or not re.fullmatch('[a-f0-9]{32}', ident):
            raise ValueError('图库标识无效')
        folder = self.root / ident
        if not folder.is_dir():
            raise ValueError('图库不存在，请先选择或建立图库')
        return folder

    def metadata(self, ident):
        folder = self._folder(ident)
        try:
            data = json.loads((folder / 'gallery.json').read_text(encoding='utf-8'))
            if data['id'] != ident or data['version'] != 1 or len(data['items']) != data['image_count']:
                raise ValueError('图库元数据不完整')
            return data
        except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise ValueError('图库读取失败：' + str(exc)) from None

    def list_galleries(self):
        if not self.root.exists():
            return []
        results = []
        for folder in self.root.iterdir():
            if not folder.is_dir() or not re.fullmatch('[a-f0-9]{32}', folder.name):
                continue
            try:
                data = self.metadata(folder.name)
                results.append({key: data[key] for key in ('id', 'label', 'kind', 'image_count', 'product_count')})
                results[-1]['status'] = 'ok'
            except ValueError as exc:
                results.append(dict(id=folder.name, label=folder.name, status='error', reason=str(exc)))
        return results

    def build(self, entries, label, kind='product_gallery', event=None):
        if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_IMAGES:
            raise ValueError('图库须包含1至100000张图片')
        if kind not in ('product_gallery', 'document_demo'):
            raise ValueError('未知图库类型')
        if not isinstance(label, str) or not label.strip() or len(label) > 100:
            raise ValueError('图库名称须为1至100字')
        with self._lock:
            ident = secrets.token_hex(16)
            stage = self.root / '.staging' / ident
            (stage / 'images').mkdir(parents=True)
            items = []
            try:
                for i, entry in enumerate(entries):
                    code = entry.get('productCode')
                    if kind == 'product_gallery' and (not isinstance(code, str) or not code.strip() or len(code) > 100):
                        raise ValueError('商品图库每张图片必须明确提供productCode')
                    if kind == 'document_demo' and code is not None:
                        raise ValueError('文档测试图库不能冒充商品档案绑定')
                    image, extension = read_image(entry['path'])
                    image.close()
                    relative = 'images/' + str(i) + extension
                    shutil.copyfile(entry['path'], stage / relative)
                    items.append(dict(id=i, image=relative, productCode=code, pixel_hash=pixel_hash(entry['path']),
                                      name=str(entry.get('name') or code or f'测试图片 {i + 1}')[:200]))
                vectors = normalized(self.encoder.encode([stage / x['image'] for x in items], event))
                if len(vectors) != len(items):
                    raise ValueError('图片特征数量与图库不一致')
                return self._publish(stage, ident, items, vectors, label.strip(), kind, self.encoder.signature)
            finally:
                if stage.is_dir() and stage.resolve().parent == (self.root / '.staging').resolve():
                    shutil.rmtree(stage)

    def _publish(self, stage, ident, items, vectors, label, kind, signature):
        """Full builds and deletion subsets share one index/metadata file format."""
        import faiss
        vectors = np.ascontiguousarray(vectors, dtype='float32')
        index_manifest = write_vector_index(stage / 'features.faiss', vectors, [item['id'] for item in items], allow_zero=True)
        data = dict(version=1, id=ident, label=label, kind=kind,
                    model_signature=signature, dimension=vectors.shape[1], image_count=len(items),
                    product_count=len({x['productCode'] for x in items if x['productCode']}),
                    index_sha256=index_manifest['indexSha256'], featureIds=index_manifest['featureIds'], indexFormat=index_manifest['indexFormat'], items=items)
        (stage / 'gallery.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        stage.rename(self.root / ident)
        return {key: data[key] for key in ('id', 'label', 'kind', 'image_count', 'product_count')}

    def import_zip(self, archive, label, event=None):
        archive = Path(archive)
        if archive.stat().st_size > MAX_ZIP_BYTES:
            raise ValueError('图库ZIP超过2GiB上限')
        unpack = self.root / '.staging' / ('unpack-' + secrets.token_hex(16))
        unpack.mkdir(parents=True)
        try:
            with ZipFile(archive) as zipped:
                names = zipped.namelist()
                name_set = set(names)
                if len(names) != len(name_set) or len(names) > MAX_IMAGES + 100:
                    raise ValueError('ZIP包含重复文件名或文件数量超过上限')
                if 'manifest.json' not in names or zipped.getinfo('manifest.json').file_size > 32 * 1024**2:
                    raise ValueError('ZIP根目录须包含不超过32MiB的manifest.json')
                if sum(x.file_size for x in zipped.infolist()) > MAX_UNPACKED_BYTES:
                    raise ValueError('图库解压后超过8GiB上限')
                manifest = json.loads(zipped.read('manifest.json').decode('utf-8-sig'))
                rows = manifest.get('items')
                if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_IMAGES:
                    raise ValueError('manifest.items须包含1至100000张图片映射')
                entries, extracted = [], {}
                for row in rows:
                    if not isinstance(row, dict):
                        raise ValueError('图片映射必须为对象')
                    name = row.get('image')
                    if not isinstance(name, str) or not name or '\\' in name or ':' in name or '..' in PurePosixPath(name).parts or PurePosixPath(name).is_absolute():
                        raise ValueError('图片路径必须是ZIP内的相对路径，禁止目录越界')
                    if name not in name_set or zipped.getinfo(name).file_size > MAX_IMAGE_BYTES:
                        raise ValueError('图片路径不存在或图片超过24MiB上限：' + name)
                    if name not in extracted:
                        target = unpack / (str(len(extracted)) + '.image')
                        with zipped.open(name) as source, target.open('wb') as destination:
                            shutil.copyfileobj(source, destination, 1024 * 1024)
                        extracted[name] = target
                    entries.append(dict(path=extracted[name], productCode=row.get('productCode'), name=row.get('name')))
                return self.build(entries, label, 'product_gallery', event)
        except (BadZipFile, KeyError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError('图库ZIP或清单无效：' + str(exc)) from None
        finally:
            if unpack.is_dir() and unpack.resolve().parent == (self.root / '.staging').resolve():
                shutil.rmtree(unpack)

    def image_path(self, ident, image_id):
        data = self.metadata(ident)
        if type(image_id) is not int or not 0 <= image_id < len(data['items']):
            raise ValueError('图库图片不存在')
        return self._folder(ident) / data['items'][image_id]['image']

    def subset(self, ident, keep):
        """Publish an immutable subset using existing vectors; never run DINO again."""
        import faiss
        with self._lock:
            data = self.metadata(ident)
            if not keep:
                return None
            if len(set(keep)) != len(keep) or any(type(i) is not int or not 0 <= i < data['image_count'] for i in keep):
                raise ValueError('图片子集无效')
            folder = self._folder(ident)
            old = read_vector_index(folder / 'features.faiss', data, allow_legacy=True)
            vectors = np.asarray([old.reconstruct(int(data['items'][position]['id'])) for position in keep], dtype='float32')
            new_id = secrets.token_hex(16)
            stage = self.root / '.staging' / new_id
            (stage / 'images').mkdir(parents=True)
            try:
                items = []
                for ordinal, position in enumerate(keep):
                    item = dict(data['items'][position])
                    path = 'images/' + str(ordinal) + Path(item['image']).suffix
                    shutil.copyfile(folder / item['image'], stage / path)
                    item.update(id=ordinal, image=path)
                    items.append(item)
                return self._publish(stage, new_id, items, vectors, data['label'], data['kind'], data['model_signature'])['id']
            finally:
                if stage.is_dir() and stage.resolve().parent == (self.root / '.staging').resolve():
                    shutil.rmtree(stage)

    def discard(self, ident):
        """Caller must own the gallery. Constrain deletion to this store's direct child."""
        with self._lock:
            folder = self._folder(ident).resolve()
            if folder.parent != self.root:
                raise ValueError('图库目录超出范围')
            if self._cached and self._cached[0] == ident:
                self._cached = None
            shutil.rmtree(folder)

    def search(self, ident, image, top_k=12):
        import faiss
        if type(top_k) is not int or not 1 <= top_k <= 50:
            raise ValueError('候选数量须为1至50')
        with self._lock:
            data = self.metadata(ident)
            if data['model_signature'] != self.encoder.signature:
                raise ValueError('图库模型或预处理版本不一致，请重新建立图库')
            folder = self._folder(ident)
            if not self._cached or self._cached[0] != ident:
                index = read_vector_index(folder / 'features.faiss', data, allow_legacy=True)
                self._cached = (ident, index)
            index = self._cached[1]
            query = normalized(self.encoder.encode([image]))
            if query.shape != (1, index.d):
                raise ValueError('查询图片特征与图库维度不一致')
            limit = min(index.ntotal, top_k * 4)
            by_id = {item['id']: item for item in data['items']}
            while True:
                scores, ids = index.search(query, limit)
                seen, candidates = set(), []
                for score, position in zip(scores[0], ids[0]):
                    if position < 0:
                        continue
                    if int(position) not in by_id:
                        raise ValueError('图库返回了未登记编号')
                    item = by_id[int(position)]
                    key = ('product', item['productCode']) if item['productCode'] else ('image', item['id'])
                    if key in seen:
                        continue
                    seen.add(key)
                    candidates.append(dict(image_id=item['id'], productCode=item['productCode'], name=item['name'],
                                           similarity=round(float(np.clip(score, -1, 1)), 6)))
                    if len(candidates) == top_k:
                        break
                if len(candidates) >= top_k or limit == index.ntotal:
                    break
                limit = min(index.ntotal, limit * 2)
            return dict(status='ok', gallery_id=ident, gallery_label=data['label'], kind=data['kind'],
                        image_count=data['image_count'], model=MODEL_NAME, decision='needs_review',
                        similarity_metric='cosine', candidates=candidates,
                        note='相似度是外观排序，不是同款概率；未找到可靠候选也不能证明从未建档')
