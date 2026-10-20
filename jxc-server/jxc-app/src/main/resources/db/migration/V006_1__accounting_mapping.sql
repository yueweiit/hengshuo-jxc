-- Versioned accounting interpretation. No default policy or automatic activation is seeded.
CREATE TABLE fin_mapping_template (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'), country_id jxc_safe_id NOT NULL,
 book_id jxc_safe_id NOT NULL,event_type varchar(64) NOT NULL CHECK(event_type ~ '^[A-Z0-9_]{1,64}$'),
 version_no integer NOT NULL CHECK(version_no>0),status varchar(16) NOT NULL DEFAULT 'NEED_REVIEW' CHECK(status IN('NEED_REVIEW','ACTIVE','RETIRED')),
 accounting_mode varchar(16) NOT NULL DEFAULT 'VOUCHER' CHECK(accounting_mode IN('VOUCHER','NO_VOUCHER')),
 no_voucher_reason varchar(1000),source_template_item_id jxc_safe_id,
 reviewed_by jxc_safe_id REFERENCES sys_user(id),reviewed_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,book_id,id,version_no),UNIQUE(country_id,book_id,event_type,version_no),
 FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),
 CHECK(status<>'ACTIVE' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
 CHECK(accounting_mode<>'NO_VOUCHER' OR length(btrim(no_voucher_reason))>0)
);
CREATE UNIQUE INDEX fin_mapping_active ON fin_mapping_template(country_id,book_id,event_type) WHERE status='ACTIVE';
CREATE TABLE fin_mapping_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,template_id jxc_safe_id NOT NULL,
 seq integer NOT NULL CHECK(seq>0),direction varchar(6) NOT NULL CHECK(direction IN('DEBIT','CREDIT')),
 account_rule jsonb NOT NULL CHECK(jsonb_typeof(account_rule)='object' AND jxc_json_ids_safe(account_rule)),
 amount_expr varchar(100) NOT NULL CHECK(amount_expr ~ '^[A-Za-z][A-Za-z0-9_]{0,99}$'),
 aux_mapping jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(aux_mapping)='object' AND jxc_json_ids_safe(aux_mapping)),
 summary_tpl varchar(500) NOT NULL DEFAULT '',cashflow_item_id jxc_safe_id,
 FOREIGN KEY(country_id,book_id,template_id) REFERENCES fin_mapping_template(country_id,book_id,id),
 FOREIGN KEY(country_id,book_id,cashflow_item_id) REFERENCES fin_cashflow_item(country_id,book_id,id),
 UNIQUE(country_id,id),UNIQUE(template_id,seq)
);
CREATE TABLE fin_event_result (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,
 event_id jxc_safe_id NOT NULL UNIQUE,source_event_version integer NOT NULL CHECK(source_event_version>0),
 mapping_template_id jxc_safe_id NOT NULL,mapping_version integer NOT NULL CHECK(mapping_version>0),
 status varchar(16) NOT NULL CHECK(status IN('GENERATED','NO_VOUCHER')),voucher_id jxc_safe_id,
 reason varchar(1000),fact_hash varchar(64) NOT NULL CHECK(fact_hash ~ '^[a-f0-9]{64}$'),
 prepared_by jxc_safe_id NOT NULL REFERENCES sys_user(id),processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(country_id,book_id,event_id) REFERENCES sys_biz_event(country_id,book_id,id),
 FOREIGN KEY(country_id,book_id,mapping_template_id,mapping_version) REFERENCES fin_mapping_template(country_id,book_id,id,version_no),
 FOREIGN KEY(country_id,book_id,voucher_id) REFERENCES fin_voucher(country_id,book_id,id),
 UNIQUE(country_id,id),CHECK((status='GENERATED' AND voucher_id IS NOT NULL) OR (status='NO_VOUCHER' AND voucher_id IS NULL AND length(btrim(reason))>0))
);
COMMENT ON COLUMN fin_event_result.source_event_version IS 'Immutable business event_seq; never the mutable outbox retry diagnostic version';
ALTER TABLE fin_voucher ADD CONSTRAINT fin_voucher_mapping_fk FOREIGN KEY(country_id,book_id,mapping_template_id,mapping_version) REFERENCES fin_mapping_template(country_id,book_id,id,version_no);
CREATE FUNCTION jxc_guard_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF OLD.status<>'NEED_REVIEW' AND (TG_OP='DELETE' OR ROW(NEW.book_id,NEW.event_type,NEW.version_no,NEW.accounting_mode,NEW.no_voucher_reason,NEW.source_template_item_id,NEW.reviewed_by,NEW.reviewed_at) IS DISTINCT FROM ROW(OLD.book_id,OLD.event_type,OLD.version_no,OLD.accounting_mode,OLD.no_voucher_reason,OLD.source_template_item_id,OLD.reviewed_by,OLD.reviewed_at)) THEN RAISE EXCEPTION 'JXC_REVIEWED_MAPPING_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF OLD.status='ACTIVE' AND NEW.status NOT IN('ACTIVE','RETIRED') OR OLD.status='RETIRED' AND NEW.status<>'RETIRED' THEN RAISE EXCEPTION 'JXC_REVIEWED_MAPPING_IMMUTABLE'; END IF;
 IF ROW(NEW.id,NEW.country_id,NEW.book_id,NEW.event_type,NEW.version_no,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.book_id,OLD.event_type,OLD.version_no,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'JXC_MAPPING_IDENTITY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fin_mapping_guard BEFORE UPDATE OR DELETE ON fin_mapping_template FOR EACH ROW EXECUTE FUNCTION jxc_guard_mapping();
CREATE FUNCTION jxc_guard_mapping_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
 IF TG_OP<>'INSERT' THEN
  SELECT status INTO parent_status FROM fin_mapping_template WHERE country_id=OLD.country_id AND id=OLD.template_id;
  IF parent_status IS DISTINCT FROM 'NEED_REVIEW' THEN RAISE EXCEPTION 'JXC_REVIEWED_MAPPING_IMMUTABLE'; END IF;
 END IF;
 IF TG_OP<>'DELETE' THEN
  SELECT status INTO parent_status FROM fin_mapping_template WHERE country_id=NEW.country_id AND id=NEW.template_id;
  IF parent_status IS DISTINCT FROM 'NEED_REVIEW' THEN RAISE EXCEPTION 'JXC_REVIEWED_MAPPING_IMMUTABLE'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER fin_mapping_line_guard BEFORE INSERT OR UPDATE OR DELETE ON fin_mapping_line FOR EACH ROW EXECUTE FUNCTION jxc_guard_mapping_line();
CREATE FUNCTION jxc_guard_fin_event_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy fin_mapping_template; evt sys_biz_event; voucher fin_voucher;
BEGIN
 SELECT * INTO policy FROM fin_mapping_template WHERE country_id=NEW.country_id AND id=NEW.mapping_template_id;
 SELECT * INTO evt FROM sys_biz_event WHERE country_id=NEW.country_id AND id=NEW.event_id;
 IF policy.status IS DISTINCT FROM 'ACTIVE' OR policy.event_type IS DISTINCT FROM evt.event_type OR NEW.source_event_version<>evt.event_seq THEN RAISE EXCEPTION 'FIN_EVENT_INTERPRETATION_INVALID'; END IF;
 IF NEW.status='NO_VOUCHER' AND policy.accounting_mode<>'NO_VOUCHER' OR NEW.status='GENERATED' AND policy.accounting_mode<>'VOUCHER' THEN RAISE EXCEPTION 'FIN_EVENT_INTERPRETATION_INVALID'; END IF;
 IF NEW.voucher_id IS NOT NULL THEN
  SELECT * INTO voucher FROM fin_voucher WHERE country_id=NEW.country_id AND id=NEW.voucher_id;
  IF voucher.source_event_id IS DISTINCT FROM NEW.event_id OR voucher.mapping_template_id IS DISTINCT FROM NEW.mapping_template_id OR voucher.mapping_version IS DISTINCT FROM NEW.mapping_version THEN RAISE EXCEPTION 'FIN_EVENT_INTERPRETATION_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fin_event_result_guard BEFORE INSERT ON fin_event_result FOR EACH ROW EXECUTE FUNCTION jxc_guard_fin_event_result();
CREATE TRIGGER fin_event_result_append_only BEFORE UPDATE OR DELETE ON fin_event_result FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['fin_mapping_template','fin_mapping_line','fin_event_result'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO "${runtimeRole}"',t);
 END LOOP;
END $$;
REVOKE UPDATE,DELETE ON fin_event_result FROM "${runtimeRole}";
