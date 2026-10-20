-- M1 infrastructure only: no people, demo records, balances or opening entries.
CREATE EXTENSION IF NOT EXISTS btree_gist;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${runtimeRole}') THEN
    RAISE EXCEPTION 'JXC_RUNTIME_ROLE_MISSING';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${runtimeRole}' AND (rolsuper OR rolbypassrls))
     OR '${runtimeRole}' = current_user
     OR pg_has_role('${runtimeRole}', current_user, 'MEMBER') THEN
    RAISE EXCEPTION 'JXC_RUNTIME_ROLE_MUST_NOT_OWN_OR_BYPASS_RLS';
  END IF;
END
$$;

CREATE SEQUENCE jxc_id_seq AS bigint MINVALUE 1 MAXVALUE 9007199254740991 NO CYCLE;
CREATE DOMAIN jxc_safe_id AS bigint CHECK (VALUE BETWEEN 1 AND 9007199254740991);

CREATE FUNCTION jxc_current_country_id() RETURNS bigint
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.country_id', true), '')::bigint $$;

-- Numeric references in JSON remain exact frontend-safe integers. Textual identifiers
-- (for example taxId) remain strings; DTOs enforce the public numeric-ID contract.
CREATE FUNCTION jxc_json_id_value_safe(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE item jsonb; number_value numeric;
BEGIN
  IF jsonb_typeof(value) = 'number' THEN
    number_value := (value #>> '{}')::numeric;
    RETURN number_value BETWEEN 1 AND 9007199254740991 AND trunc(number_value) = number_value;
  ELSIF jsonb_typeof(value) = 'array' THEN
    FOR item IN SELECT jsonb_array_elements(value) LOOP
      IF NOT jxc_json_id_value_safe(item) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END IF;
  RETURN jsonb_typeof(value) IN ('null', 'string');
END
$$;

CREATE FUNCTION jxc_json_ids_safe(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE field record; item jsonb;
BEGIN
  IF jsonb_typeof(value) = 'object' THEN
    FOR field IN SELECT key, val FROM jsonb_each(value) AS fields(key, val) LOOP
      IF field.key ~ '(^id$|_id$|Id$|_ids$|Ids$)' AND NOT jxc_json_id_value_safe(field.val) THEN RETURN false; END IF;
      IF NOT jxc_json_ids_safe(field.val) THEN RETURN false; END IF;
    END LOOP;
  ELSIF jsonb_typeof(value) = 'array' THEN
    FOR item IN SELECT jsonb_array_elements(value) LOOP
      IF NOT jxc_json_ids_safe(item) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
END
$$;

CREATE TABLE md_currency (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  code varchar(3) NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{3}$'),
  name varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  decimals smallint NOT NULL DEFAULT 2 CHECK (decimals BETWEEN 0 AND 4),
  status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED','DISABLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE sys_country (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  code varchar(16) NOT NULL UNIQUE CHECK (btrim(code) <> ''),
  name varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  default_currency varchar(3) NOT NULL DEFAULT '',
  timezone varchar(64) NOT NULL DEFAULT '',
  status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','DISABLED')),
  config jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config)='object' AND jxc_json_ids_safe(config)),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status <> 'ACTIVE' OR (default_currency ~ '^[A-Z]{3}$' AND btrim(timezone) <> ''))
);

CREATE TABLE sys_user (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  username varchar(64) NOT NULL UNIQUE CHECK (btrim(username) <> ''),
  password_hash varchar(255) NOT NULL CHECK (btrim(password_hash) <> ''),
  display_name varchar(100) NOT NULL CHECK (btrim(display_name) <> ''),
  status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED','DISABLED')),
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_country_id jxc_safe_id REFERENCES sys_country(id),
  phone varchar(32),
  email varchar(254),
  locale varchar(16) NOT NULL DEFAULT 'zh-CN',
  last_login_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE sys_session (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  token_hash varchar(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id jxc_safe_id NOT NULL REFERENCES sys_user(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at)
);
CREATE INDEX sys_session_user_idx ON sys_session(user_id);

-- The sentinel 0 is a global authorization gate, never a business country.
CREATE TABLE sys_authz_epoch (
  country_id bigint PRIMARY KEY CHECK (country_id BETWEEN 0 AND 9007199254740991),
  country_ref_id jxc_safe_id GENERATED ALWAYS AS (nullif(country_id,0)) STORED REFERENCES sys_country(id),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0)
);
INSERT INTO sys_authz_epoch(country_id) VALUES (0);

CREATE TABLE sys_role (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
  code varchar(64) NOT NULL CHECK (btrim(code) <> ''),
  name varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  role_type varchar(32) NOT NULL DEFAULT 'BUSINESS',
  status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED','DISABLED')),
  permissions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(permissions)='array'),
  field_policies jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(field_policies)='object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(country_id,code)
);

CREATE TABLE sys_user_role (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
  user_id jxc_safe_id NOT NULL REFERENCES sys_user(id),
  role_id jxc_safe_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(country_id,user_id,role_id),
  FOREIGN KEY(country_id,role_id) REFERENCES sys_role(country_id,id)
);

CREATE TABLE org_entity (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
  code varchar(32) NOT NULL CHECK (btrim(code) <> ''),
  name varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  legal_name varchar(200), tax_id varchar(64),
  status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED','DISABLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by jxc_safe_id REFERENCES sys_user(id), updated_by jxc_safe_id REFERENCES sys_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(country_id,code)
);

CREATE TABLE org_store (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
  entity_id jxc_safe_id NOT NULL,
  code varchar(32) NOT NULL CHECK (btrim(code) <> ''), name varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  timezone varchar(64) NOT NULL DEFAULT '', address varchar(500) NOT NULL DEFAULT '', opened_at date,
  default_warehouse_id jxc_safe_id,
  status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED','DISABLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by jxc_safe_id REFERENCES sys_user(id), updated_by jxc_safe_id REFERENCES sys_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(country_id,entity_id,id), UNIQUE(country_id,code),
  FOREIGN KEY(country_id,entity_id) REFERENCES org_entity(country_id,id)
);

CREATE TABLE org_warehouse (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), entity_id jxc_safe_id NOT NULL, store_id jxc_safe_id,
  code varchar(32) NOT NULL CHECK (btrim(code) <> ''), name varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  type varchar(32) NOT NULL DEFAULT 'WAREHOUSE' CHECK (type IN ('WAREHOUSE','STORE')),
  timezone varchar(64) NOT NULL DEFAULT '', address varchar(500) NOT NULL DEFAULT '',
  status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED','DISABLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by jxc_safe_id REFERENCES sys_user(id), updated_by jxc_safe_id REFERENCES sys_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(country_id,entity_id,id), UNIQUE(country_id,code),
  FOREIGN KEY(country_id,entity_id) REFERENCES org_entity(country_id,id),
  FOREIGN KEY(country_id,entity_id,store_id) REFERENCES org_store(country_id,entity_id,id),
  CHECK (type <> 'STORE' OR store_id IS NOT NULL)
);
ALTER TABLE org_store ADD CONSTRAINT org_store_default_warehouse_fk FOREIGN KEY(country_id,entity_id,default_warehouse_id) REFERENCES org_warehouse(country_id,entity_id,id);

