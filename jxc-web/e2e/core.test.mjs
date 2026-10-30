import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTarget, money4, createRun, finishStep, failStep, svgEvidence, redact, choosePowerShell} from './core.mjs';
import * as core from './core.mjs';

const valid={database:'jxc_test_ai09',country:'MX',currency:'MXN',baseURL:'http://127.0.0.1:15199',apiURL:'http://127.0.0.1:18099',bucket:'jxc-test-ai09-evidence'};
test('unexpected API errors retain their facts for diagnosis without being declared business-policy failures',()=>{
 const facts={httpStatus:403,body:{code:'SYS_FORBIDDEN'}};
 assert.equal(typeof core.CommandFailure,'function');
 const error=new core.CommandFailure('actual command error',facts);
 assert.equal(error.facts,facts);assert.equal(core.classifyFailure(error),'unclassified-command');
 assert.equal(core.classifyFailure(new core.BusinessFailure('quantity mismatch',{expected:10,actual:11})),'business');
 assert.equal(core.classifyFailure(new Error('locator missing')),'harness');
});
test('uses an existing absolute shell path and refuses a nonexistent shell before spawning',()=>{
 const available='C:/Program Files/PowerShell/7/pwsh.exe';
 assert.equal(choosePowerShell(['C:/missing/powershell.exe',available],path=>path===available),available);
 assert.throws(()=>choosePowerShell(['C:/missing/powershell.exe'],()=>false),/POWERSHELL_NOT_AVAILABLE/);
});
test('refuses wrong database, public address and a mismatched evidence bucket before any write',()=>{
 assert.doesNotThrow(()=>validateTarget(valid));
 for(const mismatch of [{database:'jxc_prod'},{database:'jxc_test_01'},{baseURL:'http://127.0.0.1:60'},{apiURL:'http://127.0.0.1:90'},{bucket:'jxc-test-01-evidence'},{baseURL:'https://example.com'},{apiURL:'http://127.0.0.1:8080'},{bucket:'production'},{currency:'CNY'}])assert.throws(()=>validateTarget({...valid,...mismatch}));
});
test('money compares exact four decimal values and rejects missing or over-precise facts',()=>{
 assert.equal(money4('0.1000')+money4('0.2000'),money4('0.3000'));
 assert.equal(money4('-50.0000'),-500000n);
 for(const value of [null,undefined,'','bad','1.00001'])assert.throws(()=>money4(value));
});
test('unexpected failure blocks only dependent unexecuted steps and keeps completed evidence',()=>{
 const run=createRun('example');finishStep(run,'01',{docNo:'SO1'});failStep(run,'02',{message:'actual error'});
 assert.equal(run.steps[0].status,'PASS');assert.equal(run.steps[0].evidence.docNo,'SO1');
 assert.equal(run.steps[1].status,'FAIL');assert.equal(run.steps[2].status,'BLOCKED');
 assert.throws(()=>finishStep(run,'03',{}));assert.equal(run.steps.length,34);
});
test('designed shortage rejection remains a passed checkpoint without blocking the chain',()=>{
 const run=createRun('example');finishStep(run,'01',{});finishStep(run,'02',{code:'INV_INSUFFICIENT_AVAILABLE'},'EXPECTED_REJECTION');
 finishStep(run,'03',{});assert.equal(run.steps[2].status,'PASS');
});
test('synthetic SVG identifies the real source and escapes data rather than executing it',()=>{
 const image=svgEvidence({runId:'run-1',kind:'sales',docNo:'SO<&"',amount:'1000 MXN'});
 assert.ok(image.includes('TEST ONLY'));assert.ok(image.includes('SO&lt;&amp;&quot;'));
 assert.ok(!image.includes('<script'));assert.ok(!image.includes('http://example'));
 assert.ok(Buffer.byteLength(image)<1024*1024);
});
test('public diagnostics redact secrets and common token/password fields recursively',()=>{
 const cleaned=redact({password:'abc',nested:{Authorization:'Bearer token',msg:'failure secret-123'},username:'mx02_sales_a'},['secret-123']);
 assert.equal(cleaned.password,'[REDACTED]');assert.equal(cleaned.nested.Authorization,'[REDACTED]');
 assert.equal(cleaned.nested.msg,'failure [REDACTED]');assert.equal(cleaned.username,'mx02_sales_a');
});
