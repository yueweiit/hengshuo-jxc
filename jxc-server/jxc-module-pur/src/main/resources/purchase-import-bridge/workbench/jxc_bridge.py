"""受限采购来源适配；复用 Docling 转换，不沿用演示商品/金额映射。"""
import base64
import hashlib
import io
import json
import posixpath
import zipfile
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image

HEADERS = ['采购单号', '商品照片', '商品规格', '采购数量', '单件售价', '售价合计',
           '供应商单价（采购单价）', '运费', '到货单位成本', '美元单位成本', '美元成本合计']
FIELDS = ['sourceOrderNo', 'photo', 'productSpec', 'purchaseQty', 'saleUnitPrice', 'saleTotal',
          'purchaseUnitPrice', 'freight', 'landedUnitCost', 'usdUnitCost', 'usdTotal']
MAX_FILE = 100 * 1024 * 1024
MAX_IMAGE = 10 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
PARSER_VERSION = 'jxc-source-v1.0'
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'p': 'http://schemas.openxmlformats.org/package/2006/relationships',
      'x': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
      'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}


class SourceError(ValueError):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.details = code, details


def validate_archive(source, max_expanded=MAX_EXPANDED):
    if not 0 < source.stat().st_size <= MAX_FILE:
        raise SourceError('FILE_LIMIT', '采购文件须为非空且不超过100MiB')
    try:
        with zipfile.ZipFile(source) as archive:
            total, seen = 0, set()
            for member in archive.infolist():
                name = member.filename
                if name in seen or name.startswith(('/', '\\')) or '\\' in name or '..' in name.split('/'):
                    raise SourceError('ARCHIVE_PATH', '工作簿包含重复或非法路径')
                seen.add(name)
                total += member.file_size
                if total > max_expanded or len(seen) > 20000:
                    raise SourceError('EXPANSION_LIMIT', '工作簿展开内容超过安全限额')
                if member.flag_bits & 1:
                    raise SourceError('ARCHIVE_ENCRYPTED', '不支持加密工作簿')
            if archive.testzip() is not None:
                raise SourceError('ARCHIVE_INVALID', '工作簿压缩内容损坏')
    except (zipfile.BadZipFile, EOFError) as error:
        raise SourceError('ARCHIVE_INVALID', '工作簿损坏，无法读取') from error


def xml(archive, name):
    data = archive.read(name)
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise SourceError('XML_INVALID', '工作簿XML含未支持的实体定义')
    return ET.fromstring(data)


def relations(archive, part):
    directory, name = posixpath.split(part)
    relpath = posixpath.join(directory, '_rels', name + '.rels')
    if relpath not in archive.namelist():
        return {}
    result = {}
    for rel in xml(archive, relpath):
        if rel.get('TargetMode') == 'External':
            continue  # 外部链接不作为本地资产，也不发出网络请求。
        target = rel.attrib['Target']
        resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(directory, target))
        if not resolved.startswith('xl/') or '..' in resolved.split('/'):
            raise SourceError('RELATION_INVALID', '工作簿关系路径越界')
        result[rel.attrib['Id']] = resolved
    return result


def cell_value(cell, strings):
    if cell.get('t') == 'inlineStr':
        return ''.join(cell.itertext())
    value = cell.find('m:v', NS)
    text = value.text if value is not None else None
    if cell.get('t') == 's' and text is not None:
        return strings[int(text)]
    return text


def progress_event(progress, phase, rows=0, total=None, images=0, total_images=None, sheet=None, row=None):
    if progress is not None:
        progress(dict(phase=phase, processedRows=rows, totalRows=total,
                      processedImages=images, totalImages=total_images, sourceSheet=sheet, sourceRow=row, sourceTotalRows=total))


