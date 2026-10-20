CREATE TABLE ap_recognition_rule (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),source_kind varchar(16) NOT NULL CHECK(source_kind IN ('PURCHASE','LOGISTICS','OTHER')),
 mode varchar(32) NOT NULL DEFAULT 'BILL_CONFIRMED' CHECK(mode IN ('BILL_CONFIRMED','MANUAL','RECEIPT_CONFIRMED')),
 execution_subject_user_id jxc_safe_id REFERENCES sys_user(id),configured_by jxc_safe_id NOT NULL REFERENCES sys_user(id),version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(country_id,id),UNIQUE(country_id,source_kind),CHECK(mode<>'RECEIPT_CONFIRMED' OR execution_subject_user_id IS NOT NULL)
);
ALTER TABLE ap_recognition_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_recognition_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON ap_recognition_rule USING(country_id=jxc_current_country_id()) WITH CHECK(country_id=jxc_current_country_id());
CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ap_recognition_rule FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open();
GRANT SELECT,INSERT,UPDATE ON ap_recognition_rule TO "${runtimeRole}";
