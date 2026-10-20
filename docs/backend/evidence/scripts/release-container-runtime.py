#!/usr/bin/env python3
"""Verify reviewed artifacts in NEW local runtime containers; never deploy production.

The existing synthetic UI database/object store are read-only inputs. Workers retain
the production configuration but their first poll is deferred past this short probe.
Secrets enter newly owned volumes through stdin; no credential is put in argv/logs.
"""
from pathlib import Path
import argparse,datetime as dt,hashlib,io,json,os,re,shutil,subprocess,tarfile,tempfile,time,uuid,zipfile

ROOT=Path(__file__).resolve().parents[4]
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def manifest(folder):
    folder=Path(folder)
    if folder.is_symlink() or not folder.is_dir():raise ValueError('Regular artifact directory required')
    files={}
    for p in sorted(folder.rglob('*')):
        if p.is_symlink():raise ValueError('Artifact symlinks are not accepted')
        if p.is_file():files[p.relative_to(folder).as_posix()]=sha(p)
        elif not p.is_dir():raise ValueError('Only regular artifact files and directories are accepted')
    return files

def image_platform(record,expected=None):
    if not isinstance(record,dict) or not all(isinstance(record.get(field),str) and record[field] for field in ('Os','Architecture')):
        raise ValueError('Inspected image platform metadata required')
    actual=record['Os']+'/'+record['Architecture']
    if expected is not None and actual!=expected:raise ValueError('Image platform mismatch: expected '+expected+', inspected '+actual)
    return actual

def reviewed_build_context(candidate=None):
    context=ROOT if candidate is None else Path(candidate)
    if context.is_symlink() or not context.is_dir():raise ValueError('Regular build context directory required')
    if candidate is not None:
        context=context.resolve()
        if context.is_relative_to(ROOT.resolve()):raise ValueError('Explicit exported build context must be outside workspace')
    required=('deploy/production/Dockerfile','deploy/production/entrypoint.sh','deploy/production/nginx.conf',
              'deploy/production/compose.yml','.dockerignore')
    hashes={}
    for relative in required:
        for directory in (ROOT,context):
            source=directory/relative
            for ancestor in (source,*source.parents):
                if ancestor==directory:break
                if ancestor.is_symlink():raise ValueError('Build input symlinks are not accepted: '+relative)
            if not source.is_file():raise ValueError('Regular reviewed build input required: '+relative)
        hashes[relative]=sha(ROOT/relative)
        if sha(context/relative)!=hashes[relative]:raise ValueError('Exported build input differs from workspace: '+relative)
    return context,hashes

