-- Technical exports reuse the original immutable outbox and consumer lease.
CREATE TABLE sys_export_job (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'), country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 book_id jxc_safe_id NOT NULL, requested_by jxc_safe_id NOT NULL REFERENCES sys_user(id), session_hash varchar(64) NOT NULL,
 job_type varchar(64) NOT NULL CHECK(job_type ~ '^[A-Z0-9_]{1,64}$'),
 params jsonb NOT NULL CHECK(jsonb_typeof(params)='object' AND jxc_json_ids_safe(params) AND octet_length(params::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days',
 UNIQUE(country_id,id),UNIQUE(country_id,book_id,id),FOREIGN KEY(country_id,book_id) REFERENCES fin_book(country_id,id)
);
CREATE TABLE sys_job_result (
 country_id jxc_safe_id NOT NULL, book_id jxc_safe_id NOT NULL, job_id jxc_safe_id PRIMARY KEY,
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(country_id,book_id,job_id) REFERENCES sys_export_job(country_id,book_id,id)
);
CREATE TABLE sys_notification (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL,
 user_id jxc_safe_id NOT NULL REFERENCES sys_user(id),job_id jxc_safe_id NOT NULL,
 title varchar(200) NOT NULL,content varchar(500) NOT NULL DEFAULT '',link varchar(200) NOT NULL DEFAULT '/jobs',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),read_at timestamptz,
 UNIQUE(country_id,id),UNIQUE(country_id,job_id,user_id),FOREIGN KEY(country_id,job_id) REFERENCES sys_export_job(country_id,id)
);
CREATE TRIGGER sys_export_job_immutable BEFORE UPDATE OR DELETE ON sys_export_job FOR EACH ROW EXECUTE FUNCTION jxc_ar_fact_immutable();
CREATE TRIGGER sys_job_result_immutable BEFORE UPDATE OR DELETE ON sys_job_result FOR EACH ROW EXECUTE FUNCTION jxc_ar_fact_immutable();
CREATE FUNCTION jxc_job_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sys_biz_event e JOIN sys_biz_event_consume c ON c.country_id=e.country_id AND c.event_id=e.id
   WHERE e.country_id=NEW.country_id AND e.book_id=NEW.book_id AND e.source_type='SYS_REPORT_EXPORT'
    AND e.event_type='SYS_REPORT_EXPORT_REQUESTED' AND e.source_id=NEW.job_id AND c.consumer='SYS_EXPORT' AND c.status='PROCESSING')
 THEN RAISE EXCEPTION 'JXC_JOB_CONSUMER_REQUIRED' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sys_job_result_guard BEFORE INSERT ON sys_job_result FOR EACH ROW EXECUTE FUNCTION jxc_job_result_guard();
CREATE OR REPLACE FUNCTION jxc_guard_biz_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.source_type='SYS_REPORT_EXPORT' OR NEW.event_type='SYS_REPORT_EXPORT_REQUESTED' THEN
   IF NEW.source_type<>'SYS_REPORT_EXPORT' OR NEW.event_type<>'SYS_REPORT_EXPORT_REQUESTED' OR NEW.event_seq<>1 OR
    NOT EXISTS(SELECT 1 FROM sys_export_job WHERE country_id=NEW.country_id AND book_id=NEW.book_id AND id=NEW.source_id)
   THEN RAISE EXCEPTION 'JXC_JOB_SOURCE_REQUIRED' USING ERRCODE='P0001'; END IF;
   PERFORM id FROM fin_book WHERE country_id=NEW.country_id AND id=NEW.book_id FOR SHARE;
  ELSE PERFORM jxc_assert_period_open(NEW.country_id,NEW.book_id,NEW.biz_date); END IF;
  RETURN NEW;
 ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001';
 ELSIF ROW(NEW.id,NEW.country_id,NEW.book_id,NEW.event_type,NEW.source_type,NEW.source_id,NEW.event_seq,NEW.payload,NEW.biz_date,NEW.occurred_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.book_id,OLD.event_type,OLD.source_type,OLD.source_id,OLD.event_seq,OLD.payload,OLD.biz_date,OLD.occurred_at)
 THEN RAISE EXCEPTION 'JXC_IMMUTABLE_FACT' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sys_export_job','sys_job_result','sys_notification'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY country_isolation ON %I USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id())',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON sys_export_job,sys_job_result,sys_notification TO "${runtimeRole}";
GRANT UPDATE(read_at) ON sys_notification TO "${runtimeRole}";
