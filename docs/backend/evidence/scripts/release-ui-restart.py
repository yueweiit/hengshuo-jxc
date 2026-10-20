#!/usr/bin/env python3
"""Replace the existing isolated UI runtime after operators pause.

Default mode permits only identical migration bytes. Explicit reviewed upgrade
modes run the original one-shot MigrationMain for an exact pinned append set. The
39-to-40/41 modes permit only five reviewed nullable columns on existing tables.
41-to-42 adds two empty assignment tables and refuses an old-policy fallback.
All old column values and sequence state must remain identical.
"""
from pathlib import Path
import argparse,datetime as dt,hashlib,json,os,re,shlex,shutil,signal,subprocess,sys,time,urllib.request,zipfile
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'jxc-server/scripts/m5'))
from catalog_contract import catalog_gaps_query

NULL_APPEND_SCRIPT='V013_7__shipment_measurement_and_receipt_confirmation.sql'
ZERO_POSTING_SCRIPT='V013_8__zero_posting_event_interpretation.sql'
ASSIGNMENT_SCRIPT='V013_9__confirmed_bill_cost_assignment.sql'
ASSIGNMENT_TABLES=frozenset(('ap_cost_assignment','ap_cost_assignment_line'))
PRIOR_ASSIGNMENT_CONTRACT_SHA256='2c275148cfefd6604814adc30a796fdd05bc00a269fc33796ddfa43e2d2a6e0a'
NULL_APPEND_COLUMNS={'lgs_shipment_line':('boxes','unit_weight','unit_volume'),'lgs_receipt':('confirmed_by','confirmed_at')}
REVIEWED_UPGRADES={'V013_6__opening_container_continuation.sql':(38,39,('V013_6__opening_container_continuation.sql',)),NULL_APPEND_SCRIPT:(39,40,(NULL_APPEND_SCRIPT,)),ZERO_POSTING_SCRIPT:(39,41,(NULL_APPEND_SCRIPT,ZERO_POSTING_SCRIPT)),ASSIGNMENT_SCRIPT:(41,42,(ASSIGNMENT_SCRIPT,))}

def reviewed_append(old,new,selected):
 if selected not in REVIEWED_UPGRADES:raise ValueError('Unknown reviewed migration append')
 old_count,new_count,added=REVIEWED_UPGRADES[selected]
 if len(old)!=old_count or len(new)!=new_count or set(new)-set(old)!=set(added) or any(new.get(name)!=digest for name,digest in old.items()):raise ValueError('Only the exact reviewed immutable migration append is authorized')
 return len(added)

def reviewed_assignment_tables(before,after):
 old_keys={(row['kind'],row['name']) for row in before};new_keys={(row['kind'],row['name']) for row in after}
 added={('table',name) for name in ASSIGNMENT_TABLES}
 if len(old_keys)!=len(before) or len(new_keys)!=len(after) or new_keys!=old_keys|added or old_keys&added:raise ValueError('Only the two exact new assignment tables may be appended')
 empty=hashlib.sha256(b'').hexdigest()
 if any(row.get('rowCount')!=0 or row.get('rowsSha256')!=empty for row in after if (row['kind'],row['name']) in added):raise ValueError('New assignment tables must remain empty during schema-only upgrade')
 comparison=[row for row in after if (row['kind'],row['name']) not in added]
 business=lambda rows:sorted((row for row in rows if row['name']!='flyway_schema_history'),key=lambda row:(row['kind'],row['name']))
 if business(before)!=business(comparison):raise ValueError('Assignment schema append changed existing facts or sequence state')
 return comparison

