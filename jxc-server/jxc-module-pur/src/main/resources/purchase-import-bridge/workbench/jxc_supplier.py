"""供应商 Excel：Docling 提取，n8n 仅选择原单元格，原文件提供实际值。"""
import hashlib
import json
import os
import re
import zipfile
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener
from workbench.jxc_bridge import FIELDS, NS, SourceError, validate_archive, xml, relations, cell_value, append_sheet_images, progress_event


def recognition_request(compact, sheet):
    """只传来源结构；资产凭证、服务地址和本地文件路径不进入模型输入。"""
    rows = [{k: row[k] for k in ('source_sheet', 'source_row', 'row_kind', 'cells', 'formulas') if k in row}
            for row in compact['rows'] if sheet is None or row['source_sheet'] == sheet]
    result = dict(format='SupplierDocumentV1', fileSha256=compact['source']['sha256'], sheet=sheet,
                tables=[{k: table[k] for k in ('source_sheet','headers','num_rows','num_cols') if k in table}
                        for table in compact['tables'] if sheet is None or table['source_sheet'] == sheet], rows=rows)
    if 'sourceCells' in compact:
        result['sourceCells'] = compact['sourceCells']
    return result


def recognize_fields(compact, sheet, task_context=None):
    # 旧启动配置仍由原入口消费；托管模式只携带短期任务凭证回到受控Java根地址。
    if task_context is None:
        endpoint, key = os.environ.get('JXC_SUPPLIER_N8N_URL', ''), os.environ.get('JXC_SUPPLIER_N8N_KEY', '')
        if not endpoint or not key:
            raise SourceError('SUPPLIER_N8N_UNAVAILABLE', '供应商Excel字段识别工作流未配置，原文件已保留')
        headers = {'Authorization': 'Bearer '+key, 'Content-Type': 'application/json'}
    else:
        root, task, credential = task_context
        endpoint = root + f'/internal/purchase-import/tasks/{task}/fields'
        headers = {'X-Purchase-Task': credential, 'Content-Type': 'application/json'}
    url = urlsplit(endpoint)
    if url.scheme not in ('http','https') or not url.hostname or url.username or url.password or url.query or url.fragment or task_context is None and not url.path.endswith('/jxc-purchase-fields-v1'):
        raise SourceError('SUPPLIER_N8N_CONFIG_INVALID', '请配置独立的采购字段识别工作流地址')
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    try:
        request = Request(endpoint, json.dumps(recognition_request(compact, sheet), ensure_ascii=False).encode('utf-8'),
                          headers, method='POST')
        # 托管请求由Java执行已保存的1～600秒连接超时，桥接不能先在300秒截断。
        with build_opener(NoRedirect).open(request, timeout=600 if task_context is not None else 300) as response:
            data = response.read(4*1024*1024+1)
        if len(data)>4*1024*1024:
            raise SourceError('SUPPLIER_MAPPING_LIMIT', '字段识别结果超过允许大小')
        result = json.loads(data)
        if result.get('status') != 'ok' or not isinstance(result.get('mapping'), dict):
            raise SourceError('SUPPLIER_N8N_FAILED', '字段识别未返回完整结果，请检查工作流')
        return result['mapping']
    except SourceError:
        raise
    except Exception:
        raise SourceError('SUPPLIER_N8N_FAILED', '字段识别连接、超时或响应解析失败，原文件已保留') from None


