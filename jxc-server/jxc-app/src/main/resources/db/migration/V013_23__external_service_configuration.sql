-- 系统级连接版本；密钥密文仅由服务端读取，历史不可变供未结束任务继续使用。
CREATE TABLE sys_external_service_revision (
 version integer PRIMARY KEY CHECK(version>0),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),
 created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER external_service_revision_append_only BEFORE UPDATE OR DELETE ON sys_external_service_revision
 FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON sys_external_service_revision
 FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open();
CREATE TABLE sys_external_service_probe (
 version integer NOT NULL CHECK(version>=0),service text NOT NULL CHECK(service IN ('n8n','deepseek','docling')),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),PRIMARY KEY(version,service)
);
CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON sys_external_service_probe
 FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open();
GRANT SELECT,INSERT ON sys_external_service_revision TO "${runtimeRole}";
GRANT SELECT,INSERT,UPDATE ON sys_external_service_probe TO "${runtimeRole}";
ALTER TABLE pur_order_import_task ADD COLUMN service_config_version integer CHECK(service_config_version>=0);
ALTER TABLE pur_order_import_task ADD COLUMN integration_model_calls integer NOT NULL DEFAULT 0 CHECK(integration_model_calls BETWEEN 0 AND 2);
COMMENT ON COLUMN pur_order_import_task.service_config_version IS '领取时绑定外部服务配置版本；0为原启动配置；自动恢复保留，人工重试重新绑定';
