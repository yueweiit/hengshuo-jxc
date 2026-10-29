"""Real Faiss vectors; model inference is intentionally separate from protocol tests."""
import hashlib
import numpy as np
import pytest
from workbench.vision import write_vector_index, read_vector_index, search_vector_index


def test_sparse_feature_ids_survive_rebuild_and_never_become_row_positions(tmp_path):
    import faiss
    path = tmp_path / 'features.faiss'
    vectors = np.array([[1, 0], [0, 1]], dtype='float32')
    manifest = write_vector_index(path, vectors, [1051, 9001])
    index = read_vector_index(path, manifest)
    base = faiss.downcast_index(index.index)
    assert isinstance(base, faiss.IndexHNSWFlat)
    assert base.metric_type == faiss.METRIC_INNER_PRODUCT
    assert base.hnsw.efConstruction == 200 and base.hnsw.efSearch == 256
    np.testing.assert_allclose(index.reconstruct(9001), [0, 1])
    assert search_vector_index(index, [[3, 4]], 2)[0] == dict(featureId=9001, score=0.8)
    assert search_vector_index(index, [[0, 1]], 2)[0]['featureId'] == 9001
    changed = write_vector_index(path, vectors[1:], [9001])
    assert search_vector_index(read_vector_index(path, changed), [[0, 1]], 1)[0]['featureId'] == 9001


def test_published_flat_index_keeps_stable_ids_and_is_not_rewritten(tmp_path):
    import faiss
    path = tmp_path / 'published-flat.faiss'
    index = faiss.IndexIDMap2(faiss.IndexFlatIP(2))
    index.add_with_ids(np.array([[1, 0], [0, 1]], dtype='float32'), np.array([1051, 9001], dtype='int64'))
    faiss.write_index(index, str(path))
    original = path.read_bytes()
    manifest = dict(dimension=2, featureIds=[1051, 9001], indexSha256=hashlib.sha256(original).hexdigest())
    restored = read_vector_index(path, manifest)
    assert search_vector_index(restored, [[0, 1]], 2)[0] == dict(featureId=9001, score=1.0)
    np.testing.assert_allclose(restored.reconstruct(1051), [1, 0])
    assert path.read_bytes() == original


def test_hnsw_recall_matches_flat_for_controlled_384_dimension_queries(tmp_path):
    import faiss
    from workbench.vision import normalized
    rng = np.random.default_rng(20261029)
    vectors = normalized(rng.standard_normal((2048, 384)))
    queries = normalized(vectors[::32] + rng.normal(0, 0.02, (64, 384)))
    feature_ids = [1051 + 17 * position for position in range(len(vectors))]
    path = tmp_path / 'hnsw.faiss'
    previous_threads = faiss.omp_get_max_threads()
    faiss.omp_set_num_threads(2)
    try:
        manifest = write_vector_index(path, vectors, feature_ids)
        index = read_vector_index(path, manifest)
        assert isinstance(faiss.downcast_index(index.index), faiss.IndexHNSWFlat)
        exact = faiss.IndexFlatIP(384)
        exact.add(vectors)
        _, expected = exact.search(queries, 10)
        actual = [search_vector_index(index, [query], 10) for query in queries]
        recalled = sum(len({hit['featureId'] for hit in hits} & {feature_ids[position] for position in positions})
                       for hits, positions in zip(actual, expected))
        assert recalled / expected.size >= 0.98
        assert all(hits[0]['featureId'] == feature_ids[position * 32] for position, hits in enumerate(actual))
    finally:
        faiss.omp_set_num_threads(previous_threads)


@pytest.mark.parametrize('vectors,ids', [([[0, 0]], [1]), ([[float('nan'), 0]], [1]), ([[float('inf'), 0]], [1]), ([[1, 0]], [0]), ([[1, 0], [0, 1]], [1, 1]), ([[1, 0]], [9007199254740992])])
def test_invalid_vector_or_identity_is_rejected(tmp_path, vectors, ids):
    with pytest.raises(ValueError):
        write_vector_index(tmp_path / 'features.faiss', vectors, ids)


