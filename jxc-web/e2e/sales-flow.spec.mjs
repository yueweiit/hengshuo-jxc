import { test,expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { Evidence,BusinessFailure } from './evidence.mjs';
import { Roles } from './roles.mjs';
import { select,command,approve,formItem } from './pages.mjs';
import { logisticsFlow } from './logistics.mjs';
import { costAndApproval,collectAndShip } from './continued-sales.mjs';
import { returnsAndPayments } from './returns-payment.mjs';
import { completeFinance } from './finance-completion.mjs';

test('隔离MXN销售主链01至34步，逐岗连续执行并保留来源',async({browser})=>{
 const e=new Evidence(),roles=new Roles(browser,e),p=e.prep;
 await roles.verifyAll();if(!e.run.checks.sameSessionSwitch)await roles.switchSameSession();
 e.prep.browserUsed=true;e.save();
 const sales=await roles.get('sales_a');
 await e.step('01','sales_a',sales,async()=>{
  if(e.run.documents.salesOrder)throw Error('已保存销售订单但检查点未完成，请核对单据后恢复，禁止重复保存');
  await sales.goto('http://127.0.0.1:15199/sales/orders');await sales.getByRole('button',{name:'代客录单'}).click();const dialog=sales.getByRole('dialog',{name:'新建销售订单',exact:true});
  await dialog.locator('.el-table__body tr').filter({hasText:'AI09-A-M'}).getByRole('textbox').fill('10');await dialog.getByRole('button',{name:'确认销售订单',exact:true}).click();
  await select(sales,dialog.locator('[data-entry-field="customer"]'),'AI09门店A现款客户');await select(sales,dialog.locator('[data-entry-field="warehouse"]'),'AI09门店A仓');
  await expect(dialog.locator('[data-entry-field="book"]')).toContainText('AI09比索测试账套');await expect(dialog.locator('input[data-entry-field="price"], [data-entry-field="price"] input')).toHaveValue('100.0000');
  await dialog.getByRole('button',{name:'下一步：备注',exact:true}).click();await dialog.getByRole('textbox',{name:'订单备注'}).fill(e.run.id);
  const result=await command(sales,'/sal/orders',()=>dialog.getByRole('button',{name:'保存并提交',exact:true}).click());e.run.documents.salesOrder=result.data;e.save();
  const facts=e.oracle(`SELECT to_jsonb(t) FROM sal_order t WHERE id=${result.data.id}`);if(facts.approval_status!=='PENDING'||Number(facts.total_amount)!==1000)throw new BusinessFailure('销售订单状态或金额不符合预期',facts);return {docNo:result.data.docNo,id:result.data.id,facts};
 });
 const order=e.run.documents.salesOrder,manager=await roles.get('manager_a');
 await e.step('02','manager_a',manager,async()=>{
  const approval=await approve(manager,order.docNo,e.run.id,'INV_INSUFFICIENT_AVAILABLE');
  const facts=e.oracle(`SELECT jsonb_build_object('order',(SELECT to_jsonb(o) FROM sal_order o WHERE id=${order.id}),'tasks',(SELECT jsonb_agg(to_jsonb(t)) FROM wf_task t JOIN wf_instance i ON i.id=t.instance_id WHERE i.doc_id=${order.id} AND i.doc_type='SALES_ORDER'),'stock',(SELECT jsonb_agg(to_jsonb(s)) FROM inv_stock_summary s WHERE warehouse_id=${e.prep.warehouseA} AND product_id=${e.prep.productId}))`);
  if(facts.order.approval_status!=='PENDING'||facts.tasks.some(t=>t.status==='APPROVED'))throw new BusinessFailure('缺货审批拒绝后单据或任务发生错误变更',facts);return {expectedRejection:true,approval,facts};
 });
 const buyer=await roles.get('buyer');
 await e.step('03','buyer',buyer,async()=>{
  await buyer.goto('http://127.0.0.1:15199/inventory/replenishments');
  if(!e.run.documents.replenishment){await buyer.getByRole('button',{name:'手工申请',exact:true}).click();const dialog=buyer.getByRole('dialog',{name:'补货',exact:true});await select(buyer,formItem(dialog,'仓库').locator('.el-select'),'AI09门店A仓');await select(buyer,formItem(dialog,'商品').locator('.el-select'),/AI09-A-M/);await formItem(dialog,'数量').locator('input').fill('10');await formItem(dialog,'原因').locator('input').fill(e.run.id+'；缺货销售单：'+order.docNo);const result=await command(buyer,'/inv/replenishments',()=>dialog.getByRole('button',{name:'确定',exact:true}).click());e.run.documents.replenishment=result.data;e.save();}
  const row=buyer.locator('.el-table__body tr').filter({hasText:e.run.documents.replenishment.docNo});await row.getByRole('button',{name:'处理',exact:true}).click();const dialog=buyer.getByRole('dialog',{name:'补货',exact:true});await select(buyer,formItem(dialog,'来源').locator('.el-select'),'中国采购');await formItem(dialog,'说明').locator('input').fill(e.run.id);await command(buyer,`/inv/replenishments/${e.run.documents.replenishment.id}/decide`,()=>dialog.getByRole('button',{name:'确定',exact:true}).click());return {id:e.run.documents.replenishment.id,docNo:e.run.documents.replenishment.docNo};
 });
 await e.step('04','buyer',buyer,async()=>{
  if(e.run.documents.purchaseOrder)throw Error('采购单已保存，需核对检查点，禁止重复保存');
  await buyer.goto('http://127.0.0.1:15199/purchase/orders');await buyer.getByRole('button',{name:'新建采购单',exact:true}).click();const dialog=buyer.getByRole('dialog',{name:'新建采购单',exact:true});await dialog.locator('.catalog-table .el-table__body tr').filter({hasText:'AI09-A-M'}).getByRole('textbox').fill('10');await dialog.getByRole('button',{name:'确认采购单',exact:true}).click();
  await select(buyer,dialog.locator('[data-entry-field="book"]'),'AI09比索测试账套 · MXN');await select(buyer,dialog.locator('[data-entry-field="supplier"] .el-select'),'AI09中国测试供应商');
  await dialog.locator('input[data-entry-field="price"], [data-entry-field="price"] input').fill('20');await dialog.locator('input[data-entry-field="tax"], [data-entry-field="tax"] input').fill('0');
  await dialog.getByRole('button',{name:'下一步：备注',exact:true}).click();await dialog.getByRole('textbox',{name:'订单备注'}).fill(e.run.id);
  const result=await command(buyer,'/pur/orders',()=>dialog.getByRole('button',{name:'保存并提交',exact:true}).click());e.run.documents.purchaseOrder=result.data;e.save();
  const facts=e.oracle(`SELECT to_jsonb(o) FROM pur_order o WHERE id=${result.data.id}`);if(facts.status!=='PENDING_APPROVAL'||Number(facts.total_amount)!==200||facts.currency!=='CNY')throw new BusinessFailure('采购单金额、币种或审批状态不符',facts);return {id:result.data.id,docNo:result.data.docNo,facts};
 });
 const purchaseManager=await roles.get('purchase_manager');
 await e.step('05','purchase_manager',purchaseManager,async()=>{const approval=await approve(purchaseManager,e.run.documents.purchaseOrder.docNo,e.run.id);const facts=e.oracle(`SELECT to_jsonb(o) FROM pur_order o WHERE id=${e.run.documents.purchaseOrder.id}`);if(facts.status!=='CONFIRMED')throw new BusinessFailure('采购单审核后未确认',facts);return {approval,facts};});
 await e.step('06','buyer',buyer,async()=>{await buyer.goto('http://127.0.0.1:15199/inventory/replenishments');const row=buyer.locator('.el-table__body tr').filter({hasText:e.run.documents.replenishment.docNo});await row.getByRole('button',{name:'关联',exact:true}).click();const dialog=buyer.getByRole('dialog',{name:'补货',exact:true});await select(buyer,formItem(dialog,'执行单').locator('.el-select'),e.run.documents.purchaseOrder.docNo);const result=await command(buyer,`/inv/replenishments/${e.run.documents.replenishment.id}/link`,()=>dialog.getByRole('button',{name:'确定',exact:true}).click());return {result};});
 await logisticsFlow(e,roles);e.snapshot('after-logistics');
 for(const role of ['buyer','purchase_manager','logistics'])await roles.close(role);
 await costAndApproval(e,roles);
 await collectAndShip(e,roles);
 await roles.close('admin');
 await returnsAndPayments(e,roles);
 for(const role of ['sales_a','manager_a','warehouse_a','cashier'])await roles.close(role);
 await completeFinance(e,roles);
 e.snapshot('after');
});
