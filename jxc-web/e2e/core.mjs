export class BusinessFailure extends Error { constructor(message,facts){super(message);this.facts=facts;} }
export class CommandFailure extends Error { constructor(message,facts){super(message);this.facts=facts;} }
export function classifyFailure(error){return error instanceof BusinessFailure?'business':error instanceof CommandFailure?'unclassified-command':'harness';}
export function validateTarget(target) {
 if(target.database!=='jxc_test_ai09'||target.country!=='MX'||target.currency!=='MXN'||target.bucket!=='jxc-test-ai09-evidence')throw Error('TEST_TARGET_MISMATCH');
 if(target.baseURL!=='http://127.0.0.1:15199'||target.apiURL!=='http://127.0.0.1:18099')throw Error('LOCAL_APP_TARGET_MISMATCH');
 return target;
}
export function choosePowerShell(candidates,exists) {
 const path=candidates.filter(Boolean).find(candidate=>exists(candidate));
 if(!path)throw Error('POWERSHELL_NOT_AVAILABLE');
 return path;
}
export function money4(value) {
 if(value===null||value===undefined||!/^[-+]?\d+(\.\d{1,4})?$/.test(String(value)))throw Error('MISSING_OR_INVALID_MONETARY_FACT');
 const text=String(value),negative=text.startsWith('-'),[whole,fraction='']=text.replace(/^[-+]/,'').split('.');
 return (BigInt(whole)*10000n+BigInt(fraction.padEnd(4,'0')))*(negative?-1n:1n);
}
export function createRun(id) {
 return {id,status:'RUNNING',steps:Array.from({length:34},(_,i)=>({id:String(i+1).padStart(2,'0'),status:'NOT_RUN'})),checks:{},documents:{},attachments:[],issues:[],startedAt:new Date().toISOString()};
}
export function finishStep(run,id,evidence,status='PASS') {
 const step=run.steps.find(s=>s.id===id);if(!step||step.status!=='NOT_RUN')throw Error('STEP_NOT_EXECUTABLE: '+id);
 if(!['PASS','EXPECTED_REJECTION'].includes(status))throw Error('INVALID_SUCCESS_STATUS');
 Object.assign(step,{status,evidence,finishedAt:new Date().toISOString()});
}
export function failStep(run,id,error) {
 const index=run.steps.findIndex(s=>s.id===id);if(index<0)throw Error('UNKNOWN_STEP');
 Object.assign(run.steps[index],{status:'FAIL',error,finishedAt:new Date().toISOString()});
 for(const step of run.steps.slice(index+1))if(step.status==='NOT_RUN')Object.assign(step,{status:'BLOCKED',blockedBy:id});
 run.status='FAILED';
}
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function svgEvidence({runId,kind,docNo,amount}) {
 return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="640" viewBox="0 0 1000 640"><rect width="1000" height="640" fill="#f6f8fc"/><rect x="35" y="35" width="930" height="570" rx="18" fill="white" stroke="#253851"/><g font-family="sans-serif" fill="#253851"><text x="70" y="105" font-size="34">TEST ONLY / 仅本地测试</text><text x="70" y="175" font-size="25">${xml(kind)}</text><text x="70" y="235" font-size="24">Run: ${xml(runId)}</text><text x="70" y="295" font-size="24">Document: ${xml(docNo)}</text><text x="70" y="355" font-size="30">${xml(amount)}</text><text x="70" y="465" font-size="22">Synthetic evidence - no actual bank transfer</text><text x="70" y="525" font-size="22">jxc_test_ai09 / MX / MXN</text></g></svg>`;
}
export function redact(value,secrets=[]) {
 if(Array.isArray(value))return value.map(item=>redact(item,secrets));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/password|authorization|token|secret|encryption.key/i.test(key)?'[REDACTED]':redact(item,secrets)]));
 if(typeof value==='string'){let text=value;for(const secret of secrets)if(secret)text=text.replaceAll(secret,'[REDACTED]');return text;}
 return value;
}