def test_corrupt_file_and_wrong_dimension_are_errors_not_empty_matches(tmp_path):
    path = tmp_path / 'features.faiss'
    manifest = write_vector_index(path, [[1, 0]], [71])
    with pytest.raises(ValueError, match='维度'):
        search_vector_index(read_vector_index(path, manifest), [[1, 0, 0]], 1)
    path.write_bytes(b'broken')
    with pytest.raises(ValueError, match='校验'):
        read_vector_index(path, manifest)


def test_bridge_index_pins_model_and_returns_stable_real_faiss_payload(tmp_path):
    from workbench.jxc_gallery import build_gallery_index, model_metadata
    import base64
    vector = np.zeros(384, dtype='<f4'); vector[0] = 1
    request = dict(model_metadata(), countryId=101, generation='a'*32, featureIds=[9871], dimension=384, features=[dict(featureId=9871, dimension=384, data=base64.b64encode(vector.tobytes()).decode())], coverage=dict(photos=1, readyPhotos=1, features=1), basisHash='b'*64)
    result = build_gallery_index(request, tmp_path)
    assert result['featureIds'] == [9871]
    assert hashlib.sha256(base64.b64decode(result['indexBase64'])).hexdigest() == result['indexSha256']
    request['modelVersion'] = 'wrong'
    with pytest.raises(ValueError, match='模型'):
        build_gallery_index(request, tmp_path)
    request.update(model_metadata()); request['preprocessVersion'] = 'wrong'
    with pytest.raises(ValueError, match='模型'):
        build_gallery_index(request, tmp_path)
    request.update(model_metadata()); request['features'][0]['dimension'] = 383
    with pytest.raises(ValueError, match='维度'):
        build_gallery_index(request, tmp_path)


def test_gallery_bridge_requires_worker_auth_and_rejects_arbitrary_paths():
    from fastapi.testclient import TestClient
    from workbench.jxc_bridge import create_app
    client = TestClient(create_app('http://127.0.0.1:9999', 'test-worker-secret'))
    body = dict(taskId='11111111-2222-4333-8444-555555555555', credential='101:'+'b'*72, assetId=1, sha256='a'*64, url='http://example.com/file')
    assert client.post('/internal/jxc/embedding', json=body).status_code == 401
    assert client.post('/internal/jxc/embedding', json=body, headers={'Authorization': 'Bearer test-worker-secret'}).status_code == 422


