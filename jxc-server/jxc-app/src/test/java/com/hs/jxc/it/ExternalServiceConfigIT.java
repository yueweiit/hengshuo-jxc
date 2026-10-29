package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.sys.service.SessionService;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT, properties="jxc.integrations.master-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
class ExternalServiceConfigIT extends BasePgIT {
    @Value("${local.server.port}") int port;
    final JsonCodec json=new JsonCodec();
    final HttpClient http=HttpClient.newHttpClient();
    @BeforeEach void setup(){
        resetFixtures();
        seed("INSERT INTO md_currency(code,name,decimals) VALUES('CNY','人民币',2)");
        seed("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(101,'CN','测试国家','CNY','Asia/Shanghai','ACTIVE')");
        seed("INSERT INTO sys_authz_epoch(country_id) VALUES(101)");
        seed("INSERT INTO sys_user(id,username,password_hash,display_name,is_platform_admin,created_country_id) VALUES(201,'integration-admin','unused','配置管理员',true,101),(202,'integration-user','unused','普通用户',false,101)");
        seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,201,clock_timestamp()+interval '1 hour'),(?,202,clock_timestamp()+interval '1 hour')",SessionService.digest("integration-admin"),SessionService.digest("integration-user"));
    }
    @Test void settingsAreRealAndOnlyPlatformAdminCanReadOrWrite()throws Exception{
        var initial=data(send("GET","",null,"integration-admin",200));
        assertThat(initial).containsEntry("version",0).containsEntry("keyReady",true);
        assertThat(((Map<?,?>)initial.get("services")).keySet().containsAll(List.of("n8n","deepseek","docling"))).isTrue();
        send("GET","",null,"integration-user",403);
        send("PUT","/deepseek",deepseek(0,"first-secret"),"integration-user",403);
        send("GET","",null,null,401);
    }
    @Test void secretIsEncryptedAndOmittedBlankReplacementAndClearHaveDistinctMeaning()throws Exception{
        var first=data(send("PUT","/deepseek",deepseek(0,"first-secret"),"integration-admin",200));
        assertThat(service(first,"deepseek")).containsEntry("keyConfigured",true).doesNotContainKeys("key","keyEncrypted","secret");
        assertThat(json.write(first)).doesNotContain("first-secret");
        String stored=owner.queryForObject("SELECT config::text FROM sys_external_service_revision WHERE version=1",String.class);
        assertThat(stored).doesNotContain("first-secret");
        var blank=deepseek(1,"");
        assertThat(service(data(send("PUT","/deepseek",blank,"integration-admin",200)),"deepseek")).containsEntry("keyConfigured",true);
        var changed=deepseek(2,"second-secret");
        send("PUT","/deepseek",changed,"integration-admin",200);
        var clear=deepseek(3,"");clear.put("enabled",false);clear.put("clearKey",true);
        assertThat(service(data(send("PUT","/deepseek",clear,"integration-admin",200)),"deepseek")).containsEntry("keyConfigured",false);
        assertThat(owner.queryForObject("SELECT string_agg(coalesce(after_value::text,''),'') FROM sys_audit_log",String.class)).doesNotContain("first-secret","second-secret");
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_external_service_revision",Integer.class)).isEqualTo(4);
    }
    @Test void staleVersionMalformedUrlUnknownFieldsAndConflictingSecretEditsDoNotMutate()throws Exception{
        send("PUT","/deepseek",deepseek(0,"first-secret"),"integration-admin",200);
        send("PUT","/deepseek",deepseek(0,"other-secret"),"integration-admin",409);
        for(String address:List.of("file:///etc/passwd","https://user:pass@example.com","https://example.com?key=secret","http://169.254.169.254","https://example.com/#secret")){
            var body=deepseek(1,"new-secret");body.put("url",address);send("PUT","/deepseek",body,"integration-admin",400);
        }
        var unknown=deepseek(1,"");unknown.put("arbitrary",true);send("PUT","/deepseek",unknown,"integration-admin",400);
        var conflict=deepseek(1,"new-secret");conflict.put("clearKey",true);send("PUT","/deepseek",conflict,"integration-admin",400);
        assertThat(data(send("GET","",null,"integration-admin",200))).containsEntry("version",1);
    }
    @Test void disabledServiceCannotSilentlyUseAnOldAddressAndTestDoesNotChangeVersion()throws Exception{
        var body=deepseek(0,"test-secret");body.put("enabled",false);
        var saved=data(send("PUT","/deepseek",body,"integration-admin",200));
        assertThat(service(saved,"deepseek")).containsEntry("enabled",false).containsEntry("source","PAGE");
        send("POST","/deepseek/test",Map.of("version",0),"integration-admin",409);
        assertThat(data(send("GET","",null,"integration-admin",200))).containsEntry("version",1);
    }
    @Test void realConnectionChecksUseSavedCredentialsAndDoNotExposeRemoteErrors()throws Exception{
        var requestKey=new java.util.concurrent.atomic.AtomicReference<String>();
        var replyStatus=new java.util.concurrent.atomic.AtomicInteger(200);
        var server=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/models",exchange->{requestKey.set(exchange.getRequestHeaders().getFirst("Authorization"));int code=replyStatus.get();byte[] out=json.write(code==200?Map.of("data",List.of(Map.of("id","deepseek-flash"))):Map.of("message","secret-marker-remote-error")).getBytes(java.nio.charset.StandardCharsets.UTF_8);exchange.sendResponseHeaders(code,out.length);exchange.getResponseBody().write(out);exchange.close();});server.start();
        try{
            var body=deepseek(0,"probe-secret");body.put("url","http://127.0.0.1:"+server.getAddress().getPort());
            send("PUT","/deepseek",body,"integration-admin",200);
            var checked=data(send("POST","/deepseek/test",Map.of("version",1),"integration-admin",200));
            assertThat(checked).containsEntry("status","ok");assertThat(requestKey.get()).isEqualTo("Bearer probe-secret");
            replyStatus.set(401);var failed=data(send("POST","/deepseek/test",Map.of("version",1),"integration-admin",200));
            assertThat(failed).containsEntry("status","error");assertThat(failed.get("message").toString()).contains("密钥").doesNotContain("secret-marker","probe-secret");
            var saved=data(send("GET","",null,"integration-admin",200));assertThat(saved).containsEntry("version",1);
            assertThat(((Map<?,?>)service(saved,"deepseek").get("lastTest")).get("status")).isEqualTo("error");
        }finally{server.stop(0);}
    }
    Map<String,Object> deepseek(int version,String secret){var body=new LinkedHashMap<String,Object>();body.put("version",version);body.put("enabled",true);body.put("url","https://api.deepseek.com");body.put("model","deepseek-flash");body.put("timeoutSeconds",180);body.put("key",secret);return body;}
    @SuppressWarnings("unchecked") Map<String,Object> service(Map<String,Object> result,String name){return (Map<String,Object>)((Map<?,?>)result.get("services")).get(name);}
    @SuppressWarnings("unchecked") Map<String,Object> data(Map<String,Object> envelope){return (Map<String,Object>)envelope.get("data");}
    Map<String,Object> send(String method,String path,Object body,String token,int expected)throws Exception{
        var builder=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1/sys/external-services"+path)).header("Content-Type","application/json").header("X-Country-Id","101");
        if(token!=null)builder.header("Authorization","Bearer "+token);
        var response=http.send(builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.write(body))).build(),HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(expected);return json.readMap(response.body());
    }
}
