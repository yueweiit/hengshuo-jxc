-- 采购来源暂存：不新增正式商品、采购、库存或财务业务引用。
CREATE TABLE pur_order_import_batch (
  id jxc_safe_id NOT NULL DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), batch_id uuid NOT NULL,
  header jsonb NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PARSING','REVIEW','COMPLETED','CANCELLED','FAILED')),
  source_status text NOT NULL DEFAULT 'AVAILABLE' CHECK(source_status IN ('AVAILABLE','SOURCE_UNAVAILABLE')),
  next_row_no integer NOT NULL DEFAULT 1 CHECK(next_row_no>0),
  created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(country_id,batch_id), UNIQUE(country_id,id)
);

-- 旧批次表头不一致时拒绝迁移，不选择任意一行覆盖。
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pur_order_import GROUP BY country_id,batch_id HAVING count(DISTINCT
    jsonb_build_array(book_id,supplier_id,currency,order_date,expected_date,payment_terms,prepay_ratio,term_days))>1)
  THEN RAISE EXCEPTION 'PUR_IMPORT_HEADER_CONFLICT: reconcile historical batch headers before migration'; END IF;
END $$;
INSERT INTO pur_order_import_batch(country_id,batch_id,header,status,source_status,next_row_no,created_by)
SELECT country_id,batch_id,jsonb_build_object('bookId',book_id,'supplierId',supplier_id,'currency',currency,
 'orderDate',order_date,'expectedDate',expected_date,'paymentTerms',payment_terms,'prepayRatio',prepay_ratio::text,'termDays',term_days),
 'REVIEW','SOURCE_UNAVAILABLE',max(row_no)+1,min(created_by)
FROM pur_order_import GROUP BY country_id,batch_id,book_id,supplier_id,currency,order_date,expected_date,payment_terms,prepay_ratio,term_days;

CREATE TABLE pur_order_import_source (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'), country_id jxc_safe_id NOT NULL,
  batch_id uuid NOT NULL, attachment_id jxc_safe_id NOT NULL,
  file_name text NOT NULL, file_sha256 text NOT NULL CHECK(file_sha256 ~ '^[a-f0-9]{64}$'),
  parser_version text, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PARSING','READY','FAILED','STALE')),
  sheets jsonb NOT NULL DEFAULT '[]', warnings jsonb NOT NULL DEFAULT '[]', associations jsonb NOT NULL DEFAULT '[]', parse_options jsonb NOT NULL DEFAULT '{}',
  error_code text, error_message text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(country_id,batch_id,id),
  FOREIGN KEY(country_id,batch_id) REFERENCES pur_order_import_batch(country_id,batch_id),
  FOREIGN KEY(country_id,attachment_id) REFERENCES sys_attachment(country_id,id)
);
ALTER TABLE pur_order_import ADD COLUMN source_id jxc_safe_id,
 ADD COLUMN source_sheet text, ADD COLUMN source_row integer CHECK(source_row>0),
 ADD COLUMN original_values jsonb, ADD COLUMN formula_provenance jsonb,
 ADD COLUMN field_origins jsonb NOT NULL DEFAULT '{}',
 ADD CONSTRAINT pur_import_batch_fk FOREIGN KEY(country_id,batch_id) REFERENCES pur_order_import_batch(country_id,batch_id),
 ADD CONSTRAINT pur_import_source_fk FOREIGN KEY(country_id,batch_id,source_id) REFERENCES pur_order_import_source(country_id,batch_id,id);
CREATE UNIQUE INDEX pur_import_source_row_uq ON pur_order_import(country_id,source_id,source_sheet,source_row);
CREATE TABLE pur_order_import_image (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'), country_id jxc_safe_id NOT NULL,
  source_id jxc_safe_id NOT NULL, attachment_id jxc_safe_id NOT NULL, image_sha256 text NOT NULL CHECK(image_sha256 ~ '^[a-f0-9]{64}$'),
  media_part text NOT NULL, mime_type text NOT NULL, width integer NOT NULL CHECK(width>0), height integer NOT NULL CHECK(height>0),
  UNIQUE(country_id,id), UNIQUE(country_id,source_id,image_sha256),
  FOREIGN KEY(country_id,source_id) REFERENCES pur_order_import_source(country_id,id),
  FOREIGN KEY(country_id,attachment_id) REFERENCES sys_attachment(country_id,id)
);
CREATE TABLE pur_order_import_row_image (
  country_id jxc_safe_id NOT NULL, row_id jxc_safe_id NOT NULL, image_id jxc_safe_id NOT NULL,
  anchor jsonb NOT NULL, association_status text NOT NULL DEFAULT 'UNCONFIRMED' CHECK(association_status IN ('UNCONFIRMED','CONFIRMED','REJECTED')),
  confirmed_by jxc_safe_id REFERENCES sys_user(id), confirmed_at timestamptz,
  PRIMARY KEY(country_id,row_id,image_id),
  FOREIGN KEY(country_id,row_id) REFERENCES pur_order_import(country_id,id) ON DELETE CASCADE,
  FOREIGN KEY(country_id,image_id) REFERENCES pur_order_import_image(country_id,id)
);
CREATE TABLE pur_order_import_task (
  id uuid PRIMARY KEY, country_id jxc_safe_id NOT NULL, batch_id uuid NOT NULL, source_id jxc_safe_id NOT NULL,
  kind text NOT NULL DEFAULT 'PARSE', input_revision integer NOT NULL, input_hash text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','NEEDS_REAUTH','STALE')),
  attempt_count integer NOT NULL DEFAULT 0, lease_owner uuid, lease_until timestamptz, next_retry_at timestamptz,
  result jsonb, error_code text, error_message text, requested_by jxc_safe_id NOT NULL REFERENCES sys_user(id),
  authorization_basis jsonb NOT NULL, credential_hash text, expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 hour',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), FOREIGN KEY(country_id,batch_id,source_id) REFERENCES pur_order_import_source(country_id,batch_id,id)
);
CREATE INDEX pur_import_task_recovery_idx ON pur_order_import_task(country_id,status,lease_until);

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['pur_order_import_batch','pur_order_import_source','pur_order_import_image','pur_order_import_row_image','pur_order_import_task'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO "${runtimeRole}"',tab);
  EXECUTE format('CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open()',tab);
  EXECUTE format('CREATE TRIGGER jxc_country_gate BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jxc_country_mutation_gate(''CONFIG'')',tab);
 END LOOP;
END $$;
