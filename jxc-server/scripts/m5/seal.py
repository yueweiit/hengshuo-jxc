#!/usr/bin/env python3
"""AES-256-GCM CMS backup envelope. The recipient private key belongs to independent custody.

Uses existing M5 path/privacy/hash primitives. No database or storage writes, no key
creation, no key export, and no in-place overwrite. Unsealing alone never restores a DB.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

spec=importlib.util.spec_from_file_location('m5_recovery',Path(__file__).with_name('recovery.py'))
recovery=importlib.util.module_from_spec(spec);spec.loader.exec_module(recovery)

class SealError(ValueError):pass

def require(condition,message):
    if not condition:raise SealError(message)

def openssl(*args):
    binary=os.environ.get('JXC_OPENSSL') or shutil.which('openssl')
    require(binary is not None,'OpenSSL 3 with CMS AES-GCM support is required')
    result=subprocess.run([binary,*map(str,args)],capture_output=True,timeout=300)
    require(result.returncode==0,'Authenticated backup envelope operation failed')

def digest_matches(path,pin):
    require(isinstance(pin,str) and len(pin)==64 and recovery.hash_file(path)==pin,'External hash pin mismatch')

def seal(source,certificate,recipient_pin,output):
    source=recovery.outside_workspace(source);certificate=recovery.private(Path(certificate));output=recovery.outside_workspace(output)
    recovery.private(source,directory=True)
    require(not output.exists() and not output.is_symlink() and source not in output.parents,'New independent output file required')
    digest_matches(certificate,recipient_pin)
    files=sorted(source.rglob('*'))
    require(files,'Backup source is empty')
    for file in files:
        require(not file.is_symlink() and (file.is_file() or file.is_dir()),'Backup links and special files are forbidden')
        if file.is_file():
            recovery.private(file);require(file.stat().st_nlink==1,'Hard-linked backup files are forbidden')
    with tempfile.TemporaryDirectory(prefix='jxc-seal-') as directory:
        plain=Path(directory)/'backup.tar';encrypted=Path(directory)/'backup.cms'
        with tarfile.open(plain,'w') as archive:
            for file in files:
                def metadata(info):
                    info.uid=info.gid=0;info.uname=info.gname='';info.mode=0o700 if info.isdir() else 0o600;return info
                archive.add(file,arcname=file.relative_to(source).as_posix(),recursive=False,filter=metadata)
        plain.chmod(0o600)
        openssl('cms','-encrypt','-aes-256-gcm','-binary','-outform','DER','-in',plain,'-out',encrypted,certificate)
        # Atomic exclusive create prevents a raced output path from being overwritten.
        with output.open('xb') as stream:
            output.chmod(0o600)
            with encrypted.open('rb') as content:shutil.copyfileobj(content,stream)
            stream.flush();os.fsync(stream.fileno())
    return {'schemaVersion':1,'algorithm':'CMS-AES-256-GCM','recipientSha256':recipient_pin,'sha256':recovery.hash_file(output),'bytes':output.stat().st_size}

def unseal(encrypted,pin,private_key,output):
    encrypted=recovery.private(Path(encrypted));private_key=recovery.private(Path(private_key));output=recovery.outside_workspace(output)
    require(not output.exists() and not output.is_symlink(),'New private restore directory required')
    digest_matches(encrypted,pin)
    result={'status':'UNSEALED','databaseRestored':False,'sha256':pin}
    with tempfile.TemporaryDirectory(prefix='jxc-unseal-') as directory:
        plain=Path(directory)/'backup.tar'
        openssl('cms','-decrypt','-binary','-inform','DER','-in',encrypted,'-inkey',private_key,'-out',plain)
        plain.chmod(0o600)
        with tarfile.open(plain,'r:') as archive:
            names=set();members=archive.getmembers();total=0
            require(len(members)<=300000,'Backup file count exceeds reviewed bound')
            for member in members:
                recovery.safe_path(member.name)
                require((member.isfile() or member.isdir()) and member.name not in names,'Backup members must be unique ordinary files/directories')
                names.add(member.name);total+=member.size
            require(total<=100*1024**3,'Backup plaintext exceeds reviewed bound')
            output.mkdir(mode=0o700)
            try:
                for member in members:
                    destination=output/member.name
                    if member.isdir():destination.mkdir(parents=True,exist_ok=True,mode=0o700)
                    else:
                        destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                        with destination.open('xb') as stream:
                            destination.chmod(0o600)
                            with archive.extractfile(member) as content:shutil.copyfileobj(content,stream)
                # Generic archives (including physical PITR packages) keep their existing receipt.
                # Only authenticated, fully verified M5 bundles may acquire a bundle identity.
                candidate=output/'manifest.json'
                is_m5=any((output/name).exists() for name in ('database.dump','snapshot.json','freeze-proof.json'))
                if candidate.is_file():
                    try:metadata=recovery.read_json(candidate)
                    except recovery.RecoveryError:
                        if is_m5:raise
                    else:is_m5=is_m5 or (isinstance(metadata,dict) and {'schemaVersion','batchId','files','attachments'}<=metadata.keys())
                if is_m5:
                    manifest_pin=recovery.hash_file(candidate)
                    manifest=recovery.verify_bundle(output,manifest_pin)
                    require(isinstance(manifest.get('source'),dict) and set(manifest['source'])=={'container','database'},'M5 bundle source identity required')
                    result.update(manifestSha256=manifest_pin,batchId=manifest['batchId'],source=manifest['source'],bundlePath=str(output.resolve()))
            except Exception:
                shutil.rmtree(output);raise
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
    encrypt=sub.add_parser('seal')
    for name in ('source','certificate','recipient-sha256','output'):encrypt.add_argument('--'+name,required=True)
    decrypt=sub.add_parser('unseal')
    for name in ('input','sha256','private-key','output'):decrypt.add_argument('--'+name,required=True)
    args=parser.parse_args()
    try:
        result=seal(args.source,args.certificate,args.recipient_sha256,args.output) if args.command=='seal' else unseal(args.input,args.sha256,args.private_key,args.output)
        print(recovery.canonical(result).decode());return 0
    except (SealError,recovery.RecoveryError,OSError,tarfile.TarError,subprocess.SubprocessError):
        print('{"status":"BACKUP_ENVELOPE_BLOCKED"}');return 2

if __name__=='__main__':raise SystemExit(main())