CREATE TABLE fin_book (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), entity_id jxc_safe_id,
  code varchar(32) NOT NULL CHECK (btrim(code) <> ''), name varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  base_currency varchar(3) NOT NULL DEFAULT '',
  status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','DISABLED')),
  start_period varchar(7) CHECK (start_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by jxc_safe_id REFERENCES sys_user(id), updated_by jxc_safe_id REFERENCES sys_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(country_id,entity_id,id), UNIQUE(country_id,code),
  FOREIGN KEY(country_id,entity_id) REFERENCES org_entity(country_id,id),
  CHECK (status <> 'ACTIVE' OR (entity_id IS NOT NULL AND base_currency ~ '^[A-Z]{3}$'))
);

CREATE TABLE fin_period (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), book_id jxc_safe_id NOT NULL,
  fiscal_year integer NOT NULL CHECK (fiscal_year BETWEEN 1900 AND 9999),
  period_no integer NOT NULL CHECK (period_no BETWEEN 1 AND 12),
  start_date date NOT NULL, end_date date NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED','OPEN','PENDING_CLOSE','CLOSED','REOPENING')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by jxc_safe_id REFERENCES sys_user(id), updated_by jxc_safe_id REFERENCES sys_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(country_id,book_id,id), UNIQUE(country_id,book_id,fiscal_year,period_no),
  FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),
  CHECK (start_date <= end_date),
  EXCLUDE USING gist (country_id WITH =, book_id WITH =, daterange(start_date,end_date,'[]') WITH &&)
);