def build_supplier_document(source, compact, mapping, selected_sheet=None, overrides=None, progress=None):
    validate_archive(source)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    review_cells = compact.get('sourceCells')
    if review_cells is None:
        with zipfile.ZipFile(source) as archive:
            strings = [''.join(item.itertext()) for item in xml(archive,'xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in archive.namelist() else []
            links = relations(archive, 'xl/workbook.xml')
            review_cells = []
            for item in xml(archive, 'xl/workbook.xml').find('m:sheets',NS):
                for cell in xml(archive,links[item.attrib['{'+NS['r']+'}id']]).findall('m:sheetData/m:row/m:c',NS):
                    value = cell_value(cell, strings)
                    if value is not None:
                        review_cells.append(dict(sheet=item.attrib['name'],cell=cell.attrib['r'],value=value))
    def reject(message):
        raise SourceError('SOURCE_MAPPING_REVIEW_REQUIRED', message, mapping=mapping, sourceCells=review_cells)
    labels = {}
    if overrides is not None:
        if (not isinstance(overrides,dict) or set(overrides) != {'mapping','specLabels','confirm'}
                or overrides['confirm'] is not True or not isinstance(overrides['specLabels'],dict)
                or len(overrides['specLabels']) > 100
                or any(not isinstance(k,str) or not re.fullmatch('[A-Z]{1,3}',k) or not isinstance(v,str) or not 0 < len(v.strip()) <= 200 for k,v in overrides['specLabels'].items())):
            reject('字段核对只允许原单元格映射、规格列标签和明确确认')
        mapping = json.loads(json.dumps(overrides['mapping']))
        if not isinstance(mapping,dict): reject('缺少可核对的原字段映射')
        mapping['needsReview'] = False
        labels = {k:v.strip() for k,v in overrides['specLabels'].items()}

    if not isinstance(mapping,dict) or set(mapping)!=set(('format','fileSha256','sheet','needsReview','reasons','ignoredRows','lines')):
        reject('字段识别结果不完整或包含未允许的业务字段')
    if compact['source']['sha256'] != digest or mapping['fileSha256'] != digest:
        reject('识别结果与原文件来源不一致')
    if mapping['format'] != 'SupplierMappingV1' or type(mapping['needsReview']) is not bool or not isinstance(mapping['reasons'],list):
        reject('字段识别格式不正确')
    if mapping['needsReview']:
        reasons = '；'.join(str(item)[:300] for item in mapping['reasons'][:10])
        reject('采购字段仍需核实：'+reasons)
    sheet_name = mapping['sheet']
    if not isinstance(sheet_name,str) or selected_sheet is not None and sheet_name != selected_sheet:
        reject('识别工作表与选择不一致')
    lines, ignored = mapping['lines'], mapping['ignoredRows']
    if not isinstance(lines,list) or not 0<len(lines)<=10000 or not isinstance(ignored,list):
        reject('没有完整采购明细或明细超过10000行')
    detail = {r['source_row'] for r in compact['rows'] if r['source_sheet']==sheet_name and r['row_kind']=='detail'}
    if not detail:
        reject('所选工作表没有可核实的Docling明细来源')
    with zipfile.ZipFile(source) as archive:
        strings = [''.join(item.itertext()) for item in xml(archive,'xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in archive.namelist() else []
        workbook=xml(archive,'xl/workbook.xml'); links=relations(archive,'xl/workbook.xml')
        sheets=[]
        for item in workbook.find('m:sheets',NS):
            part=links[item.attrib['{'+NS['r']+'}id']]; doc=xml(archive,part)
            sheets.append(dict(name=item.attrib['name'],part=part,document=doc))
        chosen=next((s for s in sheets if s['name']==sheet_name),None)
        if chosen is None: reject('识别工作表不在原文件中')
        raw={c.attrib['r']:c for row in chosen['document'].findall('m:sheetData/m:row',NS) for c in row}
        values={ref:cell_value(cell,strings) for ref,cell in raw.items()}
        output=dict(format='SourceDocumentV1',source=dict(fileSha256=digest,fileName=source.name,bytes=source.stat().st_size,parserVersion='docling-n8n-supplier-v1'),
                    sheets=[],rows=[],images=[],associations=[],warnings=[],errors=[])
        source_rows = {int(re.search('[0-9]+', ref).group()) for ref in raw}
        covered=set(); qty_cells=set(); ignored_source_rows=set()
        for item in ignored:
            if not isinstance(item,dict) or set(item)!=set(('sourceRow','reason')) or type(item['sourceRow']) is not int or item['sourceRow'] not in source_rows or not isinstance(item['reason'],str) or not item['reason'].strip() or item['sourceRow'] in ignored_source_rows:
                reject('被排除明细缺少有效来源或核对原因')
            ignored_source_rows.add(item['sourceRow'])
            if item['sourceRow'] in detail:
                covered.add(item['sourceRow'])
            output['warnings'].append(dict(code='SUPPLIER_ROW_EXCLUDED',sourceSheet=sheet_name,sourceRow=item['sourceRow'],message='识别为非采购明细，请核对：'+item['reason'][:500]))
        ignored_rows=set(covered)
        file_rows = len(detail - ignored_rows)
        output['source']['fileRows'] = file_rows
        progress_event(progress, 'PARSING', 0, file_rows, sheet=sheet_name)
        last_line = {item['sourceRow']: position for position, item in enumerate(lines)
                     if isinstance(item, dict) and type(item.get('sourceRow')) is int}
        completed_rows = set()
        for line_number, line in enumerate(lines):
            if not isinstance(line,dict) or set(line)!=set(('sourceRow','cells')) or type(line['sourceRow']) is not int or line['sourceRow'] not in detail or line['sourceRow'] in ignored_rows or not isinstance(line['cells'],dict) or set(line['cells'])-set(FIELDS):
                reject('采购行来源或字段不正确')
            row_no=line['sourceRow']; covered.add(row_no); mapped=line['cells']; normalized={}; selected={}; formulas={}; numeric={}; cached={}
            for index,field in enumerate(FIELDS):
                refs=mapped.get(field)
                if refs is None:
                    normalized[field]=None
                    continue
                refs=refs if isinstance(refs,list) and field=='productSpec' else [refs]
                if not refs or len(refs)>8 or any(not isinstance(ref,str) or not re.fullmatch('[A-Z]{1,3}[1-9][0-9]{0,6}',ref) or ref not in raw for ref in refs):
                    reject('字段引用不存在的原单元格，不能使用模型生成的数值')
                if field=='purchaseQty':
                    ref=refs[0]
                    if int(re.search('[0-9]+',ref).group())!=row_no or ref in qty_cells:
                        reject('数量单元格与原行不一致或被重复计入')
                    qty_cells.add(ref)
                texts=[values[ref] for ref in refs]
                text=' / '.join(str(t).strip() for t in texts if t is not None and str(t).strip()) if index<3 else texts[0]
                selected[field]=refs if len(refs)>1 else refs[0]
                for ref in refs:
                    column=re.sub('[0-9]','',ref); cell=raw[ref]; formula=cell.find('m:f',NS)
                    if cell.get('t','n')=='n' and values[ref] is not None: numeric[column]=values[ref]
                    if formula is not None:
                        expanded=next((r.get('formulas',{}).get(column) for r in compact['rows'] if r['source_sheet']==sheet_name and r['source_row']==int(re.search('[0-9]+',ref).group())),None)
                        if not expanded and not formula.text: reject('共享公式缺少可追溯展开结果')
                        formulas[column]=expanded or '='+formula.text; cached[column]=values[ref]
                if index<3:
                    normalized[field]=text or None
                elif text is None or text=='':
                    normalized[field]=None
                    if refs[0] in raw and raw[refs[0]].find('m:f',NS) is not None:
                        output['warnings'].append(dict(code='FORMULA_CACHE_MISSING',sourceSheet=sheet_name,sourceRow=row_no,field=field,message='公式无缓存值，待核实'))
                else:
                    try:
                        with localcontext() as context:
                            context.prec=50; value=Decimal(str(text))
                            if not value.is_finite() or value<0 or value>=10**(16 if index==3 else 20): raise InvalidOperation()
                            quantum=Decimal('0.0001' if index==3 else '0.0000000001')
                            if index==3 and (value<=0 or value!=value.quantize(quantum)): raise InvalidOperation()
                            normalized[field]=format(value.quantize(quantum,rounding=ROUND_HALF_UP),'f')
                    except (InvalidOperation,ValueError): reject('原单元格数值或数量精度需要核实')
            # 原行中未参与采购映射的旧公式同样保留，不据其重算当前采购价。
            for ref, cell in raw.items():
                if int(re.search('[0-9]+',ref).group()) != row_no:
                    continue
                column = re.sub('[0-9]','',ref)
                if cell.get('t','n') == 'n' and values[ref] is not None:
                    numeric[column] = values[ref]
                formula = cell.find('m:f',NS)
                if formula is not None:
                    expanded = next((r.get('formulas',{}).get(column) for r in compact['rows'] if r['source_sheet']==sheet_name and r['source_row']==row_no),None)
                    if not expanded and not formula.text:
                        reject('原行共享公式缺少可追溯展开结果')
                    formulas[column] = expanded or '='+formula.text
                    cached[column] = values[ref]
            quantity_column = re.sub('[0-9]','',mapped.get('purchaseQty',''))
            if quantity_column in labels:
                normalized['productSpec'] = labels[quantity_column]
                selected['manualSpecLabel'] = labels[quantity_column]
            if not normalized['productSpec']:
                reject('商品规格仍缺失，请核对数量列的规格名称')
            if not normalized['sourceOrderNo'] or len(normalized['sourceOrderNo'])>100 or normalized['purchaseQty'] is None:
                reject('采购单号或有效采购数量缺失，不能自动补写')
            original={re.sub('[0-9]','',ref):value for ref,value in values.items() if int(re.search('[0-9]+',ref).group())==row_no}
            output['rows'].append(dict(sourceSheet=sheet_name,sourceRow=row_no,sourceItemKey=mapped['purchaseQty'],sourceCells=selected,
                                       originalValues=original,rawNumericTexts=numeric,formulas=formulas,cachedValues=cached,normalizedValues=normalized))
            if last_line[row_no] == line_number:
                completed_rows.add(row_no)
                if len(completed_rows) == 1 or len(completed_rows) % 25 == 0:
                    progress_event(progress, 'PARSING', len(completed_rows), file_rows, sheet=sheet_name, row=row_no)
        if covered!=detail: reject('识别结果遗漏原采购行，未保存不完整采购单')
        progress_event(progress, 'PARSING', file_rows, file_rows, sheet=sheet_name)
        for sheet in sheets:
            output['sheets'].append(dict(name=sheet['name'],role='PURCHASE' if sheet is chosen else 'PARAMETERS'))
        append_sheet_images(archive,chosen,output,{},progress,row_count=file_rows)
        progress_event(progress, 'EXTRACTING_IMAGES', file_rows, file_rows, len(output['images']), len(output['images']), sheet_name)
        return output


def parse_supplier_document(source, output, sheet=None, docling_url='http://127.0.0.1:5001', mapping_overrides=None, progress=None, task_context=None):
    from convert import convert
    from workbench.documents import prepare_document
    validate_archive(source); output.mkdir(parents=True,exist_ok=True)
    progress_event(progress, 'CONVERTING')
    convert(source,output,docling_url)
    compact=prepare_document(source,output)
    with zipfile.ZipFile(source) as archive:
        strings=[''.join(item.itertext()) for item in xml(archive,'xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in archive.namelist() else []
        links=relations(archive,'xl/workbook.xml'); cells=[]
        for item in xml(archive,'xl/workbook.xml').find('m:sheets',NS):
            name=item.attrib['name']
            if sheet is not None and name!=sheet: continue
            doc=xml(archive,links[item.attrib['{'+NS['r']+'}id']])
            for row in doc.findall('m:sheetData/m:row',NS):
                for cell in row:
                    value=cell_value(cell,strings)
                    if value is not None: cells.append(dict(sheet=name,cell=cell.attrib['r'],value=value))
        compact['sourceCells']=cells
    if len(json.dumps(recognition_request(compact,sheet),ensure_ascii=False).encode('utf-8'))>4*1024*1024:
        raise SourceError('SUPPLIER_INPUT_LIMIT','识别内容超过4MiB，请按采购工作表拆分后导入')
    return build_supplier_document(source,compact,recognize_fields(compact,sheet,task_context) if mapping_overrides is None else mapping_overrides.get("mapping"),sheet,overrides=mapping_overrides,progress=progress)
