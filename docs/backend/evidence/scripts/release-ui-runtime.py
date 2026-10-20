#!/usr/bin/env python3
"""Start NEW persistent synthetic release UI API/PostgreSQL/MinIO; no existing runtime is touched.
Credentials and logs are stored in one owned private directory outside the workspace.
Only the explicit foundation bootstrap plus optional first store/warehouse are preconfigured;
no transaction, inventory, receivable, payable, opening or voucher is prefilled.
"""
from pathlib import Path
import argparse,datetime as dt,hashlib,importlib.util,json,os,re,secrets,shutil,signal,socket,subprocess,tempfile,time,urllib.error,urllib.request
ROOT=Path(__file__).resolve().parents[4]
SPEC=importlib.util.spec_from_file_location('worker_rehearsal',Path(__file__).with_name('release-worker-rehearsal.py'))
worker=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(worker)

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--jar',type=Path,default=ROOT/'jxc-server/jxc-app/target/jxc-app-0.1.0-SNAPSHOT.jar');p.add_argument('--api-port',type=int,default=18100);p.add_argument('--pg-port',type=int,default=55480);p.add_argument('--s3-port',type=int,default=59100);p.add_argument('--java',default='/opt/homebrew/opt/openjdk/bin/java');p.add_argument('--output',type=Path,default=ROOT/'docs/backend/evidence/release-ui-runtime.json');p.add_argument('--foundation-only',action='store_true',help='Leave stores, warehouses and all business configuration to original pages');args=p.parse_args()
 if args.output.exists() or args.output.is_symlink():raise ValueError('Evidence output already exists; select a new --output to retain historical runtime evidence')
 for port in (args.api_port,args.pg_port,args.s3_port):
  with socket.socket() as s:s.bind(('127.0.0.1',port))
 jar=args.jar.resolve();assert jar.is_file(),'Current jar is missing'
 suffix=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S')+'-'+secrets.token_hex(3)
 name='hengshuo-closure-ui-'+suffix;pg=name+'-pg';s3=name+'-s3';database='jxc_closure_ui_'+suffix.replace('-','_');bucket='closure-ui-'+suffix
 private=Path(tempfile.mkdtemp(prefix='hengshuo-closure-ui-'));private.chmod(0o700)
 snapshot=private/'runtime.jar';sha=hashlib.sha256(jar.read_bytes()).hexdigest();shutil.copyfile(jar,snapshot)
 assert sha==hashlib.sha256(snapshot.read_bytes()).hexdigest()==hashlib.sha256(jar.read_bytes()).hexdigest(),'Jar changed during freeze'
 values={k:secrets.token_hex(24) for k in ['pgPassword','ownerPassword','appPassword','storageAccessKey','storageSecretKey','password']};values['username']='closure_ui_admin';values['bankKey']=__import__('base64').b64encode(secrets.token_bytes(32)).decode()
 def write_private(path,data):path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
 def run(cmd,data=None,env=None,timeout=60):
  r=subprocess.run(cmd,input=data,text=True,capture_output=True,env=env,timeout=timeout)
  if r.returncode:
   message=r.stderr[-3000:] or r.stdout[-3000:]
   for v in values.values():message=message.replace(v,'[REDACTED]')
   raise RuntimeError(message)
  return r.stdout.strip()
 def sql(q):return run(['docker','exec','-i',pg,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],q)
 def wait(check,seconds=60):
  deadline=time.monotonic()+seconds
  while time.monotonic()<deadline:
   try:
    if check():return
   except (urllib.error.URLError,TimeoutError,ConnectionError):pass
   time.sleep(.25)
  raise RuntimeError('Timed out waiting for new isolated runtime')
 write_private(private/'credentials.json',values)
 print(json.dumps({'status':'preparing','privateDirectory':str(private),'database':database,'postgresContainer':pg,'storageContainer':s3}),flush=True)
 denv=dict(os.environ,POSTGRES_PASSWORD=values['pgPassword'],MINIO_ROOT_USER=values['storageAccessKey'],MINIO_ROOT_PASSWORD=values['storageSecretKey'])
 run(['docker','run','-d','--name',pg,'--label','jxc.rehearsal=release-closure-ui','-e','POSTGRES_PASSWORD','-e','POSTGRES_DB='+database,'-p',f'127.0.0.1:{args.pg_port}:5432',worker.PG_IMAGE],env=denv)
 run(['docker','run','-d','--name',s3,'--label','jxc.rehearsal=release-closure-ui','-e','MINIO_ROOT_USER','-e','MINIO_ROOT_PASSWORD','-p',f'127.0.0.1:{args.s3_port}:9000',worker.S3_IMAGE,'server','/data'],env=denv)
 wait(lambda:subprocess.run(['docker','exec',pg,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database],capture_output=True).returncode==0,30)
 run(['docker','exec','-i',pg,'psql','-X','-q','-v','ON_ERROR_STOP=1','-v','expected_database='+database,'-U','postgres','-d',database],(ROOT/'jxc-server/scripts/provision-db.sql').read_text())
 sql(f"ALTER ROLE jxc_owner PASSWORD '{values['ownerPassword']}';ALTER ROLE jxc_app PASSWORD '{values['appPassword']}';")
 def s3ready():
  with urllib.request.urlopen(f'http://127.0.0.1:{args.s3_port}/minio/health/ready',timeout=2) as r:return r.status==200
 wait(s3ready,30)
 spec=importlib.util.spec_from_file_location('recovery_s3',ROOT/'jxc-server/scripts/m5/recovery.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
 helper.S3({'endpoint':f'http://127.0.0.1:{args.s3_port}','bucket':bucket,'accessKey':values['storageAccessKey'],'secretKey':values['storageSecretKey']}).request('PUT')
 env={k:v for k,v in os.environ.items() if not k.startswith(('JXC_','SPRING_','PG'))}
 env.update(JXC_BIND_ADDRESS='127.0.0.1',JXC_PORT=str(args.api_port),JXC_DB_URL=f'jdbc:postgresql://127.0.0.1:{args.pg_port}/{database}',JXC_DB_USER='jxc_app',JXC_DB_PASSWORD=values['appPassword'],JXC_STORAGE_ENDPOINT=f'http://127.0.0.1:{args.s3_port}',JXC_STORAGE_ACCESS_KEY=values['storageAccessKey'],JXC_STORAGE_SECRET_KEY=values['storageSecretKey'],JXC_STORAGE_BUCKET=bucket,JXC_BANK_ENCRYPTION_KEY=values['bankKey'])
 def start(label,migrate=False,enabled=False,assignment=None):
  e=dict(env,SPRING_FLYWAY_ENABLED=str(migrate).lower())
  if migrate:e.update(JXC_MIGRATION_USER='jxc_owner',JXC_MIGRATION_PASSWORD=values['ownerPassword'])
  log=private/(label+'.log')
  command=[args.java,'-jar',str(snapshot),'--jxc.jobs.enabled='+str(enabled).lower(),'--jxc.jobs.recovery.delay-ms=3000']
  if assignment:command.append('--jxc.workbench.worker.assignments='+assignment)
  with log.open('ab') as stream:proc=subprocess.Popen(command,env=e,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
  def healthy():
   if proc.poll() is not None:raise RuntimeError('API stopped; inspect private '+str(log))
   with urllib.request.urlopen(f'http://127.0.0.1:{args.api_port}/actuator/health',timeout=2) as r:return json.load(r).get('status')=='UP'
  wait(healthy);return proc
 migration=start('migration',True);os.killpg(migration.pid,signal.SIGTERM);migration.wait(timeout=15)
 permissions=sorted(set(re.findall(r'"code","([^"\n]*:[^"\n]*)"',(ROOT/'jxc-server/jxc-module-sys/src/main/java/com/hs/jxc/sys/service/PermissionCatalog.java').read_text())))
 types=['PRODUCT','PRODUCT_UNIT','PRODUCT_BARCODE','CUSTOMER','CUSTOMER_ADDRESS','SUPPLIER','LOGISTICS_PROVIDER','OPENING_STOCK','STOCK_LIMIT','OPENING_AR','OPENING_ADVANCE','CREDIT_RULE','PRICE','OPENING_AP','OPENING_PREPAYMENT','OPENING_GL','OPENING_PURCHASE','OPENING_TRANSIT']
 permissions=[x for x in permissions if not x.endswith(':')]
 permissions+=['sys:import:'+x.lower().replace('_','-') for x in types]
 config={'schemaVersion':1,'databaseName':database,'operator':'Authorized isolated release closure fixture','reason':'Foundation-only setup for real-page acceptance; no operational data', 'currencies':[{'code':'CNY','name':'人民币','decimals':2},{'code':'MXN','name':'墨西哥比索','decimals':2}], 'country':{'code':'MX','name':'墨西哥 UI 验收合成国家','defaultCurrency':'MXN','timezone':'America/Mexico_City','status':'ACTIVE','locale':'zh-CN','enabledModules':['sys','org','md','pur','lgs','inv','sal','ar','ap','rtn','cst','fin']},'entity':{'code':'MX-ENTITY','name':'MX 验收主体'},'book':{'code':'MX-BOOK','name':'MX 验收账套','baseCurrency':'MXN','status':'ACTIVE'},'admin':{'username':values['username'],'displayName':'发布验收平台管理员','password':values['password'],'isPlatformAdmin':True},'role':{'code':'UI_ADMIN','name':'合成验收管理员','roleType':'COUNTRY_ADMIN','permissions':permissions,'fieldPolicies':{k:'WRITE' for k in ['COST','CUSTOMER_PRICE','ORDER_TOTAL','BANK_INFO','PROFIT','CREDIT']}},'dataScope':{'scopeType':'COUNTRY_ALL'}}
 bootstrap=private/'bootstrap.json';write_private(bootstrap,config)
 benv=dict(env,SPRING_PROFILES_ACTIVE='bootstrap',SPRING_MAIN_WEB_APPLICATION_TYPE='none',SPRING_FLYWAY_ENABLED='false',SPRING_MAIN_BANNER_MODE='off',JXC_BOOTSTRAP_CONFIG_FILE=str(bootstrap),JXC_JOBS_ENABLED='false')
 # The existing offline bootstrap deliberately rejects every application argument.
 run([args.java,'-jar',str(snapshot)],env=benv,timeout=90)
 foundation=json.loads(sql("SELECT json_build_object('countryId',c.id,'entityId',e.id,'bookId',b.id,'userId',u.id) FROM sys_country c JOIN org_entity e ON e.country_id=c.id JOIN fin_book b ON b.country_id=c.id JOIN sys_user u ON u.created_country_id=c.id;"))
 country,entity,user=(foundation[k] for k in ['countryId','entityId','userId'])
 if not args.foundation_only:
  foundation['storeId']=int(sql(f"INSERT INTO org_store(country_id,entity_id,code,name,created_by) VALUES({country},{entity},'MX-S1','MX 验收门店1',{user}) RETURNING id;"))
  foundation['warehouseId']=int(sql(f"INSERT INTO org_warehouse(country_id,entity_id,store_id,code,name,created_by) VALUES({country},{entity},{foundation['storeId']},'MX-W1','MX 验收仓1',{user}) RETURNING id;"))
 configuration_counts=json.loads(sql("SELECT json_build_object('stores',(SELECT count(*) FROM org_store),'warehouses',(SELECT count(*) FROM org_warehouse),'categories',(SELECT count(*) FROM md_category),'approvalDocTypes',(SELECT count(*) FROM wf_doc_type_config));"))
 if args.foundation_only:assert not any(configuration_counts.values()),'Foundation-only fixture must not prefill page configuration'
 assignment=f'{country}:{user}';proc=start('runtime',False,True,assignment)
 request=urllib.request.Request(f'http://127.0.0.1:{args.api_port}/api/v1/auth/login',data=json.dumps({'username':values['username'],'password':values['password']}).encode(),headers={'Content-Type':'application/json'},method='POST')
 with urllib.request.urlopen(request,timeout=10) as response:assert response.status==200
 zero_counts=json.loads(sql("SELECT json_build_object('purchaseOrders',(SELECT count(*) FROM pur_order),'shipments',(SELECT count(*) FROM lgs_shipment),'salesOrders',(SELECT count(*) FROM sal_order),'stockTransactions',(SELECT count(*) FROM inv_stock_txn),'receivables',(SELECT count(*) FROM ar_receivable),'payables',(SELECT count(*) FROM ap_bill),'vouchers',(SELECT count(*) FROM fin_voucher),'imports',(SELECT count(*) FROM sys_import_batch));"));assert not any(zero_counts.values())
 fixture=private/'synthetic-acceptance-proof.txt';fixture.write_text('SYNTHETIC RELEASE ACCEPTANCE FIXTURE ONLY\nNo real sale, receipt, payment or bank transfer.\nUse only inside the new labelled release UI test environment.\n');fixture.chmod(0o600)
 credentials=private/'credentials.json';write_private(credentials,{**values,'countryId':country,'api':f'http://127.0.0.1:{args.api_port}'})
 runtime=private/'runtime-private.json';write_private(runtime,{'apiPid':proc.pid,'postgresContainer':pg,'storageContainer':s3,'database':database,'bucket':bucket,'environment':env,'jar':str(snapshot),'jarSha256':sha,'credentialsFile':str(credentials),'workerEnabled':True,'workbenchAssignment':assignment})
 evidence={'schemaVersion':1,'status':'running','createdAt':dt.datetime.now(dt.timezone.utc).isoformat(),'mode':'NEW persistent isolated synthetic UI runtime','productionDeployment':False,'originalM4M5Touched':False,'api':f'http://127.0.0.1:{args.api_port}','postgresPort':args.pg_port,'storagePort':args.s3_port,'apiPid':proc.pid,'postgresContainer':pg,'storageContainer':s3,'database':database,'bucket':bucket,'jarSha256':sha,'foundation':foundation,'preparation':{'offlineBootstrap':'existing BootstrapService','sqlSetup':['first synthetic store','first synthetic warehouse'],'apiSetup':['login availability check only'],'businessPrefill':zero_counts,'doesNotCountAsBrowserAcceptance':True},'privateConfigurationOutsideWorkspace':True,'runtimeMigrationEnabled':False,'runtimeHasMigrationCredentials':False,'migrationWorkerEnabled':False,'bootstrapWorkerEnabled':False,'workerEnabled':True,'explicitWorkbenchAssignment':{'countryId':country,'userId':user}}
 evidence['preparation'].update(sqlSetup=[] if args.foundation_only else evidence['preparation']['sqlSetup'],foundationOnly=args.foundation_only,configurationBeforeNativePages=configuration_counts)
 args.output.parent.mkdir(parents=True,exist_ok=True)
 with args.output.open('x') as stream:stream.write(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'status':'running','api':evidence['api'],'privateDirectory':str(private),'credentialsFile':str(credentials),'runtimeFile':str(runtime),'proofFixture':str(fixture),'evidence':str(args.output),'jarSha256':sha},ensure_ascii=False))
if __name__=='__main__':main()
