import type { ImportField, ImportRow, ImportSource } from './purchaseImportModel'
export interface SourceReviewContext {
  format: 'SourceReviewContextV1'; imageCount: number
  columns: { key: string; header: string; examples: string[]; fields: string[] }[]
  subjects: { id: string; kind: 'IDENTIFIER' | 'PHOTO' | 'USD_AMOUNT' | 'FREIGHT'; label: string; examples: string[] }[]
}
export interface SourceReviewSheet { name: string; role: string; reviewContext?: SourceReviewContext; reviewAnswers?: Record<string, { meaning: string }> }
export interface ReviewQuestion {
  id: string; sourceId: number; fileSha256: string; fileName: string; field: ImportField; label: string; prompt: string
  note?: string; groups?: {key:string;header:string;examples:string[]}[]
  subject?: {id:string;kind:string;label:string;previousMeaning:string|null;choices:{value:string;label:string}[]}
  rows: Pick<ImportRow, 'id' | 'version' | 'rowNo' | 'sourceRow' | 'sourceItemKey' | 'sourceOrderNo'>[]
}
export interface ReviewProposal {
  batchId: string; batchVersion: number; sourceId: number; fileSha256: string; confirm: true
  changes: { rowId: number; version: number; values: Partial<Record<ImportField, string>> }[]
  interpretation?: {subjectId:string;meaning:string;previousMeaning:string|null}
}
const meaningChoices = {
  IDENTIFIER:[{value:'ORDER_NUMBER',label:'本文件采购单号'},{value:'PRODUCT_CODE',label:'商品款号或货号'},{value:'OTHER',label:'其他编号或含义'}],
  PHOTO:[{value:'PRODUCT_PHOTOS',label:'是商品照片'},{value:'OTHER',label:'其他图片或用途'}],
  USD_AMOUNT:[{value:'USD_AMOUNT',label:'是，这一列以美元计价'},{value:'OTHER',label:'不是，需要另行核对'}],
  FREIGHT:[{value:'ORDER_ONCE',label:'整单运费，只计一次'},{value:'PER_PRODUCT',label:'每个商品一笔'},{value:'PER_UNIT',label:'每件一笔'},{value:'OTHER',label:'其他含义'}],
}
function semanticQuestions(rows:ImportRow[],sources:ImportSource[],includeAnswered:boolean):ReviewQuestion[]{
  const out:ReviewQuestion[]=[]
  for(const source of sources){
    const selected=rows.filter(r=>r.sourceId===source.id)
    if(!selected.length||selected.some(r=>r.targetOrderLineId))continue
    for(const sheet of source.sheets??[]){
      const ctx=sheet.reviewContext;if(!ctx)continue
      if(ctx.format!=='SourceReviewContextV1'||!Array.isArray(ctx.columns)||!Array.isArray(ctx.subjects))throw new Error('原表核对依据不完整，请重新读取')
      for(const item of ctx.subjects){
        const previousMeaning=sheet.reviewAnswers?.[item.id]?.meaning??null;if(previousMeaning&&!includeAnswered)continue
        const examples=item.examples.map(v=>`“${v}”`).join('、')||'待核对'
        const base={id:`${source.id}:meaning:${sheet.name}:${item.id}`,sourceId:source.id,fileSha256:source.fileSha256,fileName:source.fileName,
          rows:selected.map(r=>({id:r.id,version:r.version,rowNo:r.rowNo,sourceRow:r.sourceRow,sourceItemKey:r.sourceItemKey,sourceOrderNo:r.sourceOrderNo})),
          subject:{id:`${sheet.name}:${item.id}`,kind:item.kind,label:item.label,previousMeaning,choices:meaningChoices[item.kind]}}
        if(item.kind==='IDENTIFIER')out.push({...base,field:'sourceOrderNo',label:`“${item.label}”的含义`,prompt:`原表中的“${item.label}”表示什么？它是否是本文件所有明细使用的采购单号？`,note:'确认是采购单号后，仅补充本文件尚未填写的单号；已有值保留。'})
        else if(item.kind==='PHOTO')out.push({...base,field:'photo',label:`“${item.label}”的含义`,prompt:`原表有“${item.label}”这一栏，文件中识别到 ${ctx.imageCount} 张嵌入图片。这一栏表示商品照片吗？`,note:'这里只确认图片用途，每张图的商品归属与发布图库仍需分别核对。'})
        else if(item.kind==='USD_AMOUNT')out.push({...base,field:'usdUnitCost',label:`“${item.label}”的币种`,prompt:`原列名为“${item.label}”，数值示例为 ${examples}。这里是否表示这一列金额以美元计价？`,note:'只确认这一列的币种，不会自动选择账套、修改账套基础币种或采购币种，也不会自动换汇。'})
        else if(item.kind==='FREIGHT')out.push({...base,field:'freight',label:`“${item.label}”的范围`,prompt:`原列“${item.label}”的数值示例为 ${examples}。这笔费用是整单一次、每个商品一笔，还是每件一笔？`,note:'先记录费用含义，不会直接登记费用或分摊成本。'})
      }
    }
  }
  return out
}
/** 问题来自已暂存的缺项；文件/数量列只是明确展示的补充范围，不推测业务值。 */
export function reviewQuestions(rows: ImportRow[], sources: ImportSource[], includeAnswered=false): ReviewQuestion[] {
  const groups = new Map<string, ReviewQuestion>()
  const semantic=semanticQuestions(rows,sources,includeAnswered)
  for (const row of rows) {
    if (row.targetOrderLineId) continue
    const source = sources.find(item => item.id === row.sourceId)
    if (!source || !/^[a-f0-9]{64}$/i.test(source.fileSha256)) continue
    const ctx=source.sheets?.find(s=>s.name===row.sourceSheet)?.reviewContext??source.sheets?.find(s=>s.role==='PURCHASE')?.reviewContext
    for (const [field, label] of [['sourceOrderNo', '采购单号'], ['productSpec', '商品规格'], ['purchaseQty', '采购数量'], ['purchaseUnitPrice', '采购单价']] as const) {
      if (row[field] !== null) continue
      if(field==='sourceOrderNo'&&semantic.some(q=>q.sourceId===source.id&&q.subject?.kind==='IDENTIFIER'&&!q.subject.previousMeaning))continue
      const column = row.sourceItemKey?.match(/^([A-Z]+)[0-9]+$/)?.[1]
      const scope = field === 'sourceOrderNo' ? 'file' : field === 'productSpec' && column ? `${row.sourceSheet}:columns` : String(row.id)
      const id = `${source.id}:${field}:${scope}`
      const evidence=ctx?.columns.find(c=>c.fields.includes(field))
      if (!groups.has(id)) groups.set(id, { id, sourceId: source.id, fileSha256: source.fileSha256, fileName: source.fileName, field, label, rows: [], groups:field==='productSpec'&&column?[]:undefined,
        prompt:evidence?`原列“${evidence.header}”的数值示例为 ${evidence.examples.map(v=>`“${v}”`).join('、')||'空白'}。请核对本次应填写的${label}。`:`本文件的${label}尚未明确，请填写已核实的内容，也可以稍后继续。` })
      const question = groups.get(id)!
      if (column && question.groups && !question.groups.some(g=>g.key===column)) {const original=ctx?.columns.find(c=>c.key===column);question.groups!.push({key:column,header:original?.header??'数量组',examples:original?.examples??(row.purchaseQty===null?[]:[row.purchaseQty])})}
      question.rows.push({ id: row.id, version: row.version, rowNo: row.rowNo, sourceRow: row.sourceRow, sourceItemKey: row.sourceItemKey,sourceOrderNo:row.sourceOrderNo })
    }
  }
  return [...semantic,...[...groups.values()].map(q => {
    if(q.groups?.length)q.prompt=`原表${q.groups.map((g,i)=>`“${g.header}”第${i+1}组（数量示例 ${g.examples.join('、')||'待核对'}）`).join('、')}分别对应什么商品规格？请在各组下填写规格名称。`
    return q
  })]
}
function explicitValue(value: string, label: string, maximum: number): string {
  if (!value || /^(好的?|确认|是的?|可以|都可以|随便|无所谓|同上|一样|不知道|不确定|跳过|待核[对实])$/.test(value) || /[\n;；]/.test(value)) throw new Error(`请明确填写${label}；不同值请分开核对`)
  if (value.length > maximum) throw new Error('回答过长，请填写明确的字段值')
  return value
}
export function reviewProposal(batchId: string, batchVersion: number, question: ReviewQuestion, answer: string|Record<string,string>): ReviewProposal {
  const base={batchId,batchVersion,sourceId:question.sourceId,fileSha256:question.fileSha256,confirm:true as const}
  if(question.subject){
    const selected=question.subject.choices.find(c=>typeof answer==='string'&&(c.value===answer||c.label===answer.trim()))
    if(!selected)throw new Error('这句话的含义还不明确，请选择符合原表的选项，或稍后核对')
    return {...base,interpretation:{subjectId:question.subject.id,meaning:selected.value,previousMeaning:question.subject.previousMeaning},changes:selected.value==='ORDER_NUMBER'?question.rows.filter(r=>r.sourceOrderNo===null).map(r=>({rowId:r.id,version:r.version,values:{sourceOrderNo:question.subject!.label}})):[]}
  }
  if(question.groups?.length){
    if(typeof answer==='string')throw new Error('请对照原列名和数量示例逐组填写规格名称，不需要输入列字母或等式')
    if(Object.keys(answer).length!==question.groups.length)throw new Error('请逐组填写所有待确认的规格名称')
    const values=new Map(question.groups.map(g=>[g.key,explicitValue((answer[g.key]??'').trim(),g.header,1000)]))
    return {...base,changes:question.rows.map(r=>({rowId:r.id,version:r.version,values:{productSpec:values.get(r.sourceItemKey!.match(/^([A-Z]+)[0-9]+$/)![1]!)!}}))}
  }
  if(typeof answer!=='string')throw new Error('请明确填写本次字段的值')
  const value = answer.trim().replace(/^(?:采购单号|采购单价|商品规格|采购数量|单号|规格|数量|单价)\s*(?:是|为|[:：])\s*/, '').trim()
  explicitValue(value, question.label, question.field === 'sourceOrderNo' ? 100 : 1000)
  if (['purchaseQty','purchaseUnitPrice'].includes(question.field) && !/^\d+(\.\d+)?$/.test(value)) throw new Error(`请明确填写${question.label}的数字，不确定时可稍后核对`)
  return { batchId, batchVersion, sourceId: question.sourceId, fileSha256: question.fileSha256, confirm: true,
    changes: question.rows.map(row => ({ rowId: row.id, version: row.version, values: { [question.field]: value } })) }
}
export function reviewProposalCurrent(p: ReviewProposal, batchId: string | null, version: number, rows: ImportRow[], sources: ImportSource[]): boolean {
  return p.batchId === batchId && p.batchVersion === version && sources.some(s => s.id === p.sourceId && s.fileSha256 === p.fileSha256)
    && p.changes.every(c => rows.some(r => r.id === c.rowId && r.version === c.version && r.sourceId === p.sourceId && !r.targetOrderLineId && Object.keys(c.values).every(k => r[k as ImportField] === null)))
}
