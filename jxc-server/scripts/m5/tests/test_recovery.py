"""Recovery boundary tests; live rehearsal is separate and uses real PG16/S3."""
import hashlib
from functools import lru_cache
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import shutil
import sys
import os

SCRIPT = Path(__file__).resolve().parents[1] / "recovery.py"


@lru_cache(maxsize=1)
def tool():
    if not SCRIPT.exists():
        raise AssertionError("M5 recovery tool is required before backup/restore can run")
    spec = importlib.util.spec_from_file_location("m5_recovery", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecoveryBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="m5-recovery-test-")
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)

    def tearDown(self):
        self.temp.cleanup()

    def make_bundle(self):
        data = b"private synthetic attachment\n"
        digest = hashlib.sha256(data).hexdigest()
        files = {
            "database.dump": b"PGDMP synthetic fixture only",
            "snapshot.json": b'{"tables":{}}\n',
            "freeze-proof.json": b'{"mode":"FROZEN"}\n',
            f"objects/{digest}.bin": data,
        }
        for name, content in files.items():
            path = self.root / name
            path.parent.mkdir(exist_ok=True, mode=0o700)
            path.write_bytes(content)
            path.chmod(0o600)
        manifest = {
            "schemaVersion": 1,
            "batchId": "de68df96-b030-49e1-b72e-d9694aa20e34",
            "source": {"container": "hengshuo-m4-browser-postgres-1", "database": "jxc_m01_isolated"},
            "files": {name: {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()} for name, content in files.items()},
            "attachments": [{"id": 1, "storageKey": "country/1/attachments/fixture", "size": len(data), "sha256": digest, "file": f"objects/{digest}.bin"}],
        }
        self.write_manifest(manifest)
        return manifest

    def write_manifest(self, manifest):
        raw = (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()
        path = self.root / "manifest.json"
        path.write_bytes(raw)
        path.chmod(0o600)
        return hashlib.sha256(raw).hexdigest()

    def pin(self):
        return hashlib.sha256((self.root / "manifest.json").read_bytes()).hexdigest()

    def test_verified_bundle_accepts_exact_payload_and_pin(self):
        expected = self.make_bundle()
        self.assertEqual(expected, tool().verify_bundle(self.root, self.pin()))

    def test_reviewed_ui_upgrade_accepts_only_the_exact_two_immutable_appends(self):
        path=SCRIPT.parents[3]/'docs/backend/evidence/scripts/release-ui-restart.py'
        spec=importlib.util.spec_from_file_location('m5_ui_upgrade_boundary',path)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        self.assertTrue(callable(getattr(helper,'reviewed_append',None)),'The 39-to-41 migration allowlist must be enforced before stopping any process')
        first='V013_7__shipment_measurement_and_receipt_confirmation.sql'
        second='V013_8__zero_posting_event_interpretation.sql'
        old={'V001_'+str(i)+'__history.sql':'a'*64 for i in range(39)}
        new={**old,first:'b'*64,second:'c'*64}
        self.assertEqual(2,helper.reviewed_append(old,new,second))
        self.assertEqual(1,helper.reviewed_append(old,{**old,first:'b'*64},first))
        invalid=[{**old,second:'c'*64},{**new,next(iter(old)):'d'*64},
                 {**old,first:'b'*64,'V013_9__unexpected.sql':'c'*64},
                 {**new,'V014__extra.sql':'d'*64}]
        for changed in invalid:
            with self.subTest(scripts=set(changed)-set(old)),self.assertRaises(ValueError):
                helper.reviewed_append(old,changed,second)

    def test_reviewed_assignment_upgrade_requires_exact_append_and_empty_new_tables(self):
        path=SCRIPT.parents[3]/'docs/backend/evidence/scripts/release-ui-restart.py'
        spec=importlib.util.spec_from_file_location('m5_assignment_upgrade_boundary',path)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        migration='V013_9__confirmed_bill_cost_assignment.sql'
        old={'V001_'+str(i)+'__history.sql':'a'*64 for i in range(41)}
        new={**old,migration:'b'*64}
        self.assertIn(migration,helper.REVIEWED_UPGRADES, 'The reviewed 41-to-42 append requires its own exact migration mode')
        self.assertEqual(1,helper.reviewed_append(old,new,migration))
        for changed in ({**new,next(iter(old)):'c'*64},{**new,'V014__unknown.sql':'c'*64},{**old,'V013_9__different.sql':'b'*64}):
            with self.subTest(scripts=set(changed)-set(old)),self.assertRaises(ValueError):
                helper.reviewed_append(old,changed,migration)
        self.assertTrue(callable(getattr(helper,'reviewed_assignment_tables',None)), 'New assignment tables must be proven empty, never generically excluded')
        before=[{'kind':'table','name':'ap_bill','rowCount':1,'rowsSha256':'a'*64},
                {'kind':'table','name':'flyway_schema_history','rowCount':41,'rowsSha256':'b'*64},
                {'kind':'sequence','name':'jxc_id_seq','lastValue':123,'isCalled':True}]
        appended=[{'kind':'table','name':name,'rowCount':0,'rowsSha256':hashlib.sha256(b'').hexdigest()}
                  for name in ('ap_cost_assignment','ap_cost_assignment_line')]
        after=[before[0],{'kind':'table','name':'flyway_schema_history','rowCount':42,'rowsSha256':'c'*64},before[2],*appended]
        self.assertEqual(after[:3],helper.reviewed_assignment_tables(before,after))
        for mutated in (
            after[:-1],
            [*after,{'kind':'table','name':'unknown_table','rowCount':0,'rowsSha256':hashlib.sha256(b'').hexdigest()}],
            [{**row,'rowCount':1} if row['name']=='ap_cost_assignment' else row for row in after],
            [{**row,'rowsSha256':'d'*64} if row['name']=='ap_bill' else row for row in after],
            [{**row,'lastValue':124} if row['name']=='jxc_id_seq' else row for row in after],
        ):
            with self.subTest(snapshot=mutated),self.assertRaises(ValueError):
                helper.reviewed_assignment_tables(before,mutated)

    def test_assignment_upgrade_checks_pinned_old_catalog_and_never_falls_back_after_ddl(self):
        path=SCRIPT.parents[3]/'docs/backend/evidence/scripts/release-ui-restart.py'
        spec=importlib.util.spec_from_file_location('m5_assignment_preflight_boundary',path)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        self.assertTrue(callable(getattr(helper,'reviewed_assignment_preflight',None)), 'The exact original 41 catalog must pass before any DDL')
        archive=SCRIPT.parents[3]/'docs/backend/evidence/archive/audit-contract-closure-candidate-41.json'
        prior=json.loads(archive.read_text());migrations={row['script']:row['sha256'] for row in prior['migration_files']}
        queries=[]
        def sql(query):
            queries.append(query)
            return json.dumps(prior['tables'] if 'json_object_agg(table_name,columns' in query else [])
        self.assertEqual(prior,helper.reviewed_assignment_preflight(sql,migrations))
        self.assertTrue(any('pg_constraint' in query and 'pg_trigger' in query and 'pg_class' in query for query in queries), 'Preflight must inspect constraints and triggers, not only column names')
        for gap in ('FORCE_RLS','jxc_write_gate','ap_source_claim_country_id_bill_id_fkey'):
            def weakened(query):
                return json.dumps(prior['tables'] if 'json_object_agg(table_name,columns' in query else [{'table_name':'ap_bill','constraint_name':gap}])
            with self.subTest(gap=gap),self.assertRaisesRegex(ValueError,'catalog'):helper.reviewed_assignment_preflight(weakened,migrations)
        with patch.object(helper,'PRIOR_ASSIGNMENT_CONTRACT_SHA256','0'*64),self.assertRaisesRegex(ValueError,'pin'):helper.reviewed_assignment_preflight(sql,migrations)
        self.assertFalse(helper.previous_runtime_fallback_allowed(True,True,helper.ASSIGNMENT_SCRIPT), 'An old f3 jar cannot restore the new assignment policy after migration')
        self.assertFalse(helper.previous_runtime_fallback_allowed(True,False,helper.ASSIGNMENT_SCRIPT))
        self.assertTrue(helper.previous_runtime_fallback_allowed(False,False,helper.ASSIGNMENT_SCRIPT))
        self.assertTrue(helper.previous_runtime_fallback_allowed(True,True,helper.ZERO_POSTING_SCRIPT), 'Retain the earlier reviewed upgrade boundary')

    def test_logical_cleanup_failure_preserves_diagnostics_and_cannot_report_passed(self):
        path=SCRIPT.parents[3]/'docs/backend/evidence/scripts/release-logical-recovery.py'
        spec=importlib.util.spec_from_file_location('m5_logical_cleanup',path)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        private=self.root/'diagnostics';private.mkdir(mode=0o700);(private/'retained.txt').write_text('synthetic diagnostic')
        output=self.root/'cleanup.json';evidence={'status':'passed'};suffix='012345abcdef'
        def docker(command,**kwargs):
            return subprocess.CompletedProcess(command,0,suffix+'\n','') if command[1]=='inspect' else subprocess.CompletedProcess(command,1,'','fixture removal failed')
        with patch.object(helper.subprocess,'run',side_effect=docker),self.assertRaisesRegex(RuntimeError,'clean'):
            helper.finish_rehearsal(output,evidence,['hengshuo-closure-logical-'+suffix+'-target'],private,True,'com.hengshuo.logical-recovery='+suffix)
        saved=json.loads(output.read_text());self.assertEqual('failed',saved['status']);self.assertFalse(saved['ownedResourcesCleaned']);self.assertTrue((private/'retained.txt').exists())

    def test_logical_cleanup_refuses_other_names_and_labels_but_continues_own_cleanup(self):
        path=SCRIPT.parents[3]/'docs/backend/evidence/scripts/release-logical-recovery.py'
        spec=importlib.util.spec_from_file_location('m5_logical_cleanup_scope',path)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        private=self.root/'diagnostics';private.mkdir(mode=0o700);output=self.root/'cleanup.json';suffix='012345abcdef';prefix='hengshuo-closure-logical-'+suffix+'-'
        calls=[]
        def docker(command,**kwargs):
            calls.append(command)
            if command[-1] not in (prefix+'source',prefix+'target'):return subprocess.CompletedProcess(command,1,'','Error: No such object: '+command[-1])
            return subprocess.CompletedProcess(command,0,('another-run' if command[-1]==prefix+'source' else suffix)+'\n','')
        with patch.object(helper.subprocess,'run',side_effect=docker),self.assertRaisesRegex(RuntimeError,'clean'):
            helper.finish_rehearsal(output,{'status':'passed'},['unrelated-production',prefix+'source',prefix+'target'],private,True,'com.hengshuo.logical-recovery='+suffix)
        self.assertEqual([['docker','rm','-fv',prefix+'target']],[c for c in calls if c[1]=='rm']);self.assertFalse(any('unrelated-production' in c for c in calls));self.assertTrue(private.exists());self.assertEqual('failed',json.loads(output.read_text())['status'])

    def test_logical_cleanup_success_and_already_absent_resources_are_verified(self):
        path=SCRIPT.parents[3]/'docs/backend/evidence/scripts/release-logical-recovery.py'
        spec=importlib.util.spec_from_file_location('m5_logical_cleanup_success',path)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        private=self.root/'diagnostics';private.mkdir(mode=0o700);output=self.root/'cleanup.json';suffix='012345abcdef';prefix='hengshuo-closure-logical-'+suffix+'-';calls=[]
        def docker(command,**kwargs):
            calls.append(command)
            if command[-1]!=prefix+'target':return subprocess.CompletedProcess(command,1,'','Error: No such object: '+command[-1])
            return subprocess.CompletedProcess(command,0,suffix+'\n','')
        with patch.object(helper.subprocess,'run',side_effect=docker):helper.finish_rehearsal(output,{'status':'passed'},[prefix+'source',prefix+'target'],private,True,'com.hengshuo.logical-recovery='+suffix)
        self.assertEqual([['docker','rm','-fv',prefix+'target']],[c for c in calls if c[1]=='rm']);self.assertFalse(private.exists());saved=json.loads(output.read_text());self.assertEqual('passed',saved['status']);self.assertTrue(saved['ownedResourcesCleaned'])

    def test_logical_cleanup_covers_created_container_when_run_failed_before_tracking(self):
        path=SCRIPT.parents[3]/'docs/backend/evidence/scripts/release-logical-recovery.py'
        spec=importlib.util.spec_from_file_location('m5_logical_partial_creation',path)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        private=self.root/'diagnostics';private.mkdir(mode=0o700);output=self.root/'cleanup.json';suffix='012345abcdef';partial='hengshuo-closure-logical-'+suffix+'-source';calls=[]
        def docker(command,**kwargs):
            calls.append(command)
            if command[-1]!=partial:return subprocess.CompletedProcess(command,1,'','Error: No such object: '+command[-1])
            return subprocess.CompletedProcess(command,0,suffix+'\n','')
        with patch.object(helper.subprocess,'run',side_effect=docker):helper.finish_rehearsal(output,{'status':'failed'},[],private,False,'com.hengshuo.logical-recovery='+suffix)
        self.assertIn(['docker','rm','-fv',partial],calls);self.assertTrue(private.exists());saved=json.loads(output.read_text());self.assertEqual('failed',saved['status']);self.assertTrue(saved['ownedResourcesCleaned'])

    def test_manifest_tampering_fails_external_pin(self):
        manifest = self.make_bundle()
        pin = self.pin()
        manifest["batchId"] = "62611441-938e-461d-b576-7dd2e7fa8c1d"
        self.write_manifest(manifest)
        with self.assertRaisesRegex(tool().RecoveryError, "manifest hash"):
            tool().verify_bundle(self.root, pin)

    def test_payload_tampering_and_missing_object_fail(self):
        for mode in ("tamper", "missing"):
            with self.subTest(mode=mode):
                manifest = self.make_bundle()
                path = self.root / manifest["attachments"][0]["file"]
                if mode == "tamper":
                    path.write_bytes(b"changed")
                else:
                    path.unlink()
                with self.assertRaises(tool().RecoveryError):
                    tool().verify_bundle(self.root, self.pin())

    def test_traversal_absolute_and_windows_paths_fail(self):
        for bad in ("../outside", "/tmp/outside", "objects/../../outside", "objects\\outside", "./database.dump", "objects//x"):
            with self.subTest(path=bad):
                manifest = self.make_bundle()
                manifest["files"][bad] = {"size": 0, "sha256": "0" * 64}
                pin = self.write_manifest(manifest)
                with self.assertRaises(tool().RecoveryError):
                    tool().verify_bundle(self.root, pin)

    def test_symlink_and_unlisted_file_fail(self):
        self.make_bundle()
        path = self.root / "unexpected"
        path.write_bytes(b"unlisted")
        with self.assertRaisesRegex(tool().RecoveryError, "unlisted"):
            tool().verify_bundle(self.root, self.pin())
        path.unlink()
        dump = self.root / "database.dump"
        dump.unlink()
        dump.symlink_to(self.root / "snapshot.json")
        with self.assertRaisesRegex(tool().RecoveryError, "symlink"):
            tool().verify_bundle(self.root, self.pin())

    def test_object_reference_must_match_hash_and_unique_key(self):
        for mode in ("hash", "duplicate", "keyTraversal"):
            with self.subTest(mode=mode):
                manifest = self.make_bundle()
                if mode == "hash":
                    manifest["attachments"][0]["sha256"] = "0" * 64
                elif mode == "duplicate":
                    manifest["attachments"].append(dict(manifest["attachments"][0]))
                else:
                    manifest["attachments"][0]["storageKey"] = "../outside"
                pin = self.write_manifest(manifest)
                with self.assertRaises(tool().RecoveryError):
                    tool().verify_bundle(self.root, pin)

    def test_private_permissions_are_enforced(self):
        self.make_bundle()
        (self.root / "database.dump").chmod(0o644)
        with self.assertRaisesRegex(tool().RecoveryError, "0600"):
            tool().verify_bundle(self.root, self.pin())

    def test_target_requires_exact_m5_database_and_container(self):
        module = tool()
        good = {"container": "hengshuo-m5-recovery-postgres", "database": "jxc_m5_restore_a", "adminUser": "postgres", "ownerRole": "jxc_owner", "runtimeRole": "jxc_app", "storage": {"endpoint": "http://127.0.0.1:59000", "bucket": "jxc-m5-restore-a", "accessKey": "not-secret", "secretKey": "not-secret"}}
        module.validate_target(good, "hengshuo-m5-recovery-postgres/jxc_m5_restore_a")
        for key, value in (("database", "jxc_m01_isolated"), ("container", "other-postgres"), ("database", "jxc_m5_restore_a;DROP DATABASE x")):
            bad = dict(good, **{key: value})
            with self.subTest(key=key, value=value), self.assertRaises(module.RecoveryError):
                module.validate_target(bad, f"{bad['container']}/{bad['database']}")
        with self.assertRaisesRegex(module.RecoveryError, "exact target"):
            module.validate_target(good, "hengshuo-m5-recovery-postgres/jxc_m5_wrong")

    def test_restore_command_never_uses_clean_or_disables_triggers(self):
        command = tool().restore_command({"container": "hengshuo-m5-recovery-postgres", "database": "jxc_m5_restore_a", "adminUser": "postgres"})
        self.assertIn("--single-transaction", command)
        self.assertIn("--exit-on-error", command)
        for forbidden in ("--clean", "--create", "--disable-triggers", "--no-owner", "--no-acl"):
            self.assertNotIn(forbidden, command)

    def test_freeze_proof_requires_exact_live_epoch_batch_and_source(self):
        module = tool()
        source = {"container": "hengshuo-m4-browser-postgres-1", "database": "jxc_m01_isolated"}
        batch = "de68df96-b030-49e1-b72e-d9694aa20e34"
        proof = {"schemaVersion": 1, "source": source, "batchId": batch, "epoch": 3, "mode": "FROZEN"}
        live = {"database": source["database"], "mode": "FROZEN", "batchId": batch, "epoch": 3}
        module.validate_freeze(proof, source, batch, live)
        for key, value in (("mode", "OPEN"), ("batchId", "wrong"), ("epoch", 4), ("database", "other")):
            with self.subTest(key=key), self.assertRaises(module.RecoveryError):
                module.validate_freeze(proof, source, batch, dict(live, **{key: value}))

    def test_pg_restore_enum_array_cast_is_canonicalized_without_ignoring_constraints(self):
        module = tool()
        source = "CHECK (mode::text = ANY (ARRAY['OPEN'::character varying, 'FROZEN'::character varying]::text[]))"
        restored = "CHECK (mode::text = ANY (ARRAY['OPEN'::character varying::text, 'FROZEN'::character varying::text]))"
        self.assertEqual(module.canonical_constraint(source), module.canonical_constraint(restored))
        changed = restored.replace("FROZEN", "OTHER")
        self.assertNotEqual(module.canonical_constraint(source), module.canonical_constraint(changed))
        narrowed = source.replace("character varying", "character varying(2)")
        self.assertEqual(narrowed, module.canonical_constraint(narrowed))
        source_generated="CASE WHEN ((source_type)::text = ANY ((ARRAY['PUR_ORDER_LINE'::character varying, 'PUR_ORDER_LINE_BASE'::character varying])::text[])) THEN (source_id)::bigint ELSE NULL::bigint END"
        restored_generated="CASE WHEN ((source_type)::text = ANY (ARRAY[('PUR_ORDER_LINE'::character varying)::text, ('PUR_ORDER_LINE_BASE'::character varying)::text])) THEN (source_id)::bigint ELSE NULL::bigint END"
        self.assertEqual(module.canonical_constraint(source_generated),module.canonical_constraint(restored_generated))
        self.assertNotEqual(module.canonical_constraint(source_generated),module.canonical_constraint(restored_generated.replace('PUR_ORDER_LINE_BASE','WRONG_SOURCE')))
        self.assertEqual(module.normalize_schema({'relations':[],'constraints':[],'columns':[{'default_expression':source_generated}]}),module.normalize_schema({'relations':[],'constraints':[],'columns':[{'default_expression':restored_generated}]}))

    def test_effective_acl_preserves_rights_but_normalizes_default_representation(self):
        module = tool()
        effective = [{"grantee": "jxc_owner", "grantor": "jxc_owner", "privilege": "SELECT", "grantable": False}]
        source = {"relations": [{"name": "control", "acl": "{jxc_owner=r/jxc_owner}", "effective_acl": effective}], "constraints": []}
        restored = {"relations": [{"name": "control", "acl": None, "effective_acl": effective}], "constraints": []}
        self.assertEqual(module.normalize_schema(source), module.normalize_schema(restored))
        changed = json.loads(json.dumps(restored))
        changed["relations"][0]["effective_acl"].append({"grantee": "PUBLIC", "grantor": "jxc_owner", "privilege": "UPDATE", "grantable": False})
        self.assertNotEqual(module.normalize_schema(source), module.normalize_schema(changed))

    def test_error_message_redacts_credentials(self):
        module = tool()
        message = module.safe_error(Exception("url access-secret and key-secret"), {"accessKey": "key-secret", "secretKey": "access-secret"})
        self.assertNotIn("access-secret", message)
        self.assertNotIn("key-secret", message)


class ContainerRuntimeBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='container-probe-boundary-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        path = SCRIPT.parents[3] / 'docs/backend/evidence/scripts/release-container-runtime.py'
        spec = importlib.util.spec_from_file_location('reviewed_container_probe', path)
        self.probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.probe)
        self.dist = self.root / 'dist'
        self.dist.mkdir()
        (self.dist / 'index.html').write_text('Synthetic container-boundary fixture')
        self.stage = self.root / 'stage'
        self.stage.mkdir()
        self.jar = self.stage / 'app.jar'
        self.jar.write_bytes(b'Synthetic reviewed artifact; never executed')
        self.output = self.root / 'evidence.json'
        credentials = self.root / 'credentials.json'
        credentials.write_text('{}')
        runtime = {'database': 'jxc_closure_ui_boundary', 'bucket': 'closure-ui-boundary',
                   'postgresContainer': 'hengshuo-closure-ui-boundary-pg',
                   'storageContainer': 'hengshuo-closure-ui-boundary-s3',
                   'environment': {}, 'credentialsFile': str(credentials)}
        self.runtime = self.root / 'runtime.json'
        self.runtime.write_text(json.dumps(runtime))
        self.argv = [str(path), '--runtime-config', str(self.runtime), '--artifact-stage', str(self.stage),
                     '--jar-sha256', hashlib.sha256(self.jar.read_bytes()).hexdigest(),
                     '--dist', str(self.dist), '--output', str(self.output)]
        self.private = self.root / 'private'
        self.private.mkdir()

    def test_existing_evidence_is_refused_before_config_reads_or_any_subprocess(self):
        self.output.write_text('{"historical":true}\n')
        self.runtime.unlink()
        with patch.object(sys, 'argv', self.argv), patch.object(self.probe.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'Evidence output'):
                self.probe.main()
        run.assert_not_called()
        self.assertEqual('{"historical":true}\n', self.output.read_text())

    def test_concurrent_evidence_creation_is_never_overwritten_by_failure_cleanup(self):
        def race(command, **kwargs):
            self.output.write_text('{"concurrentEvidence":true}\n')
            raise RuntimeError('Controlled failure; no Docker was invoked')
        with patch.object(sys, 'argv', self.argv), patch.object(self.probe.subprocess, 'run', side_effect=race), \
                patch.object(self.probe.tempfile, 'mkdtemp', return_value=str(self.private)):
            with self.assertRaises(FileExistsError):
                self.probe.main()
        self.assertEqual('{"concurrentEvidence":true}\n', self.output.read_text())

    def test_dist_requires_a_regular_directory_and_rejects_root_and_child_links(self):
        linked = self.root / 'linked-dist'
        linked.symlink_to(self.dist, target_is_directory=True)
        for directory in (linked, self.jar, self.root / 'missing-dist'):
            with self.subTest(directory=directory.name), self.assertRaises(ValueError):
                self.probe.manifest(directory)
        (self.dist / 'linked.js').symlink_to(self.jar)
        with self.assertRaises(ValueError):
            self.probe.manifest(self.dist)
        (self.dist / 'linked.js').unlink()
        os.mkfifo(self.dist / 'unexpected-pipe')
        with self.assertRaises(ValueError):
            self.probe.manifest(self.dist)

    def test_image_platform_uses_inspected_os_and_architecture(self):
        inspect_platform = getattr(self.probe, 'image_platform', None)
        self.assertTrue(callable(inspect_platform), 'Real image platform verification is required')
        self.assertEqual('linux/amd64', inspect_platform({'Os': 'linux', 'Architecture': 'amd64'}, 'linux/amd64'))
        self.assertEqual('linux/arm64', inspect_platform({'Os': 'linux', 'Architecture': 'arm64'}, None))
        for record in ({'Os': 'linux', 'Architecture': 'arm64'}, {'Os': 'windows', 'Architecture': 'amd64'},
                       {'Os': 'linux'}, {'Architecture': 'amd64'}):
            with self.subTest(record=record), self.assertRaises(ValueError):
                inspect_platform(record, 'linux/amd64')

    def test_application_and_gateway_architecture_mismatches_stop_before_runtime_start(self):
        for mismatched in ('application', 'gateway'):
            with self.subTest(mismatched=mismatched):
                output = self.root / (mismatched + '-evidence.json')
                private = self.root / ('private-' + mismatched)
                private.mkdir()
                argv = self.argv[:-1] + [str(output), '--platform', 'linux/amd64']
                commands = []
                def docker(command, **kwargs):
                    commands.append(command)
                    stdout = ''
                    if command[:3] == ['docker', 'context', 'inspect']:
                        stdout = json.dumps([{'Endpoints': {'docker': {'Host': 'unix:///synthetic-review-only'}}}])
                    elif command[:3] == ['docker', 'image', 'inspect']:
                        role = 'application' if command[3] == 'hengshuo-jxc-application:closure' else 'gateway'
                        stdout = json.dumps([{'Id': 'sha256:' + role, 'Os': 'linux',
                                              'Architecture': 'arm64' if role == mismatched else 'amd64'}])
                    elif command[:2] == ['docker', 'cp'] and command[2].endswith(':/app/app.jar'):
                        shutil.copyfile(self.jar, command[3])
                    elif command[:2] == ['docker', 'create'] or command[:3] == ['docker', 'buildx', 'build'] or command[:2] == ['docker', 'rm']:
                        pass
                    else:
                        self.fail('Unexpected subprocess would escape the mock boundary: ' + str(command))
                    return subprocess.CompletedProcess(command, 0, stdout, '')
                with patch.object(sys, 'argv', argv), patch.object(self.probe.subprocess, 'run', side_effect=docker), \
                        patch.object(self.probe.tempfile, 'mkdtemp', return_value=str(private)):
                    with self.assertRaisesRegex(ValueError, 'platform'):
                        self.probe.main()
                self.assertFalse(any(command[:2] == ['docker', 'run'] for command in commands))
                if mismatched == 'application':
                    self.assertFalse(any(command[:2] == ['docker', 'create'] for command in commands))

    def context_fixture(self):
        source, exported = self.root / 'source-context', self.root / 'exported-context'
        required = ('deploy/production/Dockerfile', 'deploy/production/entrypoint.sh',
                    'deploy/production/nginx.conf', 'deploy/production/compose.yml', '.dockerignore')
        for root in (source, exported):
            for name in required:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('Exact reviewed input: ' + name)
        return source, exported, required

    def test_external_build_context_requires_every_reviewed_input_byte(self):
        reviewed = getattr(self.probe, 'reviewed_build_context', None)
        self.assertTrue(callable(reviewed), 'External context must be checked against existing production inputs')
        source, exported, required = self.context_fixture()
        with patch.object(self.probe, 'ROOT', source):
            context, hashes = reviewed(exported)
            self.assertEqual(exported.resolve(), context)
            self.assertEqual(set(required), set(hashes))
            self.assertEqual(source, reviewed(None)[0])
            for name in required:
                with self.subTest(changed=name):
                    path = exported / name
                    original = path.read_bytes()
                    path.write_bytes(b'Unreviewed context replacement')
                    with self.assertRaises(ValueError):
                        reviewed(exported)
                    path.write_bytes(original)

    def test_external_context_rejects_root_links_nested_links_and_in_workspace_exports(self):
        reviewed = getattr(self.probe, 'reviewed_build_context', None)
        self.assertTrue(callable(reviewed), 'Regular external build context validation is required')
        source, exported, required = self.context_fixture()
        linked = self.root / 'linked-context'
        linked.symlink_to(exported, target_is_directory=True)
        with patch.object(self.probe, 'ROOT', source):
            for invalid in (linked, source):
                with self.subTest(invalid=invalid.name), self.assertRaises(ValueError):
                    reviewed(invalid)
            (exported / 'deploy/production/nginx.conf').unlink()
            (exported / 'deploy/production/nginx.conf').symlink_to(source / 'deploy/production/nginx.conf')
            with self.assertRaises(ValueError):
                reviewed(exported)


if __name__ == "__main__":
    unittest.main()
