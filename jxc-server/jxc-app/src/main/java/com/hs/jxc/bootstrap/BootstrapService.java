package com.hs.jxc.bootstrap;

import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.db.DbContext;
import com.hs.jxc.sys.service.PermissionCatalog;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;
import java.util.*;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Explicit offline first configuration. No demo, opening balance, financial posting or implicit grant. */
@Service
@Profile("bootstrap")
public class BootstrapService {
    private final JdbcTemplate jdbc; private final PlatformTransactionManager transactions; private final DbContext db; private final JsonCodec json;
    public BootstrapService(JdbcTemplate jdbc,PlatformTransactionManager transactions,DbContext db,JsonCodec json){this.jdbc=jdbc;this.transactions=transactions;this.db=db;this.json=json;}
    public static Map<String,Object> readConfiguration(Path path) {
        try {
            if(Files.isSymbolicLink(path)||!Files.isRegularFile(path,LinkOption.NOFOLLOW_LINKS)||Files.size(path)>65536)throw invalid();
            if(!Files.getPosixFilePermissions(path,LinkOption.NOFOLLOW_LINKS).equals(Set.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE)))throw invalid();
            if(!Files.getOwner(path,LinkOption.NOFOLLOW_LINKS).getName().equals(System.getProperty("user.name")))throw invalid();
            return new JsonCodec().readMap(Files.readString(path,StandardCharsets.UTF_8));
        }catch(Exception ignored){throw new IllegalStateException("BOOTSTRAP_CONFIG_REQUIRES_OWNED_REGULAR_0600_VALID_JSON");}
    }
    public void bootstrap(Map<String,Object> config) {
        keys(config,Set.of("schemaVersion","databaseName","operator","reason","currencies","country","entity","book","admin","role","dataScope"));
        if(!Integer.valueOf(1).equals(config.get("schemaVersion")))throw invalid();
        String database=required(config,"databaseName"), operator=required(config,"operator"), reason=required(config,"reason");
        Map<String,Object> country=object(config,"country"), entity=object(config,"entity"), book=object(config,"book"), admin=object(config,"admin"), role=object(config,"role"), scope=object(config,"dataScope");
        keys(country,Set.of("code","name","defaultCurrency","timezone","status","locale","enabledModules"));keys(entity,Set.of("code","name"));keys(book,Set.of("code","name","baseCurrency","status"));
        keys(admin,Set.of("username","displayName","password","isPlatformAdmin"));keys(role,Set.of("code","name","roleType","permissions","fieldPolicies"));keys(scope,Set.of("scopeType"));
        for(var value:List.of(country,entity,book,role)) {required(value,"code");required(value,"name");}
        if(!Set.of("DRAFT","ACTIVE").contains(required(country,"status"))||!Set.of("DRAFT","ACTIVE").contains(required(book,"status")))throw invalid();
        Map<String,Object> countryConfig=new LinkedHashMap<>();
        if(country.containsKey("locale"))countryConfig.put("locale",required(country,"locale"));
        if(country.containsKey("enabledModules")) {
            if(!(country.get("enabledModules") instanceof List<?> modules)||modules.stream().anyMatch(module->!(module instanceof String code)||!code.matches("[a-z][a-z0-9-]{0,31}")))throw invalid();
            countryConfig.put("enabledModules",modules);
        }
        ZoneId.of(required(country,"timezone"));required(role,"roleType");required(admin,"username");required(admin,"displayName");
        if(!(admin.get("isPlatformAdmin") instanceof Boolean)||!"COUNTRY_ALL".equals(scope.get("scopeType")))throw invalid();
        String password=requiredSecret(admin,"password");if(password.length()<10||password.getBytes(StandardCharsets.UTF_8).length>72)throw invalid();
        Object rawPermissions=role.get("permissions");if(!(rawPermissions instanceof List<?> permissions)||permissions.isEmpty())throw invalid();
        Set<String> catalogue=new HashSet<>();for(var module:PermissionCatalog.tree())for(Object leaf:(List<?>)module.get("children"))catalogue.add(String.valueOf(((Map<?,?>)leaf).get("code")));
        for(Object permission:permissions)if(!(permission instanceof String code)||code.contains("*")||!catalogue.contains(code))throw invalid();
        Map<String,Object> fields=object(role,"fieldPolicies");Set<String> groups=new HashSet<>();for(var group:PermissionCatalog.fieldGroups())groups.add(group.get("code"));keys(fields,groups);if(!fields.keySet().equals(groups))throw invalid();
        for(Object policy:fields.values())if(!Set.of("HIDDEN","READ","WRITE").contains(policy))throw invalid();
        if(!(config.get("currencies") instanceof List<?> currencies)||currencies.isEmpty())throw invalid();
        Set<String> currencyCodes=new HashSet<>();for(Object item:currencies){if(!(item instanceof Map<?,?>))throw invalid();Map<String,Object> c=cast(item);keys(c,Set.of("code","name","decimals"));String code=required(c,"code");if(!code.matches("[A-Z]{3}")||!currencyCodes.add(code))throw invalid();required(c,"name");if(!(c.get("decimals") instanceof Integer decimals)||decimals<0||decimals>4)throw invalid();}
        if(!currencyCodes.contains(required(country,"defaultCurrency"))||!currencyCodes.contains(required(book,"baseCurrency")))throw invalid();
        // Hash before opening the short database transaction. No original secret enters SQL or audit values.
        String hash=new BCryptPasswordEncoder(12).encode(password);
        new TransactionTemplate(transactions).executeWithoutResult(status->{
            if(!database.equals(jdbc.queryForObject("select current_database()",String.class)))throw new IllegalStateException("BOOTSTRAP_DATABASE_TARGET_MISMATCH");
            db.apply(null);jdbc.queryForObject("select epoch from sys_authz_epoch where country_id=0 for update",Long.class);
            if(jdbc.queryForObject("select (select count(*) from sys_country)+(select count(*) from sys_user)+(select count(*) from md_currency)",Long.class)!=0L)throw new IllegalStateException("BOOTSTRAP_DATABASE_NOT_EMPTY");
            // Only migration history, the operational write gate, and its audit trail may preexist.
            // Inspect actual tables, including global master data not covered by the old three-table check.
            for(String table:jdbc.queryForList("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('flyway_schema_history','sys_write_control','sys_write_control_log','sys_authz_epoch') ORDER BY tablename",String.class))
                if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM public.\""+table.replace("\"","\"\"")+"\")",Boolean.class)))throw new IllegalStateException("BOOTSTRAP_DATABASE_NOT_EMPTY");
            if(jdbc.queryForObject("SELECT count(*) FROM sys_authz_epoch WHERE country_id<>0",Integer.class)!=0)throw new IllegalStateException("BOOTSTRAP_DATABASE_NOT_EMPTY");
            for(Object item:currencies){var c=cast(item);jdbc.update("insert into md_currency(code,name,decimals) values(?,?,?)",c.get("code"),c.get("name"),c.get("decimals"));}
            long countryId=jdbc.queryForObject("insert into sys_country(code,name,default_currency,timezone,status,config) values(?,?,?,?,?,?::jsonb) returning id",Long.class,country.get("code"),country.get("name"),country.get("defaultCurrency"),country.get("timezone"),country.get("status"),json.write(countryConfig));
            db.apply(countryId);jdbc.update("insert into sys_authz_epoch(country_id,epoch) values(?,1)",countryId);
            long userId=jdbc.queryForObject("insert into sys_user(username,display_name,password_hash,is_platform_admin,created_country_id) values(?,?,?,?,?) returning id",Long.class,admin.get("username"),admin.get("displayName"),hash,admin.get("isPlatformAdmin"),countryId);
            long entityId=jdbc.queryForObject("insert into org_entity(country_id,code,name,created_by) values(?,?,?,?) returning id",Long.class,countryId,entity.get("code"),entity.get("name"),userId);
            long bookId=jdbc.queryForObject("insert into fin_book(country_id,entity_id,code,name,base_currency,status,created_by) values(?,?,?,?,?,?,?) returning id",Long.class,countryId,entityId,book.get("code"),book.get("name"),book.get("baseCurrency"),book.get("status"),userId);
            long roleId=jdbc.queryForObject("insert into sys_role(country_id,code,name,role_type,permissions,field_policies) values(?,?,?,?,?::jsonb,?::jsonb) returning id",Long.class,countryId,role.get("code"),role.get("name"),role.get("roleType"),json.write(permissions),json.write(fields));
            jdbc.update("insert into sys_user_role(country_id,user_id,role_id) values(?,?,?)",countryId,userId,roleId);
            jdbc.update("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(?,?,?,?)",countryId,userId,scope.get("scopeType"),userId);
            Map<String,Object> audit=Map.of("operator",operator,"countryId",countryId,"entityId",entityId,"bookId",bookId,"roleId",roleId,"userId",userId,"permissions",permissions,"fieldPolicies",fields,"scopeType",scope.get("scopeType"));
            new AuditWriter(jdbc,json).append(countryId,userId,"EXPLICIT_BOOTSTRAP","foundation",countryId,null,audit,reason);
            jdbc.update("update sys_authz_epoch set epoch=epoch+1 where country_id=0");
        });
    }
    @SuppressWarnings("unchecked") private static Map<String,Object> cast(Object value){return (Map<String,Object>)value;}
    private static Map<String,Object> object(Map<String,Object> parent,String key){Object value=parent.get(key);if(!(value instanceof Map<?,?>))throw invalid();return cast(value);}
    private static void keys(Map<String,Object> value,Set<String> allowed){if(!allowed.containsAll(value.keySet()))throw invalid();}
    private static String required(Map<String,Object> value,String key){Object raw=value.get(key);if(!(raw instanceof String text)||text.isBlank())throw invalid();return text.trim();}
    private static String requiredSecret(Map<String,Object> value,String key){Object raw=value.get(key);if(!(raw instanceof String text)||text.isBlank())throw invalid();return text;}
    private static IllegalArgumentException invalid(){return new IllegalArgumentException("BOOTSTRAP_CONFIG_INVALID");}
}
