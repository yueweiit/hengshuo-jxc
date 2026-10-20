CREATE TABLE md_dict (
 id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
 country_id jxc_safe_id REFERENCES sys_country(id),
 dict_type varchar(64) NOT NULL CHECK(dict_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 code varchar(64) NOT NULL CHECK(length(btrim(code))>0),
 label_i18n jsonb NOT NULL CHECK(jsonb_typeof(label_i18n)='object'),
 seq integer NOT NULL DEFAULT 1 CHECK(seq>=0),
 status varchar(16) NOT NULL DEFAULT 'ENABLED' CHECK(status IN('ENABLED','DISABLED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE NULLS NOT DISTINCT(country_id,dict_type,code)
);
ALTER TABLE md_dict ENABLE ROW LEVEL SECURITY;
ALTER TABLE md_dict FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON md_dict USING(country_id IS NULL OR country_id=jxc_current_country_id()) WITH CHECK(country_id IS NULL OR country_id=jxc_current_country_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON md_dict TO "${runtimeRole}";
CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON md_dict FOR EACH STATEMENT EXECUTE FUNCTION public.jxc_assert_writes_open();
