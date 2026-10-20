"""Real PostgreSQL acceptance tests. No production/source database writes.

Run: python3 -m unittest discover -s scripts/m5/tests -p 'test_audit.py' -v
Requires Docker and cached postgres:16-alpine; fixtures use a disposable m5 container.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import unittest
import uuid

M5 = Path(__file__).resolve().parents[1]
SERVER = M5.parents[1]
MIGRATIONS = SERVER / 'jxc-app/src/main/resources/db/migration'
AUDIT = M5 / 'audit.py'
sys.path.insert(0,str(M5))


class AuditPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = 'hengshuo-m5-audit-test-' + uuid.uuid4().hex[:10]
        subprocess.run(['docker', 'run', '-d', '--name', cls.container,
                        '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
                        '-p', '127.0.0.1::5432', 'postgres:16-alpine'],
                       check=True, capture_output=True, text=True)
        try:
            for _ in range(80):
                ready = subprocess.run(['docker', 'exec', cls.container, 'pg_isready',
                                        '-U', 'postgres', '-h', '127.0.0.1'], capture_output=True)
                if ready.returncode == 0:
                    break
                time.sleep(.1)
            else:
                raise AssertionError('Disposable PostgreSQL did not start')
            cls.sql('CREATE ROLE jxc_audit_runtime; CREATE DATABASE audit_clean;', 'postgres')
            paths = sorted(MIGRATIONS.glob('V*.sql'), key=lambda p: tuple(
                int(n) for n in re.match(r'V([\d_]+)__', p.name).group(1).split('_')))
            # Freeze baseline through M4; concurrent M5 migrations are owned by root.
            paths = [p for p in paths if int(re.match(r'V(\d+)', p.name).group(1)) <= 7]
            cls.sql('\n'.join(p.read_text().replace('${runtimeRole}', 'jxc_audit_runtime')
                              for p in paths))
            cls.sql('''CREATE TABLE flyway_schema_history (
                installed_rank integer PRIMARY KEY, version varchar(50),
                description varchar(200) NOT NULL, type varchar(20) NOT NULL,
                script varchar(1000) NOT NULL, checksum integer,
                installed_by varchar(100) NOT NULL,
                installed_on timestamp NOT NULL DEFAULT now(),
                execution_time integer NOT NULL, success boolean NOT NULL);''')
            for i, p in enumerate(paths, 1):
                version = re.match(r'V([\d_]+)__', p.name).group(1).replace('_', '.')
                cls.sql(f"INSERT INTO flyway_schema_history VALUES ({i},'{version}',"
                        f"'test baseline','SQL','{p.name}',NULL,'postgres',now(),0,true);")
            cls.sql('CREATE DATABASE audit_legacy TEMPLATE audit_clean;', 'postgres')
            cls.sql('''DO $$ DECLARE r record; BEGIN
              FOR r IN SELECT conrelid::regclass rel, conname FROM pg_constraint
                WHERE conrelid<>0 AND connamespace='public'::regnamespace AND contype IN ('f','c','u','x')
              LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I CASCADE',r.rel,r.conname); END LOOP;
              FOR r IN SELECT oid::regclass rel FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'
              LOOP EXECUTE format('ALTER TABLE %s DISABLE TRIGGER ALL',r.rel);
                EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY',r.rel); END LOOP;
              FOR r IN SELECT indexrelid::regclass rel FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
                WHERE t.relnamespace='public'::regnamespace AND i.indisunique AND NOT i.indisprimary
              LOOP EXECUTE format('DROP INDEX IF EXISTS %s CASCADE',r.rel); END LOOP;
            END $$;''', 'audit_legacy')
            cls.sql((M5 / 'tests/audit_legacy_fixture.sql').read_text(), 'audit_legacy')
            cls.sql('CREATE ROLE audit_reader LOGIN BYPASSRLS; CREATE ROLE audit_limited LOGIN;')
            cls.sql('GRANT USAGE ON SCHEMA public TO audit_reader,audit_limited; '
                    'GRANT SELECT ON ALL TABLES IN SCHEMA public TO audit_reader,audit_limited;')
        except BaseException:
            subprocess.run(['docker', 'rm', '-f', cls.container], capture_output=True)
            raise

    @classmethod
    def tearDownClass(cls):
        subprocess.run(['docker', 'rm', '-f', cls.container], check=True, capture_output=True)

    @classmethod
    def sql(cls, sql, database='audit_clean'):
        result = subprocess.run(['docker', 'exec', '-i', cls.container, 'psql', '-X',
                                 '-U', 'postgres', '-d', database, '-qAt',
                                 '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, capture_output=True)
        if result.returncode:
            raise AssertionError('Fixture SQL failed: ' + result.stderr[-1600:])
        return result.stdout

    def audit(self, database='audit_clean', user='postgres', *extra):
        self.assertTrue(AUDIT.is_file(), 'M5 read-only audit CLI is not implemented')
        result = subprocess.run([sys.executable, str(AUDIT), '--docker-container',
                                 self.container, '--database', database, '--db-user', user,
                                 '--runtime-role', 'jxc_audit_runtime', *extra],
                                text=True, capture_output=True,
                                env={**os.environ, 'PGPASSWORD': 'never-print-this-test-secret'})
        self.assertNotIn('never-print-this-test-secret', result.stdout + result.stderr)
        return result.returncode, json.loads(result.stdout)

    def fingerprint(self, database):
        dump = subprocess.run(['docker', 'exec', self.container, 'pg_dump', '-U',
                               'postgres', '-d', database, '--data-only', '--inserts',
                               '--no-owner', '--no-privileges'], check=True, capture_output=True)
        # PostgreSQL dump uses a fresh random \restrict nonce; it is not database state.
        content = b'\n'.join(x for x in dump.stdout.splitlines()
                             if not x.startswith((b'\\restrict ', b'\\unrestrict ')))
        return hashlib.sha256(content).hexdigest()

    def closure_database(self, name, excluded=()):
        self.sql('CREATE DATABASE '+name+' TEMPLATE audit_clean;', 'postgres')
        paths=sorted((p for p in MIGRATIONS.glob('V*.sql') if int(re.match(r'V(\d+)',p.name).group(1))>=8),key=lambda p:tuple(int(n) for n in re.match(r'V([\d_]+)__',p.name).group(1).split('_')))
        for rank,path in enumerate((p for p in paths if p.name not in excluded),100):
            self.sql(path.read_text().replace('${runtimeRole}','jxc_audit_runtime'),name)
            version=re.match(r'V([\d_]+)__',path.name).group(1).replace('_','.')
            self.sql("INSERT INTO flyway_schema_history(installed_rank,version,description,type,script,installed_by,execution_time,success) VALUES("+str(rank)+",'"+version+"','closure fixture','SQL','"+path.name+"','postgres',0,true)",name)

    def test_closure_profile_audits_all_new_tables_without_ignoring_unknown_schema(self):
        self.closure_database('audit_closure')
        try:
            code,report=self.audit('audit_closure')
            self.assertEqual(2,code,report)
            self.assertEqual('release-closure-pg16',report['schema_profile']['name'])
            self.assertIn('sys_country_clone_job',report['table_counts'])
            self.assertIn('sys_import_batch',report['table_counts'])
            self.assertIn('ap_cost_assignment',report['table_counts'])
            self.assertIn('ap_cost_assignment_line',report['table_counts'])
            self.assertEqual('PASS',next(c for c in report['checks'] if c['code']=='WRITE_GATE')['status'])
            self.sql('CREATE TABLE unsupported_closure_probe(id bigint)', 'audit_closure')
            code,report=self.audit('audit_closure')
            self.assertEqual(1,code)
            self.assertEqual('SCHEMA_MISMATCH',report['error']['code'])
        finally:self.sql('DROP DATABASE audit_closure;', 'postgres')

    def test_closure_catalog_catches_weakened_fk_rls_triggers_and_function_bodies(self):
        self.closure_database('audit_closure_weakened')
        try:
            self.sql("DROP TRIGGER jxc_write_gate ON sys_doc_watcher; DROP TRIGGER jxc_write_gate ON ap_cost_assignment_line; ALTER TABLE sys_country_clone_job NO FORCE ROW LEVEL SECURITY; ALTER TABLE ap_cost_assignment NO FORCE ROW LEVEL SECURITY; ALTER TABLE sys_import_row DROP CONSTRAINT sys_import_row_country_id_batch_id_fkey; ALTER TABLE ap_cost_assignment DROP CONSTRAINT ap_cost_assignment_country_id_book_id_cost_id_fkey; CREATE OR REPLACE FUNCTION jxc_country_mutation_gate() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$; DO $tamper$ BEGIN EXECUTE replace(pg_get_functiondef('jxc_period_closing_guard()'::regprocedure),'jxc_audit_runtime','wrong_runtime_role'); END $tamper$;",'audit_closure_weakened')
            code,report=self.audit('audit_closure_weakened');self.assertEqual(2,code,report)
            gaps={(r['table_name'],r['constraint_name']) for r in report['schema_profile']['missing_constraints']}
            self.assertIn(('sys_doc_watcher','jxc_write_gate'),gaps)
            self.assertIn(('ap_cost_assignment_line','jxc_write_gate'),gaps)
            self.assertIn(('ap_cost_assignment','FORCE_RLS'),gaps)
            self.assertIn(('ap_cost_assignment','ap_cost_assignment_country_id_book_id_cost_id_fkey'),gaps)
            self.assertIn(('sys_country_clone_job','FORCE_RLS'),gaps)
            self.assertIn(('sys_import_row','sys_import_row_country_id_batch_id_fkey'),gaps)
            self.assertTrue(any(table=='<function>' and 'jxc_country_mutation_gate' in name for table,name in gaps))
            self.assertIn(('<function>','jxc_period_closing_guard()'),gaps)
        finally:self.sql('DROP DATABASE audit_closure_weakened;','postgres')

    def test_recovery_accepts_pinned_closure_and_rejects_unknown_migration_before_backup(self):
        from test_recovery import tool
        recovery=tool();self.closure_database('audit_closure_recovery')
        config={'container':self.container,'database':'audit_closure_recovery','adminUser':'postgres'}
        try:
            with recovery.PgSession(config) as session:
                session.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
                facts=recovery.inventory(session)
                self.assertEqual('release-closure-pg16',recovery.supported_schema(session,facts,'jxc_audit_runtime')['name'])
                with self.assertRaisesRegex(recovery.RecoveryError,'required closure catalog'):
                    recovery.supported_schema(session,facts,'wrong_runtime_role')
            self.sql('ALTER TABLE sys_import_row DROP CONSTRAINT sys_import_row_country_id_batch_id_fkey','audit_closure_recovery')
            with recovery.PgSession(config) as session:
                session.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
                with self.assertRaisesRegex(recovery.RecoveryError,'required closure catalog'):
                    recovery.supported_schema(session,recovery.inventory(session),'jxc_audit_runtime')
            self.sql("INSERT INTO flyway_schema_history(installed_rank,version,description,type,script,installed_by,execution_time,success) VALUES(999,'99','unknown','SQL','V099__unknown.sql','postgres',0,true)",'audit_closure_recovery')
            with recovery.PgSession(config) as session:
                session.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
                with self.assertRaisesRegex(recovery.RecoveryError,'unsupported migration provenance'):recovery.supported_schema(session,recovery.inventory(session),'jxc_audit_runtime')
        finally:self.sql('DROP DATABASE audit_closure_recovery;','postgres')

    def test_closure_captures_and_rejects_changed_column_attributes_and_checks(self):
        from generate_audit_contract import generate
        from catalog_contract import catalog_gaps_query
        database='audit_closure_column_contract'
        self.closure_database(database)
        try:
            contract=generate(['docker','exec','-i',self.container,'psql','-X','-qAt',
                               '-v','ON_ERROR_STOP=1','-U','postgres','-d',database])
            self.assertTrue('column_properties' in contract,'Column nullability/defaults must be captured from migrated catalogs')
            self.assertTrue('required_checks' in contract,'Table CHECK definitions must be captured from migrated catalogs')
            def gaps():
                return json.loads(self.sql("SELECT coalesce(json_agg(x),'[]') FROM ("+
                                           catalog_gaps_query(contract,'jxc_audit_runtime')+") x",database))
            self.assertEqual([],gaps())
            changes=(
                ("ALTER TABLE sys_doc_watcher ALTER COLUMN field_groups DROP NOT NULL",
                 "ALTER TABLE sys_doc_watcher ALTER COLUMN field_groups SET NOT NULL",
                 ('sys_doc_watcher','COLUMN_ATTRIBUTE:field_groups')),
                ("ALTER TABLE sys_doc_watcher ALTER COLUMN status SET DEFAULT 'DISABLED'",
                 "ALTER TABLE sys_doc_watcher ALTER COLUMN status SET DEFAULT 'ENABLED'",
                 ('sys_doc_watcher','COLUMN_ATTRIBUTE:status')),
                ("ALTER TABLE sys_doc_watcher DROP CONSTRAINT sys_doc_watcher_watch_type_check; ALTER TABLE sys_doc_watcher ADD CONSTRAINT sys_doc_watcher_watch_type_check CHECK(watch_type IN('VIEWER','CC','OTHER'))",
                 "ALTER TABLE sys_doc_watcher DROP CONSTRAINT sys_doc_watcher_watch_type_check; ALTER TABLE sys_doc_watcher ADD CONSTRAINT sys_doc_watcher_watch_type_check CHECK(watch_type IN('VIEWER','CC'))",
                 ('sys_doc_watcher','sys_doc_watcher_watch_type_check')),
            )
            for weaken,restore,expected in changes:
                with self.subTest(expected=expected):
                    self.sql(weaken,database)
                    self.assertIn(expected,{(g['table_name'],g['constraint_name']) for g in gaps()})
                    self.sql(restore,database)
                    self.assertEqual([],gaps())
        finally:self.sql('DROP DATABASE '+database+';','postgres')

    def test_reviewed_nullable_append_preserves_old_columns_and_never_ignores_other_facts(self):
        import importlib.util
        import inspect
        path=SERVER.parent/'docs/backend/evidence/scripts/release-ui-restart.py'
        spec=importlib.util.spec_from_file_location('closure_ui_restart_test',path)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        migration='V013_7__shipment_measurement_and_receipt_confirmation.sql'
        interpretation='V013_8__zero_posting_event_interpretation.sql'
        database='audit_closure_nullable_append'
        self.closure_database(database,excluded=(migration,interpretation,'V013_9__confirmed_bill_cost_assignment.sql'))
        try:
            # Non-operational snapshot probes need no owner business commands. Their
            # explicit IDs and disabled FK triggers never touch application sequences.
            self.sql("SET session_replication_role=replica; INSERT INTO lgs_shipment_line(id,country_id,shipment_id,source_type,source_line_id,po_id,po_line_id,product_id,base_qty) VALUES(1,1,1,'EXPORT_NODE_LINE',1,1,1,1,1); INSERT INTO lgs_receipt(id,country_id,book_id,entity_id,biz_date,doc_no,delivery_id,shipment_id,warehouse_id) VALUES(2,1,1,1,'2026-10-15','SNAPSHOT-PROBE',1,1,1)",database)
            readonly=lambda query:self.sql('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'+query+'COMMIT;',database)
            before=helper.fact_snapshot(readonly)
            self.sql((MIGRATIONS/migration).read_text().replace('${runtimeRole}','jxc_audit_runtime'),database)
            self.sql((MIGRATIONS/interpretation).read_text().replace('${runtimeRole}','jxc_audit_runtime'),database)
            supported='project_null_append' in inspect.signature(helper.fact_snapshot).parameters
            projected=helper.fact_snapshot(readonly,**({'project_null_append':True} if supported else {}))
            business=lambda rows:[row for row in rows if row['name']!='flyway_schema_history']
            self.assertEqual(business(before),business(projected),'Only the five reviewed NULL columns may be removed from the old-column comparison')
            self.assertNotEqual(business(before),business(helper.fact_snapshot(readonly)))
            self.assertEqual({'lgs_receipt':0,'lgs_shipment_line':0},helper.reviewed_null_column_counts(readonly))
            self.sql("SET session_replication_role=replica; UPDATE lgs_shipment_line SET boxes=0 WHERE id=1",database)
            self.assertEqual(1,helper.reviewed_null_column_counts(readonly)['lgs_shipment_line'])
            self.sql("SET session_replication_role=replica; UPDATE lgs_shipment_line SET boxes=NULL WHERE id=1; UPDATE lgs_receipt SET doc_no='CHANGED-OLD-FACT' WHERE id=2",database)
            self.assertNotEqual(business(before),business(helper.fact_snapshot(readonly,project_null_append=True)))
            self.sql('ALTER TABLE lgs_receipt ADD COLUMN unsupported_column text',database)
            self.assertNotEqual(business(before),business(helper.fact_snapshot(readonly,project_null_append=True)))
        finally:self.sql('DROP DATABASE '+database+';','postgres')

    def test_reviewed_assignment_append_keeps_old_facts_and_requires_exact_empty_tables(self):
        import importlib.util
        path=SERVER.parent/'docs/backend/evidence/scripts/release-ui-restart.py'
        spec=importlib.util.spec_from_file_location('closure_assignment_snapshot_test',path)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        migration='V013_9__confirmed_bill_cost_assignment.sql'
        database='audit_closure_assignment_append'
        self.closure_database(database,excluded=(migration,))
        try:
            self.sql("INSERT INTO md_currency(code,name) VALUES('MXN','ORIGINAL-SNAPSHOT-PROBE')",database)
            readonly=lambda query:self.sql('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'+query+'COMMIT;',database)
            # The UI-only helper pins jxc_app. Bind only the already-reviewed
            # closing-guard runtime token; its other function bytes stay intact.
            self.sql("DO $role$ BEGIN EXECUTE replace(pg_get_functiondef('jxc_period_closing_guard()'::regprocedure),'current_user=''jxc_audit_runtime''','current_user=''jxc_app''');END $role$",database)
            prior=json.loads((SERVER.parent/'docs/backend/evidence/archive/audit-contract-closure-candidate-41.json').read_text())
            prior_migrations={row['script']:row['sha256'] for row in prior['migration_files']}
            self.assertEqual(prior,helper.reviewed_assignment_preflight(readonly,prior_migrations))
            self.sql('ALTER TABLE ap_bill NO FORCE ROW LEVEL SECURITY',database)
            with self.assertRaisesRegex(ValueError,'complete catalog'):helper.reviewed_assignment_preflight(readonly,prior_migrations)
            self.sql('ALTER TABLE ap_bill FORCE ROW LEVEL SECURITY; DROP TRIGGER jxc_write_gate ON ap_bill',database)
            with self.assertRaisesRegex(ValueError,'complete catalog'):helper.reviewed_assignment_preflight(readonly,prior_migrations)
            self.sql('CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ap_bill FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open()',database)
            foreign=next(row for row in prior['foreign_keys'] if row['table']=='ap_bill' and row['target']=='fin_book')
            definition=self.sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='ap_bill'::regclass AND conname='"+foreign['name']+"'",database).strip()
            self.sql('ALTER TABLE ap_bill DROP CONSTRAINT '+foreign['name'],database)
            with self.assertRaisesRegex(ValueError,'complete catalog'):helper.reviewed_assignment_preflight(readonly,prior_migrations)
            self.sql('ALTER TABLE ap_bill ADD CONSTRAINT '+foreign['name']+' '+definition,database)
            self.assertEqual(prior,helper.reviewed_assignment_preflight(readonly,prior_migrations))
            old_tables=set(helper.schema_columns(readonly))
            before=helper.fact_snapshot(readonly,expected_tables=old_tables)
            self.sql((MIGRATIONS/migration).read_text().replace('${runtimeRole}','jxc_audit_runtime'),database)
            current=lambda:helper.fact_snapshot(readonly,expected_tables=old_tables|helper.ASSIGNMENT_TABLES)
            self.assertEqual(before,helper.reviewed_assignment_tables(before,current()))
            self.sql("UPDATE md_currency SET name='CHANGED-OLD-FACT' WHERE code='MXN'",database)
            with self.assertRaisesRegex(ValueError,'existing facts'):helper.reviewed_assignment_tables(before,current())
            self.sql("UPDATE md_currency SET name='ORIGINAL-SNAPSHOT-PROBE' WHERE code='MXN'",database)
            # A snapshot-only probe deliberately disables provenance triggers and
            # uses explicit IDs; it is never evidence of a native business command.
            self.sql("ALTER TABLE ap_cost_assignment DISABLE TRIGGER ALL; SET session_replication_role=replica; INSERT INTO ap_cost_assignment(id,country_id,book_id,cost_id,source_basis,created_by) VALUES(1,1,1,1,'{}',1)",database)
            with self.assertRaisesRegex(ValueError,'remain empty'):helper.reviewed_assignment_tables(before,current())
            self.sql('CREATE TABLE unreviewed_assignment_table(id bigint)',database)
            with self.assertRaisesRegex(ValueError,'Unexpected application schema'):current()
        finally:self.sql('DROP DATABASE '+database+';','postgres')

    def test_closure_rejects_extra_policies_triggers_and_functions_in_audit_and_recovery(self):
        from test_recovery import tool
        recovery=tool();database='audit_closure_extra_catalog'
        self.closure_database(database)
        config={'container':self.container,'database':database,'adminUser':'postgres'}
        additions=(
            ('policy',"CREATE POLICY closure_extra_policy ON sys_doc_watcher FOR ALL TO public USING(true) WITH CHECK(true)",
             'DROP POLICY closure_extra_policy ON sys_doc_watcher',('sys_doc_watcher','UNEXPECTED_POLICY:closure_extra_policy')),
            ('trigger','CREATE TRIGGER closure_extra_trigger BEFORE INSERT ON sys_doc_watcher FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open()',
             'DROP TRIGGER closure_extra_trigger ON sys_doc_watcher',('sys_doc_watcher','UNEXPECTED_TRIGGER:closure_extra_trigger')),
            ('function',"CREATE FUNCTION public.closure_extra_function() RETURNS boolean LANGUAGE sql AS 'SELECT true'",
             'DROP FUNCTION public.closure_extra_function()',('<function>','UNEXPECTED_FUNCTION:closure_extra_function()')),
        )
        try:
            for kind,create,drop,expected in additions:
                self.sql(create,database)
                try:
                    with self.subTest(kind=kind,entrypoint='audit'):
                        code,report=self.audit(database);self.assertEqual(2,code,report)
                        gaps={(r['table_name'],r['constraint_name']) for r in report['schema_profile']['missing_constraints']}
                        self.assertIn(expected,gaps)
                    with self.subTest(kind=kind,entrypoint='recovery'):
                        with recovery.PgSession(config) as session:
                            session.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
                            with self.assertRaisesRegex(recovery.RecoveryError,'required closure catalog'):
                                recovery.supported_schema(session,recovery.inventory(session),'jxc_audit_runtime')
                finally:self.sql(drop,database)
            # Removing only the unreviewed object restores the pinned schema; no repair or ignore list.
            with recovery.PgSession(config) as session:
                session.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
                self.assertEqual('release-closure-pg16',recovery.supported_schema(session,recovery.inventory(session),'jxc_audit_runtime')['name'])
        finally:self.sql('DROP DATABASE '+database,'postgres')

    def test_read_only_role_snapshot_does_not_modify_constrained_schema(self):
        before = self.fingerprint('audit_clean')
        code, report = self.audit(user='audit_reader')
        self.assertEqual(2, code)  # M4 lacks write gate; object bytes unverified.
        self.assertTrue(report['snapshot']['read_only'])
        self.assertEqual('repeatable read', report['snapshot']['isolation'])
        self.assertEqual('audit_reader', report['snapshot']['database_user'])
        self.assertEqual(before, self.fingerprint('audit_clean'))
        checks = {c['code']: c for c in report['checks']}
        self.assertEqual('UNAVAILABLE', checks['WRITE_GATE']['status'])
        self.assertEqual('UNSUPPORTED', checks['ATTACHMENT_OBJECTS']['status'])
        self.assertEqual('PASS', checks['NEGATIVE_BALANCE']['status'])
        self.assertEqual([], report['findings'])

    def test_legacy_exceptions_are_individual_rows_with_original_nulls(self):
        before = self.fingerprint('audit_legacy')
        code, report = self.audit('audit_legacy')
        self.assertEqual(2, code)
        findings = report['findings']
        def rows(check, table):
            return {str(f['row']['id']): f for f in findings
                    if f['check_code'] == check and f['table'] == table}
        self.assertEqual({'301', '302'}, set(rows('DUPLICATE_SOURCE', 'inv_batch')))
        self.assertEqual({'401', '402'}, set(rows('NEGATIVE_BALANCE', 'inv_stock_summary')))
        self.assertIn('403', rows('OVER_OCCUPATION', 'inv_stock_summary'))
        self.assertIn('501', rows('OVER_OCCUPATION', 'ap_payment'))
        self.assertIn('303', rows('SCOPE_REFERENCE', 'inv_batch'))
        self.assertIn('601', rows('SCOPE_REFERENCE', 'fin_voucher_line'))
        rate = rows('HISTORICAL_RATE', 'cst_inbound_cost')['701']
        self.assertIsNone(rate['observed']['rate'])
        self.assertEqual('REVIEW', rate['severity'])
        self.assertIsNone(rows('HISTORICAL_COST', 'cst_inbound_cost')['701']['observed']['unit_cost'])
        self.assertIn('304', rows('HISTORICAL_COST', 'inv_batch'))
        self.assertIn('801', rows('EVENT_VOUCHER', 'sys_biz_event'))
        self.assertNotIn('802', rows('EVENT_VOUCHER', 'sys_biz_event'))  # valid NO_VOUCHER
        self.assertIn('501', rows('ATTACHMENT_METADATA', 'ap_payment'))
        self.assertIn('901', rows('ATTACHMENT_METADATA', 'sys_attachment_link'))
        self.assertEqual(before, self.fingerprint('audit_legacy'))
        self.assertTrue(report['schema_profile']['missing_constraints'])
        self.assertTrue(report['limitations'])

    def test_rls_filtered_visibility_is_rejected(self):
        code, report = self.audit(user='audit_limited')
        self.assertEqual(1, code)
        self.assertEqual('ERROR', report['status'])
        self.assertEqual('INSUFFICIENT_VISIBILITY', report['error']['code'])
        self.assertIsNone(report['findings'])

    def test_unknown_shape_fails_closed_without_zero_findings(self):
        self.sql('CREATE DATABASE audit_unknown TEMPLATE audit_clean;', 'postgres')
        try:
            self.sql('ALTER TABLE inv_stock_summary RENAME COLUMN reserved_qty TO unknown_qty;', 'audit_unknown')
            code, report = self.audit('audit_unknown')
            self.assertEqual(1, code)
            self.assertEqual('SCHEMA_MISMATCH', report['error']['code'])
            self.assertIsNone(report['findings'])
            self.assertIsNone(report.get('finding_count'))
        finally:
            self.sql('DROP DATABASE audit_unknown;', 'postgres')

    def test_unrecognized_table_or_same_version_migration_fails_closed(self):
        self.sql('CREATE DATABASE audit_future TEMPLATE audit_clean;', 'postgres')
        try:
            self.sql('CREATE TABLE unknown_inventory_engine(id bigint, country_id bigint, qty numeric);', 'audit_future')
            code, report = self.audit('audit_future')
            self.assertEqual(1, code)
            self.assertEqual('SCHEMA_MISMATCH', report['error']['code'])
            self.sql("DROP TABLE unknown_inventory_engine; INSERT INTO flyway_schema_history VALUES "
                     "(16,'008','unknown','SQL','V008__unknown_engine.sql',NULL,'postgres',now(),0,true);", 'audit_future')
            code, report = self.audit('audit_future')
            self.assertEqual(1, code)
            self.assertEqual('SCHEMA_MISMATCH', report['error']['code'])
        finally:
            self.sql('DROP DATABASE audit_future;', 'postgres')

    def m5_database(self, database):
        self.sql('CREATE DATABASE ' + database + ' TEMPLATE audit_clean;', 'postgres')
        migration = next(MIGRATIONS.glob('V008*.sql'))
        self.sql(migration.read_text().replace('${runtimeRole}', 'jxc_audit_runtime'), database)
        self.sql("INSERT INTO flyway_schema_history VALUES (16,'008','M5 fixture','SQL','"
                 + migration.name + "',NULL,'postgres',now(),0,true);", database)

    def test_v008_frozen_gate_reports_complete_statement_and_truncate_coverage(self):
        self.m5_database('audit_m5')
        try:
            self.sql("SELECT public.jxc_set_write_mode('FROZEN',0,'11111111-1111-4111-8111-111111111111',"
                     "'audit-test','isolated fixture');", 'audit_m5')
            code, report = self.audit('audit_m5')
            gate = next(c for c in report['checks'] if c['code'] == 'WRITE_GATE')
            self.assertEqual('PASS', gate['status'])
            self.assertEqual('FROZEN', gate['observed']['mode'])
            self.assertEqual([], gate['observed']['missing_trigger_tables'])
        finally:
            self.sql('DROP DATABASE audit_m5;', 'postgres')

    def test_v008_gate_cannot_be_satisfied_by_wrong_function_or_no_truncate(self):
        self.m5_database('audit_m5_weak')
        try:
            self.sql("DROP TRIGGER jxc_write_gate ON public.inv_stock_summary; "
                     "CREATE FUNCTION public.jxc_write_gate() RETURNS trigger LANGUAGE plpgsql "
                     "AS $$ BEGIN RETURN NULL; END $$; "
                     "CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE "
                     "ON public.inv_stock_summary FOR EACH STATEMENT EXECUTE FUNCTION public.jxc_write_gate(); "
                     "DROP TRIGGER jxc_write_gate ON public.inv_batch_balance; "
                     "CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE "
                     "ON public.inv_batch_balance FOR EACH STATEMENT EXECUTE FUNCTION public.jxc_assert_writes_open();",
                     'audit_m5_weak')
            code, report = self.audit('audit_m5_weak')
            gate = next(c for c in report['checks'] if c['code'] == 'WRITE_GATE')
            self.assertEqual('GAPS', gate['status'])
            self.assertEqual({'inv_stock_summary', 'inv_batch_balance'},
                             set(gate['observed']['missing_trigger_tables']))
        finally:
            self.sql('DROP DATABASE audit_m5_weak;', 'postgres')

    def test_null_legacy_balance_remains_explicit_review(self):
        self.sql('CREATE DATABASE audit_null TEMPLATE audit_legacy;', 'postgres')
        try:
            self.sql('ALTER TABLE inv_stock_summary ALTER COLUMN reserved_qty DROP NOT NULL; '
                     'UPDATE inv_stock_summary SET reserved_qty=NULL WHERE id=403;', 'audit_null')
            code, report = self.audit('audit_null')
            missing = [f for f in report['findings'] if f['check_code'] == 'NEGATIVE_BALANCE'
                       and f['table'] == 'inv_stock_summary' and f['row']['id'] == 403]
            self.assertEqual(1, len(missing))
            self.assertEqual('REVIEW', missing[0]['severity'])
            self.assertIsNone(missing[0]['observed']['reserved_qty'])
        finally:
            self.sql('DROP DATABASE audit_null;', 'postgres')

    def test_financial_decimal_evidence_does_not_round_through_float(self):
        self.sql('CREATE DATABASE audit_decimal TEMPLATE audit_legacy;', 'postgres')
        try:
            self.sql("UPDATE ap_payment SET amount=999999999999999999.123456,"
                     "used_amount=999999999999999999.223456 WHERE id=501;", 'audit_decimal')
            code, report = self.audit('audit_decimal')
            row = next(f for f in report['findings'] if f['check_code'] == 'OVER_OCCUPATION'
                       and f['table'] == 'ap_payment' and f['row']['id'] == 501)
            self.assertEqual('999999999999999999.123456', row['observed']['amount'])
            self.assertEqual('999999999999999999.223456', row['observed']['used_amount'])
        finally:
            self.sql('DROP DATABASE audit_decimal;', 'postgres')

    def test_same_name_weakened_constraints_are_not_complete(self):
        self.sql('CREATE DATABASE audit_weak TEMPLATE audit_clean;', 'postgres')
        try:
            self.sql('ALTER TABLE inv_batch DROP CONSTRAINT inv_batch_country_id_book_id_fkey; '
                     'ALTER TABLE inv_batch ADD CONSTRAINT inv_batch_country_id_book_id_fkey '
                     'FOREIGN KEY(country_id) REFERENCES sys_country(id); '
                     'ALTER TABLE inv_batch DROP CONSTRAINT inv_batch_country_id_source_type_source_line_id_key; '
                     'CREATE UNIQUE INDEX inv_batch_country_id_source_type_source_line_id_key ON inv_batch(country_id,id);',
                     'audit_weak')
            code, report = self.audit('audit_weak')
            missing = {c['constraint_name'] for c in report['schema_profile']['missing_constraints']}
            self.assertIn('inv_batch_country_id_book_id_fkey', missing)
            self.assertIn('inv_batch_country_id_source_type_source_line_id_key', missing)
        finally:
            self.sql('DROP DATABASE audit_weak;', 'postgres')

    def test_file_output_matches_stdout_and_failure_does_not_expose_connection(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'audit.json'
            code, report = self.audit('audit_clean', 'postgres', '--output', str(output))
            self.assertEqual(2, code)
            self.assertEqual(report, json.loads(output.read_text()))
            self.assertEqual(0o600, output.stat().st_mode & 0o777)
        code, report = self.audit('audit_database_does_not_exist')
        self.assertEqual(1, code)
        self.assertEqual('DATABASE_ERROR', report['error']['code'])
        self.assertNotIn('password', json.dumps(report).lower())


if __name__ == '__main__':
    unittest.main()
