import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeReport} from './report.mjs';

function evidence(overrides={}){
 const dir=mkdtempSync(join(tmpdir(),'jxc-ai09-report-'));
 return {dir,prep:{sourceCommit:'current-source',testCommit:'current-tests',backendJarSha256:'actual-jar-hash',browserUsed:false},run:{id:'AI09-CURRENT',status:'RUNNING',steps:[{id:'01',status:'NOT_RUN'}],checks:{},documents:{},issues:[],...overrides}};
}
test('reports only this run and never invents historical browser or regression passes',()=>{
 const e=evidence();
 try{
  writeReport(e);const text=readFileSync(join(e.dir,'summary.md'),'utf8');
  assert.match(text,/current-source/);assert.match(text,/actual-jar-hash/);
  assert.match(text,/NOT_RUN/);
  assert.doesNotMatch(text,/13岗页面登录和退出换岗通过|前端60|后端90|8bddb695|54项通过|原parallel存在其他未提交文件/);
 }finally{rmSync(e.dir,{recursive:true});}
});
test('records the actual failing step without assuming a historical receipt or HTTP error shape',()=>{
 const e=evidence({status:'FAILED',steps:[{id:'25',status:'FAIL',error:{role:'cashier'}},{id:'26',status:'BLOCKED'}],issues:[{classification:'business',step:'25',role:'cashier',message:'actual refund error',url:'http://127.0.0.1:15199/returns/refunds',facts:{code:'CURRENT_ERROR'}}]});
 try{
  writeReport(e);const text=readFileSync(join(e.dir,'summary.md'),'utf8');
  assert.match(text,/actual refund error/);assert.match(text,/25.*FAIL/);assert.match(text,/26.*BLOCKED/);
  assert.doesNotMatch(text,/实收仍DRAFT|HTTP404 \/ NOT_FOUND|15—34与S01被阻断/);
 }finally{rmSync(e.dir,{recursive:true});}
});
