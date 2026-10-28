ALTER TABLE pur_order_import ADD COLUMN match_task_id uuid,ADD COLUMN match_result jsonb;
ALTER TABLE pur_order_import_task ADD COLUMN callback_hash text,ADD COLUMN callback_credential_hash text;
CREATE TABLE pur_order_import_candidate (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,row_id jxc_safe_id NOT NULL,run_id uuid NOT NULL,
 product_id jxc_safe_id NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,row_id,run_id,product_id),FOREIGN KEY(country_id,row_id) REFERENCES pur_order_import(country_id,id) ON DELETE CASCADE,
 FOREIGN KEY(country_id,run_id) REFERENCES pur_order_import_task(country_id,id)
);
ALTER TABLE pur_order_import_candidate ENABLE ROW LEVEL SECURITY;
ALTER TABLE pur_order_import_candidate FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON pur_order_import_candidate USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON pur_order_import_candidate TO "${runtimeRole}";
CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON pur_order_import_candidate FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open();
CREATE TRIGGER jxc_country_gate BEFORE INSERT OR UPDATE OR DELETE ON pur_order_import_candidate FOR EACH ROW EXECUTE FUNCTION jxc_country_mutation_gate('CONFIG');
