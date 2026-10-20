package com.hs.jxc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
@Component
@Order(0)
public class RuntimeRoleVerifier implements ApplicationRunner {
    private final JdbcTemplate jdbc;
    public RuntimeRoleVerifier(JdbcTemplate jdbc){this.jdbc=jdbc;}
    @Override public void run(ApplicationArguments args){verify(jdbc);}
    public void verify(JdbcTemplate connection){
        // Same catalog semantics as scripts/m5/recovery.py role_audit: exact pg_ prefix,
        // effective membership in administrative roles, and ownership of any application relation.
        Boolean unsafe=connection.queryForObject("SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)) OR has_database_privilege(current_user,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace n WHERE left(n.nspname,8)<>'pg_temp_' AND has_schema_privilege(current_user,n.oid,'CREATE')) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND pg_has_role(current_user,c.relowner,'MEMBER'))",Boolean.class);
        if(!Boolean.FALSE.equals(unsafe))throw new IllegalStateException("JXC runtime database role must not own tables, inherit an owner, bypass RLS, or have DDL administration privileges");
    }
}
