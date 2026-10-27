import { test,expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { Evidence } from './evidence.mjs';
import { Roles } from './roles.mjs';
import { save } from './preflight.mjs';
import { join } from 'node:path';

test('连续链完成后只读核对门店与仓库范围，不重试确认',async({browser})=>{
 const e=new Evidence(),roles=new Roles(browser,e),results=[];
 assert.equal(e.run.status,'PASSED','先完成同run原34步，不借用旧失败状态');
 const facts=()=>e.oracle("SELECT jsonb_build_object('stockTransactions',(SELECT count(*) FROM inv_stock_txn),'stock',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM inv_stock_summary s),'orders',(SELECT jsonb_agg(jsonb_build_object('id',id,'approval',approval_status,'fulfillment',fulfillment_status,'payment',payment_status,'version',version) ORDER BY id) FROM sal_order),'receipts',(SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'version',version) ORDER BY id) FROM lgs_receipt),'vouchers',(SELECT count(*) FROM fin_voucher))");
 const before=facts();
 const read=async(role,path,apiPath,status)=>{const page=await roles.get(role);const responsePromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1'+apiPath&&r.request().method()==='GET');await page.goto('http://127.0.0.1:15199'+path);const response=await responsePromise,body=await response.json();assert.equal(response.status(),status);assert.equal(body.code,status===200?'OK':'NOT_FOUND');await expect(page.locator('.header')).toContainText(e.run.checks['login:'+role].displayName);results.push({role,path,httpStatus:response.status(),code:body.code,returnedId:body.data?.id,screenshot:await e.shot(page,'scope-'+role)});};
 const orderId=e.run.documents.salesOrder.id,receiptId=e.run.documents.warehouseReceipt.id;
 await read('sales_a','/sales/orders/'+orderId,'/sal/orders/'+orderId,200);
 await read('sales_b','/sales/orders/'+orderId,'/sal/orders/'+orderId,404);
 await read('warehouse_a','/logistics/receipts/'+receiptId,'/lgs/receipts/'+receiptId,200);
 await read('warehouse_b','/logistics/receipts/'+receiptId,'/lgs/receipts/'+receiptId,404);
 const after=facts();assert.deepEqual(after,before);
 e.run.checks.N03={status:'PASS',meaning:'A/B门店销售单及A/B仓实收单读取隔离；同会话换岗见sameSessionSwitch',results};e.save();save(join(e.dir,'access-inspection.json'),{status:'ok',readOnlyBusiness:true,results,before,after});
});
