CREATE TABLE sys_import_batch (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'), country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 import_type varchar(64) NOT NULL,template_version integer NOT NULL DEFAULT 1,file_sha256 varchar(64) NOT NULL,
 source_file_text text CHECK(octet_length(source_file_text)<=2000000),content_sha256 varchar(64) NOT NULL,hash_basis varchar(24) NOT NULL CHECK(hash_basis IN ('CANONICAL_ROWS','SOURCE_BYTES')),cutoff_date date,status varchar(32) NOT NULL CHECK(status IN ('VALIDATED','VALIDATION_FAILED','COMPLETED','CANCELLED')),
 requested_by jxc_safe_id NOT NULL REFERENCES sys_user(id),total_rows integer NOT NULL CHECK(total_rows BETWEEN 1 AND 10000),
 valid_rows integer NOT NULL DEFAULT 0,error_rows integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 confirmed_by jxc_safe_id REFERENCES sys_user(id),confirmed_at timestamptz,
 UNIQUE(country_id,id),UNIQUE(country_id,import_type,file_sha256)
);
CREATE TABLE sys_import_row (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,batch_id jxc_safe_id NOT NULL,row_no integer NOT NULL CHECK(row_no>0),
 raw jsonb NOT NULL CHECK(jsonb_typeof(raw)='object' AND jxc_json_ids_safe(raw)),
 normalized jsonb NOT NULL CHECK(jsonb_typeof(normalized)='object' AND jxc_json_ids_safe(normalized)),
 source_key varchar(500),errors jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(errors)='array'),target_type varchar(64),target_id jxc_safe_id,
 UNIQUE(country_id,id),UNIQUE(country_id,batch_id,row_no),FOREIGN KEY(country_id,batch_id) REFERENCES sys_import_batch(country_id,id),
 CHECK((target_type IS NULL)=(target_id IS NULL))
);
CREATE TABLE sys_import_source (
 country_id jxc_safe_id NOT NULL,import_type varchar(64) NOT NULL,source_key varchar(500) NOT NULL,row_id jxc_safe_id NOT NULL,
 PRIMARY KEY(country_id,import_type,source_key),UNIQUE(country_id,row_id),FOREIGN KEY(country_id,row_id) REFERENCES sys_import_row(country_id,id)
);
CREATE FUNCTION jxc_import_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='sys_import_batch' AND TG_OP='UPDATE' THEN
  IF OLD.status IN ('COMPLETED','CANCELLED') OR ROW(NEW.id,NEW.country_id,NEW.import_type,NEW.template_version,NEW.file_sha256,NEW.cutoff_date,NEW.requested_by,NEW.total_rows,NEW.valid_rows,NEW.error_rows,NEW.created_at,NEW.source_file_text,NEW.content_sha256,NEW.hash_basis)
   IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.import_type,OLD.template_version,OLD.file_sha256,OLD.cutoff_date,OLD.requested_by,OLD.total_rows,OLD.valid_rows,OLD.error_rows,OLD.created_at,OLD.source_file_text,OLD.content_sha256,OLD.hash_basis)
  THEN RAISE EXCEPTION 'SYS_IMPORT_IMMUTABLE'; END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='sys_import_row' AND TG_OP='UPDATE' THEN
  IF OLD.target_id IS NOT NULL OR ROW(NEW.id,NEW.country_id,NEW.batch_id,NEW.row_no,NEW.raw,NEW.normalized,NEW.source_key,NEW.errors)
   IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.batch_id,OLD.row_no,OLD.raw,OLD.normalized,OLD.source_key,OLD.errors)
  THEN RAISE EXCEPTION 'SYS_IMPORT_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'SYS_IMPORT_IMMUTABLE';
END $$;
CREATE TRIGGER sys_import_batch_immutable BEFORE UPDATE OR DELETE ON sys_import_batch FOR EACH ROW EXECUTE FUNCTION jxc_import_immutable();
CREATE TRIGGER sys_import_row_immutable BEFORE UPDATE OR DELETE ON sys_import_row FOR EACH ROW EXECUTE FUNCTION jxc_import_immutable();
CREATE TRIGGER sys_import_source_immutable BEFORE UPDATE OR DELETE ON sys_import_source FOR EACH ROW EXECUTE FUNCTION jxc_import_immutable();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sys_import_batch','sys_import_row','sys_import_source'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
  EXECUTE format('CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open()',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON sys_import_batch,sys_import_row,sys_import_source TO "${runtimeRole}";
GRANT UPDATE(status,confirmed_by,confirmed_at) ON sys_import_batch TO "${runtimeRole}";
GRANT UPDATE(target_type,target_id) ON sys_import_row TO "${runtimeRole}";
