import {test,expect} from '@playwright/test';
import {Evidence} from './evidence.mjs';
import {Roles} from './roles.mjs';
import {verifyDownload,verifyObject} from './attachments.mjs';
import {save} from './preflight.mjs';
import {join} from 'node:path';

test('仅核对已有SVG留档及重登下载，不重新提交业务',async({browser})=>{
 const e=new Evidence(),roles=new Roles(browser,e);
 const business=()=>e.oracle("SELECT jsonb_build_object('outbounds',(SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'version',version) ORDER BY id) FROM sal_outbound WHERE book_id=6),'stock',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM inv_stock_summary s WHERE country_id=3),'vouchers',(SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'version',version) ORDER BY id) FROM fin_voucher WHERE book_id=6),'period',(SELECT to_jsonb(p) FROM fin_period p WHERE id=18))"),before=business();
 for(const attachment of e.run.attachments){
  const page=await roles.get(attachment.role);await page.goto('http://127.0.0.1:15199/');await roles.relogin(attachment.role);let root;
  const fresh=e.oracle(`SELECT jsonb_build_object('attachment',(SELECT to_jsonb(a) FROM sys_attachment a WHERE id=${attachment.id}),'links',(SELECT jsonb_agg(to_jsonb(l)) FROM sys_attachment_link l WHERE attachment_id=${attachment.id}))`);expect(fresh.attachment.status).toBe('VALID');expect(fresh.attachment.object_status).toBe('AVAILABLE');expect(fresh.attachment.sha256).toBe(attachment.sourceSha256);expect(fresh.links.some(l=>l.biz_type===attachment.bizType&&l.biz_id===attachment.bizId&&l.unlinked_at===null)).toBe(true);attachment.metadata=fresh;verifyObject(e,attachment);
  if(attachment.bizType==='SAL_ORDER'){
   await page.goto('http://127.0.0.1:15199/sales/orders/'+attachment.bizId);const label=attachment.category==='SALES_DOC'?'销售单据':'收款凭证';await page.getByRole('tab',{name:label,exact:true}).click();root=page.getByRole('tabpanel',{name:label,exact:true}).locator('.doc-attachment');
  }else if(attachment.bizType==='AR_RECEIPT'){
   await page.goto('http://127.0.0.1:15199/ar/receipts');await page.locator('.el-table__body tr').filter({hasText:e.run.documents.customerReceipt.docNo}).getByRole('button',{name:'凭证',exact:true}).click();root=page.getByRole('dialog',{name:'转账凭证',exact:true}).locator('.doc-attachment');
  }else if(attachment.bizType==='REFUND'){
   await page.goto('http://127.0.0.1:15199/returns/refunds?sourceId='+attachment.bizId);root=page.getByRole('dialog',{name:'退款详情',exact:true}).locator('.doc-attachment');
  }else if(attachment.bizType==='AP_PAYMENT'){
   await page.goto('http://127.0.0.1:15199/ap/payments?sourceId='+attachment.bizId);const dialog=page.getByRole('dialog',{name:'付款凭证',exact:true});await expect(dialog).toContainText(e.run.documents.supplierPayment.docNo);root=dialog.locator('.doc-attachment');await expect(root.locator('input[type=file]')).toHaveCount(0);
  }else throw Error('Unexpected attachment business type');
  await verifyDownload(e,page,root,attachment);attachment.persistedAfterRelogin=true;e.save();await e.shot(page,'attachment-'+attachment.id+'-'+attachment.role);await roles.close(attachment.role);
 }
 const after=business();expect(after).toEqual(before);e.run.checks.attachmentPersistence={status:'PASS',ids:e.run.attachments.map(a=>a.id),reloginPassed:e.run.attachments.filter(a=>a.persistedAfterRelogin).map(a=>a.id),businessUnchanged:true};e.save();save(join(e.dir,'attachments-persistence.json'),e.run.checks.attachmentPersistence);
 expect(e.run.attachments.every(a=>a.persistedAfterRelogin&&a.downloadSha256===a.sourceSha256)).toBe(true);
});
