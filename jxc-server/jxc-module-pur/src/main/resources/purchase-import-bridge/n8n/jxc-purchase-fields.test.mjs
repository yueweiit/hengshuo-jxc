import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const workflow = () => JSON.parse(fs.readFileSync(new URL('./jxc-purchase-fields.json', import.meta.url),'utf8'))
function run(name,input,refs={}) { const code=workflow().nodes.find(n=>n.name===name).parameters.jsCode; return vm.runInNewContext(`(function(){${code}\n})()`,{$input:{first:()=>({json:input})},$:name=>({first:()=>({json:refs[name]})})}) }
const document = {format:'SupplierDocumentV1',fileSha256:'a'.repeat(64),sheet:null,tables:[{source_sheet:'订单',headers:{A:'订单',B:'数量'}}],rows:[{source_sheet:'订单',source_row:2,row_kind:'detail',cells:{A:'PO-1',B:'10'}}]}
const mapping = {format:'SupplierMappingV1',fileSha256:'a'.repeat(64),sheet:'订单',needsReview:false,reasons:[],ignoredRows:[],lines:[{sourceRow:2,cells:{sourceOrderNo:'A2',purchaseQty:'B2'}}]}
test('字段工作流拒绝凭证或调用方地址进入模型输入',()=>{
  const prepared=run('Validate document',{body:document})[0].json
  assert.equal(prepared.prompt.messages[1].content,JSON.stringify(document))
  assert.throws(()=>run('Validate document',{body:{...document,credential:'secret'}}))
  assert.throws(()=>run('Validate document',{body:{...document,url:'http://example.com'}}))
})
test('模型只能输出原单元格映射，真实字段结果可返回',()=>{
  const result=run('Validate mapping',{statusCode:200,body:{choices:[{message:{content:JSON.stringify(mapping)}}]}},{'Validate document':{document}})[0].json
  assert.equal(result.status,'ok');assert.equal(result.mapping.lines[0].cells.purchaseQty,'B2')
})
test('模型编造数字或商品ID明确失败',()=>{
  for(const altered of [{...mapping,productId:999},{...mapping,lines:[{sourceRow:2,cells:{purchaseQty:'999'}}]}]) {
    const result=run('Validate mapping',{statusCode:200,body:{choices:[{message:{content:JSON.stringify(altered)}}]}},{'Validate document':{document}})[0].json
    assert.equal(result.status,'error')
  }
})
test('模型服务失败或坏JSON不会伪装成空明细成功',()=>{
  for(const reply of [{statusCode:503},{statusCode:200,body:{choices:[{message:{content:'broken'}}]}}]) {
    const result=run('Validate mapping',reply,{'Validate document':{document}})[0].json
    assert.equal(result.status,'error');assert.ok(result.message)
  }
})
