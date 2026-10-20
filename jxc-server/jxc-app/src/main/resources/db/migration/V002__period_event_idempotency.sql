-- Volatile is intentional: after waiting for the book gate, the period SELECT
-- must see a closing transaction's newly committed status at READ COMMITTED.
CREATE FUNCTION jxc_assert_period_open(p_country_id bigint,p_book_id bigint,p_biz_date date)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE book_status text; period_status text;
BEGIN
  SELECT status INTO book_status FROM fin_book WHERE country_id=p_country_id AND id=p_book_id FOR SHARE;
  IF NOT FOUND OR book_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'FIN_BOOK_NOT_ACTIVE' USING ERRCODE='P0001';
  END IF;
  SELECT status INTO period_status FROM fin_period
    WHERE country_id=p_country_id AND book_id=p_book_id AND p_biz_date BETWEEN start_date AND end_date;
  IF NOT FOUND THEN RAISE EXCEPTION 'FIN_PERIOD_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF period_status <> 'OPEN' THEN RAISE EXCEPTION 'FIN_PERIOD_CLOSED' USING ERRCODE='P0001'; END IF;
END
$$;

CREATE TABLE sys_idempotency (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), user_id jxc_safe_id NOT NULL REFERENCES sys_user(id),
  key varchar(128) NOT NULL CHECK (btrim(key) <> ''),
  method varchar(8) NOT NULL CHECK (method IN ('POST','PUT','PATCH','DELETE')),
  endpoint varchar(500) NOT NULL CHECK (btrim(endpoint) <> ''),
  request_hash varchar(64) NOT NULL CHECK (btrim(request_hash) <> ''),
  response jsonb CHECK (jxc_json_ids_safe(response)),
  resource_refs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(resource_refs)='array' AND jxc_json_ids_safe(resource_refs)),
  book_id jxc_safe_id,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(country_id,user_id,key),
  FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id)
);

-- A placeholder can exist only inside its command transaction. Read the final
-- row at commit, so INSERT(null) followed by UPDATE(response) is valid.
CREATE FUNCTION jxc_idempotency_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final_response jsonb;
BEGIN
  SELECT response INTO final_response FROM sys_idempotency WHERE country_id=NEW.country_id AND id=NEW.id;
  IF FOUND AND final_response IS NULL THEN
    RAISE EXCEPTION 'SYS_IDEMPOTENCY_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER sys_idempotency_complete
  AFTER INSERT OR UPDATE ON sys_idempotency DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jxc_idempotency_complete();

CREATE TABLE sys_biz_event (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), book_id jxc_safe_id NOT NULL,
  event_type varchar(64) NOT NULL CHECK (btrim(event_type) <> ''),
  source_type varchar(64) NOT NULL CHECK (btrim(source_type) <> ''), source_id jxc_safe_id NOT NULL,
  event_seq integer NOT NULL DEFAULT 1 CHECK (event_seq > 0),
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload)='object' AND jxc_json_ids_safe(payload)),
  biz_date date NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','FAILED')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0), last_error text, next_retry_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE(country_id,id), UNIQUE(country_id,book_id,id),
  UNIQUE(country_id,event_type,source_type,source_id,event_seq),
  FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id)
);
CREATE INDEX sys_biz_event_retry_idx ON sys_biz_event(country_id,status,next_retry_at,id) WHERE status <> 'DONE';

CREATE FUNCTION jxc_guard_biz_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.biz_date);
    RETURN NEW;
  ELSIF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001';
  ELSIF ROW(NEW.id,NEW.country_id,NEW.book_id,NEW.event_type,NEW.source_type,NEW.source_id,NEW.event_seq,NEW.payload,NEW.biz_date,NEW.occurred_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.book_id,OLD.event_type,OLD.source_type,OLD.source_id,OLD.event_seq,OLD.payload,OLD.biz_date,OLD.occurred_at) THEN
    PERFORM jxc_assert_period_open(OLD.country_id,OLD.book_id,OLD.biz_date);
    RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001';
  END IF;
  -- Retry diagnostics do not rewrite the historical business fact.
  RETURN NEW;
END
$$;
CREATE TRIGGER sys_biz_event_guard BEFORE INSERT OR UPDATE OR DELETE ON sys_biz_event FOR EACH ROW EXECUTE FUNCTION jxc_guard_biz_event();

CREATE TABLE sys_biz_event_consume (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), book_id jxc_safe_id NOT NULL, event_id jxc_safe_id NOT NULL,
  consumer varchar(100) NOT NULL CHECK (btrim(consumer) <> ''),
  status varchar(16) NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING','DONE','FAILED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0), last_error text, processed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(event_id,consumer),
  FOREIGN KEY(country_id,book_id,event_id) REFERENCES sys_biz_event(country_id,book_id,id)
);

