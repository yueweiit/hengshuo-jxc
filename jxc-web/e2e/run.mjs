import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Evidence } from './evidence.mjs';
import { load,credentialFile } from './preflight.mjs';
import { redact } from './core.mjs';
import { writeReport } from './report.mjs';
const e=new Evidence(),attachmentsOnly=process.argv.includes('--inspect-attachments'),inspect=process.argv.includes('--inspect')||attachmentsOnly,recover=process.argv.includes('--recover'),queueRecovery=process.argv.includes('--queue-recovery');
if(!inspect&&e.run.status==='FAILED'){console.error('已有业务阻断，禁止自动重跑；请阅读 '+join(e.dir,'summary.md'));process.exitCode=2;}
else {
 const cli=fileURLToPath(new URL('../node_modules/@playwright/test/cli.js',import.meta.url));
 const result=spawnSync(process.execPath,[cli,'test',recover||queueRecovery?'recovery.spec.mjs':attachmentsOnly?'attachments-inspection.spec.mjs':inspect?'access-inspection.spec.mjs':'sales-flow.spec.mjs'],{encoding:'utf8',maxBuffer:10*1024*1024,windowsHide:true,env:{...process.env,...(recover||queueRecovery?{JXC_E2E_RECOVERY_PHASE:queueRecovery?'queue':'verify'}:{})}});
 const secrets=load(credentialFile).map(c=>c.password),log=redact((result.stdout??'')+(result.stderr??'')+(result.error?.message??''),secrets);
 writeFileSync(join(e.dir,(queueRecovery?'worker-queue':recover?'worker-recovery':attachmentsOnly?'attachments':inspect?'scope':'business')+'-runner.log'),log,'utf8');process.stdout.write(log);process.exitCode=result.error?1:result.status??1;
}
writeReport(new Evidence());