def write_evidence(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x',encoding='utf-8') as stream:stream.write(json.dumps(value,ensure_ascii=False,indent=2)+'\n')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-config',type=Path,required=True)
    parser.add_argument('--jar-sha256',required=True)
    parser.add_argument('--application-image',default='hengshuo-jxc-application:closure')
    parser.add_argument('--gateway-image',default='hengshuo-jxc-gateway:closure')
    parser.add_argument('--artifact-stage',type=Path,required=True)
    parser.add_argument('--dist',type=Path,help='Exact reviewed dist; use an external regular-file build instead of historical Documents caches')
    parser.add_argument('--platform',choices=('linux/amd64','linux/arm64'),help='Build and verify the deployment architecture explicitly')
    parser.add_argument('--build-context-root',type=Path,help='Regular external export with exact reviewed production build inputs; default is the workspace')
    parser.add_argument('--output',type=Path,default=ROOT/'docs/backend/evidence/release-container-runtime.json')
    args=parser.parse_args()
    if args.output.exists() or args.output.is_symlink():raise ValueError('Evidence output already exists; select a new --output to retain historical evidence')
    build_context,build_inputs=reviewed_build_context(args.build_context_root)
    platform_flags=['--platform',args.platform] if args.platform else []
    if args.runtime_config.resolve().is_relative_to(ROOT) or args.runtime_config.is_symlink():raise ValueError('Explicit private UI configuration outside workspace required')
    config=json.loads(args.runtime_config.read_text());credentials=json.loads(Path(config['credentialsFile']).read_text())
    if not config['database'].startswith('jxc_closure_ui_') or not config['bucket'].startswith('closure-ui-') or not all(config[k].startswith('hengshuo-closure-ui-') for k in ('postgresContainer','storageContainer')):raise ValueError('Only the explicitly isolated UI fixture can be probed')
    source_env=config['environment'];dist=args.dist if args.dist is not None else ROOT/'jxc-web/dist';expected_dist=manifest(dist)
    if not expected_dist or 'index.html' not in expected_dist or 'mockServiceWorker.js' in expected_dist:raise ValueError('Current production dist required without Mock worker')
    if sha(args.artifact_stage/'app.jar')!=args.jar_sha256:raise ValueError('Reviewed staged jar hash mismatch')
    suffix=uuid.uuid4().hex[:12];prefix='hengshuo-closure-container-'+suffix;label='com.hengshuo.container-rehearsal='+suffix
    private=Path(tempfile.mkdtemp(prefix=prefix+'-'));private.chmod(0o700)
    hidden=[str(v) for v in credentials.values() if isinstance(v,str)]+[str(v) for k,v in source_env.items() if any(x in k for x in ('PASSWORD','KEY','TOKEN'))]
    containers=[];volumes=[];network=None;steps=[];started=time.monotonic();succeeded=False
    evidence={'schemaVersion':1,'status':'running','mode':'MANUAL_DOCKER_SEMANTIC_PROOF_WITH_COMPOSE_CONFIG_VALIDATION','productionDeployment':False,'productionReleased':False,'existingUiBusinessWrites':False,'jarSha256':args.jar_sha256,'steps':steps,'requestedPlatform':args.platform,'requestedPlatformVerified':False,'externalBuildContext':args.build_context_root is not None,'buildInputHashes':build_inputs}
    def clean(value):
        result=str(value)
        for value in hidden:
            if value:result=result.replace(value,'[REDACTED]')
        return result
    def run(command,data=None,env=None,timeout=90,allow_failure=False,binary=False):
        result=subprocess.run(command,input=data,capture_output=True,text=not binary,env=env,timeout=timeout)
        if result.returncode and not allow_failure:
            detail=result.stderr if result.stderr else result.stdout
            raise RuntimeError(clean(detail.decode(errors='replace')[-3000:] if binary else detail[-3000:]))
        return result
    def text(command,**kwargs):return run(command,**kwargs).stdout.strip()
    def mark(name,**values):steps.append({'step':name,**values});print(json.dumps(steps[-1]),flush=True)
    def wait_ready(name,seconds=90):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            state=json.loads(text(['docker','inspect',name]))[0]['State']
            if not state['Running']:raise RuntimeError('New runtime exited: '+clean(text(['docker','logs',name])))
            result=run(['docker','exec',name,'java','-Dloader.main=com.hs.jxc.ops.HealthcheckMain','-cp','/app/app.jar','org.springframework.boot.loader.launch.PropertiesLauncher'],allow_failure=True)
            if result.returncode==0:return
            time.sleep(.5)
        raise RuntimeError('New runtime readiness timed out: '+clean(text(['docker','logs',name])))
    def secret_volume(kind,values,uid):
        name=prefix+'-'+kind;run(['docker','volume','create','--label',label,name]);volumes.append(name)
        payload=io.BytesIO()
        with tarfile.open(fileobj=payload,mode='w') as archive:
            for filename,value in values.items():
                data=value.encode();info=tarfile.TarInfo(filename);info.size=len(data);info.mode=0o400;info.uid=uid;info.gid=uid;archive.addfile(info,io.BytesIO(data))
        helper=prefix+'-'+kind+'-populate';containers.append(helper)
        run(['docker','run',*platform_flags,'--rm','--name',helper,'--label',label,'-i','--user','0:0','--entrypoint','/bin/sh','--mount','type=volume,src='+name+',dst=/secrets',app_image,'-c','tar -x -C /secrets && chown -R '+str(uid)+':'+str(uid)+' /secrets && chmod 500 /secrets && chmod 400 /secrets/*'],data=payload.getvalue(),binary=True)
        return name
    def base(name,volume):
        return ['docker','run',*platform_flags,'--name',name,'--label',label,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:size=128m,mode=1777','--mount','type=volume,src='+volume+',dst=/run/secrets,readonly']
    def env_flags(values):
        result=[]
        for key,value in values.items():result+=['-e',key+'='+str(value)]
        return result
    def history():
        result=text(['docker','exec',config['postgresContainer'],'psql','-X','-qAt','-U','postgres','-d',config['database'],'-v','ON_ERROR_STOP=1','-c',"BEGIN READ ONLY;SELECT to_jsonb(h)::text FROM flyway_schema_history h ORDER BY installed_rank;COMMIT;"])
        return hashlib.sha256(result.encode()).hexdigest()
    try:
        docker_context=json.loads(text(['docker','context','inspect']))[0]
        if not docker_context['Endpoints']['docker']['Host'].startswith('unix://') or (os.environ.get('DOCKER_HOST') and not os.environ['DOCKER_HOST'].startswith('unix://')):raise ValueError('This rehearsal permits only an explicit local Unix Docker endpoint')
        evidence['localDockerEndpointVerified']=True
        app_record=json.loads(text(['docker','image','inspect',args.application_image]))[0]
        evidence['applicationPlatform']=image_platform(app_record,args.platform);app_image=app_record['Id']
        # Extract accepted bytes from the real image before any runtime is started.
        inspect_name=prefix+'-artifact';run(['docker','create',*platform_flags,'--name',inspect_name,'--label',label,'--entrypoint','/bin/true',app_image]);containers.append(inspect_name)
        run(['docker','cp',inspect_name+':/app/app.jar',str(private/'image.jar')]);assert sha(private/'image.jar')==args.jar_sha256
        stage=private/'artifacts';stage.mkdir(mode=0o700);shutil.copyfile(args.artifact_stage/'app.jar',stage/'app.jar');shutil.copytree(dist,stage/'dist')
        assert manifest(stage/'dist')==expected_dist
        if reviewed_build_context(args.build_context_root)!=(build_context,build_inputs):raise ValueError('Reviewed build inputs changed during probe')
        run(['docker','buildx','build','--load',*platform_flags,'--progress','plain','--file',str(build_context/'deploy/production/Dockerfile'),'--target','gateway-verified','--build-context','release-artifacts='+str(stage),'--tag',args.gateway_image,str(build_context)],timeout=180)
        gateway_record=json.loads(text(['docker','image','inspect',args.gateway_image]))[0]
        evidence['gatewayPlatform']=image_platform(gateway_record,args.platform);gateway_image=gateway_record['Id']
        evidence['requestedPlatformVerified']=args.platform is not None
        gateway_probe=prefix+'-gateway-artifact';run(['docker','create',*platform_flags,'--name',gateway_probe,'--label',label,'--entrypoint','/bin/true',gateway_image]);containers.append(gateway_probe)
        run(['docker','cp',gateway_probe+':/usr/share/nginx/html',str(private/'image-dist')]);assert manifest(private/'image-dist')==expected_dist
        evidence.update(applicationImageId=app_image,gatewayImageId=gateway_image,distSha256=expected_dist,imageArtifactHashesMatch=True)
        mark('image-artifacts-match-reviewed-jar-and-current-dist',distFiles=len(expected_dist))
        runtime_volume=secret_volume('runtime-secrets',{'runtime_password':source_env['JXC_DB_PASSWORD'],'bank_key':source_env['JXC_BANK_ENCRYPTION_KEY'],'storage_access_key':source_env['JXC_STORAGE_ACCESS_KEY'],'storage_secret_key':source_env['JXC_STORAGE_SECRET_KEY']},10001)
        migration_volume=secret_volume('migration-secret',{'migration_password':credentials['ownerPassword']},10001)
        # Only public connection settings are passed as Docker environment arguments.
        # Join only our application to the fixtures' existing default bridge. Existing
        # containers/networks are never reconfigured, and loopback host ports stay private.
        pg_input=json.loads(text(['docker','inspect',config['postgresContainer']]))[0]
        s3_input=json.loads(text(['docker','inspect',config['storageContainer']]))[0]
        assert all(value['Config']['Labels'].get('jxc.rehearsal')=='release-closure-ui' for value in (pg_input,s3_input))
        pg_ip=pg_input['NetworkSettings']['Networks']['bridge']['IPAddress'];s3_ip=s3_input['NetworkSettings']['Networks']['bridge']['IPAddress']
        assert pg_ip and s3_ip
        db_url='jdbc:postgresql://'+pg_ip+':5432/'+config['database'];storage_endpoint='http://'+s3_ip+':9000'
        common={'JXC_DB_URL':db_url,'JXC_DB_USER':'jxc_app','JXC_EXPECT_DATABASE':config['database']}
        migration={**common,'JXC_MIGRATION_USER':'jxc_owner'};before=history()
        with zipfile.ZipFile(private/'image.jar') as archive:
            expected_migrations={(('.'.join(str(int(part)) for part in re.fullmatch(r'V([\d_]+)__.+\.sql',Path(name).name).group(1).split('_'))),Path(name).name) for name in archive.namelist() if name.startswith('BOOT-INF/classes/db/migration/V') and name.endswith('.sql')}
        applied=json.loads(text(['docker','exec',config['postgresContainer'],'psql','-X','-qAt','-U','postgres','-d',config['database'],'-v','ON_ERROR_STOP=1','-c',"BEGIN READ ONLY;SELECT coalesce(json_agg(json_build_object('version',version,'script',script,'success',success) ORDER BY installed_rank),'[]') FROM flyway_schema_history;COMMIT;"]))
        if not applied or any(row.get('success') is not True or row.get('version') is None for row in applied):raise ValueError('UI migration history is incomplete; runtime probe never applies pending DDL')
        actual_migrations=[('.'.join(str(int(part)) for part in row['version'].split('.')),row['script']) for row in applied]
        if len(actual_migrations)!=len(set(actual_migrations)) or set(actual_migrations)!=expected_migrations:raise ValueError('UI migration set differs from reviewed image; apply reviewed migrations separately before this read-only probe')
        evidence.update(migrationReadOnlyPreflightVerified=True,migrationCount=len(expected_migrations))
        match=prefix+'-migrate';containers.append(match);migrated=run(base(match,migration_volume)+env_flags(migration)+[app_image,'migrate'])
        outcome=next(json.loads(line) for line in migrated.stdout.splitlines() if line.startswith('{'))
        assert outcome=={'status':'MIGRATED','migrationsExecuted':0} and history()==before
        mismatch=prefix+'-migrate-wrong-db';containers.append(mismatch)
        wrong=run(base(mismatch,migration_volume)+env_flags({**migration,'JXC_EXPECT_DATABASE':config['database']+'_mismatch'})+[app_image,'migrate'],allow_failure=True)
        assert wrong.returncode!=0 and 'JXC_MIGRATION_FAILED' in wrong.stderr and history()==before
        refusal=prefix+'-owner-secret-refused';containers.append(refusal)
        blocked=run(base(refusal,migration_volume)+[app_image,'runtime'],allow_failure=True)
        assert blocked.returncode==78 and 'Migration credential must not be mounted' in blocked.stderr
        refusal_env=prefix+'-owner-env-refused';containers.append(refusal_env)
        blocked_env=run(base(refusal_env,runtime_volume)+['-e','JXC_MIGRATION_PASSWORD',app_image,'runtime'],env={**os.environ,'JXC_MIGRATION_PASSWORD':credentials['ownerPassword']},allow_failure=True)
        assert blocked_env.returncode==78 and 'Migration credential must not be set' in blocked_env.stderr
        evidence.update(oneShotMigrationVerified=True,migrationExpectedDatabaseMismatchRefused=True,runtimeOwnerSecretRefused=True,migrationHistoryUnchanged=True)
        mark('existing-migration-and-runtime-owner-secret-guards-verified',pendingMigrations=0)
        network=prefix+'-network';run(['docker','network','create','--label',label,network])
        runtime=prefix+'-application';containers.append(runtime)
        runtime_env={**common,'JXC_BIND_ADDRESS':'0.0.0.0','JXC_STORAGE_ENDPOINT':storage_endpoint,'JXC_STORAGE_BUCKET':source_env['JXC_STORAGE_BUCKET'],'JXC_WORKBENCH_WORKER_ASSIGNMENTS':config['workbenchAssignment'],'JXC_JOBS_RECOVERY_DELAY_MS':'3600000'}
        run(base(runtime,runtime_volume)+['-d','--network',network,'--network-alias','application']+env_flags(runtime_env)+[app_image,'runtime'])
        run(['docker','network','connect','bridge',runtime])
        wait_ready(runtime)
        inspected=json.loads(text(['docker','inspect',runtime]))[0]
        assert inspected['HostConfig']['ReadonlyRootfs'] and inspected['Config']['User']=='10001:10001'
        assert not any(key.startswith(('JXC_MIGRATION_PASSWORD=','JXC_DB_PASSWORD=','JXC_BANK_ENCRYPTION_KEY=','JXC_STORAGE_SECRET_KEY=','JXC_STORAGE_ACCESS_KEY=')) for key in inspected['Config']['Env'])
        assert text(['docker','exec',runtime,'id','-u'])=='10001'
        write_probe=run(['docker','exec',runtime,'/bin/sh','-c',': >> /app/app.jar'],allow_failure=True)
        assert write_probe.returncode!=0 and 'Read-only file system' in write_probe.stderr
        permissions=text(['docker','exec',runtime,'stat','-c','%a:%u:%g',*('/run/secrets/'+name for name in ('runtime_password','bank_key','storage_access_key','storage_secret_key'))]).splitlines()
        assert permissions==['400:10001:10001']*4
        cmdline=text(['docker','exec',runtime,'/bin/sh','-c',"tr '\\000' '\\n' < /proc/1/cmdline"])
        assert '--spring.flyway.enabled=false' in cmdline and '--spring.profiles.active=production' in cmdline
        assert run(['docker','exec',runtime,'/bin/sh','-c',"test ! -e /run/secrets/migration_password && ! tr '\\000' '\\n' < /proc/1/environ | grep -q '^JXC_MIGRATION_PASSWORD='"],allow_failure=True).returncode==0
        evidence.update(runtimeOnlyCredentials=True,flywayDisabled=True,nonRoot=True,readOnlyRootFilesystem=True,readinessVerified=True,workerPollDeferredDuringReadOnlyProbe=True)
        mark('non-root-read-only-runtime-is-ready',flywayDisabled=True,runtimeOnlyCredentials=True)
        openssl='/opt/homebrew/opt/openssl@3/bin/openssl'
        run([openssl,'req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(private/'ca.key'),'-out',str(private/'ca.pem'),'-days','1','-subj','/CN=Isolated Closure Runtime CA','-addext','basicConstraints=critical,CA:TRUE'])
        run([openssl,'req','-newkey','rsa:2048','-nodes','-keyout',str(private/'server.key'),'-out',str(private/'server.csr'),'-subj','/CN=localhost'])
        (private/'server.ext').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n')
        run([openssl,'x509','-req','-in',str(private/'server.csr'),'-CA',str(private/'ca.pem'),'-CAkey',str(private/'ca.key'),'-CAcreateserial','-out',str(private/'server.pem'),'-days','1','-extfile',str(private/'server.ext')])
        tls_volume=secret_volume('tls-secrets',{'tls_certificate':(private/'server.pem').read_text(),'tls_key':(private/'server.key').read_text()},101)
        gateway=prefix+'-gateway';containers.append(gateway)
        run(base(gateway,tls_volume)+['-d','--user','101:101','--network',network,'--tmpfs','/var/cache/nginx:size=32m,mode=1777','--tmpfs','/var/run:size=1m,mode=1777','-p','127.0.0.1::8443','-p','127.0.0.1::8080',gateway_image])
        port=text(['docker','port',gateway,'8443/tcp']).rsplit(':',1)[1];http_port=text(['docker','port',gateway,'8080/tcp']).rsplit(':',1)[1]
        curl=['curl','--noproxy','*','--silent','--show-error','--max-time','15','--cacert',str(private/'ca.pem')]
        deadline=time.monotonic()+30
        while True:
            ready=run(curl+['--fail','https://localhost:'+port+'/ready'],allow_failure=True)
            if ready.returncode==0:break
            if time.monotonic()>deadline:raise RuntimeError('Trusted HTTPS readiness unavailable: '+clean(text(['docker','logs',gateway])))
            time.sleep(.3)
        assert json.loads(ready.stdout)['status']=='UP'
        assert run(['curl','--noproxy','*','--silent','--max-time','10','https://localhost:'+port+'/ready'],allow_failure=True).returncode==60
        assert text(curl+['-o','/dev/null','-w','%{http_code}','https://localhost:'+port+'/actuator/health/liveness'])=='404'
        assert hashlib.sha256(run(curl+['--fail','https://localhost:'+port+'/'],binary=True).stdout).hexdigest()==expected_dist['index.html']
        assert text(['curl','--noproxy','*','--silent','--max-time','10','-o','/dev/null','-w','%{http_code}','http://127.0.0.1:'+http_port+'/'])=='308'
        assert text(['docker','exec',gateway,'id','-u'])=='101'
        assert text(['docker','exec',gateway,'stat','-c','%a:%u:%g','/run/secrets/tls_key','/run/secrets/tls_certificate']).splitlines()==['400:101:101']*2
        gateway_state=json.loads(text(['docker','inspect',gateway]))[0];assert gateway_state['HostConfig']['ReadonlyRootfs']
        evidence.update(httpsVerified=True,syntheticCaVerifiedWithoutInsecure=True,untrustedCaRejected=True,gatewayNonRoot=True,gatewayReadOnlyRootFilesystem=True,externalActuatorBlocked=True)
        mark('trusted-https-serves-exact-dist-and-private-readiness',untrustedCaRejected=True)
        compose_dir=private/'compose-path-validation-only';compose_dir.mkdir(mode=0o700)
        for name in ('runtime_password','migration_password','bank_key','storage_access_key','storage_secret_key','tls_certificate','tls_key'):(compose_dir/name).write_text('CONFIG_VALIDATION_ONLY')
        compose_env={**common,'JXC_APPLICATION_IMAGE':'closure/application@'+app_image,'JXC_GATEWAY_IMAGE':'closure/gateway@'+gateway_image,'JXC_STORAGE_ENDPOINT':storage_endpoint,'JXC_STORAGE_BUCKET':source_env['JXC_STORAGE_BUCKET'],'JXC_WORKBENCH_WORKER_ASSIGNMENTS':config['workbenchAssignment'],'JXC_MIGRATION_USER':'jxc_owner','JXC_BACKEND_NETWORK':network,'JXC_SECRET_DIR':str(compose_dir),'JXC_HTTP_BIND':'127.0.0.1:18080','JXC_HTTPS_BIND':'127.0.0.1:18443'}
        env_path=private/'compose.env';env_path.write_text('\n'.join(k+'='+v for k,v in compose_env.items())+'\n');env_path.chmod(0o600)
        run(['docker','compose','--env-file',str(env_path),'-f',str(ROOT/'deploy/production/compose.yml'),'--profile','migration','config','--quiet'],env={k:v for k,v in os.environ.items() if not k.startswith(('JXC_','COMPOSE_'))})
        assert manifest(dist)==expected_dist and history()==before
        if reviewed_build_context(args.build_context_root)!=(build_context,build_inputs):raise ValueError('Reviewed build inputs changed during probe')
        evidence.update(status='passed',composeConfigValidated=True,productionComposeStarted=False,composeFileSecretsHostOwnershipNotClaimed=True,completedAt=dt.datetime.now(dt.timezone.utc).isoformat(),totalSeconds=round(time.monotonic()-started,3),scriptSha256=sha(__file__))
        mark('production-compose-interpolation-valid-without-deployment')
        succeeded=True
    except BaseException as error:evidence.update(status='failed',error=clean(error));raise
    finally:
        cleanup_failed=[]
        resources=[(['docker','rm','-fv',name],'No such container') for name in reversed(containers)]
        if network:resources.append((['docker','network','rm',network],'No such network'))
        resources.extend((['docker','volume','rm',name],'No such volume') for name in volumes)
        for command,absent in resources:
            removed=subprocess.run(command,capture_output=True,text=True)
            if removed.returncode and absent.lower() not in removed.stderr.lower():cleanup_failed.append(command[-1])
        evidence['ownedResourcesCleaned']=not cleanup_failed
        if cleanup_failed:evidence.update(status='failed',cleanupIncomplete=cleanup_failed);succeeded=False
        try:write_evidence(args.output,evidence)
        except BaseException:
            print(json.dumps({'privateFailureEvidenceRetained':str(private)}),flush=True)
            raise
        if succeeded:shutil.rmtree(private)
        else:print(json.dumps({'privateFailureEvidenceRetained':str(private)}),flush=True)
        if cleanup_failed:raise RuntimeError('New owned runtime resources could not be completely cleaned')

if __name__=='__main__':main()
