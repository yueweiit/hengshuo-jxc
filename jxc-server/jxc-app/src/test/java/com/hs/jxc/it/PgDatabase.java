package com.hs.jxc.it;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

public final class PgDatabase {
    public static final String PASSWORD = UUID.randomUUID().toString();
    public static final PostgreSQLContainer PG = new PostgreSQLContainer(DockerImageName.parse("postgres:16-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229").asCompatibleSubstituteFor("postgres"))
        .withDatabaseName("jxc_m01_test").withUsername("postgres").withPassword(PASSWORD);
    static {
        PG.start();
        var admin = ownerJdbc();
        admin.execute("CREATE ROLE jxc_owner LOGIN PASSWORD '" + PASSWORD + "' NOSUPERUSER NOBYPASSRLS");
        admin.execute("CREATE ROLE jxc_app LOGIN PASSWORD '" + PASSWORD + "' NOSUPERUSER NOBYPASSRLS");
        admin.execute("GRANT ALL ON SCHEMA public TO jxc_owner");
        admin.execute("GRANT CREATE ON DATABASE jxc_m01_test TO jxc_owner");
        admin.execute("GRANT USAGE ON SCHEMA public TO jxc_app");
    }
    private PgDatabase() {}
    public static JdbcTemplate ownerJdbc() { return template("postgres"); }
    public static JdbcTemplate runtimeJdbc() { return template("jxc_app"); }
    public static JdbcTemplate template(String username) {
        return new JdbcTemplate(new DriverManagerDataSource(PG.getJdbcUrl(), username, PASSWORD));
    }
    public static void reset() {
        var admin = ownerJdbc();
        // Operational state is not fixture business data. Reopen explicitly before truncating;
        // preserve its append-only transition history and singleton so the real gate stays active.
        if(admin.queryForObject("SELECT to_regclass('public.sys_write_control') IS NOT NULL",Boolean.class)) {
            long epoch=admin.queryForObject("SELECT epoch FROM sys_write_control",Long.class);
            admin.queryForObject("SELECT jxc_set_write_mode('OPEN',?,?::uuid,'test fixture','reset isolated business fixtures')::text",String.class,epoch,UUID.randomUUID().toString());
        }
        var tables = admin.queryForList("select tablename from pg_tables where schemaname='public' and tablename NOT IN ('flyway_schema_history','sys_write_control','sys_write_control_log') order by tablename", String.class);
        if (!tables.isEmpty()) admin.execute("TRUNCATE " + String.join(",", tables.stream().map(n -> "\"" + n + "\"").toList()) + " RESTART IDENTITY CASCADE");
        // The shared sequence is not OWNED BY any table, so TRUNCATE does not reset it.
        // Keep generated IDs separate from explicit fixture IDs, independent of class order.
        admin.execute("ALTER SEQUENCE jxc_id_seq RESTART WITH 1000000000");
        admin.update("insert into sys_authz_epoch(country_id,epoch) values (0,1)");
    }
}