CREATE TABLE sys_audit_log (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), user_id jxc_safe_id NOT NULL REFERENCES sys_user(id),
  action varchar(100) NOT NULL CHECK (btrim(action) <> ''),
  resource_type varchar(64) NOT NULL CHECK (btrim(resource_type) <> ''), resource_id jxc_safe_id,
  before_value jsonb CHECK (jxc_json_ids_safe(before_value)), after_value jsonb CHECK (jxc_json_ids_safe(after_value)),
  ip varchar(64), user_agent varchar(500), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), reason varchar(1000),
  UNIQUE(country_id,id)
);
CREATE INDEX sys_audit_log_resource_idx ON sys_audit_log(country_id,resource_type,resource_id,occurred_at);
CREATE FUNCTION jxc_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'JXC_APPEND_ONLY' USING ERRCODE='P0001'; END
$$;
CREATE TRIGGER sys_audit_log_append_only BEFORE UPDATE OR DELETE ON sys_audit_log FOR EACH ROW EXECUTE FUNCTION jxc_append_only();

CREATE TABLE sys_attachment (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
  category varchar(64) NOT NULL CHECK (btrim(category) <> ''), file_name varchar(255) NOT NULL CHECK (btrim(file_name) <> ''),
  content_type varchar(128) NOT NULL, size bigint NOT NULL CHECK (size > 0),
  storage_key varchar(500) NOT NULL UNIQUE CHECK (btrim(storage_key) <> ''), sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_status varchar(16) NOT NULL DEFAULT 'AVAILABLE' CHECK (object_status IN ('AVAILABLE','MISSING','QUARANTINED','DELETED')),
  status varchar(16) NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID','DELETED')),
  uploaded_by jxc_safe_id NOT NULL REFERENCES sys_user(id), uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), UNIQUE(country_id,id)
);

CREATE TABLE sys_attachment_link (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
  country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), attachment_id jxc_safe_id NOT NULL,
  biz_type varchar(64) NOT NULL CHECK (btrim(biz_type) <> ''), biz_id jxc_safe_id NOT NULL,
  version_no integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
  linked_by jxc_safe_id NOT NULL REFERENCES sys_user(id), linked_at timestamptz NOT NULL DEFAULT clock_timestamp(), unlinked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE(country_id,id), UNIQUE(country_id,attachment_id,biz_type,biz_id,version_no),
  FOREIGN KEY(country_id,attachment_id) REFERENCES sys_attachment(country_id,id),
  CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at)
);
CREATE UNIQUE INDEX sys_attachment_link_active_uq ON sys_attachment_link(country_id,attachment_id,biz_type,biz_id) WHERE unlinked_at IS NULL;
CREATE INDEX sys_attachment_link_biz_idx ON sys_attachment_link(country_id,biz_type,biz_id) WHERE unlinked_at IS NULL;

CREATE FUNCTION jxc_attachment_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'JXC_IMMUTABLE_ATTACHMENT' USING ERRCODE='P0001'; END IF;
  IF TG_TABLE_NAME='sys_attachment' THEN
    IF (to_jsonb(NEW)-ARRAY['status','object_status','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','object_status','version']) THEN
      RAISE EXCEPTION 'JXC_IMMUTABLE_ATTACHMENT' USING ERRCODE='P0001';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['unlinked_at','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['unlinked_at','version'])
       OR (OLD.unlinked_at IS NOT NULL AND NEW.unlinked_at IS DISTINCT FROM OLD.unlinked_at) THEN
      RAISE EXCEPTION 'JXC_IMMUTABLE_ATTACHMENT_LINK' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sys_attachment_identity_immutable BEFORE UPDATE OR DELETE ON sys_attachment FOR EACH ROW EXECUTE FUNCTION jxc_attachment_identity_immutable();
CREATE TRIGGER sys_attachment_link_identity_immutable BEFORE UPDATE OR DELETE ON sys_attachment_link FOR EACH ROW EXECUTE FUNCTION jxc_attachment_identity_immutable();

-- Minimal governed workflow prerequisites. No approvers or effective rules are seeded.
CREATE TABLE wf_rule (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'), country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
  rule_key varchar(64) NOT NULL CHECK (btrim(rule_key)<>''),
  doc_type varchar(64) NOT NULL, name varchar(100) NOT NULL, priority integer NOT NULL DEFAULT 100,
  conditions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(conditions)='array' AND jxc_json_ids_safe(conditions)),
  nodes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(nodes)='array' AND jxc_json_ids_safe(nodes)),
  version_no integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
  status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','RETIRED','DISABLED')),
  effective_from timestamptz NOT NULL DEFAULT clock_timestamp(), effective_to timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by jxc_safe_id REFERENCES sys_user(id), updated_by jxc_safe_id REFERENCES sys_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(country_id,id,version_no), UNIQUE(country_id,rule_key,version_no),
  CHECK (effective_to IS NULL OR effective_from < effective_to)
);

