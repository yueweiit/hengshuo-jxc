import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { load,save,sourceRoot,sqlJSON,inventory } from './preflight.mjs';
import { finishStep,failStep,redact,BusinessFailure,classifyFailure } from './core.mjs';

export {BusinessFailure} from './core.mjs';
export class Evidence {
 constructor(){const current=load(join(sourceRoot,'runtime/validation/sales-flow-e2e/current.json'));this.dir=current.directory;this.prep=load(join(this.dir,'preparation.json'));assert.equal(this.prep.status,'ok');this.run=load(join(this.dir,'run.json'));this.currentStep=null;}
 save(){save(join(this.dir,'run.json'),redact(this.run));}
 response(role,path,method,status,body){appendFileSync(join(this.dir,'responses.jsonl'),JSON.stringify(redact({time:new Date().toISOString(),step:this.currentStep,role,path,method,status,body}))+'\n','utf8');}
 async shot(page,label){const fileName=String(label).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');const path=join(this.dir,'screenshots',fileName+'.png');await page.screenshot({path,fullPage:true});return path;}
 async step(id,role,page,action){
  if(['PASS','EXPECTED_REJECTION','PREVIOUS_RUN'].includes(this.run.steps.find(s=>s.id===id).status))return;
  assert.notEqual(this.run.status,'FAILED','存在业务失败，请先查看报告，禁止重复执行');this.currentStep=id;
  try{const result=await action();const screenshot=await this.shot(page,id+'-'+role);save(join(this.dir,'checkpoints',id+'.json'),{role,...result});finishStep(this.run,id,{role,screenshot,...result},result.expectedRejection?'EXPECTED_REJECTION':'PASS');this.run.status='RUNNING';this.save();console.log(JSON.stringify({step:id,status:this.run.steps.find(s=>s.id===id).status,docNo:result.docNo}));}
  catch(error){const screenshot=await this.shot(page,id+'-'+role+'-failure');const issue={step:id,role,url:page.url(),message:error.message,facts:error.facts,screenshot,time:new Date().toISOString(),classification:classifyFailure(error)};this.run.issues.push(issue);if(error instanceof BusinessFailure)failStep(this.run,id,issue);else this.run.status='HARNESS_PAUSED';this.save();save(join(this.dir,'issues',id+'-'+issue.classification+'.json'),redact(issue));throw error;}
  finally{this.currentStep=null;}
 }
 oracle(query){return sqlJSON(query);}
 snapshot(name){save(join(this.dir,name+'.json'),inventory());}
}
