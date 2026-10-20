"""Infrastructure selection boundaries; all container/S3 effects are synthetic mocks."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'release-logical-recovery.py'


class LogicalInfrastructureBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='logical-infrastructure-test-')
        self.addCleanup(self.tmp.cleanup)
        self.private = Path(self.tmp.name)
        spec = importlib.util.spec_from_file_location('logical_infrastructure_boundary', SCRIPT)
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.image = 'sha256:' + 'a' * 64
        self.name = 'hengshuo-closure-logical-012345abcdef-source-objects'
        self.label = 'com.hengshuo.logical-recovery=012345abcdef'

    def test_original_images_remain_defaults_and_explicit_images_are_immutable(self):
        selected = getattr(self.helper, 'selected_images', None)
        self.assertTrue(callable(selected), 'The optional image override must be validated before effects')
        self.assertEqual((self.helper.PG, self.helper.S3), selected())
        for image in (self.image, 'registry.example.test/a:reviewed@sha256:' + 'b' * 64):
            with self.subTest(image=image):
                self.assertEqual((image, image), selected(image, image))
        for invalid in ('', 'postgres:latest', 'sha256:abc', 'repo@sha256:' + 'A' * 64,
                        'sha256:' + 'a' * 64 + '\n', '--privileged', True):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                selected(invalid, self.image)

    def test_seaweed_requires_explicit_immutable_object_image_and_known_engine(self):
        selected = getattr(self.helper, 'selected_images', None)
        self.assertTrue(callable(selected), 'Seaweed cannot silently use the old MinIO default')
        for engine, image in (('seaweed', None), ('seaweed', 'chrislusf/seaweedfs:latest'),
                              ('unknown', self.image)):
            with self.subTest(engine=engine, image=image), self.assertRaises(ValueError):
                selected(None, image, engine)
        self.assertEqual((self.helper.PG, self.image), selected(None, self.image, 'seaweed'))

    def object_fixture(self, *, accept_retired_admin=False, first_head_unavailable=False):
        calls, launches, requests, containers = [], [], [], []
        state = {'launch': 0, 'firstHead': True}
        class RecoveryError(RuntimeError):
            pass
        class Client:
            def __init__(client, config):client.config = config
            def request(client, method, *args, **kwargs):
                requests.append((client.config.copy(), method))
                if first_head_unavailable and state['firstHead']:
                    state['firstHead'] = False
                    raise RecoveryError('S3 endpoint unavailable')
                if state['launch'] == 2 and client.config['accessKey'] == 'fixture-secret-3' and not accept_retired_admin:
                    raise RecoveryError('S3 request failed with HTTP 403')
                return b''
            def empty(client):
                requests.append((client.config.copy(), 'LIST'))
                return True
        def run(command, **kwargs):
            calls.append((command, kwargs))
            if command[:2] == ['docker', 'run']:
                state['launch'] += 1
                mount = next((v for v in command if v.startswith('type=bind,src=') and 'dst=/run/secrets/object_s3_config' in v), None)
                if mount:
                    config_path = Path(mount.split('src=', 1)[1].split(',dst=', 1)[0])
                    launches.append({'command':command, 'config':json.loads(config_path.read_text()),
                                     'path':config_path, 'mode':config_path.stat().st_mode & 0o777})
            return '127.0.0.1:59001' if command[:2] == ['docker', 'port'] else ''
        def wait(predicate, description):
            for _ in range(3):
                if predicate():return
            raise RuntimeError('Synthetic readiness did not succeed: ' + description)
        secrets = iter('fixture-secret-' + str(i) for i in range(1, 7))
        return dict(run=run, wait=wait, recovery=SimpleNamespace(S3=Client, RecoveryError=RecoveryError),
                    password=lambda:next(secrets), containers=containers), calls, launches, requests

    def start(self, engine='seaweed', probe=None, **options):
        create = getattr(self.helper, 'create_object_store', None)
        self.assertTrue(callable(create), 'Only the isolated object-container adapter should change')
        fixture, calls, launches, requests = self.object_fixture(**options)
        result = create(engine, self.image, self.name, self.label, 'closure-source-012345abcdef',
                        self.private / 'objects', probe=probe, **fixture)
        return result, fixture, calls, launches, requests

    def test_original_minio_creation_and_health_semantics_are_preserved(self):
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self, *args):return False
        with patch.object(self.helper.urllib.request, 'urlopen', return_value=Response()):
            (storage, proof), fixture, calls, launches, requests = self.start('minio')
        command, options = next(c for c in calls if c[0][:2] == ['docker', 'run'])
        self.assertEqual([self.image, 'server', '/data'], command[-3:])
        self.assertEqual('fixture-secret-1', options['env']['MINIO_ROOT_USER'])
        self.assertNotIn('fixture-secret-1', command)
        self.assertEqual('http://127.0.0.1:59001', storage['endpoint'])
        self.assertEqual(['PUT'], [method for _, method in requests])
        self.assertFalse(launches)
        self.assertFalse(proof['initializerCredentialRemoved'])

    def test_seaweed_initializes_then_runs_only_bucket_scoped_credentials(self):
        (storage, proof), fixture, calls, launches, requests = self.start()
        self.assertEqual(2, len(launches))
        initial, runtime = launches
        self.assertEqual(['Admin', 'Read', 'List', 'Write'], initial['config']['identities'][0]['actions'])
        identity = runtime['config']['identities'][0]
        self.assertEqual(['Read:closure-source-012345abcdef', 'List:closure-source-012345abcdef',
                          'Write:closure-source-012345abcdef'], identity['actions'])
        self.assertEqual(1, len(runtime['config']['identities']))
        self.assertEqual(storage['accessKey'], identity['credentials'][0]['accessKey'])
        self.assertNotEqual(initial['config']['identities'][0]['credentials'], identity['credentials'])
        self.assertEqual((0o600, 0o600), (initial['mode'], runtime['mode']))
        self.assertFalse(initial['path'].exists())
        self.assertTrue(proof['initializerCredentialRemoved'])
        self.assertTrue(proof['retiredInitializerCredentialRejected'])
        self.assertTrue(proof['runtimeSignedBucketReadinessVerified'])
        fixture_user=str(os.getuid())+':'+str(os.getgid())
        self.assertEqual(fixture_user, proof['isolatedFixtureUser'])
        self.assertFalse(proof['productionNonRootVerified'])
        self.assertTrue(all('--user' in item['command'] and item['command'][item['command'].index('--user')+1]==fixture_user for item in launches))
        self.assertEqual([self.name], fixture['containers'])
        stop = next(i for i, (cmd, _) in enumerate(calls) if cmd[:2] == ['docker', 'stop'])
        starts = [i for i, (cmd, _) in enumerate(calls) if cmd[:2] == ['docker', 'run']]
        self.assertLess(starts[0], stop)
        self.assertLess(stop, starts[1])
        for launch in launches:
            self.assertIn('127.0.0.1::9000', launch['command'])
            for flag in ('-s3.port=9000', '-admin.ui=false', '-webdav=false', '-s3.port.iceberg=0',
                         '-s3.port.lance=0', '-s3.iam=false', '-s3.autoCreateBucket=false',
                         '-s3.allowDeleteBucketNotEmpty=false', '-filer.tusBasePath='):
                self.assertIn(flag, launch['command'])
            self.assertFalse(any('fixture-secret-' in value for value in launch['command']))
        self.assertIn('-bucket=closure-source-012345abcdef', initial['command'])
        self.assertFalse(any(value.startswith('-bucket=') for value in runtime['command']))
        self.assertFalse(any(method == 'PUT' for _, method in requests), 'Runtime must never create the bucket')

    def test_seaweed_refuses_a_runtime_that_still_accepts_initializer_credentials(self):
        with self.assertRaisesRegex(RuntimeError, 'initializer'):
            self.start(accept_retired_admin=True)

    def test_seaweed_signed_readiness_retries_unavailable_endpoint(self):
        (storage, proof), fixture, calls, launches, requests = self.start(first_head_unavailable=True)
        self.assertTrue(proof['runtimeSignedBucketReadinessVerified'])
        self.assertGreaterEqual(sum(method == 'HEAD' for _, method in requests), 4)

    def test_seaweed_safety_probe_has_a_distinct_prebuilt_bucket_and_scoped_identity(self):
        probe = {}
        (storage, proof), fixture, calls, launches, requests = self.start(probe=probe)
        identities = launches[1]['config']['identities']
        self.assertEqual(2, len(identities))
        identity = identities[1]
        self.assertRegex(probe['bucket'], r'^jxc-m5-probe-[0-9a-f]{12}\Z')
        self.assertNotEqual(storage['bucket'], probe['bucket'])
        self.assertNotEqual(storage['accessKey'], probe['accessKey'])
        self.assertNotEqual(storage['secretKey'], probe['secretKey'])
        self.assertEqual([action+':'+probe['bucket'] for action in ('Read','List','Write')], identity['actions'])
        self.assertEqual(probe['accessKey'], identity['credentials'][0]['accessKey'])
        self.assertEqual(storage['endpoint'], probe['endpoint'])
        self.assertIn('-bucket='+storage['bucket']+','+probe['bucket'], launches[0]['command'])
        self.assertTrue(proof['independentSafetyProbeBucketVerified'])

    def test_invalid_selection_is_refused_before_missing_jar_or_any_subprocess(self):
        output = self.private / 'evidence.json'
        argv = [str(SCRIPT), '--jar', str(self.private / 'missing.jar'), '--jar-sha256', 'a' * 64,
                '--object-engine', 'seaweed', '--output', str(output)]
        with patch.object(sys, 'argv', argv), patch.object(self.helper.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'explicit'):
                self.helper.main()
        run.assert_not_called()
        self.assertFalse(output.exists())

    def live_probe_fixture(self):
        tests = self.helper.ROOT / 'jxc-server/scripts/m5/tests'
        with patch.object(sys, 'path', [str(tests), *sys.path]):
            spec = importlib.util.spec_from_file_location('logical_existing_live_probe', tests / 'test_recovery_live.py')
            live = importlib.util.module_from_spec(spec);spec.loader.exec_module(live)
        real = self.helper.module('logical_probe_private_json', tests.parent / 'recovery.py')
        operations, objects = [], {}
        class Client:
            def __init__(client, config):client.config = config
            def empty(client):return not any(bucket == client.config['bucket'] for bucket, _ in objects)
            def request(client, method, key='', data=b'', **options):
                operations.append((method, key, client.config.copy()))
                if method == 'PUT' and not key:
                    if client.config['accessKey'] == 'probe-key':raise AssertionError('A bucket-scoped runtime must not create a bucket')
                    return b''
                if method == 'PUT':
                    item = (client.config['bucket'], key)
                    if options.get('if_absent') and item in objects:raise real.RecoveryError('S3 request failed with HTTP 412')
                    objects[item] = data;return b''
                return objects[(client.config['bucket'], key)]
        case = live.RealRecoverySafetyTest('test_conditional_object_put_does_not_overwrite_existing_bytes')
        target = {'endpoint':'http://127.0.0.1:59001','bucket':'closure-target-fixture','accessKey':'target-key','secretKey':'target-secret'}
        case.config = {'target':{'storage':target}}
        case.r = SimpleNamespace(S3=Client, RecoveryError=real.RecoveryError,
                                 read_json=real.read_json, outside_workspace=real.outside_workspace)
        probe = {'endpoint':target['endpoint'],'bucket':'jxc-m5-probe-012345abcdef','accessKey':'probe-key','secretKey':'probe-secret'}
        path = self.private / 'probe-storage.json'
        def save(value):path.write_text(json.dumps(value));path.chmod(0o600)
        save(probe)
        return case, probe, path, save, operations

    def test_original_conditional_put_case_uses_explicit_prebuilt_probe_without_admin(self):
        case, probe, path, save, operations = self.live_probe_fixture()
        with patch.dict(os.environ, {'M5_RECOVERY_PROBE_STORAGE':str(path)}):
            case.test_conditional_object_put_does_not_overwrite_existing_bytes()
        self.assertEqual(['PUT','PUT','GET'], [method for method, _, _ in operations])
        self.assertTrue(all(config == probe for _, _, config in operations))
        operations.clear()
        with patch.dict(os.environ, {}, clear=True):
            case.test_conditional_object_put_does_not_overwrite_existing_bytes()
        self.assertEqual(('PUT',''), operations[0][:2], 'Original MinIO bucket creation remains the default')

    def test_live_probe_rejects_target_identity_other_endpoint_or_untrusted_private_config(self):
        case, probe, path, save, operations = self.live_probe_fixture()
        for changed in ({**probe,'endpoint':'http://127.0.0.1:59002'},
                        {**probe,'bucket':'closure-target-fixture'},
                        {**probe,'accessKey':'target-key'},
                        {**probe,'secretKey':'target-secret'},
                        {**probe,'accessKey':''}, {**probe,'admin':True}):
            with self.subTest(changed=changed):
                save(changed)
                with patch.dict(os.environ, {'M5_RECOVERY_PROBE_STORAGE':str(path)}), self.assertRaises((AssertionError,RuntimeError)):
                    case.test_conditional_object_put_does_not_overwrite_existing_bytes()
                self.assertFalse(operations)
        save(probe);path.chmod(0o644)
        with patch.dict(os.environ, {'M5_RECOVERY_PROBE_STORAGE':str(path)}), self.assertRaises(RuntimeError):
            case.test_conditional_object_put_does_not_overwrite_existing_bytes()


if __name__ == '__main__':unittest.main()
