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


def source_review_context(compact, sheet_name, values, mapping, images):
    """保留可向人展示的原文依据；坐标是内部身份，不是要求用户输入的业务语言。"""
    tables=[t for t in compact['tables'] if t['source_sheet']==sheet_name]
    headers={k:' '.join(str(v).split()) for t in tables for k,v in t.get('headers',{}).items() if v is not None}
    detail=sorted({r['source_row'] for r in compact['rows'] if r['source_sheet']==sheet_name and r['row_kind']=='detail'})
    fields={key:set() for key in headers}
    for line in mapping['lines']:
        for field, refs in line.get('cells',{}).items():
            for ref in refs if isinstance(refs,list) else [refs]:
                if isinstance(ref,str) and re.fullmatch('[A-Z]{1,3}[1-9][0-9]*',ref):
                    column=re.sub('[0-9]','',ref)
                    if column in fields: fields[column].add(field)
    columns=[]
    for column,header in headers.items():
        examples=[]
        for row in detail:
            value=values.get(column+str(row))
            if value is not None and str(value).strip() and str(value) not in examples: examples.append(str(value))
            if len(examples)==3: break
        columns.append(dict(key=column,header=header,examples=examples,fields=sorted(fields[column])))
    subjects=[]
    for ref,value in values.items():
        if value is None or not detail or int(re.search('[0-9]+',ref).group())>=detail[0]: continue
        text=str(value).strip()
        if text not in headers.values() and re.fullmatch(r'[\w./-]{3,100}',text) and re.search(r'\d',text):
            subjects.append(dict(id='title:'+ref,kind='IDENTIFIER',label=text,examples=[text]))
    for col in columns:
        label=col['header']; common=dict(id='column:'+col['key'],label=label,examples=col['examples'])
        if re.search(r'foto|photo|照片|图片',label,re.I) and images:
            subjects.append(dict(common,kind='PHOTO'))
        elif re.search(r'\busd\b|美元',label,re.I):
            subjects.append(dict(common,kind='USD_AMOUNT'))
        elif 'freight' in col['fields'] or re.search(r'flete|freight|运费',label,re.I):
            subjects.append(dict(common,kind='FREIGHT'))
    return dict(format='SourceReviewContextV1',columns=columns,subjects=subjects[:30],imageCount=len(images))


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
    diagnostics=[]
    def reject(message):
        raise SourceError('SOURCE_MAPPING_REVIEW_REQUIRED', message, mapping=mapping, sourceCells=review_cells, warnings=diagnostics)
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
        # 业务歧义不阻止读取可靠来源；写入统一warnings后由原页面逐项核对。
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
                    sheets=[],rows=[],images=[],associations=[],warnings=diagnostics,errors=[])
        if mapping['needsReview']:
            output['warnings'].append(dict(code='SOURCE_REVIEW_REQUIRED', message='采购字段待核对：'+reasons))
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
            skip_line=False
            def issue(code, field, message):
                output['warnings'].append(dict(code=code,sourceSheet=sheet_name,sourceRow=row_no,sourceItemKey=mapped.get('purchaseQty'),field=field,message=message))
            for index,field in enumerate(FIELDS):
                refs=mapped.get(field)
                if refs is None:
                    normalized[field]=None
                    continue
                refs=refs if isinstance(refs,list) and field=='productSpec' else [refs]
                if not refs or len(refs)>8 or any(not isinstance(ref,str) or not re.fullmatch('[A-Z]{1,3}[1-9][0-9]{0,6}',ref) or ref not in raw for ref in refs):
                    normalized[field]=None
                    issue('FIELD_SOURCE_INVALID',field,'原单元格无法定位，本字段未导入；请核对来源')
                    if field=='purchaseQty': skip_line=True; break
                    continue
                if field=='purchaseQty':
                    ref=refs[0]
                    if int(re.search('[0-9]+',ref).group())!=row_no or ref in qty_cells:
                        issue('ROW_NOT_STAGED',field,'数量来源与原行不一致或重复，本候选未导入')
                        skip_line=True; break
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
                    except (InvalidOperation,ValueError):
                        normalized[field]=None
                        issue('FIELD_VALUE_INVALID',field,'原数值或精度无效，已保留原格原文，业务字段待核对')
            if skip_line:
                if not output['warnings'] or output['warnings'][-1]['code']!='ROW_NOT_STAGED':
                    issue('ROW_NOT_STAGED','purchaseQty','数量来源无法定位，本候选未导入')
                continue
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
            if normalized['productSpec'] and normalized['productSpec'].strip().lower() in {'talla','size','规格','尺码','商品规格'}:
                normalized['productSpec']=None
            if normalized['sourceOrderNo'] and len(normalized['sourceOrderNo'])>100:
                normalized['sourceOrderNo']=None
            for field in ('sourceOrderNo','productSpec','purchaseQty'):
                if normalized[field] is None: issue('FIELD_REVIEW_REQUIRED',field,'本字段待核对，未补造默认值')
            item_key=mapped.get('purchaseQty') or 'ROW:'+str(row_no)
            if any(r['sourceItemKey']==item_key for r in output['rows']):
                issue('ROW_NOT_STAGED','purchaseQty','同一来源候选重复，本候选未导入'); continue
            original={re.sub('[0-9]','',ref):value for ref,value in values.items() if int(re.search('[0-9]+',ref).group())==row_no}
            output['rows'].append(dict(sourceSheet=sheet_name,sourceRow=row_no,sourceItemKey=item_key,sourceCells=selected,
                                       originalValues=original,rawNumericTexts=numeric,formulas=formulas,cachedValues=cached,normalizedValues=normalized))
            if last_line[row_no] == line_number:
                completed_rows.add(row_no)
                if len(completed_rows) == 1 or len(completed_rows) % 25 == 0:
                    progress_event(progress, 'PARSING', len(completed_rows), file_rows, sheet=sheet_name, row=row_no)
        for omitted in sorted(detail-covered):
            output['warnings'].append(dict(code='ROW_NOT_STAGED',sourceSheet=sheet_name,sourceRow=omitted,message='本原始行未获可靠字段映射，候选未导入，请核对原文件'))
        if not output['rows']: reject('没有可核实来源的明细可暂存，请核对原列；候选问题已保留')
        progress_event(progress, 'PARSING', file_rows, file_rows, sheet=sheet_name)
        for sheet in sheets:
            output['sheets'].append(dict(name=sheet['name'],role='PURCHASE' if sheet is chosen else 'PARAMETERS'))
        append_sheet_images(archive,chosen,output,{},progress,row_count=file_rows)
        context=source_review_context(compact,sheet_name,values,mapping,output['images'])
        next(item for item in output['sheets'] if item['role']=='PURCHASE')['reviewContext']=context
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
