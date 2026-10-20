#!/usr/bin/env python3
"""Exercise a real runtime-only API crash and durable worker recovery in NEW labelled containers.

Copies the supplied current jar, provisions a new PostgreSQL database with the existing
provision-db.sql, creates a separate private MinIO bucket, then removes only its own
resources on success. Credentials remain in an external private directory and are never
written to the evidence JSON. No existing M4, M5, or production resource is accessed.
"""
from pathlib import Path
import argparse, datetime as dt, hashlib, importlib.util, json, os, secrets, shutil, signal, socket, subprocess, tempfile, time, urllib.error, urllib.request, uuid

ROOT = Path(__file__).resolve().parents[4]
PG_IMAGE = 'postgres:16-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'
S3_IMAGE = 'minio/minio:RELEASE.2024-10-13T13-34-11Z@sha256:9535594ad4122b7a78c6632788a989b96d9199b483d3bd71a5ceae73a922cdfa'

class RehearsalError(RuntimeError): pass

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar', type=Path, default=ROOT/'jxc-server/jxc-app/target/jxc-app-0.1.0-SNAPSHOT.jar')
    parser.add_argument('--output', type=Path, default=ROOT/'docs/backend/evidence/release-worker-recovery.json')
    parser.add_argument('--java', default='/opt/homebrew/opt/openjdk/bin/java')
    parser.add_argument('--keep', action='store_true', help='Keep only this run\'s new containers for independent inspection')
    args = parser.parse_args()
    jar = args.jar.resolve()
    if not jar.is_file(): raise RehearsalError('Current application jar is missing')
    suffix = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S')+'-'+secrets.token_hex(3)
    name = 'hengshuo-closure-worker-'+suffix
    pg, minio = name+'-pg', name+'-s3'
    database, bucket = 'jxc_closure_worker_'+suffix.replace('-','_'), 'closure-worker-'+suffix
    private = Path(tempfile.mkdtemp(prefix='hengshuo-closure-worker-'))
    private.chmod(0o700)
    snapshot = private/'runtime.jar'; source_hash=hashlib.sha256(jar.read_bytes()).hexdigest(); shutil.copyfile(jar, snapshot)
    jar_hash = hashlib.sha256(snapshot.read_bytes()).hexdigest()
    if source_hash!=jar_hash or source_hash!=hashlib.sha256(jar.read_bytes()).hexdigest(): raise RehearsalError('Application artifact changed during snapshot; rerun after build completes')
    pg_password, owner_password, app_password = (secrets.token_hex(24) for _ in range(3))
    access, secret, token, new_token = (secrets.token_hex(24) for _ in range(4))
    digest = lambda value: hashlib.sha256(value.encode()).hexdigest()
    hidden = [pg_password, owner_password, app_password, access, secret, token, new_token, digest(token), digest(new_token)]
    clean = lambda text: __import__('functools').reduce(lambda value, item: value.replace(item, '[REDACTED]'), hidden, str(text))
    processes, containers, steps = [], [], []
    evidence = {'status':'in_progress','startedAt':dt.datetime.now(dt.timezone.utc).isoformat(), 'mode':'new isolated synthetic separate-process rehearsal', 'productionDeployment':False, 'jarSha256':jar_hash, 'database':database, 'postgresContainer':pg, 'storageContainer':minio, 'bucket':bucket, 'steps':steps}
    def mark(step, **values):
        entry = {'step':step, 'at':dt.datetime.now(dt.timezone.utc).isoformat(), **values}
        steps.append(entry); print(json.dumps(entry, ensure_ascii=False), flush=True)
    def run(command, data=None, env=None, timeout=60):
        result = subprocess.run(command, input=data, text=True, capture_output=True, env=env, timeout=timeout)
        if result.returncode: raise RehearsalError(clean(result.stderr[-3000:] or result.stdout[-3000:] or 'Command failed'))
        return result.stdout.strip()
    def sql(query, user='postgres'):
        return run(['docker','exec','-i',pg,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',user,'-d',database], query)
    def scalar(query): return sql(query).splitlines()[-1]
    def wait(predicate, seconds=60, description='state'):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            try:
                result=predicate()
                if result: return result
            except (urllib.error.URLError, ConnectionError, TimeoutError): pass
            time.sleep(0.2)
        raise RehearsalError('Timed out waiting for '+description)
    def free_port():
        with socket.socket() as sock: sock.bind(('127.0.0.1',0)); return sock.getsockname()[1]
    api_port=free_port()
    def api(path, method='GET', body=None, intent=None, bearer=None):
        headers={'Authorization':'Bearer '+(bearer or token),'X-Country-Id':'101'}
        if intent: headers['Idempotency-Key']=intent
        data=None if body is None else json.dumps(body).encode()
        if data is not None: headers['Content-Type']='application/json'
        request=urllib.request.Request(f'http://127.0.0.1:{api_port}'+path,data=data,headers=headers,method=method)
        try:
            with urllib.request.urlopen(request,timeout=10) as response: return response.status,json.load(response)
        except urllib.error.HTTPError as error: return error.code,json.load(error)
    def start(label, enabled=False, migration=False):
        env={key:value for key,value in os.environ.items() if not key.startswith(('JXC_','SPRING_','PG'))}
        env.update(JXC_BIND_ADDRESS='127.0.0.1',JXC_PORT=str(api_port),JXC_DB_URL=f'jdbc:postgresql://127.0.0.1:{pg_port}/{database}',JXC_DB_USER='jxc_app',JXC_DB_PASSWORD=app_password,SPRING_FLYWAY_ENABLED=str(migration).lower(),JXC_STORAGE_ENDPOINT=f'http://127.0.0.1:{s3_port}',JXC_STORAGE_ACCESS_KEY=access,JXC_STORAGE_SECRET_KEY=secret,JXC_STORAGE_BUCKET=bucket,JXC_BANK_ENCRYPTION_KEY=__import__('base64').b64encode(secrets.token_bytes(32)).decode())
        if migration: env.update(JXC_MIGRATION_USER='jxc_owner',JXC_MIGRATION_PASSWORD=owner_password)
        log=private/(label+'.log')
        with log.open('ab') as stream: proc=subprocess.Popen([args.java,'-jar',str(snapshot),'--jxc.jobs.enabled='+str(enabled).lower(),'--jxc.jobs.recovery.delay-ms=1000'],env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
        processes.append(proc)
        def healthy():
            if proc.poll() is not None: raise RehearsalError(clean(log.read_text(errors='replace')[-4000:]))
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{api_port}/actuator/health',timeout=2) as response: return json.load(response).get('status')=='UP'
            except urllib.error.URLError: return False
        wait(healthy,60,'API health '+label)
        time.sleep(0.3)
        if proc.poll() is not None: raise RehearsalError(clean(log.read_text(errors='replace')[-4000:]))
        mark('api-started', label=label,pid=proc.pid,workerEnabled=enabled,flywayEnabled=migration,runtimeDatabaseUser='jxc_app')
        return proc
    def stop(proc, kill=False):
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL if kill else signal.SIGTERM)
            try: proc.wait(timeout=15)
            except subprocess.TimeoutExpired: os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=10)
        if kill and proc.returncode!=-signal.SIGKILL: raise RehearsalError('Expected actual SIGKILL exit')
    def job_counts(job):
        return json.loads(scalar(f"SELECT json_build_object('results',(SELECT count(*) FROM sys_job_result WHERE job_id={job}),'notices',(SELECT count(*) FROM sys_notification WHERE job_id={job}),'events',(SELECT count(*) FROM sys_biz_event WHERE source_type='SYS_REPORT_EXPORT' AND source_id={job}),'consumeStatus',c.status,'attempts',c.attempt_count) FROM sys_biz_event e JOIN sys_biz_event_consume c ON c.event_id=e.id AND c.consumer='SYS_EXPORT' WHERE e.source_type='SYS_REPORT_EXPORT' AND e.source_id={job};"))
    def role(allowed):
        perms=['fin:ledger:view','sys:worker:view']+(['fin:ledger:export'] if allowed else [])
        sql("BEGIN;SELECT country_id FROM sys_authz_epoch WHERE country_id=101 FOR UPDATE;UPDATE sys_role SET permissions='"+json.dumps(perms)+"'::jsonb,version=version+1 WHERE id=202;UPDATE sys_authz_epoch SET epoch=epoch+1 WHERE country_id=101;COMMIT;")
    succeeded=False
    try:
        env=dict(os.environ,POSTGRES_PASSWORD=pg_password,MINIO_ROOT_USER=access,MINIO_ROOT_PASSWORD=secret)
        run(['docker','run','-d','--name',pg,'--label','jxc.rehearsal=release-closure-worker','-e','POSTGRES_PASSWORD','-e','POSTGRES_DB='+database,'-p','127.0.0.1::5432',PG_IMAGE],env=env);containers.append(pg)
        run(['docker','run','-d','--name',minio,'--label','jxc.rehearsal=release-closure-worker','-e','MINIO_ROOT_USER','-e','MINIO_ROOT_PASSWORD','-p','127.0.0.1::9000',S3_IMAGE,'server','/data'],env=env);containers.append(minio)
        pg_port=int(run(['docker','port',pg,'5432/tcp']).rsplit(':',1)[1]);s3_port=int(run(['docker','port',minio,'9000/tcp']).rsplit(':',1)[1])
        def pg_ready(): return subprocess.run(['docker','exec',pg,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database],capture_output=True).returncode==0
        wait(pg_ready,30,'new PostgreSQL')
        provision=(ROOT/'jxc-server/scripts/provision-db.sql').read_text()
        run(['docker','exec','-i',pg,'psql','-X','-q','-v','ON_ERROR_STOP=1','-v','expected_database='+database,'-U','postgres','-d',database],provision)
        sql(f"ALTER ROLE jxc_owner PASSWORD '{owner_password}';ALTER ROLE jxc_app PASSWORD '{app_password}';")
        def s3_ready():
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{s3_port}/minio/health/ready',timeout=2) as response:return response.status==200
            except urllib.error.URLError:return False
        wait(s3_ready,30,'new MinIO')
        spec=importlib.util.spec_from_file_location('existing_recovery_s3',ROOT/'jxc-server/scripts/m5/recovery.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        helper.S3({'endpoint':f'http://127.0.0.1:{s3_port}','bucket':bucket,'accessKey':access,'secretKey':secret}).request('PUT')
        mark('isolated-resources-provisioned',database=database,postgresContainer=pg,storageContainer=minio,bucket=bucket,existingProvisionHelper='jxc-server/scripts/provision-db.sql',existingS3Adapter='jxc-server/scripts/m5/recovery.py')
        migration=start('schema-migration',migration=True);stop(migration)
        evidence['migrations']=json.loads(scalar("SELECT json_agg(json_build_object('version',version,'script',script,'checksum',checksum) ORDER BY installed_rank) FROM flyway_schema_history WHERE success;"))
        role_facts=json.loads(sql("SELECT json_build_object('role',current_user,'superuser',rolsuper,'bypassRls',rolbypassrls,'createRole',rolcreaterole,'createDb',rolcreatedb) FROM pg_roles WHERE rolname=current_user;",user='jxc_app'))
        assert role_facts=={'role':'jxc_app','superuser':False,'bypassRls':False,'createRole':False,'createDb':False}
        evidence['runtimeRole']=role_facts
        sql(f"""INSERT INTO md_currency(code,name,decimals) VALUES('MXN','Synthetic peso',2);
INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(101,'CLOSUREWORKER','Synthetic worker country','MXN','UTC','ACTIVE');
INSERT INTO sys_authz_epoch(country_id) VALUES(101);INSERT INTO sys_user(id,username,password_hash,display_name,status) VALUES(201,'closure-worker-owner','unused','Synthetic worker owner','ENABLED');
INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES('{digest(token)}',201,clock_timestamp()+interval '1 hour');
INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(202,101,'CLOSUREWORKER','Synthetic worker role','["fin:ledger:view","fin:ledger:export","sys:worker:view"]','{{"COST":"WRITE","ORDER_TOTAL":"WRITE"}}');
INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(101,201,202);INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(101,201,'COUNTRY_ALL',201);
INSERT INTO org_entity(id,country_id,code,name) VALUES(301,101,'E','Synthetic worker entity');INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(601,101,301,'B','Synthetic worker book','MXN','ACTIVE');
INSERT INTO fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(701,101,601,2026,10,'2026-10-01','2026-10-31','OPEN');""")
        proc=start('queue-only',False)
        body={'bookId':601,'periodId':701};intent=str(uuid.uuid4());status,response=api('/api/v1/fin/ledgers/general/export','POST',body,intent);assert status==200,response
        job=int(response['data']['id']);again=api('/api/v1/fin/ledgers/general/export','POST',body,intent);assert again[0]==200 and int(again[1]['data']['id'])==job
        immutable_before=scalar(f'SELECT md5(row_to_json(j)::text) FROM sys_export_job j WHERE id={job};')
        assert scalar(f'SELECT count(*) FROM sys_job_result WHERE job_id={job};')=='0'
        mark('durable-idempotent-job-queued',jobId=job,duplicateRequestReturnedSameId=True,results=0)
        stop(proc)
        lock_name='closure_worker_lock_'+suffix.replace('-','_')
        lock_sql=f"SET application_name='{lock_name}';BEGIN;LOCK TABLE sys_job_result IN SHARE MODE;SELECT pg_sleep(300);ROLLBACK;"
        lockproc=subprocess.Popen(['docker','exec','-i',pg,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,text=True)
        lockproc.stdin.write(lock_sql);lockproc.stdin.close()
        wait(lambda:scalar(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{lock_name}' AND wait_event='PgSleep';")=='1',10,'new-database lock')
        proc=start('effect-blocked',True)
        wait(lambda:scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'INSERT INTO sys_job_result%' AND wait_event_type='Lock';")=='1',15,'actual blocked effect transaction')
        before=job_counts(job);assert before['consumeStatus']=='PROCESSING' and before['results']==0 and before['notices']==0,before
        mark('committed-lease-effect-uncommitted',jobId=job,**before)
        stop(proc,kill=True);sql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='{lock_name}';")
        try:lockproc.wait(timeout=10)
        except subprocess.TimeoutExpired:lockproc.kill()
        after=job_counts(job);assert after['consumeStatus']=='PROCESSING' and after['results']==0 and after['notices']==0,after
        mark('api-sigkill-effect-rolled-back',jobId=job,signal='SIGKILL',exitCode=proc.returncode,**after)
        wait(lambda:scalar(f"SELECT (c.updated_at<clock_timestamp()-interval '30 seconds')::text FROM sys_biz_event e JOIN sys_biz_event_consume c ON c.event_id=e.id AND c.consumer='SYS_EXPORT' WHERE e.source_id={job} AND e.source_type='SYS_REPORT_EXPORT';")=='true',40,'real 30-second lease expiry')
        inspector=start('stale-state-inspection',False)
        stale=api('/api/v1/sys/jobs/worker-status');assert stale[0]==200,stale
        evidence['staleWorkerStatus']=stale[1]['data'];stop(inspector)
        proc=start('recovery-runtime-only',True)
        wait(lambda:scalar(f'SELECT count(*) FROM sys_job_result WHERE job_id={job};')=='1',45,'restart recovery')
        recovered=job_counts(job);assert recovered['consumeStatus']=='DONE' and recovered['results']==recovered['notices']==recovered['events']==1 and recovered['attempts']==2,recovered
        assert scalar(f'SELECT md5(row_to_json(j)::text) FROM sys_export_job j WHERE id={job};')==immutable_before
        mark('restart-recovered-one-effect',jobId=job,immutableRequestPreserved=True,**recovered)
        role(False);denied=api(f'/api/v1/sys/jobs/{job}/download');reenqueue=api('/api/v1/fin/ledgers/general/export','POST',body,intent);assert denied[0]==reenqueue[0]==403,(denied,reenqueue)
        mark('current-permission-revocation-blocks-cached-download-and-replay',downloadStatus=denied[0],replayStatus=reenqueue[0]);role(True);stop(proc)
        proc=start('queue-revoked-effect',False)
        intent2=str(uuid.uuid4());queued=api('/api/v1/fin/ledgers/general/export','POST',body,intent2);assert queued[0]==200,queued;job2=int(queued[1]['data']['id']);role(False);stop(proc)
        proc=start('revoked-effect-runtime-only',True)
        wait(lambda:scalar(f"SELECT count(*) FROM sys_biz_event e JOIN sys_biz_event_consume c ON c.event_id=e.id AND c.consumer='SYS_EXPORT' WHERE e.source_type='SYS_REPORT_EXPORT' AND e.source_id={job2} AND c.status='FAILED';")=='1',20,'revoked current subject failure')
        failed=job_counts(job2);assert failed['results']==failed['notices']==0,failed
        failure_status=api('/api/v1/sys/jobs/worker-status');assert failure_status[0]==200,failure_status;evidence['failedWorkerStatus']=failure_status[1]['data']
        mark('revoked-current-permissions-stop-effect',jobId=job2,**failed)
        sql(f"UPDATE sys_session SET revoked_at=clock_timestamp() WHERE token_hash='{digest(token)}';INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES('{digest(new_token)}',201,clock_timestamp()+interval '1 hour');");role(True)
        retry=api(f'/api/v1/sys/jobs/{job2}/retry','POST',{},str(uuid.uuid4()),new_token);assert retry[0]==200,retry
        wait(lambda:scalar(f'SELECT count(*) FROM sys_job_result WHERE job_id={job2};')=='1',20,'new owner session retry')
        second=job_counts(job2);assert second['results']==second['notices']==second['events']==1 and second['consumeStatus']=='DONE',second
        assert scalar(f"SELECT count(*) FROM sys_job_execution_intent WHERE job_id={job2} AND session_hash='{digest(new_token)}';")=='1'
        mark('explicit-new-owner-session-retry-recovers-original-job',jobId=job2,executionIntents=1,**second)
        assert scalar('SELECT count(*) FROM fin_voucher;')=='0'
        evidence.update(status='passed',finishedAt=dt.datetime.now(dt.timezone.utc).isoformat(),sameEffectJobId=job,newSessionJobId=job2,sourceEventCount=2,jobResultCount=2,notificationCount=2,accountingVoucherCount=0,runtimeProcesses=[{'pid':p.pid,'exitCode':p.returncode} for p in processes],privateLogsOutsideWorkspace=True)
        evidence['staleAlertVerified']=any(a.get('code') in ('STALE_LEASE','WORKER_STALE','STALE_EFFECT') for a in evidence['staleWorkerStatus'].get('alerts',[]))
        evidence['failedAlertVerified']=any(a.get('code')=='FAILED_EFFECT' for a in evidence['failedWorkerStatus'].get('alerts',[]))
        if not evidence['staleAlertVerified'] or not evidence['failedAlertVerified']: raise RehearsalError('The runtime artifact did not expose the actual stale and failed effect alerts')
        stop(proc);succeeded=True
    finally:
        for proc in processes:
            try:stop(proc)
            except Exception:pass
        if not succeeded: evidence['status']='failed'
        evidence['runtimeProcesses']=[{'pid':p.pid,'exitCode':p.returncode} for p in processes]
        evidence['resourcesRetained']=args.keep or not succeeded
        if succeeded and not args.keep:
            for container in containers:
                label=run(['docker','inspect','--format','{{index .Config.Labels "jxc.rehearsal"}}',container])
                if label!='release-closure-worker':raise RehearsalError('Unexpected cleanup ownership label')
                run(['docker','rm','-f',container])
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
        if not succeeded:print(json.dumps({'status':'failed','privateDiagnostics':str(private),'evidence':str(args.output)}),flush=True)
    print(json.dumps({'status':'passed','evidence':str(args.output),'jarSha256':jar_hash,'newResourcesRemoved':not args.keep}),flush=True)

if __name__=='__main__':
    try:main()
    except Exception as error:raise SystemExit('Worker rehearsal failed: '+str(error))
