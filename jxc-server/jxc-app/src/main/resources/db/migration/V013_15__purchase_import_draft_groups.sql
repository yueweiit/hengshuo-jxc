CREATE TABLE pur_order_import_group (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,batch_id uuid NOT NULL,
 group_key text NOT NULL,source_order_no text NOT NULL,effective_header jsonb NOT NULL,header_override boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),preview_snapshot jsonb,preview_hash text,preview_token uuid,
 create_key uuid NOT NULL,outer_key uuid,request_hash text,create_request jsonb,
 create_status text NOT NULL DEFAULT 'DRAFT' CHECK(create_status IN ('DRAFT','READY','CREATING','CREATED','FAILED','UNKNOWN')),
 target_order_id jxc_safe_id,verify_status text NOT NULL DEFAULT 'NOT_CHECKED' CHECK(verify_status IN ('NOT_CHECKED','VERIFIED','READ_FAILED','DIFFERENT')),
 result_snapshot jsonb,error_code text,error_message text,fee_todos jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,batch_id,group_key),
 FOREIGN KEY(country_id,batch_id) REFERENCES pur_order_import_batch(country_id,batch_id)
);
ALTER TABLE pur_order_import ADD COLUMN group_id jxc_safe_id,ADD COLUMN target_order_line_id jxc_safe_id,
 ADD COLUMN tax_rate numeric(9,6) CHECK(tax_rate BETWEEN 0 AND 1),
 ADD CONSTRAINT pur_import_group_fk FOREIGN KEY(country_id,group_id) REFERENCES pur_order_import_group(country_id,id);
CREATE INDEX pur_import_group_rows_idx ON pur_order_import(country_id,group_id,row_no);
CREATE UNIQUE INDEX pur_import_target_line_uq ON pur_order_import(country_id,target_order_line_id) WHERE target_order_line_id IS NOT NULL;
ALTER TABLE pur_order_import_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE pur_order_import_group FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON pur_order_import_group USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON pur_order_import_group TO "${runtimeRole}";
CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON pur_order_import_group FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open();
CREATE TRIGGER jxc_country_gate BEFORE INSERT OR UPDATE OR DELETE ON pur_order_import_group FOR EACH ROW EXECUTE FUNCTION jxc_country_mutation_gate('CONFIG');
