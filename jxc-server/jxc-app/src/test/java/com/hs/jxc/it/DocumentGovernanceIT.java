package com.hs.jxc.it;

import com.hs.jxc.common.api.JsonCodec;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Value;
import static org.assertj.core.api.Assertions.*;

class DocumentGovernanceIT extends BasePgIT {
    @Value("${local.server.port}") int port;
    final HttpClient http=HttpClient.newHttpClient();final JsonCodec json=new JsonCodec();
    @BeforeEach void setup(){resetFixtures();seed("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(101,'MX','Mexico','MXN','UTC','ACTIVE')");seed("INSERT INTO sys_authz_epoch(country_id) VALUES(101)");seed("INSERT INTO sys_user(id,username,password_hash,display_name,created_country_id) VALUES(201,'governance','unused','Governance',101),(202,'limited','unused','Limited',101)");seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,201,clock_timestamp()+interval '1 hour'),(?,202,clock_timestamp()+interval '1 hour')",com.hs.jxc.sys.service.SessionService.digest("governance-fixture"),com.hs.jxc.sys.service.SessionService.digest("limited-governance-fixture"));seed("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(301,101,'ADMIN','Admin','[\"*\"]','{\"BANK_INFO\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\"}'),(302,101,'LIMITED','Limited','[\"org:entity:edit\"]','{}')");seed("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(101,201,301),(101,202,302)");seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(101,201,'COUNTRY_ALL',201)");seed("INSERT INTO org_entity(id,country_id,code,name) VALUES(401,101,'E','Entity')");}
    @Test void watcherAndCcConfigurationNeverAmplifyTheRecipientsAuthority()throws Exception{
        var b=new LinkedHashMap<String,Object>();b.put("watchType","VIEWER");b.put("targetType","DOC");b.put("docType","ORG_ENTITY");b.put("docId",401);b.put("userId",202);b.put("fieldGroups",List.of("BANK_INFO"));
        assertThat(send("POST","/sys/doc-watchers",b,"governance-fixture").statusCode()).isEqualTo(403);
        b.put("fieldGroups",List.of());ok("POST","/sys/doc-watchers",b,"governance-fixture");
        assertThat(send("GET","/org/entities/401",null,"limited-governance-fixture").statusCode()).isEqualTo(404);
        b.put("watchType","CC");ok("POST","/sys/doc-watchers",b,"governance-fixture");
        assertThat(send("GET","/org/entities/401",null,"limited-governance-fixture").statusCode()).isEqualTo(404);
    }
    @Test void allocatorIsDatabaseAtomicAndCountryConfigurationKeepsIssuedNumbers()throws Exception{
        var rule=Map.<String,Object>of("docType","ORG_TEST","prefix","TST","datePattern","yyyyMMdd","sequenceWidth",4,"resetPeriod","DAY");ok("PUT","/sys/doc-number-rules/ORG_TEST",rule,"governance-fixture");
        Set<String>numbers=java.util.concurrent.ConcurrentHashMap.newKeySet();var tasks=new ArrayList<java.util.concurrent.CompletableFuture<Void>>();
        for(int i=0;i<12;i++)tasks.add(java.util.concurrent.CompletableFuture.runAsync(()->numbers.add(inCountry(101,()->jdbc.queryForObject("SELECT jxc_next_doc_number(?,?,?::date)",String.class,101,"ORG_TEST","2026-10-16")))));
        java.util.concurrent.CompletableFuture.allOf(tasks.toArray(java.util.concurrent.CompletableFuture[]::new)).get();assertThat(numbers).hasSize(12);assertThat(numbers).contains("TST202610160001","TST202610160012");
        var edit=new LinkedHashMap<String,Object>(rule);edit.put("prefix","NEW");edit.put("version",1);ok("PUT","/sys/doc-number-rules/ORG_TEST",edit,"governance-fixture");
        assertThat(inCountry(101,()->jdbc.queryForObject("SELECT jxc_next_doc_number(?,?,?::date)",String.class,101,"ORG_TEST","2026-10-16"))).isEqualTo("NEW202610160013");assertThat(numbers).contains("TST202610160001");
    }
    HttpResponse<String>ok(String m,String p,Map<String,Object>b,String token)throws Exception{var r=send(m,p,b,token);assertThat(r.statusCode()).withFailMessage(r.body()).isEqualTo(200);return r;}
    HttpResponse<String>send(String m,String p,Map<String,Object>b,String token)throws Exception{return http.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1"+p)).header("Authorization","Bearer "+token).header("X-Country-Id","101").header("Content-Type","application/json").method(m,b==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.write(b))).build(),HttpResponse.BodyHandlers.ofString());}
}
