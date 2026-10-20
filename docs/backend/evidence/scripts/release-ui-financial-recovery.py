#!/usr/bin/env python3
"""Restore the existing isolated UI's NONEMPTY native financial data to a new target.

Thin adapter over the original V008 gate/M5 backup/guarded restore/replay. It never
creates financial facts. The source survives; this is separate from source-loss
rehearsal. Execution requires a coordinated pause and the exact current runtime.
"""
from pathlib import Path
import argparse, datetime as dt, hashlib, importlib.util, json, os, re, secrets
import shlex, signal, subprocess, sys, tempfile, time, urllib.request, uuid

ROOT=Path(__file__).resolve().parents[4]
TECHNICAL_GATE_NAMES=frozenset(('sys_write_control','sys_write_control_log','sys_write_control_log_id_seq'))

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

def require_financial_chain(value):
    for key in ('frozenAssignmentCount','frozenLineCount','generatedAssignmentCount','linkedVoucherLineCount'):
        if type(value.get(key)) is not int or value[key]<1:raise ValueError('Native nonempty FROZEN assignment/result/voucher chain is required')
    if type(value.get('brokenLinkCount')) is not int or value['brokenLinkCount']!=0 or not re.fullmatch('[0-9a-f]{64}',str(value.get('graphSha256',''))):raise ValueError('Financial identity graph is incomplete')
    return value

def business_projection(rows):
    keys=[(row['kind'],row['name']) for row in rows]
    if len(set(keys))!=len(keys):raise ValueError('Duplicate snapshot objects')
    return sorted((row for row in rows if row['name'] not in TECHNICAL_GATE_NAMES),key=lambda row:(row['kind'],row['name']))

def technical_projection(rows):
    business_projection(rows)  # Reuse duplicate-object rejection.
    result=sorted((row for row in rows if row['name'] in TECHNICAL_GATE_NAMES),key=lambda row:(row['kind'],row['name']))
    if {(row['kind'],row['name']) for row in result}!={('table','sys_write_control'),('table','sys_write_control_log'),('sequence','sys_write_control_log_id_seq')}:raise ValueError('Exact three source gate technical objects are required')
    return result

def refreeze_after_stop_attempt(ops):
    try:ops.stop_started_source()
    finally:ops.refreeze_source()

def run_sequence(ops):
    ops.stop_source()
    try:
        ops.freeze_source();ops.backup_restore_verify();ops.verify_source();ops.cleanup_target()
        ops.resume_source();ops.start_source()
    except BaseException:
        if ops.source_opened:refreeze_after_stop_attempt(ops)
        raise

FINANCIAL_TABLES=('ap_cost_assignment','ap_cost_assignment_line','ap_bill','ap_bill_line','ap_source_claim','cst_inbound_cost','cst_cost_confirmation','sys_biz_event','fin_event_result','fin_voucher','fin_voucher_line')
# Hash PostgreSQL's exact numeric JSON text; no Python float conversion or economic calculation.
FINANCIAL_SQL="""WITH a AS (SELECT * FROM ap_cost_assignment WHERE status='FROZEN')
SELECT json_build_object(
 'frozenAssignmentCount',(SELECT count(*) FROM a),
 'frozenLineCount',(SELECT count(*) FROM ap_cost_assignment_line l JOIN a ON (a.country_id,a.book_id,a.id)=(l.country_id,l.book_id,l.assignment_id)),
 'generatedAssignmentCount',(SELECT count(*) FROM a JOIN fin_event_result r ON (r.country_id,r.book_id,r.event_id)=(a.country_id,a.book_id,a.frozen_event_id) JOIN fin_voucher v ON (v.country_id,v.book_id,v.id)=(r.country_id,r.book_id,r.voucher_id) WHERE r.status='GENERATED'),
 'linkedVoucherLineCount',(SELECT count(*) FROM a JOIN fin_event_result r ON (r.country_id,r.book_id,r.event_id)=(a.country_id,a.book_id,a.frozen_event_id) JOIN fin_voucher_line l ON (l.country_id,l.book_id,l.voucher_id)=(r.country_id,r.book_id,r.voucher_id) WHERE r.status='GENERATED'),
 'brokenLinkCount',(SELECT count(*) FROM a WHERE NOT EXISTS(SELECT 1 FROM ap_cost_assignment_line l WHERE (l.country_id,l.book_id,l.assignment_id)=(a.country_id,a.book_id,a.id)) OR NOT EXISTS(SELECT 1 FROM fin_event_result r WHERE (r.country_id,r.book_id,r.event_id)=(a.country_id,a.book_id,a.frozen_event_id) AND r.status IN ('GENERATED','NO_VOUCHER'))),
 'graphSha256',encode(pg_catalog.sha256(convert_to(jsonb_build_object("""+','.join("'"+name+"',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE \"C\"),'[]'::jsonb) FROM "+name+' t)' for name in FINANCIAL_TABLES)+")::text,'UTF8')),'hex'));"

