-- Explicitly maintained report rules. No account, opening balance or active template is seeded.
CREATE TABLE fin_report_template (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,
 report_type varchar(16) NOT NULL CHECK(report_type IN('BALANCE_SHEET','INCOME')),name varchar(200) NOT NULL CHECK(length(btrim(name))>0),
 rule_code varchar(32) NOT NULL CHECK(rule_code IN('CATEGORY_V1','ACCOUNT_MAP_V1')),version_no integer NOT NULL CHECK(version_no>0),
 status varchar(16) NOT NULL DEFAULT 'NEED_REVIEW' CHECK(status IN('NEED_REVIEW','ACTIVE','RETIRED')),
 reviewed_by jxc_safe_id REFERENCES sys_user(id),reviewed_at timestamptz,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,book_id,report_type,version_no),
 FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id),CHECK(status<>'ACTIVE' OR reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
);
CREATE UNIQUE INDEX fin_report_active ON fin_report_template(country_id,book_id,report_type) WHERE status='ACTIVE';
CREATE TABLE fin_report_template_line (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,template_id jxc_safe_id NOT NULL,
 seq integer NOT NULL CHECK(seq>0),code varchar(64) NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{0,63}$'),name varchar(200) NOT NULL CHECK(length(btrim(name))>0),
 formula varchar(16) NOT NULL CHECK(formula IN('CLOSING_NET','PERIOD_NET','LINE_SUM')),
 category varchar(16) CHECK(category IN('ASSET','LIABILITY','EQUITY','COST','EXPENSE','INCOME','PROFIT_LOSS')),
 sign smallint NOT NULL DEFAULT 1 CHECK(sign IN(-1,1)),terms jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(terms)='array'),
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),UNIQUE(country_id,book_id,template_id,id),UNIQUE(template_id,seq),UNIQUE(template_id,code),
 FOREIGN KEY(country_id,book_id,template_id) REFERENCES fin_report_template(country_id,book_id,id)
);
CREATE TABLE fin_report_line_account (
 country_id jxc_safe_id NOT NULL,book_id jxc_safe_id NOT NULL,line_id jxc_safe_id NOT NULL,account_id jxc_safe_id NOT NULL,
 PRIMARY KEY(country_id,book_id,line_id,account_id),
 FOREIGN KEY(country_id,book_id,line_id) REFERENCES fin_report_template_line(country_id,book_id,id),
 FOREIGN KEY(country_id,book_id,account_id) REFERENCES fin_account(country_id,book_id,id)
);
CREATE FUNCTION jxc_guard_report_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status<>'NEED_REVIEW' THEN RAISE EXCEPTION 'JXC_REVIEWED_REPORT_IMMUTABLE';END IF;RETURN OLD;
 END IF;
 IF ROW(NEW.id,NEW.country_id,NEW.book_id,NEW.report_type,NEW.version_no,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.book_id,OLD.report_type,OLD.version_no,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'JXC_REPORT_IDENTITY_IMMUTABLE';END IF;
 IF OLD.status<>'NEED_REVIEW' AND (to_jsonb(NEW)-ARRAY['status','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version']) THEN RAISE EXCEPTION 'JXC_REVIEWED_REPORT_IMMUTABLE';END IF;
 IF OLD.status='ACTIVE' AND NEW.status NOT IN('ACTIVE','RETIRED') OR OLD.status='RETIRED' AND NEW.status<>'RETIRED' THEN RAISE EXCEPTION 'JXC_REVIEWED_REPORT_IMMUTABLE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fin_report_template_guard BEFORE UPDATE OR DELETE ON fin_report_template FOR EACH ROW EXECUTE FUNCTION jxc_guard_report_template();
CREATE FUNCTION jxc_guard_report_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
 IF TG_TABLE_NAME='fin_report_template_line' THEN
  IF TG_OP<>'INSERT' THEN SELECT status INTO parent_status FROM fin_report_template WHERE country_id=OLD.country_id AND book_id=OLD.book_id AND id=OLD.template_id;IF parent_status IS DISTINCT FROM 'NEED_REVIEW' THEN RAISE EXCEPTION 'JXC_REVIEWED_REPORT_IMMUTABLE';END IF;END IF;
  IF TG_OP<>'DELETE' THEN SELECT status INTO parent_status FROM fin_report_template WHERE country_id=NEW.country_id AND book_id=NEW.book_id AND id=NEW.template_id;IF parent_status IS DISTINCT FROM 'NEED_REVIEW' THEN RAISE EXCEPTION 'JXC_REVIEWED_REPORT_IMMUTABLE';END IF;END IF;
 ELSE
  IF TG_OP<>'INSERT' THEN SELECT t.status INTO parent_status FROM fin_report_template t JOIN fin_report_template_line l ON l.country_id=t.country_id AND l.book_id=t.book_id AND l.template_id=t.id WHERE l.country_id=OLD.country_id AND l.book_id=OLD.book_id AND l.id=OLD.line_id;IF parent_status IS DISTINCT FROM 'NEED_REVIEW' THEN RAISE EXCEPTION 'JXC_REVIEWED_REPORT_IMMUTABLE';END IF;END IF;
  IF TG_OP<>'DELETE' THEN SELECT t.status INTO parent_status FROM fin_report_template t JOIN fin_report_template_line l ON l.country_id=t.country_id AND l.book_id=t.book_id AND l.template_id=t.id WHERE l.country_id=NEW.country_id AND l.book_id=NEW.book_id AND l.id=NEW.line_id;IF parent_status IS DISTINCT FROM 'NEED_REVIEW' THEN RAISE EXCEPTION 'JXC_REVIEWED_REPORT_IMMUTABLE';END IF;END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER fin_report_line_guard BEFORE INSERT OR UPDATE OR DELETE ON fin_report_template_line FOR EACH ROW EXECUTE FUNCTION jxc_guard_report_line();
CREATE TRIGGER fin_report_line_account_guard BEFORE INSERT OR UPDATE OR DELETE ON fin_report_line_account FOR EACH ROW EXECUTE FUNCTION jxc_guard_report_line();
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['fin_report_template','fin_report_template_line','fin_report_line_account'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO "${runtimeRole}"',t);
 END LOOP;
END $$;
