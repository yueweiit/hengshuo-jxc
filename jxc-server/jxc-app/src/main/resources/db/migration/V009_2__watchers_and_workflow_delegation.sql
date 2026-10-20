CREATE TABLE sys_doc_watcher (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),watch_type varchar(16) NOT NULL CHECK(watch_type IN('VIEWER','CC')),target_type varchar(32) NOT NULL CHECK(target_type IN('DOC','WAREHOUSE_RULE','DOC_TYPE_RULE')),doc_type varchar(64) NOT NULL,doc_id jxc_safe_id,warehouse_id jxc_safe_id,user_id jxc_safe_id NOT NULL REFERENCES sys_user(id),field_groups jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(field_groups)='array'),status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK(status IN('ENABLED','DISABLED')),version integer NOT NULL DEFAULT 1,created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),CHECK(target_type<>'DOC' OR doc_id IS NOT NULL),CHECK(target_type<>'WAREHOUSE_RULE' OR warehouse_id IS NOT NULL)
);
CREATE TABLE sys_delegation (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),from_user_id jxc_safe_id NOT NULL REFERENCES sys_user(id),to_user_id jxc_safe_id NOT NULL REFERENCES sys_user(id),scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='array'),start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,reason text NOT NULL CHECK(btrim(reason)<>''),status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','REVOKED')),version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),CHECK(from_user_id<>to_user_id),CHECK(end_at>start_at)
);
ALTER TABLE wf_task ADD COLUMN acted_by jxc_safe_id REFERENCES sys_user(id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sys_doc_watcher','sys_delegation'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
  EXECUTE format('CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open()',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO "${runtimeRole}"',t);
 END LOOP;
END $$;