CREATE TABLE wf_doc_type_config (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'), country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
  doc_type varchar(64) NOT NULL CHECK (btrim(doc_type)<>''), approval_required boolean NOT NULL DEFAULT true,
  key_fields jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(key_fields)='array'),
  version integer NOT NULL DEFAULT 1 CHECK (version>0), UNIQUE(country_id,id), UNIQUE(country_id,doc_type)
);

CREATE TABLE wf_instance (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'), country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
  doc_type varchar(64) NOT NULL, doc_id jxc_safe_id NOT NULL, doc_version integer NOT NULL DEFAULT 1 CHECK (doc_version > 0),
  rule_id jxc_safe_id, rule_version_no integer NOT NULL DEFAULT 0 CHECK (rule_version_no >= 0),
  key_fields_hash varchar(64), key_fields_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(key_fields_snapshot)='object' AND jxc_json_ids_safe(key_fields_snapshot)),
  approval_required boolean NOT NULL DEFAULT true,
  status varchar(16) NOT NULL DEFAULT 'BLOCKED' CHECK (status IN ('BLOCKED','PENDING','APPROVED','REJECTED','WITHDRAWN','INVALIDATED')),
  submitted_by jxc_safe_id NOT NULL REFERENCES sys_user(id), submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz, blocked_reason varchar(1000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE(country_id,id),
  FOREIGN KEY(country_id,rule_id,rule_version_no) REFERENCES wf_rule(country_id,id,version_no),
  CHECK ((rule_id IS NULL AND rule_version_no=0) OR (rule_id IS NOT NULL AND rule_version_no>0)),
  CHECK (status <> 'PENDING' OR rule_id IS NOT NULL),
  CHECK (NOT (approval_required AND status='APPROVED') OR rule_id IS NOT NULL)
);
CREATE INDEX wf_instance_doc_idx ON wf_instance(country_id,doc_type,doc_id);

CREATE TABLE wf_task (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'), country_id jxc_safe_id NOT NULL REFERENCES sys_country(id), instance_id jxc_safe_id NOT NULL,
  node_seq integer NOT NULL CHECK (node_seq > 0), node_name varchar(100) NOT NULL,
  assignee_id jxc_safe_id NOT NULL REFERENCES sys_user(id), delegate_from_id jxc_safe_id REFERENCES sys_user(id),
  status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SKIPPED')),
  comment varchar(1000), acted_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(country_id,id), UNIQUE(country_id,instance_id,node_seq,assignee_id),
  FOREIGN KEY(country_id,instance_id) REFERENCES wf_instance(country_id,id)
);

CREATE TABLE sys_todo (
  id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'), country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
  todo_type varchar(64) NOT NULL, dedup_key varchar(200) NOT NULL, title varchar(500) NOT NULL,
  link varchar(500) NOT NULL DEFAULT '', perm varchar(100), assignee_id jxc_safe_id REFERENCES sys_user(id),
  status varchar(16) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), UNIQUE(country_id,id), UNIQUE(country_id,dedup_key)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['sys_idempotency','sys_biz_event','sys_biz_event_consume','sys_audit_log','sys_attachment','sys_attachment_link','wf_rule','wf_doc_type_config','wf_instance','wf_task','sys_todo'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY country_isolation ON %I USING (country_id = jxc_current_country_id()) WITH CHECK (country_id = jxc_current_country_id())',table_name);
  END LOOP;
END
$$;

GRANT SELECT, INSERT ON sys_idempotency,sys_biz_event,sys_biz_event_consume,sys_audit_log,sys_attachment,sys_attachment_link TO "${runtimeRole}";
GRANT UPDATE(response,resource_refs) ON sys_idempotency TO "${runtimeRole}";
GRANT UPDATE(status,retry_count,last_error,next_retry_at,version) ON sys_biz_event TO "${runtimeRole}";
GRANT UPDATE(status,attempt_count,last_error,processed_at,updated_at,version) ON sys_biz_event_consume TO "${runtimeRole}";
GRANT UPDATE(status,object_status,version) ON sys_attachment TO "${runtimeRole}";
GRANT UPDATE(unlinked_at,version) ON sys_attachment_link TO "${runtimeRole}";
GRANT SELECT, INSERT, UPDATE, DELETE ON wf_rule,wf_doc_type_config,wf_instance,wf_task,sys_todo TO "${runtimeRole}";
