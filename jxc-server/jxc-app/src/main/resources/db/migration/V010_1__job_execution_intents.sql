-- Renew execution authority without mutating the original immutable export request.
CREATE TABLE sys_job_execution_intent (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
 book_id jxc_safe_id NOT NULL,job_id jxc_safe_id NOT NULL,requested_by jxc_safe_id NOT NULL REFERENCES sys_user(id),session_hash varchar(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(country_id,id),
 FOREIGN KEY(country_id,book_id,job_id) REFERENCES sys_export_job(country_id,book_id,id)
);
ALTER TABLE sys_job_execution_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE sys_job_execution_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON sys_job_execution_intent USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON sys_job_execution_intent FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open();
CREATE TRIGGER sys_job_execution_intent_immutable BEFORE UPDATE OR DELETE ON sys_job_execution_intent FOR EACH ROW EXECUTE FUNCTION jxc_ar_fact_immutable();
CREATE FUNCTION jxc_job_execution_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sys_export_job j JOIN sys_session s ON s.user_id=j.requested_by WHERE j.country_id=NEW.country_id AND j.book_id=NEW.book_id AND j.id=NEW.job_id AND j.requested_by=NEW.requested_by AND j.expires_at>clock_timestamp() AND s.token_hash=NEW.session_hash AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'SYS_JOB_OWNER_SESSION_REQUIRED' USING ERRCODE='23514'; END IF;RETURN NEW;END $$;
CREATE TRIGGER sys_job_execution_intent_owner BEFORE INSERT ON sys_job_execution_intent FOR EACH ROW EXECUTE FUNCTION jxc_job_execution_owner();
GRANT SELECT,INSERT ON sys_job_execution_intent TO "${runtimeRole}";
