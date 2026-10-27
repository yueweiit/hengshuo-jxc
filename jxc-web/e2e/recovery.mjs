import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {CommandFailure} from './core.mjs';
import {load,save,sha} from './preflight.mjs';

async function api(e,page,role,path,method='GET',body,key){
 const response=await page.evaluate(async({path,method,body,key})=>{
  const token=localStorage.getItem('jxc.token'),country=localStorage.getItem('jxc.countryId');
  if(!token||!country)throw Error('本岗位没有已登录的实际会话');
  const r=await fetch('/api/v1'+path,{method,headers:{Authorization:'Bearer '+token,'X-Country-Id':country,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {httpStatus:r.status,text:await r.text()};
 },{path,method,body,key});
 let result;
 try{result=JSON.parse(response.text);}catch{throw new CommandFailure('原生接口返回非JSON',{path,httpStatus:response.httpStatus,text:response.text.slice(0,500)});}
 // Roles already records mutations and errors; add only the otherwise omitted successful reads.
 if(method==='GET'&&response.httpStatus<400)e.response(role,path,method,response.httpStatus,result);
 return {httpStatus:response.httpStatus,...result};
}
function ok(response){
 if(response.httpStatus!==200||response.code!=='OK')throw new CommandFailure('原生命令失败：'+response.code,response);
 return response.data;
}
function proof(e,id){
 assert.ok(Number.isSafeInteger(id)&&id>0);
 return e.oracle(`SELECT jsonb_build_object('job',(SELECT jsonb_build_object('id',id,'bookId',book_id,'ownerId',requested_by,'type',job_type) FROM sys_export_job WHERE id=${id}),'results',(SELECT count(*) FROM sys_job_result WHERE job_id=${id}),'notifications',(SELECT count(*) FROM sys_notification WHERE job_id=${id}),'events',(SELECT count(*) FROM sys_biz_event WHERE source_type='SYS_REPORT_EXPORT' AND source_id=${id}),'consumers',(SELECT jsonb_agg(jsonb_build_object('status',c.status,'attempts',c.attempt_count,'error',c.last_error)) FROM sys_biz_event_consume c JOIN sys_biz_event b ON b.id=c.event_id AND b.country_id=c.country_id WHERE b.source_type='SYS_REPORT_EXPORT' AND b.source_id=${id}))`);
}
function business(e){return e.oracle("SELECT jsonb_build_object('batches',(SELECT count(*) FROM inv_batch),'stock',(SELECT sum(on_hand_qty) FROM inv_stock_summary),'cogsFacts',(SELECT count(*) FROM cst_cogs),'cogsAmount',(SELECT sum(amount) FROM cst_cogs),'ar',(SELECT sum(open_amount) FROM ar_receivable),'ap',(SELECT sum(amount-paid_amount) FROM ap_bill),'vouchers',(SELECT count(*) FROM fin_voucher),'ledgerDebit',(SELECT sum(closing_debit) FROM fin_account_balance),'ledgerCredit',(SELECT sum(closing_credit) FROM fin_account_balance))");}

export async function queueWorkerRecovery(e,roles){
 assert.ok(!e.run.documents.workerRecoveryJob,'已有原生任务时先核对检查点，禁止创建第二个恢复目标');
 const admin=await roles.get('admin'),accountant=await roles.get('accountant');
 const readonlyBefore=business(e);
 await accountant.reload();await roles.relogin('accountant');
 const readonlyAfter=business(e);assert.deepEqual(readonlyAfter,readonlyBefore);
 e.run.checks.refreshAndRelogin={status:'PASS',role:'accountant',before:readonlyBefore,after:readonlyAfter};e.save();
 const status=ok(await api(e,admin,'admin','/sys/jobs/worker-status'));
 assert.equal(status.enabled,false,'恢复演练先以真实配置暂停worker，禁止SQL改任务状态');
 const role=e.oracle("SELECT jsonb_build_object('id',id) FROM sys_role WHERE code='AI09_ACCOUNTANT'");
 assert.ok(role?.id,'缺少本组已创建的会计角色');
 const original=ok(await api(e,admin,'admin','/sys/roles/'+role.id));
 assert.ok(Array.isArray(original.permissions));
 assert.ok(!original.permissions.some(p=>p==='*'||p==='fin:*'||p==='fin:ledger:*'),'本组正向岗位须保持专属权限');
 e.run.checks.workerRecovery={status:'PREPARING',roleId:role.id,originalPermissions:original.permissions};e.save();
 if(!original.permissions.includes('fin:ledger:export')){
  ok(await api(e,admin,'admin',`/sys/roles/${role.id}/permissions`,'PUT',{version:original.version,permissions:[...original.permissions,'fin:ledger:export']},randomUUID()));
 }
 const book=e.prep.bookId;
 const period=e.oracle(`SELECT to_jsonb(p) FROM fin_period p WHERE book_id=${book} AND fiscal_year=2026 AND period_no=10`);
 assert.ok(period?.id);
 const body={bookId:book,periodId:period.id},intent=randomUUID();
 const job=ok(await api(e,accountant,'accountant','/fin/ledgers/balance/export','POST',body,intent));
 e.run.documents.workerRecoveryJob=job;e.run.checks.workerRecovery.jobId=job.id;e.save();
 const replay=ok(await api(e,accountant,'accountant','/fin/ledgers/balance/export','POST',body,intent));
 assert.equal(replay.id,job.id);
 const facts=proof(e,job.id);
 assert.equal(facts.results,0);assert.equal(facts.notifications,0);assert.equal(facts.events,1);
 assert.equal(ok(await api(e,accountant,'accountant','/sys/jobs/'+job.id)).status,'QUEUED');
 Object.assign(e.run.checks.workerRecovery,{status:'QUEUED_BEFORE_PROCESS_STOP',jobId:job.id,before:facts,businessBefore:business(e),expectedJarSha256:e.prep.backendJarSha256});
 e.run.documents.workerRecoveryJob=job;e.save();save(join(e.dir,'worker-queued-before-stop.json'),e.run.checks.workerRecovery);
}

export async function verifyWorkerRecovery(e,roles){
 const check=e.run.checks.workerRecovery;
 assert.equal(check.status,'QUEUED_BEFORE_PROCESS_STOP');
 const restart=load(join(e.dir,'worker-process-restart.json'));
 assert.notEqual(restart.beforePid,restart.afterPid);
 assert.equal(restart.jarShaBefore,check.expectedJarSha256);assert.equal(restart.jarShaAfter,check.expectedJarSha256);
 assert.equal(restart.wasProcessing,true);assert.equal(restart.inFlight.consumer.status,'PROCESSING');assert.ok(restart.inFlight.blockedReads>0);
 assert.equal(restart.inFlight.results,0);assert.equal(restart.inFlight.notifications,0);
 const admin=await roles.get('admin'),accountant=await roles.get('accountant');
 try{
  assert.equal(ok(await api(e,admin,'admin','/sys/jobs/worker-status')).enabled,true);
  const deadline=Date.now()+45000;
  let state;
  do{
   state=ok(await api(e,accountant,'accountant','/sys/jobs/'+check.jobId));
   if(state.status==='FAILED')throw new CommandFailure('恢复后的原任务明确失败',{state,facts:proof(e,check.jobId)});
   if(state.status==='SUCCESS')break;
   await delay(500);
  }while(Date.now()<deadline);
  assert.equal(state.status,'SUCCESS');
  const first=ok(await api(e,accountant,'accountant',`/sys/jobs/${check.jobId}/download`));
  const again=ok(await api(e,accountant,'accountant',`/sys/jobs/${check.jobId}/download`));
  assert.equal(typeof first.content,'string');assert.ok(first.content.trim().length>0);
  assert.equal(sha(first.content),sha(again.content));
  writeFileSync(join(e.dir,'assets','worker-ledger-export.csv'),first.content,'utf8');
  const facts=proof(e,check.jobId);
  assert.equal(facts.results,1);assert.equal(facts.notifications,1);assert.equal(facts.events,1);
  assert.equal(facts.consumers.length,1);assert.equal(facts.consumers[0].status,'DONE');assert.ok(facts.consumers[0].attempts>=2);
  assert.deepEqual(business(e),check.businessBefore);
  const current=ok(await api(e,admin,'admin','/sys/roles/'+check.roleId));
  ok(await api(e,admin,'admin',`/sys/roles/${check.roleId}/permissions`,'PUT',{version:current.version,permissions:current.permissions.filter(p=>p!=='fin:ledger:export')},randomUUID()));
  const denied=await api(e,accountant,'accountant',`/sys/jobs/${check.jobId}/download`);
  assert.equal(denied.httpStatus,403);assert.equal(denied.code,'SYS_FORBIDDEN');
  const retry=await api(e,accountant,'accountant',`/sys/jobs/${check.jobId}/retry`,'POST',{},randomUUID());
  assert.equal(retry.httpStatus,403);
  assert.deepEqual(proof(e,check.jobId),facts);
  Object.assign(check,{status:'PASS',after:facts,restart,downloadSha256:sha(first.content),revokedDownload:denied.httpStatus,revokedRetry:retry.httpStatus,businessAfter:business(e)});
  save(join(e.dir,'worker-recovery-verification.json'),check);
 }catch(error){
  Object.assign(check,{status:'ERROR',firstError:error.message,facts:error.facts});e.save();throw error;
 }finally{
  const current=ok(await api(e,admin,'admin','/sys/roles/'+check.roleId));
  ok(await api(e,admin,'admin',`/sys/roles/${check.roleId}/permissions`,'PUT',{version:current.version,permissions:check.originalPermissions},randomUUID()));
  check.permissionsRestored=true;e.save();
 }
}
