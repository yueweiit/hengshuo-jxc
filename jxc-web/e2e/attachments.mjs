import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {expect} from '@playwright/test';
import {svgEvidence} from './core.mjs';
import {sha,configuration,sourceRoot} from './preflight.mjs';
import {command} from './pages.mjs';
import {BusinessFailure} from './evidence.mjs';

export function verifyObject(e,attachment){
 const url=new URL(configuration.JXC_STORAGE_ENDPOINT);url.username=configuration.JXC_STORAGE_ACCESS_KEY;url.password=configuration.JXC_STORAGE_SECRET_KEY;
 const env={...process.env,MC_HOST_evidence:url.href},target='evidence/'+configuration.JXC_STORAGE_BUCKET+'/'+attachment.metadata.attachment.storage_key,args=['--config-dir',join(e.dir,'private/mc')],mc=join(sourceRoot,'runtime/jxc-env/mc.exe');
 const object=JSON.parse(execFileSync(mc,[...args,'--json','stat',target],{env,encoding:'utf8',windowsHide:true}));assert.equal(object.status,'success');assert.equal(Number(object.size),attachment.sourceSize);
 const bytes=execFileSync(mc,[...args,'cat',target],{env,maxBuffer:1024*1024,windowsHide:true});assert.equal(sha(bytes),attachment.sourceSha256);attachment.object={status:object.status,size:object.size,key:object.key,sha256:sha(bytes)};e.save();return attachment.object;
}

export async function verifyDownload(e,page,root,attachment){
 const row=root.getByRole('list',{name:'已上传附件',exact:true}).locator('li').filter({hasText:attachment.fileName});await expect(row).toBeVisible();const pending=page.waitForEvent('download');await row.getByRole('button',{name:'下载',exact:true}).click();const download=await pending;const path=join(e.dir,'assets','download-'+attachment.id+'.svg');await download.saveAs(path);const hash=sha(readFileSync(path));if(hash!==attachment.sourceSha256)throw new BusinessFailure('页面下载附件内容不一致',{id:attachment.id,expected:attachment.sourceSha256,actual:hash});attachment.downloadSha256=hash;attachment.downloadedThroughUI=true;e.save();return hash;
}
export async function uploadSVG(e,page,root,{role,bizType,bizId,category,docNo,amount,kind,sourceAsset}){
 let attachment=e.run.attachments.find(a=>a.bizType===bizType&&a.bizId===bizId&&a.category===category);
 if(!attachment){
  const fileName=category+'-'+bizId+'.svg',path=join(e.dir,'assets',fileName);const bytes=sourceAsset?readFileSync(sourceAsset):Buffer.from(svgEvidence({runId:e.run.id,kind:kind+' / '+new Date().toISOString(),docNo,amount}),'utf8');writeFileSync(path,bytes);
  const result=await command(page,'/sys/attachments',()=>root.locator('input[type=file]').setInputFiles({name:fileName,mimeType:'image/svg+xml',buffer:bytes}));
  attachment={id:result.data.id,fileName,role,bizType,bizId,category,sourceAsset:path,sourceSha256:sha(bytes),sourceSize:bytes.length};e.run.attachments.push(attachment);e.save();
 }
 const facts=e.oracle(`SELECT jsonb_build_object('attachment',(SELECT to_jsonb(a) FROM sys_attachment a WHERE id=${attachment.id}),'links',(SELECT jsonb_agg(to_jsonb(l)) FROM sys_attachment_link l WHERE attachment_id=${attachment.id}))`);
 assert.equal(facts.attachment.country_id,3);assert.equal(facts.attachment.status,'VALID');assert.equal(facts.attachment.object_status,'AVAILABLE');assert.equal(facts.attachment.category,category);assert.equal(facts.attachment.content_type,'image/svg+xml');assert.equal(facts.attachment.sha256,attachment.sourceSha256);assert.equal(Number(facts.attachment.size),attachment.sourceSize);assert.equal(facts.attachment.uploaded_by,e.run.checks['login:'+role].userId);
 assert.ok(facts.links.some(l=>l.biz_type===bizType&&l.biz_id===bizId&&l.unlinked_at===null));attachment.metadata=facts;
 verifyObject(e,attachment);
 await verifyDownload(e,page,root,attachment);return attachment;
}
