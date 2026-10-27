import {expect} from '@playwright/test';
import {BusinessFailure} from './evidence.mjs';
import {command,select,approve,formItem} from './pages.mjs';
import {uploadSVG} from './attachments.mjs';

export async function returnsAndPayments(e,roles){
 const sales=await roles.get('sales_a');
 await e.step('25','sales_a',sales,async()=>{
  if(e.run.documents.salesReturn)throw Error('退货单已创建，请核对状态，禁止重建');
  await sales.goto('http://127.0.0.1:15199/returns/sales');await sales.getByRole('button',{name:'申请退货',exact:true}).click();const d=sales.getByRole('dialog',{name:'销售退货',exact:true});await select(sales,formItem(d,'出库单').locator('.el-select'),new RegExp(e.run.documents.outbound6.docNo));await select(sales,formItem(d,'退回仓').locator('.el-select'),'AI09门店A仓');await select(sales,formItem(d,'原因').locator('.el-select'),'客户原因');await select(sales,formItem(d,'责任方').locator('.el-select'),'客户');await d.getByRole('spinbutton').fill('1');const result=await command(sales,'/rtn/sales',()=>d.getByRole('button',{name:'提交',exact:true}).click());e.run.documents.salesReturn=result.data;e.save();return {docNo:result.data.docNo,result};
 });
 const manager=await roles.get('manager_a'),accountant=await roles.get('accountant'),rt=e.run.documents.salesReturn;
 await e.step('26','manager_a/accountant',manager,async()=>{
  const tasks=e.oracle(`SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM wf_task t JOIN wf_instance i ON i.id=t.instance_id WHERE i.doc_type='SALES_RETURN' AND i.doc_id=${rt.id}`);
  if(!tasks.some(t=>t.assignee_id===70&&t.status==='APPROVED'))await approve(manager,rt.docNo,e.run.id);
  const afterFirst=e.oracle(`SELECT to_jsonb(r) FROM rtn_sales_return r WHERE id=${rt.id}`);if(afterFirst.status==='PENDING_APPROVAL')await approve(accountant,rt.docNo,e.run.id);
  const facts=e.oracle(`SELECT jsonb_build_object('return',(SELECT to_jsonb(r) FROM rtn_sales_return r WHERE id=${rt.id}),'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY node_seq) FROM wf_task t JOIN wf_instance i ON i.id=t.instance_id WHERE i.doc_type='SALES_RETURN' AND i.doc_id=${rt.id}))`);if(facts.return.status!=='PENDING_RECEIPT'||facts.tasks.length!==2||facts.tasks[0].acted_by!==70||facts.tasks[1].acted_by!==110)throw new BusinessFailure('退货审批顺序或身份不符',facts);return {facts};
 });
 const warehouse=await roles.get('warehouse_a');
 const openReturn=async page=>{await page.goto('http://127.0.0.1:15199/returns/sales');await page.locator('.el-table__body tr').filter({hasText:rt.docNo}).getByRole('button',{name:'处理',exact:true}).click();return page.getByRole('dialog',{name:rt.docNo,exact:true});};
 await e.step('27','warehouse_a',warehouse,async()=>{
  const d=await openReturn(warehouse);let state=e.oracle(`SELECT to_jsonb(r) FROM rtn_sales_return r WHERE id=${rt.id}`);
  if(state.status==='PENDING_RECEIPT'){await d.getByRole('spinbutton').nth(0).fill('1');await command(warehouse,`/rtn/sales/${rt.id}/receive`,()=>d.getByRole('button',{name:'确认实收',exact:true}).click());}
  state=e.oracle(`SELECT to_jsonb(r) FROM rtn_sales_return r WHERE id=${rt.id}`);
  if(state.status==='PENDING_INSPECT'){await d.getByRole('spinbutton').nth(1).fill('1');await d.getByRole('spinbutton').nth(2).fill('0');await command(warehouse,`/rtn/sales/${rt.id}/inspect`,()=>d.getByRole('button',{name:'验货入库',exact:true}).click());}
  const facts=e.oracle(`SELECT jsonb_build_object('return',(SELECT to_jsonb(r) FROM rtn_sales_return r WHERE id=${rt.id}),'stock',(SELECT to_jsonb(s) FROM inv_stock_summary s WHERE warehouse_id=26 AND product_id=132))`);if(facts.return.status!=='PENDING_SETTLE'||Number(facts.stock.on_hand_qty)!==1||Number(facts.stock.reserved_qty)!==0||Number(facts.stock.frozen_qty)!==0)throw new BusinessFailure('退货验货库存或状态不符',facts);return {facts};
 });
 await e.step('28','accountant',accountant,async()=>{const d=await openReturn(accountant);if(e.oracle(`SELECT to_jsonb(r) FROM rtn_sales_return r WHERE id=${rt.id}`).status!=='COMPLETED')await command(accountant,`/rtn/sales/${rt.id}/settle`,()=>d.getByRole('button',{name:'处理账款',exact:true}).click());const facts=e.oracle(`SELECT to_jsonb(r) FROM rtn_sales_settlement r WHERE return_id=${rt.id}`);if(facts.status!=='EFFECTIVE'||Number(facts.total_amount)!==100||Number(facts.refundable_amount)!==100||Number(facts.ar_offset_amount)!==0)throw new BusinessFailure('退货账款结果不符',facts);return {facts};});
 const cashier=await roles.get('cashier'),reviewer=await roles.get('fin_reviewer');
 await e.step('29','cashier/fin_reviewer',cashier,async()=>{
  await cashier.goto('http://127.0.0.1:15199/returns/refunds');
  if(!e.run.documents.refund){await cashier.getByRole('button',{name:'申请退款',exact:true}).click();const d=cashier.getByRole('dialog',{name:'申请退款',exact:true});await select(cashier,formItem(d,'客户').locator('.el-select'),'AI09门店A现款客户');await formItem(d,'金额').locator('input').fill('100');await select(cashier,formItem(d,'账户').locator('.el-select'),'AI09主体比索银行');await formItem(d,'收款人').locator('input').fill('AI09测试客户A');await formItem(d,'收款账户').locator('input').fill('TEST-AI09-CUSTOMER-A');const result=await command(cashier,'/rtn/refunds',()=>d.getByRole('button',{name:'提交审批',exact:true}).click());e.run.documents.refund=result.data;e.save();}
  const refund=e.run.documents.refund;let state=e.oracle(`SELECT to_jsonb(r) FROM rtn_refund r WHERE id=${refund.id}`);if(state.status==='PENDING_APPROVAL')await approve(reviewer,refund.docNo,e.run.id);
  await cashier.goto('http://127.0.0.1:15199/returns/refunds');await cashier.locator('.el-table__body tr').filter({hasText:refund.docNo}).getByRole('button',{name:'登记支付',exact:true}).click();const d=cashier.getByRole('dialog',{name:'登记退款支付',exact:true});await formItem(d,'实际支付日').locator('input').fill(e.prep.date);await formItem(d,'参考号').locator('input').fill(e.run.id+'-REFUND');await uploadSVG(e,cashier,d.locator('.doc-attachment'),{role:'cashier',bizType:'REFUND',bizId:refund.id,category:'REFUND_PROOF',docNo:refund.docNo,amount:'MXN 100.00',kind:'Customer refund'});await command(cashier,`/rtn/refunds/${refund.id}/pay`,()=>d.getByRole('button',{name:'确认支付',exact:true}).click());state=e.oracle(`SELECT to_jsonb(r) FROM rtn_refund r WHERE id=${refund.id}`);if(state.status!=='PAID')throw new BusinessFailure('退款未支付',state);return {docNo:refund.docNo,facts:state};
 });
 await e.step('30','cashier',cashier,async()=>{
  await cashier.goto('http://127.0.0.1:15199/ap/payments');
  if(!e.run.documents.supplierPayment){await cashier.getByRole('button',{name:'登记付款',exact:true}).click();const d=cashier.getByRole('dialog',{name:'登记付款',exact:true});await select(cashier,formItem(d,'往来对象').locator('.el-select'),'AI09中国测试供应商');await formItem(d,'金额').locator('input').fill('500');await select(cashier,formItem(d,'账户').locator('.el-select'),'AI09主体比索银行');await formItem(d,'参考号').locator('input').fill(e.run.id+'-SUP');const result=await command(cashier,'/ap/payments',()=>d.getByRole('button',{name:'保存',exact:true}).click());e.run.documents.supplierPayment=result.data;e.save();}
  const payment=e.run.documents.supplierPayment;await cashier.locator('.el-table__body tr').filter({hasText:payment.docNo}).getByRole('button',{name:'确认',exact:true}).click();const d=cashier.getByRole('dialog',{name:'确认付款',exact:true});await uploadSVG(e,cashier,d.locator('.doc-attachment'),{role:'cashier',bizType:'AP_PAYMENT',bizId:payment.id,category:'PAYMENT_OUT_PROOF',docNo:payment.docNo,amount:'MXN 500.00',kind:'Supplier bank payment'});const result=await command(cashier,`/ap/payments/${payment.id}/confirm`,()=>d.getByRole('button',{name:'确认付款',exact:true}).click());return {docNo:payment.docNo,result};
 });
 await e.step('31','accountant',accountant,async()=>{
  if(e.run.documents.apSettlement)throw Error('核销已保存，需核对检查点，禁止重复提交');await accountant.goto('http://127.0.0.1:15199/ap/settlements');await accountant.getByRole('button',{name:'核销',exact:true}).click();const d=accountant.getByRole('dialog',{name:'核销应付',exact:true});await select(accountant,formItem(d,'往来对象').locator('.el-select'),'AI09中国测试供应商');await select(accountant,formItem(d,'来源单').locator('.el-select'),new RegExp(e.run.documents.supplierPayment.docNo));await select(accountant,formItem(d,'账单').locator('.el-select'),new RegExp(e.run.documents.apBill.docNo));await formItem(d,'账单金额').locator('input').fill('200');await formItem(d,'实际结算汇率').locator('input').fill('0.4');await formItem(d,'实际结算汇率').locator('input').blur();await expect(formItem(d,'换算预览')).toContainText('来源消耗 500.00；汇兑差额 0.00');const result=await command(accountant,'/ap/settlements',()=>d.getByRole('button',{name:'确认',exact:true}).click());e.run.documents.apSettlement=result.data;e.save();return {docNo:result.data.docNo,result};
 });
}
