import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateTarget,createRun,choosePowerShell} from './core.mjs';
import {validateFixtureIdentity} from './fixture-identity.mjs';

export const sourceRoot=resolve(process.env.JXC_E2E_SOURCE_ROOT||fileURLToPath(new URL('../..',import.meta.url)));
export const envFile=resolve(process.env.JXC_E2E_ENV_FILE||join(sourceRoot,'runtime/jxc-env/test-ai09.env'));
const local=await import(pathToFileURL(join(sourceRoot,'runtime/jxc-env/local-env.mjs')).href);
export const configuration=local.config(envFile);
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const load=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
export const save=(path,data)=>writeFileSync(path,JSON.stringify(data,null,2),'utf8');
export const credentialFile=join(sourceRoot,'runtime/jxc-env/jxc-test-ai09.accounts.secret.json');
export function sqlJSON(select) {
 const sql=`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='3s'; DO $g$ BEGIN IF current_database()<>'jxc_test_ai09' OR current_setting('transaction_read_only')<>'on' THEN RAISE EXCEPTION 'TEST_READ_ONLY_REQUIRED'; END IF; END $g$; ${select}; COMMIT;`;
 return JSON.parse(local.docker(configuration,['exec','-i',configuration.JXC_DB_CONTAINER,'psql','-X','-qAt','-U','postgres','-d','jxc_test_ai09','-v','ON_ERROR_STOP=1'],{input:sql}));
}
export function inventory() {
 const sql=readFileSync(join(sourceRoot,'runtime/validation/20261026-foundation-inventory/inventory.sql'),'utf8');
 return JSON.parse(local.docker(configuration,['exec','-i',configuration.JXC_DB_CONTAINER,'psql','-X','-qAt','-U','postgres','-d','jxc_test_ai09','-v','ON_ERROR_STOP=1'],{input:sql}));
}
function sourceFingerprint() {
 const files=[];const walk=dir=>{for(const item of readdirSync(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())walk(path);else if(item.isFile())files.push([path.slice(sourceRoot.length),sha(readFileSync(path))]);}};
 walk(join(sourceRoot,'jxc-web/src'));
 for(const file of ['package.json','package-lock.json','vite.config.ts','.env.development','.env.production']){const path=join(sourceRoot,'jxc-web',file);if(existsSync(path))files.push([file,sha(readFileSync(path))]);}
 return sha(JSON.stringify(files.sort((a,b)=>a[0].localeCompare(b[0]))));
}
function distFingerprint(){
 const root=join(sourceRoot,'jxc-web/dist'),files=[];
 const walk=directory=>{for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())walk(path);else if(entry.isFile())files.push([path.slice(root.length).replaceAll('\\','/'),sha(readFileSync(path))]);}};
 assert.ok(existsSync(join(root,'index.html')),'缺少本次实际页面运行所需生产构建');walk(root);
 return sha(JSON.stringify(files.sort((a,b)=>a[0].localeCompare(b[0]))));
}
export async function prepare() {
 validateTarget({database:configuration.JXC_EXPECT_DATABASE,country:'MX',currency:'MXN',baseURL:'http://127.0.0.1:'+configuration.JXC_WEB_PORT,apiURL:configuration.VITE_API_TARGET.replace(/\/$/,''),bucket:configuration.JXC_STORAGE_BUCKET});
 local.checkContainer(configuration);
 const id='E2E-MXN-'+new Date().toISOString().replace(/[-:.]/g,'').slice(0,15)+'-'+randomUUID().slice(0,4);
 const directory=join(sourceRoot,'runtime/validation/sales-flow-e2e',id);mkdirSync(directory,{recursive:true});
 const aclScript=`$taskP='${directory.replaceAll("'","''")}';$taskU=[Security.Principal.WindowsIdentity]::GetCurrent().User;$taskA=[Security.AccessControl.DirectorySecurity]::new();$taskA.SetOwner($taskU);$taskA.SetAccessRuleProtection($true,$false);$taskI=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit;$taskA.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskU,'FullControl',$taskI,'None','Allow'));Set-Acl -LiteralPath $taskP -AclObject $taskA`;
 const shell=choosePowerShell([process.env.JXC_E2E_POWERSHELL,join(process.env.ProgramFiles||'C:/Program Files','PowerShell/7/pwsh.exe'),join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe')],existsSync);
 execFileSync(shell,['-NoProfile','-NonInteractive','-Command',aclScript],{stdio:'pipe'});
 for(const sub of ['backup','private','screenshots','checkpoints','assets','issues'])mkdirSync(join(directory,sub));
 const run=createRun(id);save(join(directory,'run.json'),run);
 save(join(sourceRoot,'runtime/validation/sales-flow-e2e/current.json'),{directory,id});
 const before=inventory();save(join(directory,'before.json'),before);
 try {
  assert.equal(before.database,'jxc_test_ai09');assert.equal(before.readOnly,'on');assert.equal(before.countries.length,1);assert.equal(before.countries[0].code,'MX');assert.equal(before.countries[0].default_currency,'MXN');
  validateFixtureIdentity(before);
  const product=before.products.find(p=>p.product_code==='AI09-A-M');assert.ok(product);
  for(const stock of before.stock.filter(s=>s.product_id===product.id&&s.warehouse_id===26))for(const key of ['on_hand_qty','reserved_qty','frozen_qty'])assert.equal(Number(stock[key]),0,'主商品库存前置条件不满足：'+key);
  assert.ok(before.warehouses.some(w=>w.id===26&&w.type==='WAREHOUSE'&&w.store_id===23));assert.equal(before.users.length,13);
  assert.ok(before.prices.some(p=>p.product_code==='AI09-A-M'&&p.currency==='MXN'&&Number(p.price)===100));
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  assert.ok(before.periods.some(p=>p.status==='OPEN'&&p.start_date<=date&&p.end_date>=date),'业务日期期间未开放');
  const pending=sqlJSON("SELECT jsonb_build_object('tasks',(SELECT count(*) FROM wf_task WHERE country_id=3 AND status='PENDING'),'returns',(SELECT count(*) FROM rtn_sales_return WHERE country_id=3 AND status NOT IN ('COMPLETED','CANCELLED','REJECTED')))");
  assert.equal(pending.tasks,0,'存在其他未完成审批');assert.equal(pending.returns,0,'存在未完成退货');
  const dump='/tmp/'+id+'.dump';local.docker(configuration,['exec',configuration.JXC_DB_CONTAINER,'pg_dump','-U','postgres','-d','jxc_test_ai09','-Fc','-f',dump]);
  local.docker(configuration,['cp',configuration.JXC_DB_CONTAINER+':'+dump,join(directory,'backup/database.dump')]);
  local.docker(configuration,['cp',configuration.JXC_MINIO_CONTAINER+':/data/'+configuration.JXC_STORAGE_BUCKET,join(directory,'backup/minio-bucket')]);
  const preparation={status:'ok',id,directory,date,productId:product.id,countryId:3,bookId:6,warehouseA:26,warehouseB:33,customerId:167,creditCustomerId:172,bankAccountId:401,backendJarSha256:sha(readFileSync(configuration.JXC_APP_JAR)),frontendSourceSha256:sourceFingerprint(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8'}).trim(),testCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../..',import.meta.url)),encoding:'utf8'}).trim(),browserUsed:false};
  preparation.frontendDistSha256=distFingerprint();preparation.frontendServingMode='vite-preview-production-dist';
  save(join(directory,'preparation.json'),preparation);console.log(JSON.stringify({status:'ok',directory,id,date,productId:product.id,backup:true}));return preparation;
 }catch(error){save(join(directory,'preparation.json'),{status:'error',message:error.message,directory,id});run.status='PRECONDITION_BLOCKED';run.issues.push({classification:'environment',message:error.message});save(join(directory,'run.json'),run);throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepare();