def append_sheet_images(archive, sheet, output, image_ids, progress=None, row_count=None):
    rows = len(output['rows']) if row_count is None else row_count
    progress_event(progress, 'EXTRACTING_IMAGES', rows, rows, len(image_ids), sheet=sheet['name'])
    for drawing in sheet['document'].findall('m:drawing', NS):
        draw_part = relations(archive, sheet['part']).get(drawing.attrib['{' + NS['r'] + '}id'])
        if draw_part is None:
            raise SourceError('DRAWING_MISSING', '图片关联缺失，不能报告提取成功')
        draw_links = relations(archive, draw_part)
        for anchor in xml(archive, draw_part):
            for blip in anchor.findall('.//a:blip', NS):
                part = draw_links.get(blip.get('{' + NS['r'] + '}embed'))
                if part is None:
                    raise SourceError('IMAGE_MISSING', '图片关系不是可读取的内嵌原图')
                data = archive.read(part)
                if not 0 < len(data) <= MAX_IMAGE:
                    raise SourceError('IMAGE_LIMIT', '单张原图超过10MiB或内容为空')
                sha = hashlib.sha256(data).hexdigest()
                if sha not in image_ids:
                    try:
                        with Image.open(io.BytesIO(data)) as image:
                            mime = Image.MIME.get(image.format)
                            if mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif'):
                                raise SourceError('IMAGE_TYPE', '原图格式暂不支持')
                            image.verify()
                            image_ids[sha] = sha
                            output['images'].append(dict(imageId=sha, sha256=sha, mimeType=mime,
                                bytes=len(data), width=image.width, height=image.height, mediaPart=part,
                                contentBase64=base64.b64encode(data).decode('ascii')))
                            if len(image_ids) == 1 or len(image_ids) % 25 == 0:
                                progress_event(progress, 'EXTRACTING_IMAGES', rows, rows, len(image_ids), sheet=sheet['name'])
                    except SourceError:
                        raise
                    except Exception as error:
                        raise SourceError('IMAGE_INVALID', f'{sheet["name"]}!{part}原图读取或校验失败') from error
                origin = anchor.find('x:from', NS)
                target_row = int(origin.find('x:row', NS).text) + 1 if origin is not None else None
                anchor_data = {'type': anchor.tag.rsplit('}', 1)[-1], 'xml': ET.tostring(anchor, encoding='unicode')}
                output['associations'].append(dict(imageId=sha, sourceSheet=sheet['name'], sourceRow=target_row,
                                                   anchor=anchor_data, status='UNCONFIRMED'))


