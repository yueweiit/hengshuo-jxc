#!/usr/bin/env python3
"""Native PG16 basebackup+continuous WAL/PITR isolated proof; no existing database is accepted.

The encrypted retained bundle and independent synthetic recipient key survive removal
of the source containers, volumes and secret directory. Physical off-host durability
still requires the deployment's separately reviewed backup destination.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('seal',ROOT/'jxc-server/scripts/m5/seal.py')
seal=importlib.util.module_from_spec(spec);spec.loader.exec_module(seal)
IMAGE='postgres:16-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'


def command(*args,**kwargs):
    result=subprocess.run(list(map(str,args)),capture_output=True,timeout=120,**kwargs)
    if result.returncode:raise RuntimeError('Isolated PITR command failed: '+str(args[0]))
    return result.stdout


def sql(container,query):
    return command('docker','exec',container,'psql','-XAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','jxc_pitr','-c',query).decode().strip()


def wait_ready(container):
    for _ in range(60):
        result=subprocess.run(['docker','exec',container,'pg_isready','-U','postgres','-d','jxc_pitr'],capture_output=True)
        if result.returncode==0:return
        time.sleep(1)
    raise RuntimeError('Isolated PostgreSQL not ready')


def export_tar(container,path,destination):
    with destination.open('xb') as output:
        destination.chmod(0o600)
        result=subprocess.run(['docker','exec',container,'tar','-C',path,'-cf','-','.'],stdout=output,stderr=subprocess.PIPE,timeout=120)
    if result.returncode:raise RuntimeError('Native backup export failed')


def load_volume(volume,archive):
    with archive.open('rb') as data:
        result=subprocess.run(['docker','run','--rm','-i','-v',volume+':/restore',IMAGE,'sh','-ec','cd /restore\ntar -xf -\nchown -R postgres:postgres /restore\nchmod 700 /restore'],stdin=data,capture_output=True,timeout=120)
    if result.returncode:raise RuntimeError('Isolated restore volume preparation failed')


def run(output):
    run_id=uuid.uuid4().hex[:12];prefix='hengshuo-release-pitr-'+run_id
    source=prefix+'-source';target=prefix+'-target';label='com.hengshuo.pitr='+run_id
    volumes={name:'jxc_release_pitr_'+run_id+'_'+name for name in ('source','base','wal','target','retained_wal')}
    retained=Path(tempfile.mkdtemp(prefix='jxc-independent-backup-'));retained.chmod(0o700)
    custody=Path(tempfile.mkdtemp(prefix='jxc-independent-custody-'));custody.chmod(0o700)
    source_host=Path(tempfile.mkdtemp(prefix='jxc-source-host-'));source_host.chmod(0o700)
    restore_host=Path(tempfile.mkdtemp(prefix='jxc-restore-host-'));restore_host.chmod(0o700)
    started=time.monotonic();containers=[];created=[]
    try:
        for volume in volumes.values():command('docker','volume','create','--label',label,volume);created.append(volume)
        password=source_host/'postgres_password';password.write_text(secrets.token_urlsafe(32));password.chmod(0o600)
        command('docker','run','-d','--name',source,'--label',label,'-e','POSTGRES_DB=jxc_pitr','-e','POSTGRES_PASSWORD_FILE=/run/secrets/pgpass','-v',str(password)+':/run/secrets/pgpass:ro','-v',volumes['source']+':/var/lib/postgresql/data','-v',volumes['base']+':/base','-v',volumes['wal']+':/archive','-v',str(ROOT/'deploy/production/archive-wal.sh')+':/opt/jxc/archive-wal.sh:ro',IMAGE,'postgres','-c','wal_level=replica','-c','archive_mode=on','-c','archive_command=/opt/jxc/archive-wal.sh %p %f','-c','archive_timeout=30s');containers.append(source);wait_ready(source)
        command('docker','exec','-u','0',source,'chown','postgres:postgres','/base','/archive')
        sql(source,'CREATE TABLE pitr_marker(id integer PRIMARY KEY, description text NOT NULL)')
        cluster=sql(source,'SELECT system_identifier FROM pg_control_system()')
        command('docker','exec','-u','postgres',source,'pg_basebackup','-U','postgres','-D','/base','-X','stream','-c','fast')
        command('docker','exec','-u','postgres',source,'pg_verifybackup','/base')
        sql(source,"INSERT INTO pitr_marker VALUES(1,'committed before target')")
        target_time=sql(source,"SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')||'+00'")
        time.sleep(0.1)
        sql(source,"INSERT INTO pitr_marker VALUES(2,'committed after target')")
        segment=sql(source,'SELECT pg_walfile_name(pg_current_wal_lsn())')
        sql(source,'SELECT pg_switch_wal()')
        for _ in range(60):
            if subprocess.run(['docker','exec',source,'test','-f','/archive/'+segment],capture_output=True).returncode==0:break
            time.sleep(1)
        else:raise RuntimeError('Continuous WAL archive did not complete')
        raw=source_host/'retained';raw.mkdir(mode=0o700)
        export_tar(source,'/base',raw/'base.tar');export_tar(source,'/archive',raw/'wal.tar')
        manifest={'schemaVersion':1,'systemIdentifier':cluster,'targetTime':target_time,'files':{name:seal.recovery.hash_file(raw/name) for name in ('base.tar','wal.tar')}}
        seal.recovery.write_private(raw/'physical-manifest.json',seal.recovery.canonical(manifest))
        openssl=os.environ.get('JXC_OPENSSL') or shutil.which('openssl')
        command(openssl,'req','-x509','-newkey','rsa:2048','-nodes','-keyout',custody/'recipient.key','-out',custody/'recipient.pem','-days','1','-subj','/CN=synthetic-independent-custodian')
        for path in custody.iterdir():path.chmod(0o600)
        receipt=seal.seal(raw,custody/'recipient.pem',seal.recovery.hash_file(custody/'recipient.pem'),retained/'backup.cms')
        # Prove the source host and its local credentials are no longer usable during recovery.
        command('docker','rm','-f',source);containers.remove(source)
        for name in ('source','base','wal'):command('docker','volume','rm',volumes[name]);created.remove(volumes[name])
        shutil.rmtree(source_host)
        recovery_started=time.monotonic()
        seal.unseal(retained/'backup.cms',receipt['sha256'],custody/'recipient.key',restore_host/'unsealed')
        unsealed=restore_host/'unsealed';loaded=seal.recovery.read_json(unsealed/'physical-manifest.json')
        for name,pin in loaded['files'].items():
            if seal.recovery.hash_file(unsealed/name)!=pin:raise RuntimeError('Retained physical payload hash mismatch')
        load_volume(volumes['target'],unsealed/'base.tar');load_volume(volumes['retained_wal'],unsealed/'wal.tar')
        recovery_configuration="restore_command = 'cp /archive/%f %p'\nrecovery_target_time = '"+target_time+"'\nrecovery_target_action = 'promote'\n"
        command('docker','run','--rm','-i','-v',volumes['target']+':/data',IMAGE,'sh','-ec','cat >> /data/postgresql.auto.conf\ntouch /data/recovery.signal\nchown postgres:postgres /data/postgresql.auto.conf /data/recovery.signal',input=recovery_configuration.encode())
        command('docker','run','-d','--name',target,'--label',label,'-v',volumes['target']+':/var/lib/postgresql/data','-v',volumes['retained_wal']+':/archive:ro',IMAGE,'postgres','-c','archive_mode=off');containers.append(target);wait_ready(target)
        for _ in range(60):
            if sql(target,'SELECT pg_is_in_recovery()')=='f':break
            time.sleep(1)
        else:raise RuntimeError('PITR target never promoted')
        markers=sql(target,'SELECT string_agg(id::text,\',\' ORDER BY id) FROM pitr_marker')
        if markers!='1' or sql(target,'SELECT system_identifier FROM pg_control_system()')!=cluster:raise RuntimeError('PITR did not stop at the requested committed boundary')
        result={'schemaVersion':1,'status':'passed','mode':'ISOLATED_SYNTHETIC_REHEARSAL','postgresImage':IMAGE,'baseBackupVerified':True,'continuousWalArchived':True,'sourceContainerRemoved':True,'sourceVolumesRemoved':True,'sourceSecretsDirectoryRemoved':True,'independentRecipientKeyUsed':True,'encryptedBundleSha256':receipt['sha256'],'beforeTargetTransactionPresent':True,'afterTargetTransactionAbsent':True,'pitrRecoverySeconds':round(time.monotonic()-recovery_started,3),'totalSeconds':round(time.monotonic()-started,3),'productionReleased':False,'physicalOffsiteDurabilityVerified':False}
        Path(output).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');return result
    finally:
        for container in containers:
            subprocess.run(['docker','rm','-f',container],capture_output=True)
        for volume in created:
            subprocess.run(['docker','volume','rm',volume],capture_output=True)
        for directory in (source_host,restore_host,retained,custody):
            if directory.exists():shutil.rmtree(directory)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',required=True);args=parser.parse_args()
    print(json.dumps(run(args.output),ensure_ascii=False))
