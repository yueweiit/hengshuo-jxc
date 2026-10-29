package com.hs.jxc.sys.integrations;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbContext;
import com.hs.jxc.sys.service.AuthorizationService;
import java.util.*;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 系统级不可变连接版本；只在服务端内部解密，页面和审计使用同一脱敏输出。 */
@Service
public class ExternalServiceConfig {
    public static final List<String> SERVICES=List.of("n8n","deepseek","docling");
    private final JdbcTemplate jdbc;private final AuthorizationService auth;private final DbContext db;
    private final JsonCodec json;private final ExternalServiceSecrets secrets;private final AuditWriter audit;private final Environment env;
    public ExternalServiceConfig(JdbcTemplate jdbc,AuthorizationService auth,DbContext db,JsonCodec json,ExternalServiceSecrets secrets,AuditWriter audit,Environment env){this.jdbc=jdbc;this.auth=auth;this.db=db;this.json=json;this.secrets=secrets;this.audit=audit;this.env=env;}
    @Transactional(readOnly=true) public int currentVersion(){return jdbc.queryForObject("SELECT coalesce(max(version),0) FROM sys_external_service_revision",Integer.class);}
    @Transactional public Map<String,Object> get(RequestContext ctx){authorize(ctx,false);return output(currentVersion());}
    public void authorize(RequestContext ctx,boolean write){
        var neutral=new RequestContext(ctx.userId(),null,ctx.traceId(),ctx.tokenHash());
        var access=write?auth.authorizePolicyWrite(neutral,true):auth.authorize(neutral);
        if(!access.platformAdmin())throw ApiException.forbidden();
    }
    @Transactional public Map<String,Object> save(RequestContext ctx,String name,Map<String,Object> body){
        authorize(ctx,true);requireService(name);
        int current=currentVersion();if(version(body)!=current)throw Inputs.conflict();
        if(!secrets.ready())throw new ApiException(503,"INTEGRATION_MASTER_KEY_REQUIRED","后端尚未配置有效的服务加密主密钥，配置未保存");
        var allowed=new HashSet<>(List.of("version","enabled","timeoutSeconds"));
        allowed.addAll(name.equals("n8n")?List.of("fieldsUrl","recognitionUrl","fieldsKey","recognitionKey","clearFieldsKey","clearRecognitionKey"):name.equals("deepseek")?List.of("url","model","key","clearKey"):List.of("url","key","clearKey"));
        if(!allowed.containsAll(body.keySet()))throw Inputs.bad("配置含未允许字段");
        if(!(body.get("enabled") instanceof Boolean))throw Inputs.bad("请明确指定连接启用状态");
        int timeout=integer(body.get("timeoutSeconds"),1,600,"超时须为1至600的整数秒");
        var all=snapshot(current);var service=map(all.get(name));var before=publicService(name,service);
        service.put("enabled",body.get("enabled"));service.put("timeoutSeconds",timeout);service.put("source","PAGE");
        for(String field:name.equals("n8n")?List.of("fieldsUrl","recognitionUrl"):List.of("url")){
            String value=Inputs.text(body,field,"").trim();if(!value.isEmpty()){
                if(value.length()>2048)throw Inputs.bad("服务地址过长");
                var address=ExternalServiceHttp.address(value);
                if(name.equals("n8n")&&!address.getPath().endsWith(field.equals("fieldsUrl")?"/jxc-purchase-fields-v1":"/jxc-purchase-recognition-v1"))throw Inputs.bad("请填写对应的独立采购识别工作流地址");
                value=value.replaceAll("/+$","");
            }
            service.put(field,value);
        }
        if(name.equals("deepseek")){String model=Inputs.text(body,"model","").trim();if(!model.isEmpty()&&!model.matches("[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}"))throw Inputs.bad("模型名称格式无效");service.put("model",model);}
        for(String field:keyFields(name)){
            String clear=clearField(field);Object flag=body.get(clear);
            if(body.containsKey(clear)&&!(flag instanceof Boolean))throw Inputs.bad("清除密钥须为明确的是或否");
            String value=Inputs.text(body,field,"");
            if(Boolean.TRUE.equals(flag)&&!value.isEmpty())throw Inputs.bad("替换密钥和清除密钥不能同时进行");
            if(!value.isEmpty()&&(value.length()>4096||value.chars().anyMatch(c->c<33||c>126)))throw Inputs.bad("访问密钥含空白、无效字符或长度超过限制");
            if(Boolean.TRUE.equals(flag))service.put(field,"");else if(!value.isEmpty())service.put(field,value);
        }
        if(Boolean.TRUE.equals(service.get("enabled")))requireConfigured(name,service);
        all.put(name,service);var encrypted=json.readMap(json.write(all));
        for(String serviceName:SERVICES){var entry=map(encrypted.get(serviceName));for(String field:keyFields(serviceName)){String value=text(entry,field);entry.put(field,value.isEmpty()?"":secrets.seal(serviceName+"."+field,value));}encrypted.put(serviceName,entry);}
        if(current==Integer.MAX_VALUE)throw new ApiException(409,"INTEGRATION_VERSION_LIMIT","配置版本已达到上限，请联系管理员");
        int next=current+1;
        jdbc.update("INSERT INTO sys_external_service_revision(version,config,created_by) VALUES(?,?::jsonb,?)",next,json.write(encrypted),ctx.userId());
        Long country=ctx.countryId();if(country==null)country=jdbc.queryForObject("SELECT created_country_id FROM sys_user WHERE id=?",Long.class,ctx.userId());
        if(country==null)throw Inputs.bad("请先选择记录配置操作日志的国家");
        db.apply(country);auth.gate(country,false);
        audit.append(country,ctx.userId(),"保存外部服务配置","EXTERNAL_SERVICE",next,auditState(name,before),auditState(name,publicService(name,service)),"系统级 "+name+" 连接配置");
        return output(next);
    }
    /** 仅供任务连接读取，不可作为HTTP响应。版本0保留原启动配置。 */
    @Transactional(readOnly=true) public Map<String,Object> snapshot(int version){
        if(version==0)return startup();
        var rows=jdbc.queryForList("SELECT config::text FROM sys_external_service_revision WHERE version=?",String.class,version);
        if(rows.size()!=1)throw new ApiException(503,"INTEGRATION_VERSION_MISSING","任务所用连接配置版本不存在，未回退旧配置");
        var all=json.readMap(rows.getFirst());
        for(String name:SERVICES){var service=map(all.get(name));for(String field:keyFields(name)){String value=text(service,field);service.put(field,value.isEmpty()?"":secrets.open(name+"."+field,value));}all.put(name,service);}
        return all;
    }
    public static void requireConfigured(String name,Map<String,Object> service){
        for(String field:name.equals("n8n")?List.of("fieldsUrl","recognitionUrl","fieldsKey","recognitionKey"):name.equals("deepseek")?List.of("url","model","key"):List.of("url","key"))if(text(service,field).isEmpty())throw new ApiException(400,"INTEGRATION_NOT_CONFIGURED","请完整配置 "+name+" 的连接地址、模型及访问密钥");
    }
    public static void requireEnabled(String name,Map<String,Object> service){if(!Boolean.TRUE.equals(service.get("enabled")))throw new ApiException(503,"INTEGRATION_DISABLED",name+" 连接未启用，请检查外部服务配置");requireConfigured(name,service);}
    public static int version(Map<String,Object> body){return integer(body.get("version"),0,Integer.MAX_VALUE,"请提供有效的配置版本");}
    public static void requireService(String name){if(!SERVICES.contains(name))throw Inputs.bad("不支持的外部服务");}
    public static Map<String,Object> map(Object value){if(!(value instanceof Map<?,?> input))throw new ApiException(503,"INTEGRATION_CONFIG_INVALID","服务配置结构无效");var out=new LinkedHashMap<String,Object>();input.forEach((k,v)->out.put(String.valueOf(k),v));return out;}
    public static String text(Map<String,Object> service,String key){Object value=service.get(key);if(!(value instanceof String))throw new ApiException(503,"INTEGRATION_CONFIG_INVALID","服务配置字段无效");return (String)value;}
    private static int integer(Object value,int min,int max,String message){if(!(value instanceof Number number))throw Inputs.bad(message);try{int n=new java.math.BigDecimal(number.toString()).intValueExact();if(n<min||n>max)throw Inputs.bad(message);return n;}catch(ArithmeticException|NumberFormatException error){throw Inputs.bad(message);}}
    private static List<String> keyFields(String name){return name.equals("n8n")?List.of("fieldsKey","recognitionKey"):List.of("key");}
    private static String clearField(String field){return "clear"+Character.toUpperCase(field.charAt(0))+field.substring(1);}
    private Map<String,Object> auditState(String name,Map<String,Object> service){var out=new LinkedHashMap<String,Object>();out.put("service",name);for(String field:List.of("enabled","source","timeoutSeconds"))out.put(field,service.get(field));for(String field:keyFields(name))out.put(field+"Configured",service.get(field+"Configured"));return out;}
    private Map<String,Object> publicService(String name,Map<String,Object> raw){var out=new LinkedHashMap<>(raw);for(String field:keyFields(name)){out.remove(field);out.put(field+"Configured",!text(raw,field).isEmpty());}out.put("lastTest",null);return out;}
    private Map<String,Object> output(int version){
        Map<String,Object> raw;
        if(version==0)raw=startup();else raw=json.readMap(jdbc.queryForObject("SELECT config::text FROM sys_external_service_revision WHERE version=?",String.class,version));
        var services=new LinkedHashMap<String,Object>();
        for(String name:SERVICES){var out=publicService(name,map(raw.get(name)));var probes=jdbc.queryForList("SELECT result::text FROM sys_external_service_probe WHERE version=? AND service=?",String.class,version,name);if(!probes.isEmpty())out.put("lastTest",json.readMap(probes.getFirst()));services.put(name,out);}
        return Map.of("version",version,"keyReady",secrets.ready(),"services",services,"workerEnabled",env.getProperty("jxc.purchase-import.worker-enabled",Boolean.class,false),"recognitionEnabled",env.getProperty("jxc.purchase-import.recognition.enabled",Boolean.class,false));
    }
    private Map<String,Object> startup(){
        var n8n=new LinkedHashMap<String,Object>();n8n.put("fieldsUrl",env.getProperty("jxc.purchase-import.fields-url",""));n8n.put("fieldsKey",env.getProperty("jxc.purchase-import.fields-key",""));n8n.put("recognitionUrl",env.getProperty("jxc.purchase-import.n8n-url",""));n8n.put("recognitionKey",env.getProperty("jxc.purchase-import.n8n-key",""));n8n.put("timeoutSeconds",600);n8n.put("source","STARTUP");n8n.put("enabled",!text(n8n,"recognitionUrl").isBlank()&&!text(n8n,"recognitionKey").isBlank());
        var docling=new LinkedHashMap<String,Object>();docling.put("url",env.getProperty("jxc.purchase-import.worker-url",""));docling.put("key",env.getProperty("jxc.purchase-import.worker-key",""));docling.put("timeoutSeconds",600);docling.put("source","STARTUP");docling.put("enabled",!text(docling,"url").isBlank()&&!text(docling,"key").isBlank());
        if(text(n8n,"fieldsUrl").isBlank()&&text(n8n,"recognitionUrl").isBlank())n8n.put("source","UNCONFIGURED");
        if(text(docling,"url").isBlank())docling.put("source","UNCONFIGURED");
        return new LinkedHashMap<>(Map.of("n8n",n8n,"docling",docling,"deepseek",new LinkedHashMap<>(Map.of("url","https://api.deepseek.com","model","deepseek-flash","key","","enabled",false,"timeoutSeconds",540,"source","UNCONFIGURED"))));
    }
}