def build_source_document(source: Path, compact: dict, purchase_sheet=None, progress=None):
    validate_archive(source)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if compact.get('source', {}).get('sha256') != digest:
        raise SourceError('SOURCE_HASH_MISMATCH', '解析来源与原文件哈希不一致')
    with zipfile.ZipFile(source) as archive:
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(item.itertext()) for item in xml(archive, 'xl/sharedStrings.xml')]
        workbook = xml(archive, 'xl/workbook.xml')
        links = relations(archive, 'xl/workbook.xml')
        sheets, matching = [], []
        for item in workbook.find('m:sheets', NS):
            part = links[item.attrib['{' + NS['r'] + '}id']]
            document = xml(archive, part)
            rows = {}
            for row in document.findall('m:sheetData/m:row', NS):
                cells = {''.join(filter(str.isalpha, cell.attrib['r'])): cell for cell in row}
                rows[int(row.attrib['r'])] = cells
            header_row = next((n for n, cells in rows.items()
                               if [cell_value(cells.get(chr(65+i)), strings) if chr(65+i) in cells else None
                                   for i in range(11)] == HEADERS), None)
            sheet = dict(name=item.attrib['name'], part=part, document=document, rows=rows, header=header_row)
            sheets.append(sheet)
            if header_row is not None:
                matching.append(sheet['name'])
        if not matching:
            raise SourceError('TEMPLATE_HEADERS_REQUIRED', '未找到符合11列表头的采购工作表')
        if purchase_sheet is None and len(matching) > 1:
            raise SourceError('SHEET_SELECTION_REQUIRED', '多个工作表符合采购模板，请选择', sheets=matching)
        selected = purchase_sheet or matching[0]
        if selected not in matching:
            raise SourceError('SHEET_INVALID', '所选工作表不符合采购模板', sheets=matching)
        output = dict(format='SourceDocumentV1', source=dict(fileSha256=digest, fileName=source.name,
                      bytes=source.stat().st_size, parserVersion=PARSER_VERSION),
                      sheets=[], rows=[], images=[], associations=[], warnings=[], errors=[])
        parsed_rows = {(row['source_sheet'], row['source_row']): row for row in compact['rows']}
        image_ids = {}
        for sheet in sheets:
            role = 'PURCHASE' if sheet['name'] == selected else 'UNSELECTED' if sheet['name'] in matching else 'PARAMETERS'
            source_rows = [{ 'sourceRow': number, 'values': {col: cell_value(cell, strings) for col, cell in cells.items()}}
                           for number, cells in sheet['rows'].items() if number > 1]
            output['sheets'].append(dict(name=sheet['name'], role=role, sourceRows=source_rows))
            if role != 'PURCHASE':
                continue
            data_rows = []
            for number, cells in sheet['rows'].items():
                if number <= sheet['header']:
                    continue
                texts = {col: cell_value(cell, strings) for col, cell in cells.items()}
                if not any(value is not None and str(value).strip() for value in texts.values()):
                    continue
                if texts.get('A') in ('合计', '总计', 'total', 'TOTAL', 'subtotal'):
                    continue
                data_rows.append((number, cells, texts))
            progress_event(progress, 'PARSING', 0, len(data_rows), sheet=sheet['name'])
            output['source']['fileRows'] = len(data_rows)
            for number, cells, texts in data_rows:
                parsed = parsed_rows.get((sheet['name'], number))
                if parsed is None:
                    raise SourceError('SOURCE_ROW_MISSING', f'{sheet["name"]}!{number}未出现在解析来源中')
                formulas = {}
                for col, cell in cells.items():
                    formula = cell.find('m:f', NS)
                    if formula is None:
                        continue
                    # OOXML shared formulas omit text on follower cells. prepare_document
                    # already expands them with openpyxl; retain that single expansion path.
                    if col in parsed.get('formulas', {}):
                        formulas[col] = parsed['formulas'][col]
                    elif formula.text:
                        formulas[col] = '=' + formula.text
                    else:
                        raise SourceError('FORMULA_UNRESOLVED', f'{sheet["name"]}!{col}{number}共享公式未展开')
                raw_numeric = {col: texts[col] for col, cell in cells.items() if cell.get('t', 'n') == 'n' and texts[col] is not None}
                values = {}
                for index, field in enumerate(FIELDS):
                    col = chr(65+index)
                    text = texts.get(col)
                    if index < 3:
                        values[field] = str(text).strip() if text is not None and str(text).strip() else None
                        continue
                    if text is None or text == '':
                        values[field] = None
                        if col in formulas:
                            output['warnings'].append(dict(code='FORMULA_CACHE_MISSING', sourceSheet=sheet['name'],
                                                           sourceRow=number, field=field, message='公式无缓存值，待核实'))
                        continue
                    try:
                        with localcontext() as ctx:
                            ctx.prec = 50
                            value = Decimal(text)
                            if not value.is_finite() or value < 0:
                                raise InvalidOperation()
                            if index == 3 and (value <= 0 or value != value.quantize(Decimal('0.0001')) or value >= 10 ** 16):
                                raise InvalidOperation()
                            value = value.quantize(Decimal('0.0001') if index == 3 else Decimal('0.0000000001'), rounding=ROUND_HALF_UP)
                            if index != 3 and value >= 10 ** 20:
                                raise InvalidOperation()
                            values[field] = format(value, 'f')
                    except (InvalidOperation, ValueError) as error:
                        raise SourceError('CELL_INVALID', f'{sheet["name"]}!{col}{number}数值不符合采购字段精度') from error
                if not values['sourceOrderNo'] or values['purchaseQty'] is None:
                    raise SourceError('ROW_REQUIRED', f'{sheet["name"]}!{number}缺少采购单号或有效数量')
                output['rows'].append(dict(sourceSheet=sheet['name'], sourceRow=number,
                    originalValues=parsed['cells'], rawNumericTexts=raw_numeric, formulas=formulas,
                    cachedValues={col: texts.get(col) for col in formulas}, normalizedValues=values))
                processed = len(output['rows'])
                if processed == 1 or processed % 25 == 0 or processed == len(data_rows):
                    progress_event(progress, 'PARSING', processed, len(data_rows), sheet=sheet['name'], row=number)
            append_sheet_images(archive, sheet, output, image_ids, progress)
            progress_event(progress, 'EXTRACTING_IMAGES', len(output['rows']), len(data_rows), len(image_ids), len(image_ids), sheet['name'])
        if not output['rows']:
            raise SourceError('NO_PURCHASE_ROWS', '所选采购工作表没有有效采购明细')
        return output


