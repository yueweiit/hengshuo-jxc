"""Opt-in real PostgreSQL 16 / private MinIO safety regressions.

M5_RECOVERY_CONFIG=/absolute/0600/recovery.json python3 -m unittest discover ...
Only creates isolated M5 probe databases/roles/buckets, never changes source data.
"""
import copy
import os
from pathlib import Path
import subprocess
import unittest
import uuid

from test_recovery import tool


@unittest.skipUnless(os.environ.get("M5_RECOVERY_CONFIG"), "requires explicit private rehearsal config")
class RealRecoverySafetyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r = tool()
        cls.config = cls.r.load_config(os.environ["M5_RECOVERY_CONFIG"])

    def new_probe(self):
        target = copy.deepcopy(self.config["target"])
        target["database"] = "jxc_m5_probe_" + uuid.uuid4().hex[:10]
        subprocess.run(["docker", "exec", target["container"], "createdb", "-U", target["adminUser"], "--template=template0", target["database"]], check=True, capture_output=True)
        return target

    def test_nonpublic_schema_is_refused_before_backup_claims_full_inventory(self):
        for schema in ("synthetic_extra", "pgx"):
            with self.subTest(schema=schema):
                target = self.new_probe()
                with self.r.PgSession(target) as session:
                    session.execute("CREATE SCHEMA " + schema)
                    with self.assertRaisesRegex(self.r.RecoveryError, "unsupported non-public schema"):
                        self.r.inventory(session)

    def test_failed_concurrent_unique_index_is_refused(self):
        target = self.new_probe()
        with self.r.PgSession(target) as session:
            session.execute("CREATE TABLE synthetic_probe(id bigint);INSERT INTO synthetic_probe VALUES(1),(1)")
        result = subprocess.run(self.r.command(target, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qc", "CREATE UNIQUE INDEX CONCURRENTLY synthetic_invalid ON synthetic_probe(id)"), capture_output=True)
        self.assertNotEqual(0, result.returncode)
        with self.r.PgSession(target) as session:
            with self.assertRaisesRegex(self.r.RecoveryError, "invalid/not-ready PostgreSQL index"):
                self.r.inventory(session)

    def test_column_acl_change_is_detected_in_schema_fingerprint(self):
        target = self.new_probe()
        with self.r.PgSession(target) as session:
            session.execute("CREATE TABLE sys_attachment(id bigint,storage_key text,sha256 text,size bigint,status text,object_status text); CREATE TABLE synthetic_notification(id bigint,read_at timestamptz,body text); GRANT UPDATE(read_at) ON synthetic_notification TO " + target["runtimeRole"])
            before = self.r.inventory(session)
            session.execute("REVOKE UPDATE(read_at) ON synthetic_notification FROM " + target["runtimeRole"] + "; GRANT UPDATE(body) ON synthetic_notification TO " + target["runtimeRole"])
            after = self.r.inventory(session)
        self.assertEqual(before["tables"], after["tables"])
        self.assertNotEqual(before["schema"], after["schema"])

    def test_replication_runtime_role_is_refused(self):
        target = self.new_probe()
        suffix = uuid.uuid4().hex[:10]
        target.update(ownerRole="jxc_m5_owner_" + suffix, runtimeRole="jxc_m5_runtime_" + suffix)
        with self.r.PgSession(target) as session:
            session.execute("CREATE ROLE " + target["ownerRole"] + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; CREATE ROLE " + target["runtimeRole"] + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE REPLICATION")
            with self.assertRaisesRegex(self.r.RecoveryError, "role attributes unsafe"):
                self.r.role_audit(session, target)

    def test_restore_guard_blocks_resume_until_verification_finishes(self):
        self.assertTrue(callable(getattr(self.r, "lock_restored_gate", None)), "restore verification requires a held FOR SHARE gate guard")
        target = self.new_probe()
        batch = self.config["batchId"]
        with self.r.PgSession(target) as setup:
            setup.execute("CREATE TABLE sys_write_control(singleton boolean PRIMARY KEY,mode text,batch_id uuid,epoch bigint); INSERT INTO sys_write_control VALUES(true,'FROZEN'," + self.r.sql_literal(batch) + "::uuid,3)")
        update = self.r.command(target, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qc", "SET lock_timeout='150ms'; UPDATE sys_write_control SET mode='OPEN',epoch=4 WHERE singleton")
        with self.r.PgSession(target) as guard:
            self.r.lock_restored_gate(guard, target, batch, 3)
            blocked = subprocess.run(update, capture_output=True, text=True)
            self.assertNotEqual(0, blocked.returncode)
            self.assertIn("lock timeout", blocked.stderr)
        resumed = subprocess.run(update, capture_output=True, text=True)
        self.assertEqual(0, resumed.returncode, resumed.stderr)
        with self.r.PgSession(target) as guard:
            with self.assertRaisesRegex(self.r.RecoveryError, "expected FROZEN batch"):
                self.r.lock_restored_gate(guard, target, batch, 3)

    def test_conditional_object_put_does_not_overwrite_existing_bytes(self):
        target = self.config["target"]["storage"]
        probe_path = os.environ.get("M5_RECOVERY_PROBE_STORAGE")
        if probe_path:
            # Optional fixture initialization owns this separate random bucket.
            # Its runtime identity cannot create buckets or access restored objects.
            storage = self.r.read_json(self.r.outside_workspace(probe_path))
            self.assertEqual({"endpoint", "bucket", "accessKey", "secretKey"}, set(storage))
            self.assertTrue(all(isinstance(value, str) and value for value in storage.values()))
            self.assertEqual(target["endpoint"], storage["endpoint"])
            self.assertRegex(storage["bucket"], r"^jxc-m5-probe-[0-9a-f]{12}\Z")
            for field in ("bucket", "accessKey", "secretKey"):
                self.assertNotEqual(target[field], storage[field])
        else:
            storage = dict(target, bucket="jxc-m5-probe-" + uuid.uuid4().hex[:12])
        client = self.r.S3(storage)
        if probe_path:self.assertTrue(client.empty(), "Dedicated prebuilt probe bucket must be empty")
        else:client.request("PUT")
        client.request("PUT", "probe/original", b"synthetic first", if_absent=True)
        with self.assertRaisesRegex(self.r.RecoveryError, "412"):
            client.request("PUT", "probe/original", b"synthetic overwritten", if_absent=True)
        self.assertEqual(b"synthetic first", client.request("GET", "probe/original"))

    def test_inherited_other_relation_owner_is_refused(self):
        suffix = uuid.uuid4().hex[:10]
        target = copy.deepcopy(self.config["target"])
        target.update(database="jxc_m5_probe_" + suffix, ownerRole="jxc_m5_owner_" + suffix, runtimeRole="jxc_m5_runtime_" + suffix)
        other = "jxc_m5_other_" + suffix
        subprocess.run(["docker", "exec", target["container"], "createdb", "-U", target["adminUser"], "--template=template0", target["database"]], check=True, capture_output=True)
        with self.r.PgSession(target) as session:
            session.execute("CREATE ROLE " + target["ownerRole"] + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; CREATE ROLE " + target["runtimeRole"] + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; CREATE ROLE " + other + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; CREATE TABLE public.synthetic_probe(id bigint); ALTER TABLE public.synthetic_probe OWNER TO " + other)
            self.r.role_audit(session, target)
            session.execute("GRANT " + other + " TO " + target["runtimeRole"])
            with self.assertRaisesRegex(self.r.RecoveryError, "unsafe ownership"):
                self.r.role_audit(session, target)

    def test_default_sequence_acl_includes_select_update_and_usage(self):
        target = self.config["target"]
        with self.r.PgSession(target) as session:
            session.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            actual = self.r.inventory(session)
        sequence = next(item for item in actual["schema"]["relations"] if item["name"] == "sys_write_control_log_id_seq")
        self.assertEqual({"SELECT", "UPDATE", "USAGE"}, {item["privilege"] for item in sequence["acl"] if item["grantee"] == "jxc_owner"})

    def test_pg_enum_check_roundtrip_has_identical_acceptance(self):
        target = self.config["target"]
        with self.r.PgSession(target) as session:
            session.execute("BEGIN; CREATE TEMP TABLE m5_enum_source(mode varchar(16) CHECK(mode IN ('OPEN','FROZEN'))); CREATE TEMP TABLE m5_enum_restored(mode varchar(16) CHECK(mode::text = ANY(ARRAY['OPEN'::character varying::text,'FROZEN'::character varying::text])))")
            definitions = session.json("SELECT json_agg(pg_get_constraintdef(oid,true) ORDER BY conrelid::regclass::text) FROM pg_constraint WHERE conrelid IN ('pg_temp.m5_enum_source'::regclass,'pg_temp.m5_enum_restored'::regclass)")
            self.assertNotEqual(definitions[0], definitions[1])
            self.assertEqual(self.r.canonical_constraint(definitions[0]), self.r.canonical_constraint(definitions[1]))
            for value in ("OPEN", "FROZEN", "OTHER", "", "OPEN ", None):
                accepted = []
                for definition in definitions:
                    expression = definition.removeprefix("CHECK ")
                    result = session.json("WITH input(mode) AS (VALUES (" + ("NULL" if value is None else self.r.sql_literal(value)) + "::varchar(16))) SELECT json_build_object('accepted',(" + expression + ") IS NOT FALSE) FROM input")
                    accepted.append(result["accepted"])
                self.assertEqual(accepted[0], accepted[1])
            session.execute("CREATE TEMP TABLE m5_generated_source(source_type varchar(32),source_id bigint,value bigint GENERATED ALWAYS AS (CASE WHEN source_type IN ('PUR_ORDER_LINE','PUR_ORDER_LINE_BASE') THEN source_id ELSE NULL END) STORED)")
            source_expression=session.json("SELECT json_build_object('expression',pg_get_expr(adbin,adrelid)) FROM pg_attrdef WHERE adrelid='pg_temp.m5_generated_source'::regclass")['expression']
            session.execute("CREATE TEMP TABLE m5_generated_restored(source_type varchar(32),source_id bigint,value bigint GENERATED ALWAYS AS ("+source_expression+") STORED)")
            restored_expression=session.json("SELECT json_build_object('expression',pg_get_expr(adbin,adrelid)) FROM pg_attrdef WHERE adrelid='pg_temp.m5_generated_restored'::regclass")['expression']
            self.assertNotEqual(source_expression,restored_expression)
            self.assertEqual(self.r.canonical_constraint(source_expression),self.r.canonical_constraint(restored_expression))
            for value in ('PUR_ORDER_LINE','PUR_ORDER_LINE_BASE','OTHER','',None):
                selected='NULL' if value is None else self.r.sql_literal(value)
                session.execute("INSERT INTO m5_generated_source(source_type,source_id) VALUES("+selected+",17);INSERT INTO m5_generated_restored(source_type,source_id) VALUES("+selected+",17)")
            self.assertEqual(session.json("SELECT json_agg(t ORDER BY source_type NULLS FIRST) FROM m5_generated_source t"),session.json("SELECT json_agg(t ORDER BY source_type NULLS FIRST) FROM m5_generated_restored t"))
