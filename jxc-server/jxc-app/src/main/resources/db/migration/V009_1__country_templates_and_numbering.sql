-- Forward-only SYS closure. No operational data or implicit user grants are seeded.
CREATE TABLE sys_country_template (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),version_no integer NOT NULL CHECK(version_no>0),status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','PUBLISHED','RETIRED')),change_note text NOT NULL,source_params jsonb NOT NULL CHECK(jsonb_typeof(source_params)='object'),published_by jxc_safe_id REFERENCES sys_user(id),published_at timestamptz,created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),UNIQUE(country_id,version_no)
);
CREATE TABLE sys_country_template_item (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,template_id jxc_safe_id NOT NULL,item_type varchar(64) NOT NULL,item_key varchar(64) NOT NULL,label varchar(200) NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND jxc_json_ids_safe(payload)),requires_review boolean NOT NULL,sensitive boolean NOT NULL DEFAULT false,UNIQUE(country_id,id),UNIQUE(country_id,template_id,item_key),FOREIGN KEY(country_id,template_id) REFERENCES sys_country_template(country_id,id)
);
CREATE TABLE sys_country_clone_job (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),source_country_id jxc_safe_id NOT NULL,template_id jxc_safe_id NOT NULL,selected_item_ids jsonb NOT NULL CHECK(jsonb_typeof(selected_item_ids)='array' AND jxc_json_ids_safe(selected_item_ids)),status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','APPLIED','DONE','CANCELLED')),copy_result jsonb NOT NULL DEFAULT '{}',created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),applied_at timestamptz,UNIQUE(country_id,id),UNIQUE(country_id),FOREIGN KEY(source_country_id,template_id) REFERENCES sys_country_template(country_id,id)
);
CREATE TABLE sys_country_config_review (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),source_template_item_id jxc_safe_id,config_type varchar(64) NOT NULL,item_key varchar(64) NOT NULL,label varchar(200) NOT NULL,payload jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(payload)='object'),review_status varchar(16) NOT NULL DEFAULT 'NEED_REVIEW' CHECK(review_status IN('NEED_REVIEW','REVIEWED')),reviewed_by jxc_safe_id REFERENCES sys_user(id),reviewed_at timestamptz,comment text NOT NULL DEFAULT '',UNIQUE(country_id,id),UNIQUE(country_id,source_template_item_id,item_key)
);
CREATE TABLE sys_template_upgrade (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),from_template_id jxc_safe_id NOT NULL,to_template_id jxc_safe_id NOT NULL,source_country_id jxc_safe_id NOT NULL,diff jsonb NOT NULL CHECK(jsonb_typeof(diff)='array'),status varchar(16) NOT NULL DEFAULT 'PREVIEWED' CHECK(status IN('PREVIEWED','CONFIRMED','REJECTED')),created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),decided_by jxc_safe_id REFERENCES sys_user(id),decided_at timestamptz,UNIQUE(country_id,id),FOREIGN KEY(source_country_id,from_template_id) REFERENCES sys_country_template(country_id,id),FOREIGN KEY(source_country_id,to_template_id) REFERENCES sys_country_template(country_id,id)
);
CREATE TABLE sys_doc_number_rule (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),doc_type varchar(64) NOT NULL CHECK(doc_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),prefix varchar(20) NOT NULL CHECK(prefix ~ '^[A-Z0-9-]{1,20}$'),date_pattern varchar(16) NOT NULL DEFAULT 'yyyyMMdd' CHECK(date_pattern IN('','yyyy','yyyyMM','yyyyMMdd')),sequence_width integer NOT NULL DEFAULT 6 CHECK(sequence_width BETWEEN 3 AND 12),reset_period varchar(16) NOT NULL DEFAULT 'NONE' CHECK(reset_period IN('NONE','YEAR','MONTH','DAY')),version integer NOT NULL DEFAULT 1,UNIQUE(country_id,id),UNIQUE(country_id,doc_type),CHECK(reset_period='NONE' OR reset_period='YEAR' AND date_pattern<>'' OR reset_period='MONTH' AND date_pattern IN('yyyyMM','yyyyMMdd') OR reset_period='DAY' AND date_pattern='yyyyMMdd')
);
CREATE TABLE sys_doc_number_counter (
 country_id jxc_safe_id NOT NULL,doc_type varchar(64) NOT NULL,bucket varchar(16) NOT NULL,last_value bigint NOT NULL CHECK(last_value>0),PRIMARY KEY(country_id,doc_type,bucket),FOREIGN KEY(country_id,doc_type) REFERENCES sys_doc_number_rule(country_id,doc_type)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sys_country_template','sys_country_template_item','sys_country_clone_job','sys_country_config_review','sys_template_upgrade','sys_doc_number_rule','sys_doc_number_counter'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
  EXECUTE format('CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open()',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO "${runtimeRole}"',t);
 END LOOP;
END $$;
CREATE FUNCTION jxc_next_doc_number(selected_country bigint,selected_type text,document_date date) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE rule sys_doc_number_rule;bucket_value text;issued bigint;date_part text;
BEGIN
 IF selected_country IS DISTINCT FROM jxc_current_country_id() OR document_date IS NULL THEN RAISE EXCEPTION 'SYS_COUNTRY_REQUIRED';END IF;
 SELECT * INTO rule FROM sys_doc_number_rule WHERE country_id=selected_country AND doc_type=selected_type FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SYS_CONFIG_MISSING: document number rule';END IF;
 bucket_value:=CASE rule.reset_period WHEN 'DAY' THEN to_char(document_date,'YYYYMMDD') WHEN 'MONTH' THEN to_char(document_date,'YYYYMM') WHEN 'YEAR' THEN to_char(document_date,'YYYY') ELSE '*' END;
 INSERT INTO sys_doc_number_counter(country_id,doc_type,bucket,last_value) VALUES(selected_country,selected_type,bucket_value,1)
 ON CONFLICT(country_id,doc_type,bucket) DO UPDATE SET last_value=sys_doc_number_counter.last_value+1 RETURNING last_value INTO issued;
 IF length(issued::text)>rule.sequence_width THEN RAISE EXCEPTION 'SYS_NUMBER_EXHAUSTED';END IF;
 date_part:=CASE rule.date_pattern WHEN 'yyyyMMdd' THEN to_char(document_date,'YYYYMMDD') WHEN 'yyyyMM' THEN to_char(document_date,'YYYYMM') WHEN 'yyyy' THEN to_char(document_date,'YYYY') ELSE '' END;
 RETURN rule.prefix||date_part||lpad(issued::text,rule.sequence_width,'0');
END $$;
REVOKE ALL ON FUNCTION jxc_next_doc_number(bigint,text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jxc_next_doc_number(bigint,text,date) TO "${runtimeRole}";
