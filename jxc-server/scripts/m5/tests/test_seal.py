"""Encrypted off-host backup roundtrip and tamper boundaries; all keys are synthetic and temporary."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


def sealing():
    spec=importlib.util.spec_from_file_location('seal',Path(__file__).resolve().parents[1]/'seal.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


@unittest.skipUnless(Path('/opt/homebrew/opt/openssl@3/bin/openssl').exists() or shutil.which('openssl'), 'OpenSSL required')
class SealedBackupTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='jxc-sealed-backup-');self.root=Path(self.temp.name);self.root.chmod(0o700)
        self.openssl='/opt/homebrew/opt/openssl@3/bin/openssl' if Path('/opt/homebrew/opt/openssl@3/bin/openssl').exists() else shutil.which('openssl')
        self.old=os.environ.get('JXC_OPENSSL');os.environ['JXC_OPENSSL']=self.openssl
        subprocess.run([self.openssl,'req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(self.root/'key.pem'),'-out',str(self.root/'recipient.pem'),'-days','1','-subj','/CN=synthetic-backup-custodian'],check=True,capture_output=True)
        for path in self.root.iterdir():path.chmod(0o600)
        (self.root/'source').mkdir(mode=0o700);(self.root/'source'/'manifest.json').write_text('{"synthetic":true}');(self.root/'source'/'manifest.json').chmod(0o600)
    def tearDown(self):
        if self.old is None:os.environ.pop('JXC_OPENSSL',None)
        else:os.environ['JXC_OPENSSL']=self.old
        self.temp.cleanup()
    def test_encrypted_backup_restores_after_source_directory_and_local_secrets_are_unavailable(self):
        s=sealing();receipt=s.seal(self.root/'source',self.root/'recipient.pem',s.recovery.hash_file(self.root/'recipient.pem'),self.root/'offsite.cms')
        shutil.rmtree(self.root/'source')
        result=s.unseal(self.root/'offsite.cms',receipt['sha256'],self.root/'key.pem',self.root/'restored')
        self.assertEqual('{"synthetic":true}',(self.root/'restored'/'manifest.json').read_text())
        self.assertNotIn('manifestSha256',result)
        self.assertNotIn('batchId',result)

    def test_m5_unseal_binds_authenticated_ciphertext_to_verified_bundle_identity(self):
        from test_recovery import RecoveryBoundaryTest
        fixture=RecoveryBoundaryTest('test_verified_bundle_accepts_exact_payload_and_pin')
        fixture.setUp();self.addCleanup(fixture.tearDown)
        manifest=fixture.make_bundle();s=sealing()
        receipt=s.seal(fixture.root,self.root/'recipient.pem',s.recovery.hash_file(self.root/'recipient.pem'),self.root/'offsite.cms')
        result=s.unseal(self.root/'offsite.cms',receipt['sha256'],self.root/'key.pem',self.root/'restored')
        self.assertEqual(receipt['sha256'],result['sha256'])
        self.assertEqual(fixture.pin(),result.get('manifestSha256'))
        self.assertEqual(manifest['batchId'],result.get('batchId'))
        self.assertEqual(manifest['source'],result.get('source'))
        self.assertEqual(str((self.root/'restored').resolve()),result.get('bundlePath'))

    def test_invalid_m5_payload_cannot_get_a_successful_unseal_bundle_receipt(self):
        from test_recovery import RecoveryBoundaryTest
        fixture=RecoveryBoundaryTest('test_verified_bundle_accepts_exact_payload_and_pin')
        fixture.setUp();self.addCleanup(fixture.tearDown)
        fixture.make_bundle();(fixture.root/'database.dump').write_bytes(b'corrupt M5 payload')
        s=sealing();receipt=s.seal(fixture.root,self.root/'recipient.pem',s.recovery.hash_file(self.root/'recipient.pem'),self.root/'offsite.cms')
        with self.assertRaises(s.recovery.RecoveryError):
            s.unseal(self.root/'offsite.cms',receipt['sha256'],self.root/'key.pem',self.root/'restored')
        self.assertFalse((self.root/'restored').exists())

    def test_physical_pitr_archive_keeps_the_generic_unseal_receipt(self):
        (self.root/'source'/'manifest.json').unlink()
        payload=self.root/'source'/'physical-manifest.json';payload.write_text('{"kind":"physical-pitr"}');payload.chmod(0o600)
        s=sealing();receipt=s.seal(self.root/'source',self.root/'recipient.pem',s.recovery.hash_file(self.root/'recipient.pem'),self.root/'offsite.cms')
        result=s.unseal(self.root/'offsite.cms',receipt['sha256'],self.root/'key.pem',self.root/'restored')
        self.assertEqual({'status':'UNSEALED','databaseRestored':False,'sha256':receipt['sha256']},result)
        self.assertEqual(payload.read_bytes(),(self.root/'restored'/'physical-manifest.json').read_bytes())
    def test_tampered_ciphertext_cannot_create_a_restore_directory(self):
        s=sealing();receipt=s.seal(self.root/'source',self.root/'recipient.pem',s.recovery.hash_file(self.root/'recipient.pem'),self.root/'offsite.cms')
        data=bytearray((self.root/'offsite.cms').read_bytes());data[-1]^=1;(self.root/'offsite.cms').write_bytes(data)
        with self.assertRaises(s.SealError):s.unseal(self.root/'offsite.cms',receipt['sha256'],self.root/'key.pem',self.root/'restored')
        self.assertFalse((self.root/'restored').exists())
        # A replaced transport hash cannot bypass the envelope authentication tag.
        with self.assertRaises(s.SealError):s.unseal(self.root/'offsite.cms',s.recovery.hash_file(self.root/'offsite.cms'),self.root/'key.pem',self.root/'restored')
        self.assertFalse((self.root/'restored').exists())
    def test_recipient_pin_and_symlink_sources_fail_closed(self):
        s=sealing()
        with self.assertRaises(s.SealError):s.seal(self.root/'source',self.root/'recipient.pem','0'*64,self.root/'offsite.cms')
        (self.root/'source'/'escaped').symlink_to(self.root/'key.pem')
        with self.assertRaises(s.SealError):s.seal(self.root/'source',self.root/'recipient.pem',s.recovery.hash_file(self.root/'recipient.pem'),self.root/'offsite.cms')
