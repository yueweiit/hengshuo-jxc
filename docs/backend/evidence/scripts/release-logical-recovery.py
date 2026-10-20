#!/usr/bin/env python3
"""Run the existing full recovery core through an exact non-M5 target allowlist.

Creates only four newly labelled disposable containers. The source is migrated by a
hash-pinned copy of the current jar. No existing database/container is inspected.
Secrets, dump, key and receipts stay in a new external 0700 directory.
"""
from pathlib import Path
import argparse, copy, datetime as dt, hashlib, importlib.util, json, os, re, secrets, shutil, subprocess, sys, tempfile, time, urllib.request, uuid, zipfile

ROOT=Path(__file__).resolve().parents[4]
PG='postgres:16-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'
S3='minio/minio:RELEASE.2024-10-13T13-34-11Z@sha256:9535594ad4122b7a78c6632788a989b96d9199b483d3bd71a5ceae73a922cdfa'

def module(name,file):
    spec=importlib.util.spec_from_file_location(name,file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

def selected_images(postgres_image=None,object_image=None,object_engine='minio'):
    if object_engine not in ('minio','seaweed'):raise ValueError('Explicit supported object engine required')
    if object_engine=='seaweed' and object_image is None:raise ValueError('Seaweed requires an explicit reviewed immutable object image')
    images=(PG if postgres_image is None else postgres_image,S3 if object_image is None else object_image)
    for image in images:
        if not isinstance(image,str) or not re.fullmatch(r'(?:sha256:[0-9a-f]{64}|[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64})',image):
            raise ValueError('Exact immutable image digest or image Id required')
    return images

def create_object_store(engine,image,name,label,bucket,private,run,wait,recovery,password,containers,probe=None):
    """Adapt only the newly owned object container; backup/restore still use recovery.S3."""
    access,secret=password(),password()
    base=['docker','run','-d','--name',name,'--label',label,'-p','127.0.0.1::9000']
    proof={'engine':engine,'image':image,'initializerCredentialRemoved':False,
           'retiredInitializerCredentialRejected':False,'runtimeSignedBucketReadinessVerified':False,
           'onlyS3HostPortPublished':True,'internalListenersIsolationClaimed':False}
    def storage():
        port=run(['docker','port',name,'9000/tcp']).rsplit(':',1)[1]
        return {'endpoint':'http://127.0.0.1:'+port,'bucket':bucket,'accessKey':access,'secretKey':secret}
    if engine=='minio':
        env={**os.environ,'MINIO_ROOT_USER':access,'MINIO_ROOT_PASSWORD':secret}
        run(base+['-e','MINIO_ROOT_USER','-e','MINIO_ROOT_PASSWORD',image,'server','/data'],env=env);containers.append(name)
        config=storage()
        def ready():
            with urllib.request.urlopen(config['endpoint']+'/minio/health/ready',timeout=2) as response:return response.status==200
        wait(ready,'new private object storage');recovery.S3(config).request('PUT')
        return config,proof
    if engine!='seaweed':raise ValueError('Unsupported object engine')
    # The disposable restore fixture reads operator-owned host binds. Non-root
    # production ownership is verified separately with dedicated named volumes.
    fixture_user=str(os.getuid())+':'+str(os.getgid())
    proof.update(isolatedFixtureUser=fixture_user,productionNonRootVerified=False)
    private.mkdir(mode=0o700);data=private/'data';data.mkdir(mode=0o700)
    initializer=private/'initializer.json';runtime=private/'runtime.json';admin_access,admin_secret=password(),password()
    def identity(name,key,value,actions):return {'name':name,'credentials':[{'accessKey':key,'secretKey':value}],'actions':actions}
    def write_config(path,identities):
        with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as stream:
            stream.write(json.dumps({'identities':identities})+'\n')
    runtime_identities=[identity('jxc-runtime',access,secret,[action+':'+bucket for action in ('Read','List','Write')])]
    buckets=[bucket]
    if probe is not None:
        probe_bucket='jxc-m5-probe-'+secrets.token_hex(6);probe_access,probe_secret=password(),password()
        probe.update(bucket=probe_bucket,accessKey=probe_access,secretKey=probe_secret)
        buckets.append(probe_bucket)
        runtime_identities.append(identity('jxc-recovery-safety-probe',probe_access,probe_secret,
                                           [action+':'+probe_bucket for action in ('Read','List','Write')]))
    write_config(initializer,[identity('jxc-initializer',admin_access,admin_secret,['Admin','Read','List','Write'])])
    write_config(runtime,runtime_identities)
    flags=['mini','-dir=/data','-ip=127.0.0.1','-ip.bind=0.0.0.0','-s3.port=9000',
           '-admin.ui=false','-webdav=false','-s3.port.iceberg=0','-s3.port.lance=0','-s3.iam=false',
           '-s3.autoCreateBucket=false','-s3.allowDeleteBucketNotEmpty=false','-filer.tusBasePath=',
           '-master.telemetry=false','-s3.config=/run/secrets/object_s3_config']
    def launch(config,initialize=False):
        run(base+['--user',fixture_user,'--mount','type=bind,src='+str(data)+',dst=/data',
                  '--mount','type=bind,src='+str(config)+',dst=/run/secrets/object_s3_config,readonly',
                  '-e','S3_BUCKET=',image,*flags]+(['-bucket='+','.join(buckets)] if initialize else []));containers.append(name)
        return storage()
    def signed_ready(config):
        try:
            recovery.S3(config).request('HEAD')
            return recovery.S3(config).empty()
        except recovery.RecoveryError as error:
            if str(error) in ('S3 endpoint unavailable','S3 request failed with HTTP 404','S3 request failed with HTTP 503'):return False
            raise
    initial_storage=launch(initializer,True)
    initial_storage.update(accessKey=admin_access,secretKey=admin_secret)
    wait(lambda:signed_ready(initial_storage),'new authenticated initializer bucket')
    run(['docker','stop','--time','30',name]);run(['docker','rm','-v',name]);containers.remove(name)
    initializer.unlink()
    config=launch(runtime)
    wait(lambda:signed_ready(config),'new authenticated runtime bucket')
    retired={**config,'accessKey':admin_access,'secretKey':admin_secret}
    try:recovery.S3(retired).request('HEAD')
    except recovery.RecoveryError as error:
        if str(error)!='S3 request failed with HTTP 403':raise
    else:raise RuntimeError('Retired initializer credential is still accepted by the runtime')
    if probe is not None:
        probe['endpoint']=config['endpoint']
        wait(lambda:signed_ready(probe),'new authenticated independent safety probe bucket')
        proof['independentSafetyProbeBucketVerified']=True
    proof.update(initializerCredentialRemoved=True,retiredInitializerCredentialRejected=True,
                 runtimeSignedBucketReadinessVerified=True,runtimeBucketActions=['Read','List','Write'])
    return config,proof

def finish_rehearsal(output,evidence,containers,private,succeeded,label):
    # Match the container proof's fail-closed cleanup, restricted to this run's exact names and label.
    match=re.fullmatch(r'com\.hengshuo\.logical-recovery=([0-9a-f]{12})',label)
    suffix=match.group(1) if match else None
    allowed={'hengshuo-closure-logical-'+suffix+'-'+kind for kind in ('source','source-objects','target','target-objects')} if suffix else set()
    # docker run can create a container and then fail before it is appended to the tracking list.
    # The four derived names are the entire discovery boundary; tracked names never expand it.
    failed=sorted(set(containers)-allowed) if suffix else ['invalid-run-label']
    def absent(result):return any(value in result.stderr.lower() for value in ('no such container','no such object'))
    for name in sorted(allowed,reverse=True):
        try:
            inspected=subprocess.run(['docker','inspect','--format','{{index .Config.Labels "com.hengshuo.logical-recovery"}}',name],capture_output=True,text=True,timeout=30)
            if inspected.returncode and absent(inspected):continue
            if inspected.returncode or inspected.stdout.strip()!=suffix:failed.append(name);continue
            removed=subprocess.run(['docker','rm','-fv',name],capture_output=True,text=True,timeout=30)
            if removed.returncode and not absent(removed):failed.append(name)
        except (OSError,subprocess.SubprocessError):failed.append(name)
    evidence['ownedResourcesCleaned']=not failed
    if failed:evidence.update(status='failed',cleanupIncomplete=failed)
    if succeeded and not failed:
        try:shutil.rmtree(private)
        except OSError:evidence.update(status='failed',privateCleanupIncomplete=True);succeeded=False
    else:succeeded=False
    if not succeeded:
        evidence['status']='failed';evidence['privateFailureEvidenceRetained']=str(private)
        print(json.dumps({'privateFailureEvidenceRetained':str(private)}),flush=True)
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x') as stream:stream.write(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
    if failed or evidence.get('privateCleanupIncomplete'):raise RuntimeError('New owned logical recovery resources could not be completely cleaned')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar',type=Path,default=ROOT/'jxc-server/jxc-app/target/jxc-app-0.1.0-SNAPSHOT.jar')
    parser.add_argument('--jar-sha256',required=True,help='External hash of the final reviewed application artifact')
    parser.add_argument('--java',default='/opt/homebrew/opt/openjdk/bin/java')
    parser.add_argument('--postgres-image',help='Optional exact immutable PostgreSQL image digest/Id; default retains the original fixture')
    parser.add_argument('--object-engine',choices=('minio','seaweed'),default='minio',help='Explicit fixture adapter; existing MinIO semantics remain the default')
    parser.add_argument('--object-image',help='Optional exact immutable object image digest/Id; required for Seaweed')
    parser.add_argument('--output',type=Path,default=ROOT/'docs/backend/evidence/release-logical-recovery.json')
    args=parser.parse_args();jar=args.jar.resolve()
    if args.output.exists() or args.output.is_symlink():raise ValueError('Refusing to replace existing logical recovery evidence')
    pg_image,object_image=selected_images(args.postgres_image,args.object_image,args.object_engine)
    if hashlib.sha256(jar.read_bytes()).hexdigest()!=args.jar_sha256:raise ValueError('Application jar does not match the reviewed external hash')
    # An older jar must not create resources or silently omit a final migration.
    with zipfile.ZipFile(jar) as archive:
        for migration in (ROOT/'jxc-server/jxc-app/src/main/resources/db/migration').glob('V*.sql'):
            if archive.read('BOOT-INF/classes/db/migration/'+migration.name)!=migration.read_bytes():
                raise ValueError('Application jar does not contain the current reviewed migration bytes')
    private=Path(tempfile.mkdtemp(prefix='hengshuo-closure-recovery-'));private.chmod(0o700)
    source_private=private/'source-secrets';source_private.mkdir(mode=0o700)
    recipient=private/'independent-custodian';recipient.mkdir(mode=0o700)
    snapshot=private/'runtime.jar';shutil.copyfile(jar,snapshot);snapshot.chmod(0o600)
    jar_hash=hashlib.sha256(snapshot.read_bytes()).hexdigest()
    if jar_hash!=args.jar_sha256 or jar_hash!=hashlib.sha256(jar.read_bytes()).hexdigest():raise ValueError('Application artifact changed during snapshot')
    recovery=module('closure_recovery',ROOT/'jxc-server/scripts/m5/recovery.py')
    production=module('closure_production',ROOT/'jxc-server/scripts/m5/production.py')
    seal=module('closure_seal',ROOT/'jxc-server/scripts/m5/seal.py')
    gate=module('closure_gate',ROOT/'jxc-server/scripts/m5/write_gate.py')
    suffix=uuid.uuid4().hex[:12];label='com.hengshuo.logical-recovery='+suffix
    containers=[];steps=[];hidden=[];probe_storage={}
    evidence={'schemaVersion':1,'mode':'ISOLATED_SYNTHETIC_EXACT_ALLOWLIST','productionReleased':False,'jarSha256':jar_hash,'steps':steps,
              'postgresImage':pg_image,'objectImage':object_image,'objectEngine':args.object_engine,'objectStorageFixtures':[]}
    def redacted(value):
        value=str(value)
        for secret in hidden:value=value.replace(secret,'[REDACTED]')
        return value
    def run(command,data=None,env=None,timeout=60):
        result=subprocess.run(command,input=data,text=True,capture_output=True,env=env,timeout=timeout)
        if result.returncode:raise RuntimeError(redacted(result.stderr[-2000:] or result.stdout[-2000:] or 'Rehearsal command failed'))
        return result.stdout.strip()
    def mark(name,**values):
        steps.append({'step':name,**values});print(json.dumps(steps[-1],ensure_ascii=False),flush=True)
    def wait(predicate,description):
        until=time.monotonic()+45
        while time.monotonic()<until:
            try:
                if predicate():return
            except (OSError,ValueError):pass
            time.sleep(.2)
        raise RuntimeError('Timed out waiting for '+description)
    def password():
        value=secrets.token_hex(24);hidden.append(value);return value
    def sql(target,statement):
        return run(['docker','exec','-i',target['container'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',target['database']],statement)
    def create(kind):
        name='hengshuo-closure-logical-'+suffix+'-'+kind;database='jxc_closure_'+kind+'_'+suffix
        admin,owner,app=(password() for _ in range(3))
        store=name+'-objects';bucket='closure-'+kind+'-'+suffix
        env={**os.environ,'POSTGRES_PASSWORD':admin}
        run(['docker','run','-d','--name',name,'--label',label,'-e','POSTGRES_PASSWORD','-e','POSTGRES_DB='+database,'-p','127.0.0.1::5432',pg_image],env=env);containers.append(name)
        objects_private=source_private/'objects' if kind=='source' else private/'target-objects'
        storage,objects_proof=create_object_store(args.object_engine,object_image,store,label,bucket,objects_private,run,wait,recovery,password,containers,
                                                  probe=probe_storage if kind=='target' and args.object_engine=='seaweed' else None)
        evidence['objectStorageFixtures'].append({'kind':kind,**objects_proof})
        pg_port=run(['docker','port',name,'5432/tcp']).rsplit(':',1)[1]
        target={'container':name,'database':database,'adminUser':'postgres','ownerRole':'jxc_owner','runtimeRole':'jxc_app','storage':storage}
        # The image's temporary init server accepts local sockets before its final restart.
        wait(lambda:subprocess.run(['docker','exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database],capture_output=True).returncode==0,'new PostgreSQL TCP listener')
        run(['docker','exec','-i',name,'psql','-X','-q','-v','ON_ERROR_STOP=1','-v','expected_database='+database,'-U','postgres','-d',database],(ROOT/'jxc-server/scripts/provision-db.sql').read_text())
        sql(target,"ALTER ROLE jxc_owner PASSWORD '"+owner+"';ALTER ROLE jxc_app PASSWORD '"+app+"';")
        return target,{'pgPort':pg_port,'ownerPassword':owner,'runtimePassword':app},store
    succeeded=False;started=time.monotonic()
    original_verify=production.recovery.verify_restored
    def verify_with_failure_evidence(target,bundle,manifest):
        try:return original_verify(target,bundle,manifest)
        except production.recovery.RecoveryError:
            with recovery.PgSession(target) as session:
                session.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL timezone='UTC';SET LOCAL extra_float_digits=3")
                recovery.write_private(private/'failed-restored-inventory.json',recovery.canonical(recovery.inventory(session)))
            raise
    production.recovery.verify_restored=verify_with_failure_evidence
    try:
        source,source_secrets,source_store=create('source')
        recovery.write_private(source_private/'credentials.json',recovery.canonical(source_secrets))
        env={key:value for key,value in os.environ.items() if not key.startswith(('JXC_','SPRING_','PG'))}
        env.update(JXC_DB_URL='jdbc:postgresql://127.0.0.1:'+source_secrets['pgPort']+'/'+source['database'],JXC_DB_USER='jxc_app',JXC_MIGRATION_USER='jxc_owner',JXC_MIGRATION_PASSWORD=source_secrets['ownerPassword'],JXC_EXPECT_DATABASE=source['database'])
        result=run([args.java,'-Dloader.main=com.hs.jxc.migration.MigrationMain','-cp',str(snapshot),'org.springframework.boot.loader.launch.PropertiesLauncher'],env=env,timeout=120)
        if '"status":"MIGRATED"' not in result:raise RuntimeError('One-shot jar migration did not succeed')
        migrations=json.loads(sql(source,"SELECT json_agg(json_build_object('version',version,'script',script) ORDER BY installed_rank) FROM flyway_schema_history WHERE success"))
        mark('fresh-source-migrated',migrationCount=len(migrations),migrator='MigrationMain',runtimeRole='jxc_app')
        data=b'isolated closure recovery attachment\n';digest=hashlib.sha256(data).hexdigest();key='country/101/attachments/closure-recovery'
        recovery.S3(source['storage']).request('PUT',key,data,if_absent=True)
        sql(source,"INSERT INTO md_currency(code,name,decimals) VALUES('MXN','Synthetic peso',2);INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(101,'MX','Synthetic recovery','MXN','UTC','ACTIVE');INSERT INTO sys_authz_epoch(country_id) VALUES(101);INSERT INTO sys_user(id,username,password_hash,display_name) VALUES(201,'closure-recovery','unused','Synthetic recovery');INSERT INTO sys_attachment(country_id,category,file_name,content_type,size,storage_key,sha256,uploaded_by) VALUES(101,'TEST','synthetic.txt','text/plain',"+str(len(data))+","+recovery.sql_literal(key)+","+recovery.sql_literal(digest)+",201);")
        config={'schemaVersion':1,'batchId':str(uuid.uuid4()),'source':source}
        state=gate.query(source,'BEGIN READ ONLY;'+gate.STATE_SQL+'COMMIT;')
        gate.query(source,"SELECT jxc_set_write_mode('FROZEN',"+str(state['epoch'])+",'"+config['batchId']+"'::uuid,'isolated-rehearsal','verified closure backup');")
        proof=gate.proof(source,gate.query(source,'BEGIN READ ONLY;'+gate.STATE_SQL+'COMMIT;'))
        proof_path=source_private/'frozen.json';recovery.write_private(proof_path,recovery.canonical(proof))
        backed=recovery.backup(config,proof_path,private/'bundle',source['container']+'/'+source['database'])
        mark('existing-full-backup-complete',tableCount=backed['tableCount'],attachmentCount=backed['attachmentCount'],manifestSha256=backed['manifestSha256'])
        openssl='/opt/homebrew/opt/openssl@3/bin/openssl';os.environ['JXC_OPENSSL']=openssl
        run([openssl,'req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(recipient/'key.pem'),'-out',str(recipient/'recipient.pem'),'-days','1','-subj','/CN=isolated-closure-custodian'])
        for path in recipient.iterdir():path.chmod(0o600)
        envelope=seal.seal(private/'bundle',recipient/'recipient.pem',recovery.hash_file(recipient/'recipient.pem'),private/'retained.cms')
        shutil.rmtree(private/'bundle')
        run(['docker','rm','-fv',source['container'],source_store]);containers.remove(source['container']);containers.remove(source_store)
        shutil.rmtree(source_private)
        source['storage']['accessKey']='source-unavailable';source['storage']['secretKey']='source-unavailable';source_secrets.clear()
        unsealed=seal.unseal(private/'retained.cms',envelope['sha256'],recipient/'key.pem',private/'restored-bundle')
        if unsealed.get('manifestSha256')!=backed['manifestSha256'] or unsealed.get('batchId')!=config['batchId'] or unsealed.get('source')!=recovery.verify_bundle(private/'restored-bundle',backed['manifestSha256'])['source']:raise RuntimeError('Unseal receipt is not bound to the actual verified M5 bundle')
        evidence['unsealReceiptManifestAndSourceBound']=True
        mark('source-loss-and-authenticated-unseal',sourceContainersRemoved=True,sourceSecretsDirectoryRemoved=True,independentRecipientKeyUsed=True)
        # Source loss is complete before the target exists: at most one new PG/S3 pair.
        target,target_secrets,target_store=create('target');config['target']=target
        # Provision helper creates the extension; the restore target must still be empty.
        sql(target,'DROP EXTENSION btree_gist;')
        with recovery.PgSession(target) as session:identity=session.json("SELECT json_build_object('database',current_database(),'systemIdentifier',system_identifier::text) FROM pg_control_system()")
        allow={'container':target['container'],'database':target['database'],'systemIdentifier':identity['systemIdentifier'],'storageEndpoint':target['storage']['endpoint'],'storageBucket':target['storage']['bucket']}
        allow_path=private/'target-allowlist.json';recovery.write_private(allow_path,recovery.canonical(allow));allow_pin=recovery.hash_file(allow_path)
        try:recovery.validate_target(target,target['container']+'/'+target['database'])
        except recovery.RecoveryError:pass
        else:raise RuntimeError('Original M5 prefix guard was weakened')
        wrong=copy.deepcopy(allow);wrong['systemIdentifier']='1'+allow['systemIdentifier'][1:]
        if wrong==allow:wrong['systemIdentifier']='2'+allow['systemIdentifier'][1:]
        wrong_path=private/'wrong-cluster.json';recovery.write_private(wrong_path,recovery.canonical(wrong))
        try:production.guarded_restore(config,wrong_path,recovery.hash_file(wrong_path),private/'restored-bundle',backed['manifestSha256'],target['container']+'/'+target['database'],private/'wrong-receipt.json')
        except production.ProductionError:pass
        else:raise RuntimeError('Wrong cluster allowlist was accepted')
        with recovery.PgSession(target) as session:recovery.assert_empty(session)
        if not recovery.S3(target['storage']).empty():raise RuntimeError('Rejected target was modified')
        mark('wrong-cluster-refused-before-effects',originalM5GuardPreserved=True,targetDatabaseEmpty=True,targetBucketEmpty=True)
        restored=production.guarded_restore(config,allow_path,allow_pin,private/'restored-bundle',backed['manifestSha256'],target['container']+'/'+target['database'],private/'receipt.json')
        replay=production.guarded_restore(config,allow_path,allow_pin,private/'restored-bundle',backed['manifestSha256'],target['container']+'/'+target['database'],private/'receipt.json')
        if restored['status']!='RESTORED' or replay['status']!='VERIFIED_REPLAY':raise RuntimeError('Restore/replay did not verify')
        if restored['verification']['attachmentCount']!=1:raise RuntimeError('Attachment was not restored')
        live_config=private/'recovery-config.json';recovery.write_private(live_config,recovery.canonical(config))
        live_env={k:v for k,v in os.environ.items() if k not in ('M5_RECOVERY_CONFIG','M5_RECOVERY_PROBE_STORAGE')}
        live_env['M5_RECOVERY_CONFIG']=str(live_config)
        if probe_storage:
            probe_path=private/'safety-probe-storage.json';recovery.write_private(probe_path,recovery.canonical(probe_storage))
            live_env['M5_RECOVERY_PROBE_STORAGE']=str(probe_path)
        live=subprocess.run([sys.executable,'-m','unittest','discover','-s',str(ROOT/'jxc-server/scripts/m5/tests'),'-p','test_recovery_live.py','-v'],env=live_env,capture_output=True,text=True,timeout=180)
        if live.returncode:raise RuntimeError(redacted(live.stderr[-3000:] or live.stdout[-3000:]))
        if 'Ran 9 tests' not in live.stderr or 'skipped=' in live.stderr:raise RuntimeError('Existing real recovery regressions did not all execute')
        evidence['existingRecoverySafetyTests']=9
        evidence.update(status='passed',migrations=migrations,verification=restored['verification'],replayStatus=replay['status'],manifestSha256=backed['manifestSha256'],envelopeSha256=envelope['sha256'],allowlistSha256=allow_pin,sourceSecretsDirectoryRemoved=True,sourceContainersRemoved=True,independentRecipientKeyUsed=True,physicalOffsiteDurabilityVerified=False,totalSeconds=round(time.monotonic()-started,3))
        mark('exact-allowlist-full-core-restored',tableCount=restored['verification']['tableCount'],allTableDigestsMatch=True,allAttachmentHashesMatch=True,replayStatus=replay['status'],writesRemainFrozen=True)
        succeeded=True
    except BaseException as error:
        evidence.update(status='failed',error=redacted(error));raise
    finally:
        finish_rehearsal(args.output,evidence,containers,private,succeeded,label)

if __name__=='__main__':main()