CREATE TABLE md_fund_account (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), entity_id jxc_safe_id NOT NULL,
  store_id jxc_safe_id, book_id jxc_safe_id,
  name varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  account_type varchar(16) NOT NULL CHECK (account_type IN ('CASH','BANK','OTHER')),
  currency varchar(3) NOT NULL REFERENCES md_currency(code),
  bank_name varchar(200), account_no_encrypted text,
  -- fin_account arrives in M3; its composite FK must be added in that migration.
  gl_account_id jxc_safe_id,
  status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED','DISABLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by jxc_safe_id REFERENCES sys_user(id), updated_by jxc_safe_id REFERENCES sys_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id),
  FOREIGN KEY(country_id,entity_id) REFERENCES org_entity(country_id,id),
  FOREIGN KEY(country_id,entity_id,store_id) REFERENCES org_store(country_id,entity_id,id),
  FOREIGN KEY(country_id,entity_id,book_id) REFERENCES fin_book(country_id,entity_id,id),
  CHECK (gl_account_id IS NULL OR book_id IS NOT NULL)
);

CREATE TABLE sys_user_data_scope (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), user_id jxc_safe_id NOT NULL REFERENCES sys_user(id),
  scope_type varchar(16) NOT NULL CHECK (scope_type IN ('COUNTRY_ALL','ENTITY','STORE','WAREHOUSE','BOOK')),
  entity_id jxc_safe_id, store_id jxc_safe_id, warehouse_id jxc_safe_id, book_id jxc_safe_id,
  effective_from timestamptz NOT NULL DEFAULT clock_timestamp(), effective_to timestamptz,
  granted_by jxc_safe_id NOT NULL REFERENCES sys_user(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id),
  FOREIGN KEY(country_id,entity_id) REFERENCES org_entity(country_id,id),
  FOREIGN KEY(country_id,store_id) REFERENCES org_store(country_id,id),
  FOREIGN KEY(country_id,warehouse_id) REFERENCES org_warehouse(country_id,id),
  FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),
  CHECK (effective_to IS NULL OR effective_from < effective_to),
  CHECK (
    (scope_type='COUNTRY_ALL' AND num_nonnulls(entity_id,store_id,warehouse_id,book_id)=0) OR
    (scope_type='ENTITY' AND entity_id IS NOT NULL AND num_nonnulls(entity_id,store_id,warehouse_id,book_id)=1) OR
    (scope_type='STORE' AND store_id IS NOT NULL AND num_nonnulls(entity_id,store_id,warehouse_id,book_id)=1) OR
    (scope_type='WAREHOUSE' AND warehouse_id IS NOT NULL AND num_nonnulls(entity_id,store_id,warehouse_id,book_id)=1) OR
    (scope_type='BOOK' AND book_id IS NOT NULL AND num_nonnulls(entity_id,store_id,warehouse_id,book_id)=1)
  )
);
CREATE INDEX sys_user_data_scope_user_idx ON sys_user_data_scope(country_id,user_id,effective_from,effective_to);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['sys_role','sys_user_role','org_entity','org_store','org_warehouse','fin_book','fin_period','md_fund_account','sys_user_data_scope'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY country_isolation ON %I USING (country_id = jxc_current_country_id()) WITH CHECK (country_id = jxc_current_country_id())',table_name);
  END LOOP;
END
$$;
ALTER TABLE sys_authz_epoch ENABLE ROW LEVEL SECURITY;
ALTER TABLE sys_authz_epoch FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON sys_authz_epoch USING (country_id=0 OR country_id=jxc_current_country_id()) WITH CHECK (country_id=0 OR country_id=jxc_current_country_id());

GRANT USAGE ON SCHEMA public TO "${runtimeRole}";
GRANT USAGE, SELECT ON SEQUENCE jxc_id_seq TO "${runtimeRole}";
GRANT USAGE ON DOMAIN jxc_safe_id TO "${runtimeRole}";
GRANT SELECT, INSERT, UPDATE, DELETE ON md_currency,sys_country,sys_user,sys_session,sys_role,sys_user_role,org_entity,org_store,org_warehouse,fin_book,fin_period,md_fund_account,sys_user_data_scope TO "${runtimeRole}";
GRANT SELECT, INSERT, UPDATE ON sys_authz_epoch TO "${runtimeRole}";