class Rehearsal:
    def __init__(self,args):
        self.args=args;self.logical=module('ui_financial_logical',ROOT/'docs/backend/evidence/scripts/release-logical-recovery.py')
        self.runtime=module('ui_financial_runtime',ROOT/'docs/backend/evidence/scripts/release-ui-restart.py')
        self.recovery=module('ui_financial_core',ROOT/'jxc-server/scripts/m5/recovery.py')
        self.production=module('ui_financial_production',ROOT/'jxc-server/scripts/m5/production.py')
        self.gate=module('ui_financial_gate',ROOT/'jxc-server/scripts/m5/write_gate.py')
        self.private=Path(tempfile.mkdtemp(prefix='hengshuo-ui-financial-'));self.private.chmod(0o700)
        self.cfg=json.loads(args.runtime_config.read_text());self.pub=json.loads((ROOT/'docs/backend/evidence/release-ui-runtime.json').read_text())
        self.env=dict(self.cfg['environment']);self.source_opened=False;self.source_stopped=False;self.source_stop_attempted=False;self.active=None
        self.suffix=uuid.uuid4().hex[:12];self.label='com.hengshuo.logical-recovery='+self.suffix
        self.target_names=['hengshuo-closure-logical-'+self.suffix+'-'+kind for kind in ('target','target-objects')]
        self.target=None;self.containers=[];self.batch=str(uuid.uuid4())
        self.source={'container':self.cfg['postgresContainer'],'database':self.cfg['database'],'adminUser':'postgres','ownerRole':'jxc_owner','runtimeRole':'jxc_app','storage':{'endpoint':self.env['JXC_STORAGE_ENDPOINT'],'bucket':self.env['JXC_STORAGE_BUCKET'],'accessKey':self.env['JXC_STORAGE_ACCESS_KEY'],'secretKey':self.env['JXC_STORAGE_SECRET_KEY']}}
        self.contract=json.loads((ROOT/'jxc-server/scripts/m5/audit_contract_closure.json').read_text());self.tables=set(self.contract['tables'])
        self.evidence={'schemaVersion':1,'status':'running','mode':'EXISTING_ISOLATED_UI_NONEMPTY_FINANCIAL_RESTORE','productionReleased':False,'productionDeployment':False,'sourceDestroyed':False,'sourceSecretsDestroyed':False,'sourceBusinessCommands':0,'jarSha256':args.jar_sha256,'batchId':self.batch,'sourceDatabase':self.source['database'],'sourceApiPidBefore':args.expected_pid,'targetResourceNames':self.target_names,'allowedSourceTechnicalChanges':sorted(TECHNICAL_GATE_NAMES),'scriptSha256':self.runtime.sha(__file__)}

    def command(self,argv,data=None,env=None,timeout=90):
        value=subprocess.run(argv,input=data,text=True,capture_output=True,env=env,timeout=timeout)
        if value.returncode:
            self.recovery.write_private(self.private/('command-failure-'+uuid.uuid4().hex+'.txt'),(value.stdout+'\n'+value.stderr).encode())
            raise RuntimeError('Owned rehearsal command failed; inspect private diagnostics: '+argv[0])
        return value.stdout.strip()

    def sql(self,target,query,readonly=True):
        prefix="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL timezone='UTC';" if readonly else ''
        return self.command(['docker','exec','-i',target['container'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',target['database']],prefix+query+('COMMIT;' if readonly else ''))

    def snapshot(self,target):return self.runtime.fact_snapshot(lambda q:self.sql(target,q),expected_tables=self.tables)
    def financial(self,target):return require_financial_chain(json.loads(self.sql(target,FINANCIAL_SQL)))
    def gate_state(self):return self.gate.query(self.source,'BEGIN READ ONLY;'+self.gate.STATE_SQL+'COMMIT;')

    def record_technical_snapshot(self,phase,state,rows):
        stages=self.evidence.setdefault('sourceTechnicalSnapshots',{})
        stages[phase]={'gate':{key:state.get(key) for key in ('mode','batch_id','epoch')},'objects':technical_projection(rows)}
        if phase=='resumed':
            changes={}
            for label,left,right in [('beforeToFrozen','before','frozen'),('frozenToResumed','frozen','resumed')]:
                old={(row['kind'],row['name']):row for row in stages[left]['objects']}
                new={(row['kind'],row['name']):row for row in stages[right]['objects']}
                changes[label]=[{'kind':key[0],'name':key[1],'before':old[key],'after':new[key]} for key in sorted(old) if old[key]!=new[key]]
            self.evidence['sourceTechnicalChanges']=changes

    def preflight(self):
        context=json.loads(self.command(['docker','context','inspect']))[0]
        if not context['Endpoints']['docker']['Host'].startswith('unix://') or (os.environ.get('DOCKER_HOST') and not os.environ['DOCKER_HOST'].startswith('unix://')):raise ValueError('Only the local Unix Docker endpoint is supported')
        # Reuse the exact existing PID/role/secret/DB/S3/catalog/artifact validator; no --execute.
        cmd=[sys.executable,str(ROOT/'docs/backend/evidence/scripts/release-ui-restart.py'),'--runtime-config',str(self.args.runtime_config),'--jar',self.cfg['jar'],'--jar-sha256',self.args.jar_sha256,'--expected-pid',str(self.args.expected_pid),'--expected-database',self.args.expected_database,'--expected-system-identifier',self.args.expected_system_identifier,'--expected-old-sha256',self.args.jar_sha256]
        checked=json.loads(self.command(cmd));
        if checked['status']!='preflight_passed' or checked['migrationCount']!=42 or checked['targetMigrationCount']!=42 or checked['ddlExecuted'] is not False:raise ValueError('Exact current same-schema42 preflight required')
        state=self.gate_state()
        if state['mode']!='OPEN' or state['missing_gates']!=[]:raise ValueError('Source must initially be OPEN with complete write gates')
        self.open_state=state
        self.financial_before=self.financial(self.source)
        self.evidence.update(financialBefore=self.financial_before,preflight='passed',sourceWriteModeBefore='OPEN')

    def stop_pid(self,pid,jar,must_listen=True):
        command=shlex.split(self.command(['ps','-p',str(pid),'-o','command=']))
        flags=['--jxc.jobs.enabled='+str(self.cfg['workerEnabled']).lower(),'--jxc.jobs.recovery.delay-ms=3000','--jxc.workbench.worker.assignments='+self.cfg['workbenchAssignment']]
        listener=self.command(['lsof','-nP','-iTCP:18100','-sTCP:LISTEN','-t']) if must_listen else str(pid)
        if len(command)<3 or Path(command[0]).resolve()!=Path(self.args.java).resolve() or command[1]!='-jar' or Path(command[2]).resolve()!=Path(jar).resolve() or command[3:]!=flags or os.getpgid(pid)!=pid or listener!=str(pid):raise ValueError('Exact owned runtime process changed')
        os.killpg(pid,signal.SIGTERM);until=time.monotonic()+25
        while time.monotonic()<until:
            check=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
            if check.returncode or check.stdout.strip().startswith('Z'):return
            time.sleep(.1)
        raise RuntimeError('Owned UI process did not stop')

    def stop_source(self):
        # The parent requires a second fresh native preflight immediately before stop.
        self.preflight();self.source_stop_attempted=True;self.stop_pid(self.args.expected_pid,self.cfg['jar']);self.source_stopped=True
        self.before=self.snapshot(self.source)
        self.record_technical_snapshot('before',self.open_state,self.before)

    def transition(self,mode):
        state=self.gate_state()
        if mode=='OPEN':
            if state['mode']!='FROZEN' or state['batch_id']!=self.batch or state['epoch']!=self.frozen['epoch']:raise ValueError('Only this exact frozen source batch/epoch may resume')
            # Treat an ambiguous commit as OPEN until explicitly re-frozen; never
            # rely on the following observation succeeding to set the safety fence.
            self.source_opened=True
        elif mode=='FROZEN':
            if state['mode']!='OPEN' or state['epoch']!=self.open_state['epoch'] or state['batch_id']!=self.open_state['batch_id']:raise ValueError('Source OPEN epoch changed before freeze')
        else:raise ValueError('Unsupported source write transition')
        self.gate.query(self.source,"SELECT jxc_set_write_mode('"+mode+"',"+str(state['epoch'])+",'"+self.batch+"'::uuid,'isolated-ui-financial-recovery','reviewed full financial recovery');")
        observed=self.gate_state()
        if observed['mode']!=mode or observed['batch_id']!=self.batch or observed['epoch']!=state['epoch']+1:raise ValueError('Source CAS write transition was not observed')
        if mode=='OPEN':self.open_state=observed
        return observed

    def freeze_source(self):
        state=self.transition('FROZEN');self.frozen=self.gate.proof(self.source,state)
        self.financial_before=self.financial(self.source);self.frozen_facts=self.snapshot(self.source)
        self.record_technical_snapshot('frozen',state,self.frozen_facts)
        self.recovery.write_private(self.private/'frozen.json',self.recovery.canonical(self.frozen))
        self.evidence.update(sourceFrozenEpoch=state['epoch'],financialBefore=self.financial_before)

    def create_target(self):
        # Same pinned images and provision-db.sql used by the existing logical adapter.
        name,store=self.target_names;database='jxc_closure_financial_'+self.suffix
        passwords={key:secrets.token_hex(24) for key in ('POSTGRES_PASSWORD','MINIO_ROOT_USER','MINIO_ROOT_PASSWORD')}
        env={**os.environ,**passwords}
        self.command(['docker','run','-d','--name',name,'--label',self.label,'-e','POSTGRES_PASSWORD','-e','POSTGRES_DB='+database,'-p','127.0.0.1::5432',self.logical.PG],env=env);self.containers.append(name)
        self.command(['docker','run','-d','--name',store,'--label',self.label,'-e','MINIO_ROOT_USER','-e','MINIO_ROOT_PASSWORD','-p','127.0.0.1::9000',self.logical.S3,'server','/data'],env=env);self.containers.append(store)
        endpoint='http://127.0.0.1:'+self.command(['docker','port',store,'9000/tcp']).rsplit(':',1)[1]
        self.target={'container':name,'database':database,'adminUser':'postgres','ownerRole':'jxc_owner','runtimeRole':'jxc_app','storage':{'endpoint':endpoint,'bucket':'closure-financial-'+self.suffix,'accessKey':passwords['MINIO_ROOT_USER'],'secretKey':passwords['MINIO_ROOT_PASSWORD']}}
        until=time.monotonic()+45
        while time.monotonic()<until:
            if subprocess.run(['docker','exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database],capture_output=True).returncode==0:break
            time.sleep(.1)
        else:raise RuntimeError('New target PostgreSQL did not start')
        self.command(['docker','exec','-i',name,'psql','-X','-q','-v','ON_ERROR_STOP=1','-v','expected_database='+database,'-U','postgres','-d',database],(ROOT/'jxc-server/scripts/provision-db.sql').read_text())
        self.sql(self.target,'DROP EXTENSION btree_gist;',False)
        until=time.monotonic()+45
        while time.monotonic()<until:
            try:
                with urllib.request.urlopen(endpoint+'/minio/health/ready',timeout=2) as response:
                    if response.status==200:break
            except OSError:pass
            time.sleep(.2)
        else:raise RuntimeError('New target object storage did not start')
        self.recovery.S3(self.target['storage']).request('PUT')

    def backup_restore_verify(self):
        config={'schemaVersion':1,'batchId':self.batch,'source':self.source}
        backed=self.recovery.backup(config,self.private/'frozen.json',self.private/'bundle',self.source['container']+'/'+self.source['database'])
        self.create_target();config['target']=self.target
        with self.recovery.PgSession(self.target) as session:
            identity=session.json("SELECT json_build_object('database',current_database(),'systemIdentifier',system_identifier::text) FROM pg_control_system()")
        allowed={'container':self.target['container'],'database':self.target['database'],'systemIdentifier':identity['systemIdentifier'],'storageEndpoint':self.target['storage']['endpoint'],'storageBucket':self.target['storage']['bucket']}
        allow_path=self.private/'target-allowlist.json';self.recovery.write_private(allow_path,self.recovery.canonical(allowed))
        receipt=self.private/'receipt.json';expected=self.target['container']+'/'+self.target['database']
        restored=self.production.guarded_restore(config,allow_path,self.recovery.hash_file(allow_path),self.private/'bundle',backed['manifestSha256'],expected,receipt)
        replay=self.production.guarded_restore(config,allow_path,self.recovery.hash_file(allow_path),self.private/'bundle',backed['manifestSha256'],expected,receipt)
        target_financial=self.financial(self.target)
        if restored['status']!='RESTORED' or replay['status']!='VERIFIED_REPLAY' or target_financial!=self.financial_before:raise ValueError('Exact native financial restore/replay differs')
        if self.snapshot(self.target)!=self.frozen_facts:raise ValueError('Restored full table/sequence facts differ')
        self.evidence.update(verification=restored['verification'],financialRestored=target_financial,financialGraphExact=True,allTablesAndSequencesExact=True,replayStatus=replay['status'],manifestSha256=backed['manifestSha256'],targetWritesRemainFrozen=True,targetAllowlistSha256=self.recovery.hash_file(allow_path))

    def verify_source(self):
        if self.gate_state()['mode']!='FROZEN' or self.snapshot(self.source)!=self.frozen_facts or self.financial(self.source)!=self.financial_before:raise ValueError('Frozen source changed during recovery')

    def cleanup_target(self):
        # Reuse the tested exact-derived-name/label cleanup, including partial creation.
        cleanup=self.private/'target-cleanup';cleanup.mkdir(mode=0o700)
        result=dict(self.evidence)
        self.logical.finish_rehearsal(self.private/'target-cleanup.json',result,self.containers,cleanup,True,self.label)
        self.containers=[];self.evidence['ownedTargetResourcesCleaned']=True

    def resume_source(self):
        state=self.transition('OPEN');self.source_opened=True;resumed=self.snapshot(self.source)
        if business_projection(resumed)!=business_projection(self.before):raise ValueError('Source nontechnical facts changed')
        self.record_technical_snapshot('resumed',state,resumed)
        canonical=lambda value:json.dumps(value,sort_keys=True,separators=(',',':')).encode()
        self.evidence.update(sourceNontechnicalFactsUnchanged=True,sourceTechnicalTransitionOnly=True,sourceNontechnicalSnapshotSha256=hashlib.sha256(canonical(business_projection(resumed))).hexdigest())

    def start_source(self):
        if self.runtime.sha(self.cfg['jar'])!=self.args.jar_sha256:raise ValueError('Original source artifact changed')
        flags=['--jxc.jobs.enabled='+str(self.cfg['workerEnabled']).lower(),'--jxc.jobs.recovery.delay-ms=3000','--jxc.workbench.worker.assignments='+self.cfg['workbenchAssignment']]
        log=self.args.runtime_config.parent/('runtime-financial-recovery-'+self.args.jar_sha256[:12]+'.log');log.touch(mode=0o600,exist_ok=True);log.chmod(0o600)
        with log.open('ab') as output:self.active=subprocess.Popen([self.args.java,'-jar',self.cfg['jar'],*flags],env=self.env,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
        until=time.monotonic()+90
        while time.monotonic()<until:
            if self.active.poll() is not None:raise RuntimeError('Same-artifact source runtime stopped')
            try:
                with urllib.request.urlopen(self.pub['api']+'/actuator/health',timeout=2) as response:ready=json.load(response).get('status')=='UP'
                listeners=subprocess.run(['lsof','-nP','-iTCP:18100','-sTCP:LISTEN','-t'],capture_output=True,text=True).stdout.strip()
                if ready and listeners==str(self.active.pid):break
            except OSError:pass
            time.sleep(.2)
        else:raise RuntimeError('Same-artifact source readiness timed out')
        self.cfg['apiPid']=self.active.pid;self.pub.update(apiPid=self.active.pid,status='running',financialRecoveryVerifiedAt=self.runtime.stamp())
        self.runtime.write(self.args.runtime_config,self.cfg,True);self.runtime.write(ROOT/'docs/backend/evidence/release-ui-runtime.json',self.pub)
        self.evidence.update(sourceApiPidAfter=self.active.pid,sourceOriginalRuntimeRestored=True,sourceOriginalWorkerPollMs=3000,sourceFinalWriteMode='OPEN',health='UP')

    def stop_started_source(self):
        if self.active and self.active.poll() is None:self.stop_pid(self.active.pid,self.cfg['jar'],must_listen=False);self.active.wait(timeout=10)

    def refreeze_source(self):
        self.evidence['sourceRefreezeAttempted']=True
        state=self.gate_state()
        if state['mode']=='FROZEN' and state['batch_id']==self.batch and state['epoch']==self.frozen['epoch']:
            self.source_opened=False;return
        if state['mode']!='OPEN' or state['batch_id']!=self.batch or state['epoch']!=self.frozen['epoch']+1:raise ValueError('Cannot refreeze a different source batch/epoch')
        self.open_state=state;self.transition('FROZEN');self.source_opened=False

    def observe_process(self):
        pid=self.active.pid if self.active is not None else self.args.expected_pid
        if self.active is not None and self.active.poll() is not None:return {'state':'stopped','pid':pid}
        try:
            result=subprocess.run(['ps','-p',str(pid),'-o','stat=','-o','command='],capture_output=True,text=True,timeout=5)
            if result.returncode==1 and not result.stdout.strip() and not result.stderr.strip():return {'state':'stopped','pid':pid}
            if result.returncode or not result.stdout.strip():return {'state':'unknown','pid':pid}
            state,command=result.stdout.strip().split(None,1)
            if state.startswith('Z'):return {'state':'stopped','pid':pid}
            command=shlex.split(command)
            if len(command)<3 or Path(command[0]).resolve()!=Path(self.args.java).resolve() or command[1]!='-jar' or Path(command[2]).resolve()!=Path(self.cfg['jar']).resolve():return {'state':'unknown','pid':pid}
            return {'state':'running','pid':pid}
        except (OSError,ValueError,subprocess.SubprocessError):return {'state':'unknown','pid':pid}

    def record_failure(self):
        self.evidence.update(status='failed',error='Financial recovery failed; private diagnostics retained')
        if not self.source_stopped and not getattr(self,'source_stop_attempted',False):return
        try:
            if self.source_opened:refreeze_after_stop_attempt(self)
        finally:
            try:state=self.gate_state()
            except BaseException:state={'mode':'UNKNOWN','batch_id':None,'epoch':None}
            process=self.observe_process()
            health='DOWN' if process['state']=='stopped' else 'UNKNOWN'
            self.evidence.update(sourceFinalWriteMode=state['mode'],sourceGateAfterFailure={key:state.get(key) for key in ('mode','batch_id','epoch')},sourceProcessAfterFailure=process,health=health)
            self.pub.update(status='stopped' if process['state']=='stopped' else 'failed',apiPid=process['pid'] if process['state']=='running' else None,health=health,observedProcessState=process['state'],observedWriteMode=state['mode'],failedFinancialRecoveryEvidence=str(self.args.output))
            self.runtime.write(ROOT/'docs/backend/evidence/release-ui-runtime.json',self.pub)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime-config',type=Path,required=True);p.add_argument('--jar-sha256',required=True);p.add_argument('--expected-pid',type=int,required=True)
    p.add_argument('--expected-database',required=True);p.add_argument('--expected-system-identifier',required=True);p.add_argument('--operators-paused',action='store_true');p.add_argument('--execute',action='store_true')
    p.add_argument('--java',default='/opt/homebrew/opt/openjdk/bin/java');p.add_argument('--output',type=Path,default=ROOT/'docs/backend/evidence/release-ui-financial-recovery.json');a=p.parse_args()
    if a.runtime_config.is_symlink() or a.runtime_config.resolve().is_relative_to(ROOT) or a.runtime_config.stat().st_uid!=os.getuid() or a.runtime_config.stat().st_mode&0o777!=0o600:raise ValueError('Explicit owned external private0600 UI config required')
    ops=Rehearsal(a);success=False
    try:
        ops.preflight()
        if not a.execute:
            print(json.dumps({'status':'preflight_passed','financial':ops.financial_before,'sourceStopped':False}));return
        if not a.operators_paused:raise ValueError('Explicit coordinated operator pause required')
        run_sequence(ops);success=True;ops.evidence.update(status='passed',completedAt=ops.runtime.stamp())
    except BaseException:
        ops.record_failure()
        raise
    finally:
        if not a.execute:
            import shutil
            shutil.rmtree(ops.private)
        else:
            try:ops.logical.finish_rehearsal(a.output,ops.evidence,ops.containers,ops.private,success,ops.label)
            except BaseException:
                ops.record_failure()
                ops.runtime.write(a.output,ops.evidence)
                raise
    print(json.dumps({'status':'passed','jarSha256':a.jar_sha256,'sourceFinalWriteMode':'OPEN','targetWritesRemainFrozen':True,'sourceApiPidAfter':ops.active.pid}))

if __name__=='__main__':main()