def reviewed_assignment_preflight(sql,old_migrations):
 path=ROOT/'docs/backend/evidence/archive/audit-contract-closure-candidate-41.json'
 if path.is_symlink() or sha(path)!=PRIOR_ASSIGNMENT_CONTRACT_SHA256:raise ValueError('Original 41 catalog pin differs from the reviewed contract')
 prior=json.loads(path.read_text())
 if len(prior['migrations'])!=41 or len(prior['tables'])!=190 or {row['script']:row['sha256'] for row in prior['migration_files']}!=old_migrations:raise ValueError('Original 41 migration catalog does not match the old artifact')
 if schema_columns(sql)!=prior['tables']:raise ValueError('Previous schema differs from the pinned original column catalog')
 if json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM ("+catalog_gaps_query(prior,'jxc_app')+") x;")):raise ValueError('Previous schema differs from the pinned original complete catalog')
 return prior

def previous_runtime_fallback_allowed(upgrade_started,upgrade_verified,selected_upgrade):
 return not upgrade_started or upgrade_verified and selected_upgrade!=ASSIGNMENT_SCRIPT

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def stamp():return dt.datetime.now(dt.timezone.utc).isoformat()
def write(path,data,private=False):
 path=Path(path);temp=path.with_name(path.name+'.new');temp.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');temp.chmod(0o600 if private else 0o644);os.replace(temp,path)
def write_evidence(path,data):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 with path.open('x') as stream:stream.write(json.dumps(data,ensure_ascii=False,indent=2)+'\n')

def run(command,data=None):
 r=subprocess.run(command,input=data,text=True,capture_output=True,timeout=30)
 if r.returncode:raise RuntimeError('Command failed without exposing private output: '+command[0])
 return r.stdout.strip()
def migrations(jar):
 with zipfile.ZipFile(jar) as z:
  files={Path(n).name:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if re.fullmatch(r'BOOT-INF/classes/db/migration/V[^/]+\.sql',n)}
 if len(files) not in (38,39,40,41,42):raise ValueError('Expected the reviewed 38 through 42-migration release')
 return files

def fact_snapshot(sql,*,project_null_append=False,expected_tables=None):
 names=sql("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind IN ('r','p') ORDER BY relname;").splitlines()
 sequences=sql("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind='S' ORDER BY relname;").splitlines()
 expected=set(expected_tables)|{'flyway_schema_history'} if expected_tables is not None else None
 if (expected is not None and set(names)!=expected) or (expected is None and len(names)!=191) or any(not re.fullmatch(r'[a-z][a-z0-9_]*',n) for n in names+sequences):raise ValueError('Unexpected application schema')
 queries=[]
 for name in names:
  value='to_jsonb(t)'
  if project_null_append and name in NULL_APPEND_COLUMNS:value='('+value+"-ARRAY["+','.join("'"+column+"'" for column in NULL_APPEND_COLUMNS[name])+'])'
  queries.append("SELECT json_build_object('kind','table','name','"+name+"','rowCount',count(*),'rowsSha256',encode(pg_catalog.sha256(convert_to(coalesce(string_agg("+value+"::text,E'\\n' ORDER BY "+value+"::text),''),'UTF8')),'hex')) FROM public.\""+name+"\" t;")
 queries += ["SELECT json_build_object('kind','sequence','name','"+n+"','lastValue',last_value,'isCalled',is_called) FROM public.\""+n+"\";" for n in sequences]
 return [json.loads(line) for line in sql('\n'.join(queries)).splitlines()]

def reviewed_null_column_counts(sql):
 queries=["SELECT json_build_object('table','"+table+"','nonNullRows',count(*)) FROM public.\""+table+'\" WHERE '+' OR '.join('"'+column+'" IS NOT NULL' for column in columns)+';' for table,columns in NULL_APPEND_COLUMNS.items()]
 return {row['table']:row['nonNullRows'] for row in map(json.loads,sql('\n'.join(queries)).splitlines())}

def schema_columns(sql):
 return json.loads(sql("SELECT coalesce(json_object_agg(table_name,columns ORDER BY table_name),'{}') FROM (SELECT c.relname table_name,json_object_agg(a.attname,format_type(a.atttypid,a.atttypmod) ORDER BY a.attnum) columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname<>'flyway_schema_history' GROUP BY c.relname) x;"))

