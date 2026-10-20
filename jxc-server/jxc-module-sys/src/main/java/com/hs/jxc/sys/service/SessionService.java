package com.hs.jxc.sys.service;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbContext;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;

@Service
public class SessionService {
    private final JdbcTemplate jdbc;private final AuthorizationService authorization;private final DbContext db;private final com.hs.jxc.common.api.JsonCodec json;
    private final BCryptPasswordEncoder passwords=new BCryptPasswordEncoder(12);
    private final SecureRandom random=new SecureRandom();
    private final String dummy=passwords.encode("nonexistent-account-timing-only");
    private final int lifetimeHours;
    public SessionService(JdbcTemplate jdbc,AuthorizationService authorization,DbContext db,com.hs.jxc.common.api.JsonCodec json,@Value("${jxc.security.session-hours:12}")int lifetimeHours) {this.jdbc=jdbc;this.authorization=authorization;this.db=db;this.json=json;this.lifetimeHours=lifetimeHours;}
    @Transactional
    public Map<String,Object> login(String username,String password) {
        if(username==null||password==null||username.length()>100||password.length()>72)throw badCredentials();
        db.apply(null);authorization.gate(0,false);
        var users=jdbc.queryForList("SELECT id,password_hash,status FROM sys_user WHERE username=?",username);
        var user=users.isEmpty()?null:users.getFirst();
        String hash=user==null?dummy:String.valueOf(user.get("password_hash"));
        boolean valid;
        try{valid=passwords.matches(password,hash);}catch(IllegalArgumentException e){valid=false;}
        if(user==null||!valid)throw badCredentials();
        if(!"ENABLED".equals(user.get("status")))throw new ApiException(400,"AUTH_DISABLED","账号已停用，请联系管理员");
        byte[] value=new byte[32];random.nextBytes(value);String token=Base64.getUrlEncoder().withoutPadding().encodeToString(value);
        jdbc.update("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,?,clock_timestamp()+(? * interval '1 hour'))",digest(token),user.get("id"),lifetimeHours);
        jdbc.update("UPDATE sys_user SET last_login_at=clock_timestamp() WHERE id=?",user.get("id"));
        return Map.of("token",token);
    }
    /** Preliminary identity only; each business transaction rechecks this under the gates. */
    public long identify(String token) {
        var ids=jdbc.queryForList("SELECT s.user_id FROM sys_session s JOIN sys_user u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='ENABLED'",Long.class,digest(token));
        if(ids.size()!=1)throw new ApiException(401,"AUTH_REQUIRED","登录已过期，请重新登录");
        return ids.getFirst();
    }
    @Transactional public void logout(RequestContext ctx) {
        authorization.authorizePolicyWrite(new RequestContext(ctx.userId(),null,ctx.traceId(),ctx.tokenHash()),true);
        jdbc.update("UPDATE sys_session SET revoked_at=clock_timestamp() WHERE token_hash=? AND user_id=?",ctx.tokenHash(),ctx.userId());
        authorization.bump(0);
    }
    @Transactional public Map<String,Object> me(RequestContext ctx,Long wanted) {
        var identity=authorization.authorize(new RequestContext(ctx.userId(),null,ctx.traceId(),ctx.tokenHash()));
        var candidates=jdbc.queryForList("SELECT id,code,name,default_currency,timezone,status,config::text FROM sys_country ORDER BY id");
        List<Map<String,Object>> countries=new ArrayList<>();
        for(var country:candidates) {
            long id=((Number)country.get("id")).longValue();db.apply(id);authorization.gate(id,false);
            if(identity.platformAdmin()||jdbc.queryForObject("SELECT count(*) FROM sys_user_role WHERE country_id=? AND user_id=?",Integer.class,id,ctx.userId())>0) {
                Map<String,Object> c=new LinkedHashMap<>();c.put("id",id);c.put("code",country.get("code"));c.put("name",country.get("name"));c.put("status",country.get("status"));c.put("defaultCurrency",country.get("default_currency"));c.put("timezone",country.get("timezone"));c.put("locale","zh-CN");c.put("dateFormat","YYYY-MM-DD");c.put("numberFormat","1,234.56");c.put("isTest",false);c.put("enabledModules",List.of());Map<String,Object> config=json.readMap(String.valueOf(country.get("config")));for(String key:List.of("locale","dateFormat","numberFormat","isTest","enabledModules","sourceCountryId","sourceTemplateVersionId","activatedAt"))if(config.containsKey(key))c.put(key,config.get(key));countries.add(c);
            }
        }
        Map<String,Object> current=countries.stream().filter(c->Objects.equals(c.get("id"),wanted)).findFirst().orElseGet(()->countries.stream().filter(c->"ACTIVE".equals(c.get("status"))).findFirst().orElse(countries.isEmpty()?null:countries.getFirst()));
        Long countryId=current==null?null:((Number)current.get("id")).longValue();
        var access=authorization.authorize(new RequestContext(ctx.userId(),countryId,ctx.traceId(),ctx.tokenHash()));
        var raw=jdbc.queryForMap("SELECT id,username,display_name,is_platform_admin,locale FROM sys_user WHERE id=?",ctx.userId());
        Map<String,Object> user=Map.of("id",raw.get("id"),"username",raw.get("username"),"displayName",raw.get("display_name"),"isPlatformAdmin",raw.get("is_platform_admin"),"locale",raw.get("locale"));
        Map<String,Object> result=new LinkedHashMap<>();result.put("user",user);result.put("countries",countries);result.put("currentCountryId",countryId);result.put("permissions",access.permissions());result.put("fieldGroups",access.fieldGroups());return result;
    }
    public String encodePassword(String value) {
        if(value==null||value.length()<10||value.getBytes(StandardCharsets.UTF_8).length>72)throw new ApiException(400,"SYS_BAD_REQUEST","密码须为10至72字节");
        return passwords.encode(value);
    }
    public static String digest(String token) {try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));}catch(NoSuchAlgorithmException e){throw new IllegalStateException(e);}}
    private static ApiException badCredentials(){return new ApiException(400,"AUTH_BAD_CREDENTIALS","账号或密码错误");}
}
