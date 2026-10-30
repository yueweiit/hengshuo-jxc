import {test} from '@playwright/test';
import {Evidence} from './evidence.mjs';
import {Roles} from './roles.mjs';
import {queueWorkerRecovery,verifyWorkerRecovery} from './recovery.mjs';

test('原生导出在本组应用停止重启后只恢复一个结果并重新核对当前权限',async({browser})=>{
 const e=new Evidence(),roles=new Roles(browser,e);
 if(process.env.JXC_E2E_RECOVERY_PHASE==='queue')await queueWorkerRecovery(e,roles);
 else if(process.env.JXC_E2E_RECOVERY_PHASE==='verify')await verifyWorkerRecovery(e,roles);
 else throw Error('必须明确选择queue或verify阶段');
});