def test_legacy_demo_index_is_read_only_compatible_but_not_a_formal_feature_manifest(tmp_path):
    import faiss
    path = tmp_path / 'old.faiss'
    index = faiss.IndexFlatIP(2); index.add(np.array([[1, 0], [0, 1]], dtype='float32'))
    faiss.write_index(index, str(path))
    manifest = dict(dimension=2, image_count=2, index_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    with pytest.raises(ValueError, match='格式'):
        read_vector_index(path, manifest)
    assert read_vector_index(path, manifest, allow_legacy=True).ntotal == 2


class QueryEncoder:
    from workbench.vision import MODEL_NAME, WEIGHT_SHA256
    signature = MODEL_NAME + ':' + WEIGHT_SHA256 + ':exif-rgb-short256-center224-imagenet-v1'
    def __init__(self): self.calls = 0
    def encode(self, paths):
        self.calls += 1
        vectors = np.zeros((len(paths), 384), dtype='float32'); vectors[:, 1] = 1
        return vectors


def search_fixture(tmp_path):
    import json
    from PIL import Image
    from workbench.jxc_gallery import model_metadata
    query = tmp_path / 'query.png'; Image.new('RGB', (8, 8), 'blue').save(query)
    path = tmp_path / 'index.faiss'; vectors = np.zeros((2, 384), dtype='float32'); vectors[0, 0] = 1; vectors[1, 1] = 1
    manifest = dict(model_metadata(), **write_vector_index(path, vectors, [1051, 9001]), format='GalleryManifestV1', countryId=101, generation='a'*32, coverage=dict(photos=2, readyPhotos=2, features=2), basisHash='b'*64)
    manifest['manifestSha256'] = hashlib.sha256(json.dumps(manifest, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    return query, path, manifest


def test_restricted_search_returns_real_feature_ids_and_reuses_only_same_country_model_hash(tmp_path):
    from workbench.jxc_gallery import search_gallery_index, QueryFeatureCache
    query, path, manifest = search_fixture(tmp_path); encoder = QueryEncoder(); cache = QueryFeatureCache(2)
    first = search_gallery_index(query, path, manifest, 101, encoder, 2, cache)
    second = search_gallery_index(query, path, manifest, 101, encoder, 2, cache)
    assert first == second
    assert first['hits'][0]['featureId'] == 9001
    assert 'productId' not in first['hits'][0]
    assert encoder.calls == 1
    with pytest.raises(ValueError, match='国家'):
        search_gallery_index(query, path, manifest, 102, encoder, 2, cache)


def test_search_rejects_bad_manifest_or_corrupt_index_instead_of_no_candidates(tmp_path):
    from workbench.jxc_gallery import search_gallery_index, QueryFeatureCache
    query, path, manifest = search_fixture(tmp_path); encoder = QueryEncoder(); cache = QueryFeatureCache(2)
    changed = dict(manifest, dimension=383)
    with pytest.raises(ValueError):
        search_gallery_index(query, path, changed, 101, encoder, 2, cache)
    path.write_bytes(b'broken')
    with pytest.raises(ValueError, match='校验'):
        search_gallery_index(query, path, manifest, 101, encoder, 2, cache)


def test_search_http_requires_worker_auth_and_forbids_caller_urls():
    from fastapi.testclient import TestClient
    from workbench.jxc_bridge import create_app
    client = TestClient(create_app('http://127.0.0.1:9999', 'test-worker-secret'))
    body = dict(taskId='11111111-2222-4333-8444-555555555555', credential='101:'+'b'*72, url='http://example.com/private')
    assert client.post('/internal/jxc/search', json=body).status_code == 401
    assert client.post('/internal/jxc/search', json=body, headers={'Authorization': 'Bearer test-worker-secret'}).status_code == 422


def test_authorized_http_search_refetches_scoped_assets_even_on_feature_cache_hit(tmp_path):
    from fastapi.testclient import TestClient
    from workbench.jxc_bridge import create_app
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    query, index_path, manifest = search_fixture(tmp_path); encoder = QueryEncoder(); seen = []
    credential = '101:' + 'b'*72
    class Handler(BaseHTTPRequestHandler):
        allowed = True
        def do_GET(self):
            seen.append((self.path, self.headers.get('X-Purchase-Task')))
            if not self.allowed or self.headers.get('X-Purchase-Task') != credential:
                self.send_response(403); self.end_headers(); return
            data = query.read_bytes() if self.path.endswith('/71') else index_path.read_bytes()
            self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        def log_message(self, *_): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler); thread = Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        client = TestClient(create_app(f'http://127.0.0.1:{server.server_port}', 'test-worker-secret', encoder))
        body = dict(taskId='11111111-2222-4333-8444-555555555555', credential=credential, queryAssetId=71, querySha256=hashlib.sha256(query.read_bytes()).hexdigest(), indexAssetId=72, manifest=manifest, topK=2)
        headers = {'Authorization': 'Bearer test-worker-secret'}
        for _ in range(2):
            result = client.post('/internal/jxc/search', json=body, headers=headers)
            assert result.status_code == 200, result.text
            assert result.json()['search']['hits'][0]['featureId'] == 9001
        assert encoder.calls == 1 and len(seen) == 4
        assert all(token == credential for _, token in seen)
        Handler.allowed = False
        revoked = client.post('/internal/jxc/search', json=body, headers=headers)
        assert revoked.status_code == 422 and revoked.json()['status'] == 'error'
        assert 'hits' not in revoked.json()
    finally:
        server.shutdown(); server.server_close(); thread.join()
