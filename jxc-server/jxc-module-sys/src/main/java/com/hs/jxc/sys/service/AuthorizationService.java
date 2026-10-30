package com.hs.jxc.sys.service;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbContext;
import com.hs.jxc.sys.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.*;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

@Service
public class AuthorizationService {
    private static final Object HELD_GATES=new Object();
    private final JdbcTemplate jdbc;
    private final DbContext db;
    private final JsonCodec json;
    public AuthorizationService(JdbcTemplate jdbc,DbContext db,JsonCodec json) {this.jdbc=jdbc;this.db=db;this.json=json;}
    public Access authorize(RequestContext ctx) { return decision(ctx,false,false,false); }
    public Access authorizePolicyWrite(RequestContext ctx,boolean global) { return decision(ctx,true,global,false); }
    /** Atomic multi-owner configuration/import commands acquire both gates at entry, never upgrade a reader. */
    public Access authorizeCoordinatedWrite(RequestContext ctx){return decision(ctx,true,true,false,true);}
    /** Current authority for a configured approver, including users who are not logged in. No new identity is established. */
    public Access accessForSubject(Access actor,long userId) {
        long country=actor.requireCountry();
        if(!heldGates().containsKey(0L)||!heldGates().containsKey(country))throw new IllegalStateException("Subject lookup requires the caller's authorization gates");
        return decision(new RequestContext(userId,country,"approval-subject",null),false,false,true);
    }
    private Access decision(RequestContext ctx,boolean write,boolean global,boolean subject){return decision(ctx,write,global,subject,false);}
    private Access decision(RequestContext ctx,boolean write,boolean global,boolean subject,boolean coordinated) {
        if(!TransactionSynchronizationManager.isActualTransactionActive()) throw new IllegalStateException("Authorization requires an existing transaction");
        // No authority SQL may precede these gates. Never upgrade an already shared gate.
        db.apply(null);
        gate(0,write&&global);
        if(ctx.countryId()!=null) {db.apply(ctx.countryId());gate(ctx.countryId(),write&&(!global||coordinated));}
        var identities=subject?jdbc.queryForList("SELECT id,status,is_platform_admin,clock_timestamp()+interval '100 years' expires_at FROM sys_user WHERE id=?",ctx.userId()):jdbc.queryForList("SELECT u.id,u.status,u.is_platform_admin,s.expires_at FROM sys_user u JOIN sys_session s ON s.user_id=u.id WHERE u.id=? AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()",ctx.userId(),ctx.tokenHash());
        if(identities.isEmpty())throw new ApiException(401,"AUTH_REQUIRED","登录已过期，请重新登录");
        var identity=identities.getFirst();
        if(!"ENABLED".equals(identity.get("status")))throw new ApiException(401,"AUTH_DISABLED","账号已停用");
        boolean platform=Boolean.TRUE.equals(identity.get("is_platform_admin"));
        Set<String> permissions=new HashSet<>();
        Map<String,String> fields=new HashMap<>();
        FieldPolicyService.GROUPS.forEach(g->fields.put(g,"HIDDEN"));
        if(platform)permissions.addAll(List.of("sys:country:view","sys:country:create","sys:country:activate","sys:template:publish","sys:integration:config"));
        Instant until=instant(identity.get("expires_at"));
        DataScope scope=DataScope.none();
        if(ctx.countryId()!=null) {
            if(jdbc.queryForObject("SELECT count(*) FROM sys_country WHERE id=?",Integer.class,ctx.countryId())!=1)
                throw new ApiException(403,"SYS_FORBIDDEN","没有该国家的授权");
            var roles=jdbc.queryForList("SELECT r.permissions::text,r.field_policies::text,r.status FROM sys_user_role ur JOIN sys_role r ON r.country_id=ur.country_id AND r.id=ur.role_id WHERE ur.user_id=? AND ur.country_id=?",ctx.userId(),ctx.countryId());
            if(!platform&&roles.isEmpty())throw new ApiException(403,"SYS_FORBIDDEN","没有该国家的授权");
            for(var role:roles)if("ENABLED".equals(role.get("status"))) {
                List<?> p=json.read(String.valueOf(role.get("permissions")),List.class);p.forEach(v->permissions.add(String.valueOf(v)));
                json.readMap(String.valueOf(role.get("field_policies"))).forEach((g,v)->{String level=String.valueOf(v);if(FieldPolicyService.GROUPS.contains(g)&&FieldPolicyService.rank(level)>FieldPolicyService.rank(fields.get(g)))fields.put(g,level);});
            }
            var grants=jdbc.queryForList("SELECT scope_type,entity_id,store_id,warehouse_id,book_id,effective_to FROM sys_user_data_scope WHERE country_id=? AND user_id=? AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp())",ctx.countryId(),ctx.userId());
            Set<Long> entities=new HashSet<>(),stores=new HashSet<>(),warehouses=new HashSet<>(),books=new HashSet<>();
            boolean all=false;
            for(var g:grants) {
                switch(String.valueOf(g.get("scope_type"))) {case "COUNTRY_ALL"->all=true;case "ENTITY"->entities.add(id(g,"entity_id"));case "STORE"->stores.add(id(g,"store_id"));case "WAREHOUSE"->warehouses.add(id(g,"warehouse_id"));case "BOOK"->books.add(id(g,"book_id"));default->throw new IllegalStateException("Invalid persisted scope");}
                Instant end=instant(g.get("effective_to"));if(end!=null&&end.isBefore(until))until=end;
            }
            for(var r:jdbc.queryForList("SELECT id,entity_id FROM org_store WHERE country_id=?",ctx.countryId()))if(entities.contains(id(r,"entity_id")))stores.add(id(r,"id"));
            for(var r:jdbc.queryForList("SELECT id,entity_id,store_id FROM org_warehouse WHERE country_id=?",ctx.countryId()))if(entities.contains(id(r,"entity_id"))||stores.contains(id(r,"store_id")))warehouses.add(id(r,"id"));
            for(var r:jdbc.queryForList("SELECT id,entity_id FROM fin_book WHERE country_id=?",ctx.countryId()))if(entities.contains(id(r,"entity_id")))books.add(id(r,"id"));
            scope=new DataScope(all,entities,stores,warehouses,books);
        }
        if(!platform)permissions.remove("sys:integration:config");
        Access result=new Access(ctx.userId(),ctx.countryId(),platform,permissions,fields,scope,until);
        final Instant expires=until;
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization(){@Override public void beforeCommit(boolean readOnly) {
            Instant now=jdbc.queryForObject("SELECT clock_timestamp()",(rs,n)->rs.getTimestamp(1).toInstant());
            if(expires!=null&&!now.isBefore(expires))throw new ApiException(403,"SYS_FORBIDDEN","授权或会话已到期，请重新操作");
        }});
        return result;
    }
    @SuppressWarnings("unchecked")
    private Map<Long,Boolean> heldGates() {
        Map<Long,Boolean> held=(Map<Long,Boolean>)TransactionSynchronizationManager.getResource(HELD_GATES);
        if(held==null) {
            held=new HashMap<>();TransactionSynchronizationManager.bindResource(HELD_GATES,held);
            final Map<Long,Boolean> resource=held;
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization(){
                @Override public void suspend(){TransactionSynchronizationManager.unbindResourceIfPossible(HELD_GATES);}
                @Override public void resume(){TransactionSynchronizationManager.bindResource(HELD_GATES,resource);}
                @Override public void afterCompletion(int status){if(TransactionSynchronizationManager.getResource(HELD_GATES)==resource)TransactionSynchronizationManager.unbindResource(HELD_GATES);}
            });
        }
        return held;
    }
    public void gate(long countryId,boolean exclusive) {
        if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Authorization gate requires a transaction");
        Map<Long,Boolean> held=heldGates();
        if(held.containsKey(countryId)) {
            if(exclusive&&!held.get(countryId))throw new IllegalStateException("Authorization shared gates cannot be upgraded; begin with authorizePolicyWrite");
            return;
        }
        if(countryId==0&&!held.isEmpty())throw new IllegalStateException("Global authorization gate must precede country gates");
        var rows=jdbc.queryForList("SELECT epoch FROM sys_authz_epoch WHERE country_id=? FOR "+(exclusive?"UPDATE":"SHARE"),countryId);
        if(rows.isEmpty())throw new ApiException(403,"SYS_FORBIDDEN","国家授权尚未配置");
        held.put(countryId,exclusive);
    }
    public void bump(long countryId) {
        if(!Boolean.TRUE.equals(heldGates().get(countryId)))throw new IllegalStateException("Authorization epoch mutation requires its exclusive gate");
        jdbc.update("UPDATE sys_authz_epoch SET epoch=epoch+1 WHERE country_id=?",countryId);
    }
    private static long id(Map<String,Object> row,String key) {return row.get(key) instanceof Number n?n.longValue():Long.MIN_VALUE;}
    static Instant instant(Object v) {if(v==null)return null;if(v instanceof Timestamp t)return t.toInstant();if(v instanceof java.time.OffsetDateTime d)return d.toInstant();return Instant.parse(v.toString());}
}