def parse_document(source: Path, output: Path, purchase_sheet=None, docling_url='http://127.0.0.1:5001', progress=None):
    """转换器是唯一 Docling 调用方；不调用带旧商品快照的 seed_review。"""
    from convert import convert
    from workbench.documents import prepare_document
    validate_archive(source)
    output.mkdir(parents=True, exist_ok=True)
    progress_event(progress, 'CONVERTING')
    convert(source, output, docling_url)
    compact = prepare_document(source, output)
    return build_source_document(source, compact, purchase_sheet, progress=progress)


def create_app(asset_base=None, worker_key=None, encoder=None):
    """单独启动的受限服务；配置缺失即拒绝，不继承工作台任意文件入口。"""
    import hmac
    import os
    import tempfile
    import uuid
    from urllib.parse import urlsplit
    from urllib.request import Request, build_opener, HTTPRedirectHandler
    from fastapi import FastAPI, Header, Body
    from fastapi.responses import JSONResponse

    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise SourceError('ASSET_REDIRECT', '来源资产不允许重定向')

    asset_base = asset_base if asset_base is not None else os.environ.get('JXC_ASSET_BASE_URL', '')
    worker_key = worker_key if worker_key is not None else os.environ.get('JXC_BRIDGE_WORKER_KEY', '')
    app = FastAPI(title='JXC restricted purchase bridge', docs_url=None, redoc_url=None, openapi_url=None)

    def guard(authorization):
        if not worker_key or not asset_base:
            return JSONResponse(status_code=503, content=dict(status='error', code='BRIDGE_UNAVAILABLE', message='受限桥接配置缺失'))
        if not hmac.compare_digest(authorization or '', 'Bearer ' + worker_key):
            return JSONResponse(status_code=401, content=dict(status='error', code='AUTH_REQUIRED', message='桥接鉴权失败'))
        return None  # 明确表示本次鉴权成功，继续执行路由。

    def scope(body, asset_field=None):
        import re
        task = str(uuid.UUID(body['taskId']))
        credential = body['credential']
        if not isinstance(credential, str) or not re.fullmatch(r'[1-9][0-9]{0,15}:[a-f0-9-]{64,100}', credential):
            raise SourceError('REQUEST_INVALID', '任务凭证无效')
        if asset_field:
            ident, digest = body[asset_field], body['sha256']
            if type(ident) is not int or not 0 < ident <= 9007199254740991 or not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
                raise SourceError('REQUEST_INVALID', '资产编号或哈希无效')
        return task, credential

    def server_base():
        target = urlsplit(asset_base)
        if target.scheme not in ('http', 'https') or target.username or target.query or target.fragment:
            raise SourceError('BRIDGE_CONFIG_INVALID', '服务端资产入口配置无效')
        return asset_base.rstrip('/')

    def fetch(task, ident, credential, digest, path, maximum):
        request = Request(server_base() + f'/internal/purchase-import/tasks/{task}/assets/{ident}', headers={'X-Purchase-Task': credential})
        from urllib.error import HTTPError
        try:
            with build_opener(NoRedirect).open(request, timeout=30) as response, path.open('wb') as output:
                size = 0
                while data := response.read(1024 * 1024):
                    size += len(data)
                    if size > maximum:
                        raise SourceError('FILE_LIMIT', '任务资产超过允许大小')
                    output.write(data)
        except HTTPError as error:
            if error.code in (401, 403):
                raise SourceError('ASSET_FORBIDDEN', '任务资产授权已失效或超出范围') from None
            if error.code == 404:
                raise SourceError('ASSET_NOT_FOUND', '任务授权资产已不存在') from None
            raise SourceError('ASSET_READ_FAILED', '受控资产服务返回读取失败') from None
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise SourceError('SOURCE_HASH_MISMATCH', '任务资产哈希不一致')

    def progress_reporter(task, source, credential):
        def report(event):
            from urllib.error import HTTPError, URLError
            request = Request(server_base() + f'/internal/purchase-import/tasks/{task}/progress',
                data=json.dumps(dict(event, sourceId=source), ensure_ascii=False).encode('utf-8'),
                headers={'X-Purchase-Task': credential, 'Content-Type': 'application/json'}, method='POST')
            try:
                with build_opener(NoRedirect).open(request, timeout=10) as response:
                    if response.status != 200:
                        raise SourceError('PROGRESS_REPORT_FAILED', '进度服务未确认本次上报')
            except HTTPError as error:
                if error.code == 409:
                    raise SourceError('INPUT_CHANGED', '任务尝试或步骤已变化，旧进度未写入') from None
                if error.code in (401, 403):
                    raise SourceError('PROGRESS_FORBIDDEN', '进度上报授权已失效') from None
                raise SourceError('PROGRESS_REPORT_FAILED', '进度服务拒绝本次上报') from None
            except (URLError, TimeoutError, OSError):
                raise SourceError('PROGRESS_REPORT_FAILED', '进度上报连接或响应失败') from None
        return report

    def parse_source(body, authorization, source_parser):
        rejected = guard(authorization)
        if rejected is not None:
            return rejected
        try:
            if set(body)-{'taskId', 'sourceId', 'sha256', 'credential', 'sheet', 'mappingOverrides', 'reportProgress', 'managedServices'} or not {'taskId','sourceId','sha256','credential','sheet'} <= set(body) or type(body.get('reportProgress', False)) is not bool or type(body.get('managedServices', False)) is not bool:
                raise SourceError('REQUEST_INVALID', '只接受任务范围资产清单，不能指定文件或网络路径')
            task, credential = scope(body, 'sourceId')
            source_id, digest = body['sourceId'], body['sha256']
            sheet = body['sheet']
            if sheet is not None and (not isinstance(sheet, str) or not 0 < len(sheet) <= 31):
                raise SourceError('REQUEST_INVALID', '工作表选择无效')
            with tempfile.TemporaryDirectory(prefix='jxc-source-') as directory:
                path = Path(directory) / 'source.xlsx'
                reporter = progress_reporter(task, source_id, credential) if body.get('reportProgress') else None
                progress_event(reporter, 'READING')
                fetch(task, source_id, credential, digest, path, MAX_FILE)
                args = (path, Path(directory) / 'parsed', sheet, os.environ.get('JXC_DOCLING_URL', 'http://127.0.0.1:5001'))
                options = {'progress': reporter} if reporter is not None else {}
                if body.get('managedServices'):
                    if source_parser is parse_document:
                        raise SourceError('REQUEST_INVALID', '托管服务配置只支持采购字段识别入口')
                    options['task_context'] = (server_base(), task, credential)
                if 'mappingOverrides' in body:
                    if source_parser is parse_document or not isinstance(body['mappingOverrides'],dict):
                        raise SourceError('REQUEST_INVALID','当前解析入口不接受字段修正')
                    document = source_parser(*args, mapping_overrides=body['mappingOverrides'], **options)
                else:
                    document = source_parser(*args, **options)
                return dict(status='ok', document=document)
        except SourceError as error:
            return JSONResponse(status_code=422, content=dict(status='error', code=error.code, message=str(error), details=error.details))
        except (TypeError, ValueError, KeyError):
            return JSONResponse(status_code=422, content=dict(status='error', code='REQUEST_INVALID', message='任务请求格式无效'))
        except Exception:
            # 不把带任务凭证的请求对象/网络错误原文放进响应或日志。
            return JSONResponse(status_code=502, content=dict(status='error', code='PARSE_FAILED', message='来源读取、Docling转换或原图提取失败'))



    @app.post('/internal/jxc/connection-test')
    def connection_test(body: dict = Body(...), authorization: str | None = Header(default=None)):
        rejected = guard(authorization)
        if rejected is not None:
            return rejected
        if body != {'format': 'JxcConnectionProbeV1'}:
            return JSONResponse(status_code=422, content=dict(status='error', code='REQUEST_INVALID', message='只接受连接检查协议'))
        return dict(status='ok', format='JxcConnectionProbeV1', purpose='docling')

    @app.post('/internal/jxc/parse')
    def parse(body: dict = Body(...), authorization: str | None = Header(default=None)):
        # 保留尚未升级的 Java 客户端；新客户端只把非模板送到supplier-parse。
        return parse_source(body, authorization, parse_document)

    @app.post('/internal/jxc/supplier-parse')
    def supplier_parse(body: dict = Body(...), authorization: str | None = Header(default=None)):
        from workbench.jxc_supplier import parse_supplier_document
        return parse_source(body, authorization, parse_supplier_document)

    from workbench.vision import DinoEncoder
    from workbench.jxc_gallery import embedding_result, build_gallery_index, search_gallery_index, validate_gallery_manifest, QueryFeatureCache
    encoder = encoder if encoder is not None else DinoEncoder()
    query_cache = QueryFeatureCache(256)

    @app.post('/internal/jxc/embedding')
    def embedding(body: dict = Body(...), authorization: str | None = Header(default=None)):
        rejected = guard(authorization)
        if rejected is not None:
            return rejected
        try:
            if set(body) != {'taskId', 'credential', 'assetId', 'sha256'}:
                raise SourceError('REQUEST_INVALID', '只接受任务原图引用，不能指定文件或网络路径')
            task, credential = scope(body, 'assetId')
            with tempfile.TemporaryDirectory(prefix='jxc-feature-') as directory:
                image = Path(directory) / 'original.image'
                fetch(task, body['assetId'], credential, body['sha256'], image, MAX_IMAGE)
                result = embedding_result(image, encoder)
            return dict(status='ok', feature=result)
        except SourceError as error:
            return JSONResponse(status_code=422, content=dict(status='error', code=error.code, message=str(error)))
        except (ValueError, TypeError, KeyError) as error:
            return JSONResponse(status_code=422, content=dict(status='error', code='FEATURE_INVALID', message=str(error)))
        except Exception:
            return JSONResponse(status_code=503, content=dict(status='error', code='FEATURE_UNAVAILABLE', message='任务原图读取或模型提取失败'))

    @app.post('/internal/jxc/index')
    def index(body: dict = Body(...), authorization: str | None = Header(default=None)):
        rejected = guard(authorization)
        if rejected is not None:
            return rejected
        try:
            if set(body) != {'taskId', 'credential', 'input'}:
                raise SourceError('REQUEST_INVALID', '只接受版本固定的图库清单')
            scope(body)
            with tempfile.TemporaryDirectory(prefix='jxc-index-') as directory:
                result = build_gallery_index(body['input'], directory)
            return dict(status='ok', index=result)
        except SourceError as error:
            return JSONResponse(status_code=422, content=dict(status='error', code=error.code, message=str(error)))
        except (ValueError, TypeError, KeyError):
            return JSONResponse(status_code=422, content=dict(status='error', code='INDEX_INVALID', message='索引模型、维度、清单或特征数据无效'))
        except Exception:
            return JSONResponse(status_code=503, content=dict(status='error', code='INDEX_UNAVAILABLE', message='索引构建失败'))

    @app.post('/internal/jxc/search')
    def search(body: dict = Body(...), authorization: str | None = Header(default=None)):
        rejected = guard(authorization)
        if rejected is not None:
            return rejected
        try:
            if set(body) != {'taskId', 'credential', 'queryAssetId', 'querySha256', 'indexAssetId', 'manifest', 'topK'}:
                raise SourceError('REQUEST_INVALID', '只接受任务原图和已发布图库引用，禁止文件或网络路径')
            task, credential = scope(dict(body, sha256=body['querySha256']), 'queryAssetId')
            country = int(credential.partition(':')[0])
            manifest = body['manifest']
            if not isinstance(manifest, dict):
                raise ValueError('图库清单无效')
            validate_gallery_manifest(manifest, country)
            index_asset = body['indexAssetId']
            if type(index_asset) is not int or not 0 < index_asset <= 9007199254740991:
                raise ValueError('索引资产编号无效')
            with tempfile.TemporaryDirectory(prefix='jxc-search-') as directory:
                query, index_path = Path(directory) / 'query.image', Path(directory) / 'features.faiss'
                # 即使特征命中内存缓存，仍读取受限资产以重新检查当前授权和hash。
                fetch(task, body['queryAssetId'], credential, body['querySha256'], query, MAX_IMAGE)
                fetch(task, index_asset, credential, manifest['indexSha256'], index_path, 256 * 1024 * 1024)
                result = search_gallery_index(query, index_path, manifest, country, encoder, body['topK'], query_cache)
            return dict(status='ok', search=result)
        except SourceError as error:
            return JSONResponse(status_code=422, content=dict(status='error', code=error.code, message=str(error)))
        except (ValueError, TypeError, KeyError):
            return JSONResponse(status_code=422, content=dict(status='error', code='SEARCH_INVALID', message='查询国家、模型、清单、索引或图片特征无效'))
        except Exception:
            return JSONResponse(status_code=503, content=dict(status='error', code='SEARCH_UNAVAILABLE', message='任务资产读取或图片检索失败'))

    return app


app = create_app()