def isolated_endpoint(api):
 match=re.fullmatch(r'http://127\.0\.0\.1:([0-9]+)',api)
 if not match or not 1024<=int(match.group(1))<=65535:raise ValueError('Explicit isolated loopback API with unprivileged port required')
 return match.group(1)

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--runtime-config',type=Path,required=True);p.add_argument('--jar',type=Path,required=True);p.add_argument('--jar-sha256',required=True);p.add_argument('--expected-pid',type=int,required=True);p.add_argument('--expected-database',required=True);p.add_argument('--expected-system-identifier',required=True);p.add_argument('--expected-old-sha256',required=True);p.add_argument('--reviewed-schema-upgrade',choices=REVIEWED_UPGRADES);p.add_argument('--execute',action='store_true');p.add_argument('--operators-paused',action='store_true');p.add_argument('--java',default='/opt/homebrew/opt/openjdk/bin/java');p.add_argument('--output',type=Path,default=ROOT/'docs/backend/evidence/release-ui-jar-restart.json');p.add_argument('--runtime-evidence',type=Path,default=ROOT/'docs/backend/evidence/release-ui-runtime.json');p.add_argument('--expected-api',default='http://127.0.0.1:18100');a=p.parse_args()
 private=a.runtime_config.resolve();public_path=a.runtime_evidence;api_port=isolated_endpoint(a.expected_api)
 if a.output.exists() or a.output.is_symlink():raise ValueError('Refusing to replace existing restart evidence')
 if public_path.is_symlink() or not public_path.is_file():raise ValueError('Regular isolated runtime evidence required')
 if a.runtime_config.is_symlink() or private.is_relative_to(ROOT) or private.stat().st_uid!=os.getuid() or private.stat().st_mode&0o777!=0o600:raise ValueError('Owned private 0600 runtime file required')
 cfg=json.loads(private.read_text());pub=json.loads(public_path.read_text());old_jar=Path(cfg['jar']).resolve();jar=a.jar.resolve();env=dict(cfg['environment']);old_pid=cfg['apiPid'];db=cfg['database'];pg=cfg['postgresContainer']
 if cfg.get('jarSha256')!=a.expected_old_sha256 or pub.get('jarSha256')!=a.expected_old_sha256 or sha(old_jar)!=a.expected_old_sha256:raise ValueError('Exact previous runtime artifact required')
 if not re.fullmatch(r'[a-f0-9]{64}',a.jar_sha256) or sha(jar)!=a.jar_sha256:raise ValueError('New frozen artifact hash mismatch')
 if old_pid!=a.expected_pid or pub.get('apiPid')!=old_pid or db!=a.expected_database or pub.get('database')!=db or not db.startswith('jxc_closure_ui_'):raise ValueError('Exact authorized PID/database required')
 if pub.get('productionDeployment') is not False or pub.get('originalM4M5Touched') is not False or pub.get('api')!=a.expected_api or pub.get('postgresContainer')!=pg:raise ValueError('Only the existing isolated UI fixture is supported')
 if env.get('JXC_DB_URL')!='jdbc:postgresql://127.0.0.1:'+str(pub['postgresPort'])+'/'+db or env.get('JXC_DB_USER')!='jxc_app' or env.get('JXC_PORT')!=api_port:raise ValueError('Private runtime connection changed')
 if str(env.get('JXC_ACCOUNTING_WORKER_ENABLED','false')).lower()=='true' or 'SPRING_APPLICATION_JSON' in env:raise ValueError('This fixture must not enable an independent accounting scheduler')
 if cfg.get('storageContainer')!=pub.get('storageContainer') or cfg.get('bucket')!=pub.get('bucket') or env.get('JXC_STORAGE_ENDPOINT')!='http://127.0.0.1:'+str(pub['storagePort']) or env.get('JXC_STORAGE_BUCKET')!=pub.get('bucket'):raise ValueError('Exact existing isolated storage endpoint and bucket required')
 if any(k in env for k in ('JXC_MIGRATION_USER','JXC_MIGRATION_PASSWORD','JXC_BOOTSTRAP_CONFIG_FILE','SPRING_FLYWAY_USER','SPRING_FLYWAY_PASSWORD')):raise ValueError('Runtime must contain only runtime credentials')
 old_migrations=migrations(old_jar);new_migrations=migrations(jar)
 null_append=a.reviewed_schema_upgrade in (NULL_APPEND_SCRIPT,ZERO_POSTING_SCRIPT)
 table_append=a.reviewed_schema_upgrade==ASSIGNMENT_SCRIPT
 if a.reviewed_schema_upgrade:
  append_count=reviewed_append(old_migrations,new_migrations,a.reviewed_schema_upgrade)
  contract=json.loads((ROOT/'jxc-server/scripts/m5/audit_contract_closure.json').read_text());pinned={row['script']:row['sha256'] for row in contract['migration_files']}
  if pinned!=new_migrations:raise ValueError('Upgrade artifact must match the complete audited migration bytes')
 else:
  if old_migrations!=new_migrations:raise ValueError('Jar-only restart refuses changed migration names or bytes')
  if len(new_migrations)==42:
   contract=json.loads((ROOT/'jxc-server/scripts/m5/audit_contract_closure.json').read_text())
   if {row['script']:row['sha256'] for row in contract['migration_files']}!=new_migrations:raise ValueError('42-migration artifact differs from the complete audited migration bytes')
 inspect=json.loads(run(['docker','inspect',pg]))[0];ports=inspect['NetworkSettings']['Ports'].get('5432/tcp',[])
 if inspect['Config']['Labels'].get('jxc.rehearsal')!='release-closure-ui' or not inspect['State']['Running'] or ports!=[{'HostIp':'127.0.0.1','HostPort':str(pub['postgresPort'])}]:raise ValueError('Exact labelled isolated PostgreSQL container required')
 storage=json.loads(run(['docker','inspect',cfg['storageContainer']]))[0]
 if storage['Config']['Labels'].get('jxc.rehearsal')!='release-closure-ui' or not storage['State']['Running'] or storage['NetworkSettings']['Ports'].get('9000/tcp')!=[{'HostIp':'127.0.0.1','HostPort':str(pub['storagePort'])}]:raise ValueError('Exact labelled isolated storage container required')
 command=shlex.split(run(['ps','-p',str(old_pid),'-o','command=']))
 if len(command)<3 or Path(command[0]).resolve()!=Path(a.java).resolve() or command[1]!='-jar' or Path(command[2]).resolve()!=old_jar or os.getpgid(old_pid)!=old_pid:raise ValueError('Exact owned Java process group required')
 expected_flags=['--jxc.jobs.enabled='+str(cfg['workerEnabled']).lower(),'--jxc.jobs.recovery.delay-ms=3000','--jxc.workbench.worker.assignments='+cfg['workbenchAssignment']]
 if command[3:]!=expected_flags:raise ValueError('Unexpected existing runtime flags')
 def listener():
  r=subprocess.run(['lsof','-nP','-iTCP:'+api_port,'-sTCP:LISTEN','-t'],capture_output=True,text=True,timeout=10);return r.stdout.strip().splitlines()
 if listener()!=[str(old_pid)]:raise ValueError('Port listener is not the exact authorized PID')
 def sql(q):return run(['docker','exec','-i',pg,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"+q+"\nCOMMIT;")
 identity=json.loads(sql("SELECT json_build_object('database',current_database(),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()));"))
 if identity!={'database':db,'systemIdentifier':a.expected_system_identifier}:raise ValueError('Exact isolated database cluster required')
 history=json.loads(sql("SELECT coalesce(json_agg(row_to_json(h) ORDER BY installed_rank),'[]') FROM flyway_schema_history h;"))
 if len(history)!=len(old_migrations) or any(row['success'] is not True or row['version'] is None for row in history) or {row['script'] for row in history}!=set(old_migrations):raise ValueError('Read-only migration history preflight failed')
 if len(new_migrations)==42 and not table_append:
  if schema_columns(sql)!=contract['tables']:raise ValueError('Existing 42-migration schema differs from the complete audited column set')
  if json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM ("+catalog_gaps_query(contract,'jxc_app')+") x;")):raise ValueError('Existing 42-migration schema differs from the complete audited catalog contract')
 if null_append:
  expected_columns=json.loads(json.dumps(contract['tables']))
  for table,columns in NULL_APPEND_COLUMNS.items():
   for column in columns:del expected_columns[table][column]
  if schema_columns(sql)!=expected_columns:raise ValueError('Previous schema differs from the exact reviewed pre-append column set')
 if table_append:
  if len(contract['tables'])!=192 or not ASSIGNMENT_TABLES<=set(contract['tables']):raise ValueError('Expected the complete reviewed 192-table assignment catalog')
  prior_contract=reviewed_assignment_preflight(sql,old_migrations)
  if prior_contract['tables']!={name:columns for name,columns in contract['tables'].items() if name not in ASSIGNMENT_TABLES}:raise ValueError('New catalog changed the original 190-table column set')
 evidence={'schemaVersion':1,'status':'preflight_passed','productionDeployment':False,'originalM4M5Touched':False,'businessWrites':0,'ddlExecuted':False,'migrationRunnerInvoked':False,'reviewedSchemaUpgrade':a.reviewed_schema_upgrade,'jarSha256':a.jar_sha256,'previousJarSha256':a.expected_old_sha256,'database':db,'systemIdentifier':identity['systemIdentifier'],'postgresContainerId':inspect['Id'],'storageContainerId':storage['Id'],'previousApiPid':old_pid,'migrationCount':len(old_migrations),'targetMigrationCount':len(new_migrations),'migrationSha256':new_migrations,'scriptSha256':sha(__file__),'createdAt':stamp()}
 if not a.execute:print(json.dumps(evidence));return
 if not a.operators_paused:raise ValueError('Coordinated operator pause required before process replacement')
 directory=private.parent;new_jar=directory/('runtime-'+a.jar_sha256[:16]+'.jar');shutil.copyfile(jar,new_jar);new_jar.chmod(0o600)
 if sha(new_jar)!=a.jar_sha256:raise ValueError('Copied runtime artifact hash mismatch')
 env['SPRING_FLYWAY_ENABLED']='false';children=[];old_stopped=False;upgrade_started=False;upgrade_verified=False
 def stop(pid):
  if os.getpgid(pid)!=pid:raise ValueError('Process group changed before stop')
  os.killpg(pid,signal.SIGTERM);deadline=time.monotonic()+25
  while time.monotonic()<deadline:
   r=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
   if r.returncode or r.stdout.strip().startswith('Z'):return
   time.sleep(.1)
  raise RuntimeError('Owned Java process did not stop gracefully')
 def facts(after_assignment=False):
  tables=set(contract['tables']) if len(new_migrations)==42 else None
  if table_append and not after_assignment:tables-=ASSIGNMENT_TABLES
  return fact_snapshot(sql,expected_tables=tables)
 def start(path,label,delay):
  log=directory/(label+'.log');log.touch(mode=0o600,exist_ok=True);log.chmod(0o600)
  flags=[expected_flags[0],'--jxc.jobs.recovery.delay-ms='+str(delay),expected_flags[2]]
  with log.open('ab') as stream:proc=subprocess.Popen([a.java,'-jar',str(path),*flags],env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
  children.append(proc);deadline=time.monotonic()+90
  while time.monotonic()<deadline:
   if proc.poll() is not None:raise RuntimeError('New UI process stopped; inspect private runtime log')
   try:
    with urllib.request.urlopen(pub['api']+'/actuator/health',timeout=2) as response:up=json.load(response).get('status')=='UP'
    if up and listener()==[str(proc.pid)]:return proc
   except (OSError,ValueError):pass
   time.sleep(.2)
  raise RuntimeError('New UI readiness timeout; inspect private runtime log')
 def save_runtime(proc,path,artifact):
  cfg.update(apiPid=proc.pid,jar=str(path),jarSha256=artifact,environment=env);write(private,cfg,True);pub.update(apiPid=proc.pid,previousJarSha256=a.expected_old_sha256,jarSha256=artifact,upgradedAt=stamp(),status='running',runtimeMigrationEnabled=False,runtimeHasMigrationCredentials=False,migrationCount=len(new_migrations) if evidence.get('ddlExecuted') else len(old_migrations));write(public_path,pub)
 try:
  # Recheck identity immediately before the only destructive operation: stopping our exact process.
  if shlex.split(run(['ps','-p',str(old_pid),'-o','command=']))!=command or listener()!=[str(old_pid)]:raise ValueError('Runtime changed during preflight')
  stop(old_pid);old_stopped=True
  if listener():raise ValueError('Authorized port did not become free')
  before=facts();expected=before
  if a.reviewed_schema_upgrade:
   credentials=Path(cfg['credentialsFile']).resolve()
   if credentials.is_relative_to(ROOT) or credentials.is_symlink() or credentials.stat().st_uid!=os.getuid() or credentials.stat().st_mode&0o777!=0o600:raise ValueError('Owned private 0600 migration credentials required')
   values=json.loads(credentials.read_text());migration_env=dict(env,JXC_MIGRATION_USER='jxc_owner',JXC_MIGRATION_PASSWORD=values['ownerPassword'],JXC_EXPECT_DATABASE=db)
   log=directory/('schema-upgrade-'+a.jar_sha256[:12]+'.log');log.touch(mode=0o600,exist_ok=True);log.chmod(0o600)
   upgrade_started=True;evidence.update(ddlAttempted=True,migrationRunnerInvoked=True,ddlExecuted=None)
   with log.open('wb') as stream:
    result=subprocess.run([a.java,'-Dloader.main=com.hs.jxc.migration.MigrationMain','-cp',str(new_jar),'org.springframework.boot.loader.launch.PropertiesLauncher'],env=migration_env,stdout=stream,stderr=subprocess.STDOUT,timeout=120)
   if result.returncode or not re.search(r'\{"status":"MIGRATED","migrationsExecuted":'+str(append_count)+r'\}',log.read_text()):raise ValueError('The exact one-shot migration did not report the reviewed applied migration count')
   history_after=json.loads(sql("SELECT coalesce(json_agg(row_to_json(h) ORDER BY installed_rank),'[]') FROM flyway_schema_history h;"))
   if len(history_after)!=len(new_migrations) or history_after[:-append_count]!=history or tuple(row['script'] for row in history_after[-append_count:])!=REVIEWED_UPGRADES[a.reviewed_schema_upgrade][2] or any(row['success'] is not True for row in history_after[-append_count:]):raise ValueError('Migration history is not the exact successful append')
   expected=facts(after_assignment=True);business=lambda rows:[row for row in rows if row['name']!='flyway_schema_history']
   comparison=expected
   if null_append:
    if schema_columns(sql)!=contract['tables']:raise ValueError('New schema differs from the complete audited column set')
    gaps=json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM ("+catalog_gaps_query(contract,'jxc_app')+") x;"))
    if gaps:raise ValueError('New schema differs from the complete audited catalog contract')
    null_counts=reviewed_null_column_counts(sql)
    if set(null_counts)!=set(NULL_APPEND_COLUMNS) or any(null_counts.values()):raise ValueError('Existing rows acquired a value in a reviewed new nullable column')
    comparison=fact_snapshot(sql,project_null_append=True)
    evidence.update(factComparison='EXACT_OLD_COLUMNS_WITH_REVIEWED_NULL_COLUMN_APPEND',reviewedAddedColumns={table:list(columns) for table,columns in NULL_APPEND_COLUMNS.items()},newColumnsNonNullRows=null_counts,oldColumnFactsAfterUpgrade=comparison,fullColumnFactsAfterUpgrade=expected,completePostMigrationCatalogVerified=True,contractSha256=sha(ROOT/'jxc-server/scripts/m5/audit_contract_closure.json'))
   if table_append:
    if schema_columns(sql)!=contract['tables']:raise ValueError('New schema differs from the complete audited column set')
    gaps=json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM ("+catalog_gaps_query(contract,'jxc_app')+") x;"))
    if gaps:raise ValueError('New schema differs from the complete audited catalog contract')
    comparison=reviewed_assignment_tables(before,expected)
    evidence.update(factComparison='EXACT_OLD_FACTS_WITH_TWO_EMPTY_ASSIGNMENT_TABLES',reviewedAddedTables=sorted(ASSIGNMENT_TABLES),newTablesEmpty=True,oldColumnFactsAfterUpgrade=comparison,fullColumnFactsAfterUpgrade=expected,completePostMigrationCatalogVerified=True,contractSha256=sha(ROOT/'jxc-server/scripts/m5/audit_contract_closure.json'),reviewedExistingUniqueAppend='ap_bill_country_book_id')
   if business(before)!=business(comparison):raise ValueError('Schema-only upgrade changed old business columns or sequence state')
   evidence.update(ddlExecuted=True,migrationRunnerInvoked=True,migrationsExecuted=append_count,migrationHistoryAppendOnly=True,migrationHistoryBefore=history,migrationHistoryAfter=history_after,previousMigrationCount=len(old_migrations),migrationCount=len(new_migrations))
   upgrade_verified=True
  probe=start(new_jar,'runtime-jar-verify-'+a.jar_sha256[:12],3600000);after=facts(after_assignment=True);evidence.update(beforeFacts=before,afterFacts=after)
  if expected!=after:raise ValueError('Application facts or sequence state changed during runtime-only startup')
  stop(probe.pid);probe.wait(timeout=10);active=start(new_jar,'runtime-'+a.jar_sha256[:12],3000);save_runtime(active,new_jar,a.jar_sha256)
  table_count=len(contract['tables']) if len(new_migrations)==42 else 190
  evidence.update(status='passed',apiPid=active.pid,verificationApiPid=probe.pid,operatorsPaused=True,tableFactsUnchanged=True,applicationTables=table_count,allPublicTablesIncludingFlyway=table_count+1,sequenceStateUnchanged=True,migrationHistoryUnchanged=not bool(a.reviewed_schema_upgrade),sameDatabasePreserved=True,temporaryVerificationPollDelayMs=3600000,originalWorkerSettingsRestored=True,workerEnabled=cfg['workerEnabled'],workbenchAssignment=cfg['workbenchAssignment'],runtimeMigrationEnabled=False,runtimeHasMigrationCredentials=False,health='UP',beforeFacts=before,afterFacts=after,completedAt=stamp())
  write_evidence(a.output,evidence);print(json.dumps({'status':'passed','jarSha256':a.jar_sha256,'apiPid':active.pid,'applicationTablesUnchanged':190 if table_append else table_count,'migrationCount':len(new_migrations),'output':str(a.output)}))
 except BaseException:
  for child in children:
   if child.poll() is None:
    try:stop(child.pid);child.wait(timeout=10)
    except BaseException:pass
  evidence.update(status='failed',completedAt=stamp(),error='Controlled UI runtime replacement failed; private logs retained')
  if old_stopped and not listener() and previous_runtime_fallback_allowed(upgrade_started,upgrade_verified,a.reviewed_schema_upgrade):
   try:
    fallback=start(old_jar,'runtime-fallback-'+a.expected_old_sha256[:12],3000);save_runtime(fallback,old_jar,a.expected_old_sha256);evidence.update(previousJarRestored=True,fallbackApiPid=fallback.pid)
   except BaseException:evidence['previousJarRestored']=False
  if old_stopped and not evidence.get('previousJarRestored'):
   pub.update(status='stopped',apiPid=None,previousApiPid=old_pid,failedTargetJarSha256=a.jar_sha256,failedAt=stamp(),restartFailureEvidence=str(a.output),migrationCount=len(new_migrations) if upgrade_verified else None if upgrade_started else len(old_migrations));write(public_path,pub)
  write_evidence(a.output,evidence);raise

if __name__=='__main__':main()
