package com.hs.jxc.sys.service;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbContext;
import com.hs.jxc.sys.api.Access;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import java.time.Instant;
import java.util.*;
import java.util.function.Function;

/** Authorization edits begin with exclusive gates; they never enter through an ordinary shared query. */
@Service
public class SystemManagementService {
    private final CountryLifecycle lifecycle;
    private final org.springframework.beans.factory.ObjectProvider<com.hs.jxc.sys.imports.ImportHandler> imports;private final com.hs.jxc.common.audit.AuditWriter auditWriter;private final JdbcTemplate jdbc;private final AuthorizationService auth;private final SessionService sessions;private final JsonCodec json;private final DbContext db;private final TransactionTemplate tx;
    public SystemManagementService(JdbcTemplate jdbc,AuthorizationService auth,SessionService sessions,JsonCodec json,DbContext db,PlatformTransactionManager tm,com.hs.jxc.common.audit.AuditWriter auditWriter,org.springframework.beans.factory.ObjectProvider<com.hs.jxc.sys.imports.ImportHandler> imports,CountryLifecycle lifecycle){this.lifecycle=lifecycle;this.imports=imports;this.auditWriter=auditWriter;this.jdbc=jdbc;this.auth=auth;this.sessions=sessions;this.json=json;this.db=db;this.tx=new TransactionTemplate(tm);}
    private <T>T read(RequestContext c,String[] permissions,Function<Access,T> work){return tx.execute(s->{var a=auth.authorize(c);a.requireCountry();a.require(permissions);return work.apply(a);});}
    private <T>T write(RequestContext c,boolean global,String permission,Function<Access,T> work){return tx.execute(s->{var a=auth.authorizePolicyWrite(c,global);a.requireCountry();a.require(permission);lifecycle.requireConfigurationWritable(a);T result=work.apply(a);auth.bump(global?0:a.requireCountry());return result;});}
    public Map<String,Object> catalog(RequestContext c){return tx.execute(s->{auth.authorize(c);return Map.of("tree",PermissionCatalog.tree(imports.orderedStream().flatMap(h->h.types().stream()).toList()),"fieldGroups",PermissionCatalog.fieldGroups());});}
    public Map<String,Object> users(RequestContext c,Map<String,String> query){return read(c,new String[]{"sys:user:edit"},a->{
        List<Map<String,Object>> rows=new ArrayList<>();
        for(var r:jdbc.queryForList("SELECT id,username,display_name,phone,email,status,is_platform_admin,created_country_id,locale,version FROM sys_user ORDER BY id"))if(manageable(a,r))rows.add(userOutput(a,r));
        return page(rows,query,List.of("username","displayName","phone","email"));
    });}
    public Map<String,Object> user(RequestContext c,long id){return read(c,new String[]{"sys:user:edit"},a->userOutput(a,managed(a,id,false)));}
    public Map<String,Object> createUser(RequestContext c,Map<String,Object> b){return write(c,true,"sys:user:edit",a->{
        String username=required(b,"username"),display=required(b,"displayName"),password=sessions.encodePassword(text(b,"password",null));
        Long id=jdbc.queryForObject("INSERT INTO sys_user(username,password_hash,display_name,phone,email,status,is_platform_admin,created_country_id,locale) VALUES(?,?,?,?,?,'ENABLED',false,?,?) RETURNING id",Long.class,username,password,display,text(b,"phone",null),text(b,"email",null),a.requireCountry(),text(b,"locale","zh-CN"));
        audit(a,"新增","user",id,null,Map.of("username",username,"displayName",display));return userOutput(a,managed(a,id,false));
    });}
    public Map<String,Object> updateUser(RequestContext c,long id,Map<String,Object> b){return write(c,true,"sys:user:edit",a->{
        var before=managed(a,id,true);long version=version(b);
        int changed=jdbc.update("UPDATE sys_user SET display_name=?,phone=?,email=?,locale=?,version=version+1,updated_at=clock_timestamp() WHERE id=? AND version=?",text(b,"displayName",String.valueOf(before.get("display_name"))),text(b,"phone",(String)before.get("phone")),text(b,"email",(String)before.get("email")),text(b,"locale",String.valueOf(before.get("locale"))),id,version);if(changed!=1)throw conflict();
        var after=managed(a,id,false);audit(a,"修改","user",id,safeUser(before),safeUser(after));return userOutput(a,after);
    });}
    public Map<String,Object> toggleUser(RequestContext c,long id,boolean enabled){return write(c,true,"sys:user:edit",a->{var r=managed(a,id,true);String status=enabled?"ENABLED":"DISABLED";jdbc.update("UPDATE sys_user SET status=?,version=version+1,updated_at=clock_timestamp() WHERE id=?",status,id);if(!enabled)jdbc.update("UPDATE sys_session SET revoked_at=clock_timestamp() WHERE user_id=? AND revoked_at IS NULL",id);audit(a,enabled?"启用":"停用","user",id,Map.of("status",r.get("status")),Map.of("status",status));return userOutput(a,managed(a,id,false));});}
    public Map<String,Object> resetPassword(RequestContext c,long id){return write(c,true,"sys:user:edit",a->{managed(a,id,true);String password="Tmp!"+UUID.randomUUID().toString().replace("-","").substring(0,18);jdbc.update("UPDATE sys_user SET password_hash=?,version=version+1,updated_at=clock_timestamp() WHERE id=?",sessions.encodePassword(password),id);jdbc.update("UPDATE sys_session SET revoked_at=clock_timestamp() WHERE user_id=? AND revoked_at IS NULL",id);audit(a,"重置密码","user",id,null,null);return Map.of("password",password);});}
    public Map<String,Object> grants(RequestContext c,long id,Long requestedCountry){checkCountry(c,requestedCountry);return read(c,new String[]{"sys:user:edit"},a->{managed(a,id,false);return grants(a,id);});}
    private Map<String,Object> grants(Access a,long id){return Map.of("version",jdbc.queryForObject("SELECT version FROM sys_user WHERE id=?",Integer.class,id),"roleIds",jdbc.queryForList("SELECT role_id FROM sys_user_role WHERE country_id=? AND user_id=? ORDER BY role_id",Long.class,a.requireCountry(),id),"dataScopes",jdbc.queryForList("SELECT scope_type,COALESCE(entity_id,store_id,warehouse_id,book_id) scope_ref_id,effective_from,effective_to FROM sys_user_data_scope WHERE country_id=? AND user_id=? ORDER BY id",a.requireCountry(),id).stream().map(this::camel).toList());}
    public Map<String,Object> setRoles(RequestContext c,long id,Long requestedCountry,List<Long> roleIds,long expectedVersion){return replaceGrants(c,id,requestedCountry,roleIds,null,expectedVersion);}
    public Map<String,Object> setScopes(RequestContext c,long id,Long requestedCountry,List<Map<String,Object>> scopes,long expectedVersion){return replaceGrants(c,id,requestedCountry,null,scopes,expectedVersion);}
    /** Roles and data scope use one CAS, one epoch gate, one audit and one transaction. */
    public Map<String,Object> setGrants(RequestContext c,long id,Long country,List<Long> roles,List<Map<String,Object>> scopes,long version){return replaceGrants(c,id,country,roles,scopes,version);}
    private Map<String,Object> replaceGrants(RequestContext c,long id,Long requestedCountry,List<Long> roleIds,List<Map<String,Object>> scopes,long expectedVersion){checkCountry(c,requestedCountry);return write(c,false,"sys:user:edit",a->{
        managed(a,id,false);Set<Long> unique=roleIds==null?null:new LinkedHashSet<>(roleIds);
        if(unique!=null)for(Long roleId:unique){if(roleId==null)throw bad("角色ID不合法");var role=role(a,roleId);ceiling(a,permissions(role),policies(role));}
        Instant now=jdbc.queryForObject("SELECT clock_timestamp()",(rs,n)->rs.getTimestamp(1).toInstant());
        List<Map<String,Object>> normalized=new ArrayList<>();
        if(scopes!=null){var own=jdbc.queryForList("SELECT * FROM sys_user_data_scope WHERE country_id=? AND user_id=? AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp())",a.requireCountry(),a.userId());
            for(var scope:scopes){String type=required(scope,"scopeType");scopeColumn(type);Long ref=type.equals("COUNTRY_ALL")?null:longValue(scope.get("scopeRefId"));
                if(!type.equals("COUNTRY_ALL")&&(ref==null||jdbc.queryForObject("SELECT count(*) FROM "+scopeTable(type)+" WHERE country_id=? AND id=?",Integer.class,a.requireCountry(),ref)!=1))throw bad("数据范围不属于该国家");
                Instant start=parseInstant(scope.get("effectiveFrom"),now),end=parseInstant(scope.get("effectiveTo"),null);if(end!=null&&!end.isAfter(start))throw bad("授权结束时间必须晚于开始时间");
                if(own.stream().noneMatch(g->covers(a,g,type,ref)&&!AuthorizationService.instant(g.get("effective_from")).isAfter(start)&&(g.get("effective_to")==null||end!=null&&!AuthorizationService.instant(g.get("effective_to")).isBefore(end))))throw forbidden("授权范围和期限不能超出自己的有效授权");
                var item=new LinkedHashMap<String,Object>();item.put("scopeType",type);item.put("scopeRefId",ref);item.put("effectiveFrom",start);item.put("effectiveTo",end);normalized.add(item);
            }
        }
        var before=grants(a,id);bumpUserVersion(id,expectedVersion);
        if(unique!=null){jdbc.update("DELETE FROM sys_user_role WHERE country_id=? AND user_id=?",a.requireCountry(),id);for(long roleId:unique)jdbc.update("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(?,?,?)",a.requireCountry(),id,roleId);}
        if(scopes!=null){jdbc.update("DELETE FROM sys_user_data_scope WHERE country_id=? AND user_id=?",a.requireCountry(),id);
            for(var scope:normalized){String type=String.valueOf(scope.get("scopeType"));Instant start=(Instant)scope.get("effectiveFrom"),end=(Instant)scope.get("effectiveTo");
                List<Object>args=new ArrayList<>(List.of(a.requireCountry(),id,type));String column="";if(!type.equals("COUNTRY_ALL")){column=","+scopeColumn(type);args.add(scope.get("scopeRefId"));}args.add(java.sql.Timestamp.from(start));args.add(end==null?null:java.sql.Timestamp.from(end));args.add(a.userId());
                jdbc.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type"+column+",effective_from,effective_to,granted_by) VALUES("+String.join(",",Collections.nCopies(args.size(),"?"))+")",args.toArray());
            }
        }
        var after=grants(a,id);audit(a,unique!=null&&scopes!=null?"设置授权":unique!=null?"设置角色":"设置数据范围","user",id,before,after);return after;
    });}
    public List<Map<String,Object>> userOptions(RequestContext c){return tx.execute(s->{var a=auth.authorize(c);if(!a.platformAdmin()){a.requireCountry();a.require("sys:user:edit","wf:rule:edit","sys:watcher:edit","org:store:edit");}
        return jdbc.queryForList("SELECT id,username,display_name,status,is_platform_admin,created_country_id FROM sys_user WHERE status='ENABLED' ORDER BY display_name,id").stream().filter(r->a.platformAdmin()||manageable(a,r)).map(r->Map.<String,Object>of("id",r.get("id"),"username",r.get("username"),"displayName",r.get("display_name"))).toList();
    });}
    /** Joins the caller's transaction; callers with store users must start with country policy-write authorization. */
    public void grantNewStoreUsers(RequestContext c,long storeId,List<Long> userIds) {
        if(userIds==null||userIds.isEmpty())return;
        write(c,false,"sys:user:edit",a->{
            var stores=jdbc.queryForList("SELECT id,country_id,entity_id FROM org_store WHERE country_id=? AND id=?",a.requireCountry(),storeId);
            if(stores.isEmpty())throw missing();
            var row=stores.getFirst();Map<String,Object> trusted=new HashMap<>();trusted.put("countryId",row.get("country_id"));trusted.put("entityId",row.get("entity_id"));trusted.put("storeId",storeId);a.requireRow(trusted);
            var own=jdbc.queryForList("SELECT * FROM sys_user_data_scope WHERE country_id=? AND user_id=? AND effective_from<=clock_timestamp() AND (effective_to IS NULL OR effective_to>clock_timestamp())",a.requireCountry(),a.userId());
            var covering=own.stream().filter(g->covers(a,g,"STORE",storeId)).toList();
            if(covering.isEmpty())throw forbidden("不能授予超出自身的数据范围");
            Instant end=null;
            if(covering.stream().noneMatch(g->g.get("effective_to")==null))end=covering.stream().map(g->AuthorizationService.instant(g.get("effective_to"))).max(Instant::compareTo).orElseThrow();
            if(userIds.stream().anyMatch(Objects::isNull))throw bad("用户ID不合法");
            Set<Long> targets=new TreeSet<>(userIds);
            for(Long userId:targets) {
                if(userId==null)throw bad("用户ID不合法");managed(a,userId,false);
                if(jdbc.queryForObject("SELECT count(*) FROM sys_user_data_scope WHERE country_id=? AND user_id=? AND scope_type='STORE' AND store_id=?",Integer.class,a.requireCountry(),userId,storeId)==0) {
                    jdbc.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,store_id,effective_to,granted_by) VALUES(?,?,'STORE',?,?,?)",a.requireCountry(),userId,storeId,end==null?null:java.sql.Timestamp.from(end),a.userId());
                    jdbc.update("UPDATE sys_user SET version=version+1,updated_at=clock_timestamp() WHERE id=?",userId);
                    Map<String,Object> after=new LinkedHashMap<>();after.put("scopeType","STORE");after.put("scopeRefId",storeId);after.put("effectiveTo",end);
                    audit(a,"新门店授权","user",userId,null,after);
                }
            }
            return null;
        });
    }
    public Map<String,Object> roles(RequestContext c,Map<String,String> query){return read(c,new String[]{"sys:role:edit","sys:user:edit"},a->page(jdbc.queryForList("SELECT * FROM sys_role WHERE country_id=? ORDER BY id",a.requireCountry()).stream().map(this::roleOutput).toList(),query,List.of("code","name")));}
    public Map<String,Object> getRole(RequestContext c,long id){return read(c,new String[]{"sys:role:edit","sys:user:edit"},a->roleOutput(role(a,id)));}
    public Map<String,Object> createRole(RequestContext c,Map<String,Object> b){return write(c,false,"sys:role:edit",a->{List<String> permissions=strings(b.get("permissions"));Map<String,String> policies=policyInput(b.get("fieldPolicies"));ceiling(a,permissions,policies);Long id=jdbc.queryForObject("INSERT INTO sys_role(country_id,code,name,role_type,status,permissions,field_policies) VALUES(?,?,?,?,'ENABLED',?::jsonb,?::jsonb) RETURNING id",Long.class,a.requireCountry(),required(b,"code"),required(b,"name"),text(b,"roleType","BUSINESS"),json.write(permissions),json.write(policies));var out=roleOutput(role(a,id));audit(a,"新增","role",id,null,out);return out;});}
    public Map<String,Object> updateRole(RequestContext c,long id,Map<String,Object> b){return write(c,false,"sys:role:edit",a->{var old=role(a,id);ceiling(a,permissions(old),policies(old));if(jdbc.update("UPDATE sys_role SET code=?,name=?,role_type=?,version=version+1,updated_at=clock_timestamp() WHERE country_id=? AND id=? AND version=?",text(b,"code",String.valueOf(old.get("code"))),text(b,"name",String.valueOf(old.get("name"))),text(b,"roleType",String.valueOf(old.get("role_type"))),a.requireCountry(),id,version(b))!=1)throw conflict();var out=roleOutput(role(a,id));audit(a,"修改","role",id,roleOutput(old),out);return out;});}
    public Map<String,Object> toggleRole(RequestContext c,long id,boolean enabled){return write(c,false,"sys:role:edit",a->{var old=role(a,id);ceiling(a,permissions(old),policies(old));jdbc.update("UPDATE sys_role SET status=?,version=version+1 WHERE country_id=? AND id=?",enabled?"ENABLED":"DISABLED",a.requireCountry(),id);var out=roleOutput(role(a,id));audit(a,enabled?"启用":"停用","role",id,roleOutput(old),out);return out;});}
    public Map<String,Object> setRolePermissions(RequestContext c,long id,List<String> permissions,long expectedVersion){return write(c,false,"sys:role:edit",a->{var old=role(a,id);ceiling(a,permissions(old),policies(old));ceiling(a,permissions,Map.of());if(jdbc.update("UPDATE sys_role SET permissions=?::jsonb,version=version+1 WHERE country_id=? AND id=? AND version=?",json.write(new LinkedHashSet<>(permissions)),a.requireCountry(),id,expectedVersion)!=1)throw conflict();var out=roleOutput(role(a,id));audit(a,"设置权限","role",id,roleOutput(old),out);return out;});}
    public Map<String,Object> setRoleFields(RequestContext c,long id,Map<String,String> policies,long expectedVersion){return write(c,false,"sys:role:edit",a->{var old=role(a,id);ceiling(a,permissions(old),policies(old));ceiling(a,List.of(),policies);if(jdbc.update("UPDATE sys_role SET field_policies=?::jsonb,version=version+1 WHERE country_id=? AND id=? AND version=?",json.write(policies),a.requireCountry(),id,expectedVersion)!=1)throw conflict();var out=roleOutput(role(a,id));audit(a,"设置字段权限","role",id,roleOutput(old),out);return out;});}
    public void requireManageableUser(Access actor,long id){managed(actor,id,false);}
    public void requireManageableRole(Access actor,long id){var role=role(actor,id);ceiling(actor,permissions(role),policies(role));}
    private long bumpUserVersion(long id,long expected){if(jdbc.update("UPDATE sys_user SET version=version+1,updated_at=clock_timestamp() WHERE id=? AND version=?",id,expected)!=1)throw conflict();return expected+1;}
    private Map<String,Object> managed(Access a,long id,boolean accountWrite){var found=jdbc.queryForList("SELECT id,username,display_name,phone,email,status,is_platform_admin,created_country_id,locale,version FROM sys_user WHERE id=?",id);if(found.isEmpty()||!manageable(a,found.getFirst()))throw missing();var user=found.getFirst();if(accountWrite&&!a.platformAdmin()){
        for(Long country:jdbc.queryForList("SELECT id FROM sys_country WHERE id<>? ORDER BY id",Long.class,a.requireCountry())){db.apply(country);if(jdbc.queryForObject("SELECT count(*) FROM sys_user_role WHERE country_id=? AND user_id=?",Integer.class,country,id)>0){db.apply(a.countryId());throw forbidden("跨国家共享账号的资料、状态和密码需由平台管理员维护");}}
        db.apply(a.countryId());
    }return user;}
    private boolean manageable(Access a,Map<String,Object> u){if(a.platformAdmin())return true;if(Boolean.TRUE.equals(u.get("is_platform_admin")))return false;return Objects.equals(longValue(u.get("created_country_id")),a.countryId())||jdbc.queryForObject("SELECT count(*) FROM sys_user_role WHERE country_id=? AND user_id=?",Integer.class,a.requireCountry(),u.get("id"))>0;}
    private Map<String,Object> userOutput(Access a,Map<String,Object> row){var out=safeUser(row);out.put("roleNames",jdbc.queryForList("SELECT r.name FROM sys_user_role ur JOIN sys_role r ON r.country_id=ur.country_id AND r.id=ur.role_id WHERE ur.country_id=? AND ur.user_id=? ORDER BY r.id",String.class,a.requireCountry(),row.get("id")));out.put("scopeText",String.join("、",jdbc.queryForList("SELECT scope_type FROM sys_user_data_scope WHERE country_id=? AND user_id=? ORDER BY id",String.class,a.requireCountry(),row.get("id"))));return out;}
    private Map<String,Object> safeUser(Map<String,Object> row){Map<String,Object> out=new LinkedHashMap<>();for(String key:List.of("id","username","display_name","phone","email","status","is_platform_admin","created_country_id","locale","version"))out.put(camelKey(key),row.get(key));return out;}
    private Map<String,Object> role(Access a,long id){var roles=jdbc.queryForList("SELECT * FROM sys_role WHERE country_id=? AND id=?",a.requireCountry(),id);if(roles.isEmpty())throw missing();return roles.getFirst();}
    private Map<String,Object> roleOutput(Map<String,Object> role){var result=camel(role);result.put("permissions",permissions(role));result.put("fieldPolicies",policies(role));result.put("isTemplate",false);result.put("userCount",jdbc.queryForObject("SELECT count(*) FROM sys_user_role WHERE country_id=? AND role_id=?",Integer.class,role.get("country_id"),role.get("id")));return result;}
    private List<String> permissions(Map<String,Object> role){return strings(json.read(String.valueOf(role.get("permissions")),List.class));}
    private Map<String,String> policies(Map<String,Object> role){return policyInput(json.readMap(String.valueOf(role.get("field_policies"))));}
    private void ceiling(Access a,List<String> permissions,Map<String,String> fields){if(permissions.stream().anyMatch(p->!a.has(p)))throw forbidden("不能授予或维护超出自身权限的角色或权限点");for(var p:fields.entrySet()){if(!FieldPolicyService.GROUPS.contains(p.getKey())||!Set.of("HIDDEN","READ","WRITE").contains(p.getValue()))throw bad("字段权限值不合法");if(FieldPolicyService.rank(p.getValue())>FieldPolicyService.rank(a.fieldGroups().get(p.getKey())))throw forbidden("不能授予超出自身可见性的字段权限");}}
    private boolean covers(Access a,Map<String,Object> grant,String type,Long ref){String own=String.valueOf(grant.get("scope_type"));if(own.equals("COUNTRY_ALL"))return true;if(own.equals(type))return Objects.equals(longValue(grant.get(scopeColumn(own))),ref);if(own.equals("ENTITY")&&Set.of("STORE","WAREHOUSE","BOOK").contains(type))return jdbc.queryForObject("SELECT count(*) FROM "+scopeTable(type)+" WHERE country_id=? AND id=? AND entity_id=?",Integer.class,a.requireCountry(),ref,grant.get("entity_id"))>0;if(own.equals("STORE")&&type.equals("WAREHOUSE"))return jdbc.queryForObject("SELECT count(*) FROM org_warehouse WHERE country_id=? AND id=? AND store_id=?",Integer.class,a.requireCountry(),ref,grant.get("store_id"))>0;return false;}
    private void audit(Access a,String action,String type,long id,Object before,Object after){auditWriter.append(a.requireCountry(),a.userId(),action,type,id,before,after,null);}

    private static String scopeColumn(String type){return switch(type){case "COUNTRY_ALL"->"";case "ENTITY"->"entity_id";case "STORE"->"store_id";case "WAREHOUSE"->"warehouse_id";case "BOOK"->"book_id";default->throw bad("不支持的数据范围类型");};}
    private static String scopeTable(String type){return switch(type){case "ENTITY"->"org_entity";case "STORE"->"org_store";case "WAREHOUSE"->"org_warehouse";case "BOOK"->"fin_book";default->throw bad("不支持的数据范围类型");};}
    private static void checkCountry(RequestContext c,Long requested){if(requested!=null&&!Objects.equals(c.countryId(),requested))throw forbidden("只能管理当前国家的授权");}
    public static List<String> strings(Object value){if(value==null)return List.of();if(!(value instanceof Collection<?> list))throw bad("数组参数不合法");List<String> out=new ArrayList<>();for(Object v:list){if(!(v instanceof String s)||s.isBlank())throw bad("权限点不合法");out.add(s);}return out;}
    public static Map<String,String> policyInput(Object value){if(value==null)return Map.of();if(!(value instanceof Map<?,?> map))throw bad("字段权限值不合法");Map<String,String> out=new HashMap<>();for(var e:map.entrySet())out.put(String.valueOf(e.getKey()),String.valueOf(e.getValue()));return out;}
    private static Long longValue(Object v){return v==null?null:Inputs.id(v);}
    private static long version(Map<String,Object> b){return Inputs.version(b);}
    private static Instant parseInstant(Object value,Instant fallback){if(value==null||value.toString().isBlank())return fallback;try{return Instant.parse(value.toString());}catch(Exception e){try{return java.time.OffsetDateTime.parse(value.toString()).toInstant();}catch(Exception ignored){throw bad("授权有效期不合法");}}}
    private static String required(Map<String,Object>b,String key){return Inputs.required(b,key);}
    private static String text(Map<String,Object>b,String key,String fallback){return Inputs.text(b,key,fallback);}
    private Map<String,Object> camel(Map<String,Object> row){Map<String,Object> out=new LinkedHashMap<>();row.forEach((k,v)->out.put(camelKey(k),v));return out;}
    private static String camelKey(String key){StringBuilder b=new StringBuilder();boolean upper=false;for(char c:key.toCharArray()){if(c=='_')upper=true;else{b.append(upper?Character.toUpperCase(c):c);upper=false;}}return b.toString();}
    private static Map<String,Object> page(List<Map<String,Object>> rows,Map<String,String> q,List<String> searchKeys){String keyword=q.getOrDefault("keyword","").toLowerCase(Locale.ROOT);var filtered=rows.stream().filter(r->keyword.isEmpty()||searchKeys.stream().anyMatch(k->String.valueOf(r.get(k)).toLowerCase(Locale.ROOT).contains(keyword))).filter(r->!q.containsKey("status")||q.get("status").equals(String.valueOf(r.get("status")))).filter(r->!q.containsKey("roleType")||q.get("roleType").equals(String.valueOf(r.get("roleType")))).toList();int page=positive(q.get("page"),1,1000000),size=positive(q.get("size"),20,200);int from=Math.min(filtered.size(),(page-1)*size),to=Math.min(filtered.size(),from+size);return Map.of("records",filtered.subList(from,to),"total",filtered.size(),"page",page,"size",size);}
    private static int positive(String value,int fallback,int max){if(value==null)return fallback;try{int n=Integer.parseInt(value);if(n<1||n>max)throw bad("分页参数不合法");return n;}catch(NumberFormatException e){throw bad("分页参数不合法");}}
    private static ApiException missing(){return new ApiException(404,"NOT_FOUND","记录不存在或不在你的数据范围内");}
    private static ApiException bad(String message){return new ApiException(400,"SYS_BAD_REQUEST",message);}
    private static ApiException forbidden(String message){return new ApiException(403,"SYS_FORBIDDEN",message);}
    private static ApiException conflict(){return new ApiException(409,"SYS_VERSION_CONFLICT","记录已被他人修改，请刷新后重试");}
}
