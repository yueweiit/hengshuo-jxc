CREATE TABLE md_image_index_generation (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 generation varchar(32) NOT NULL CHECK(generation ~ '^[a-f0-9]{32}$'),model_name text NOT NULL,model_version text NOT NULL,preprocess_version text NOT NULL,
 basis_hash text NOT NULL,manifest jsonb NOT NULL,status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','READY','FAILED')),
 attachment_id jxc_safe_id,active boolean NOT NULL DEFAULT false,error_message text,
 created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,generation),FOREIGN KEY(country_id,attachment_id) REFERENCES sys_attachment(country_id,id),
 CHECK(NOT active OR status='READY'),CHECK(status<>'READY' OR attachment_id IS NOT NULL)
);
CREATE UNIQUE INDEX md_image_index_active_uq ON md_image_index_generation(country_id,model_name,model_version,preprocess_version) WHERE active;
ALTER TABLE pur_order_import_row_image ADD COLUMN publish_status text NOT NULL DEFAULT 'PENDING' CHECK(publish_status IN ('PENDING','READY','FAILED')),
 ADD COLUMN product_image_id jxc_safe_id,ADD COLUMN publish_product_id jxc_safe_id,ADD COLUMN publish_error text;
ALTER TABLE pur_order_import_task ADD COLUMN input_data jsonb NOT NULL DEFAULT '{}',ADD COLUMN phase text;
ALTER TABLE md_image_index_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE md_image_index_generation FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON md_image_index_generation USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON md_image_index_generation TO "${runtimeRole}";
CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON md_image_index_generation FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open();
CREATE TRIGGER jxc_country_gate BEFORE INSERT OR UPDATE OR DELETE ON md_image_index_generation FOR EACH ROW EXECUTE FUNCTION jxc_country_mutation_gate('CONFIG');
