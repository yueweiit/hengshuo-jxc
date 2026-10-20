CREATE TABLE sys_worker_runtime (
 country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),kind varchar(64) NOT NULL,status varchar(16) NOT NULL CHECK(status IN ('RUNNING','SUCCESS','FAILED')),
 last_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_completed_at timestamptz,last_failure_at timestamptz,last_error varchar(64),last_daily_date date,recovered_count integer NOT NULL DEFAULT 0,attempt_count integer NOT NULL DEFAULT 1,
 PRIMARY KEY(country_id,kind)
);
ALTER TABLE sys_worker_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE sys_worker_runtime FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON sys_worker_runtime USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON sys_worker_runtime FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open();
GRANT SELECT,INSERT,UPDATE ON sys_worker_runtime TO "${runtimeRole}";
