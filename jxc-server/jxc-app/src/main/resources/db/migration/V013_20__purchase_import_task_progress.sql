-- 进度独立于业务保存事务；不修改任务终态或导入明细。
CREATE TABLE pur_order_import_task_progress (
 country_id jxc_safe_id NOT NULL,task_id uuid NOT NULL,lease_owner uuid NOT NULL,
 attempt_count integer NOT NULL CHECK(attempt_count>0),phase_order integer NOT NULL,
 snapshot jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(country_id,task_id),
 FOREIGN KEY(country_id,task_id) REFERENCES pur_order_import_task(country_id,id)
);
ALTER TABLE pur_order_import_task_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE pur_order_import_task_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON pur_order_import_task_progress USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON pur_order_import_task_progress TO "${runtimeRole}";
CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON pur_order_import_task_progress FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open();
CREATE TRIGGER jxc_country_gate BEFORE INSERT OR UPDATE OR DELETE ON pur_order_import_task_progress FOR EACH ROW EXECUTE FUNCTION jxc_country_mutation_gate('CONFIG');
