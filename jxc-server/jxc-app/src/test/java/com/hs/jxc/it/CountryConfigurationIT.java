package com.hs.jxc.it;

import com.hs.jxc.common.api.JsonCodec;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Value;
import static org.assertj.core.api.Assertions.*;

/** A second country must be created by the real template commands without source operating data. */
class CountryConfigurationIT extends BasePgIT {
    @Value("${local.server.port}") int port;
    final HttpClient http=HttpClient.newHttpClient();final JsonCodec json=new JsonCodec();
    @BeforeEach void source(){
        resetFixtures();
        seed("INSERT INTO md_currency(code,name,decimals) VALUES('MXN','Peso',2),('CNY','Yuan',2)");
        seed("INSERT INTO sys_country(id,code,name,default_currency,timezone,status,config) VALUES(101,'MX','Mexico','MXN','America/Mexico_City','ACTIVE','{\"enabledModules\":[\"sys\",\"org\",\"fin\"],\"locale\":\"es-MX\",\"sourceOnlySecret\":\"excluded-marker\"}')");
        seed("INSERT INTO sys_authz_epoch(country_id) VALUES(101)");
        seed("INSERT INTO sys_user(id,username,password_hash,display_name,is_platform_admin,created_country_id) VALUES(201,'platform','unused','Platform',true,101),(202,'new-country-admin','unused','New country administrator',false,101)");
        seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,201,clock_timestamp()+interval '1 hour')",com.hs.jxc.sys.service.SessionService.digest("country-template-fixture"));
    }
    @Test void publishedTemplateCloneRequiresLocalReviewAndDoesNotCopyPeopleBanksOrTransactions()throws Exception{
        var template=data(ok("POST","/sys/country-templates",Map.of("sourceCountryId",101,"changeNote","Synthetic configuration structure")));
        long templateId=id(template);ok("POST","/sys/country-templates/"+templateId+"/publish",null);
        assertThatThrownBy(()->inCountry(101,()->jdbc.update("UPDATE sys_country_template SET source_params='{\"tampered\":true}' WHERE country_id=101 AND id=?",templateId))).hasMessageContaining("SYS_TEMPLATE_IMMUTABLE");
        assertThatThrownBy(()->inCountry(101,()->jdbc.update("UPDATE sys_country_template_item SET payload='{\"tampered\":true}' WHERE country_id=101 AND template_id=?",templateId))).hasMessageContaining("SYS_TEMPLATE_IMMUTABLE");
        assertThatThrownBy(()->inCountry(101,()->jdbc.update("DELETE FROM sys_country_template_item WHERE country_id=101 AND template_id=?",templateId))).hasMessageContaining("SYS_TEMPLATE_IMMUTABLE");
        var job=data(ok("POST","/sys/country-clone-jobs",Map.of("templateId",templateId,"targetCode","CN","targetName","China test","isTest",true)));long jobId=id(job),country=id((Map<String,Object>)job.get("targetCountry"));
        assertThat(owner.queryForObject("SELECT status FROM sys_country WHERE id=?",String.class,country)).isEqualTo("DRAFT");
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_user_role WHERE country_id=?",Integer.class,country)).isZero();
        var target=(Map<String,Object>)job.get("targetCountry");
        assertThat(target).doesNotContainKey("sourceOnlySecret");
        assertThat(json.readMap(owner.queryForObject("SELECT config::text FROM sys_country WHERE id=?",String.class,country))).doesNotContainKey("sourceOnlySecret");
        ok("PUT","/sys/countries/"+country+"/params",Map.of("version",target.get("version"),"name","China test","defaultCurrency","CNY","timezone","Asia/Shanghai","locale","zh-CN","enabledModules",List.of("sys","org"),"isTest",true));
        ok("POST","/sys/country-clone-jobs/"+jobId+"/org",Map.of("entity",Map.of("code","CN-E","name","China test entity"),"warehouse",Map.of("code","CN-W","name","China test warehouse"),"book",Map.of("code","CN-B","name","China test book")));
        ok("POST","/sys/country-clone-jobs/"+jobId+"/admin",Map.of("userIds",List.of(202)));
        seed("UPDATE sys_role SET code='CN_LOCAL_ADMIN',role_type='COUNTRY_ADMIN' WHERE country_id=? AND code='COUNTRY_ADMIN'",country);
        ok("POST","/sys/country-clone-jobs/"+jobId+"/apply",null);
        assertThatThrownBy(()->inCountry(country,()->jdbc.update("UPDATE sys_country_clone_job SET selected_item_ids='[]' WHERE country_id=? AND id=?",country,jobId))).hasMessageContaining("SYS_TEMPLATE_IMMUTABLE");
        assertThat(json.readMap(owner.queryForObject("SELECT config::text FROM sys_country WHERE id=?",String.class,country)).get("enabledModules")).isEqualTo(List.of("sys","org"));
        assertThat(send("POST","/sys/countries/"+country+"/activate",null).statusCode()).isEqualTo(409);
        var reviews=(List<Map<String,Object>>)json.readMap(ok("GET","/sys/countries/"+country+"/reviews",null).body()).get("data");
        assertThat(reviews).isNotEmpty();
        for(var review:reviews)ok("POST","/sys/countries/"+country+"/reviews/"+id(review)+"/confirm",Map.of("comment","Reviewed synthetic local settings"));
        assertThatThrownBy(()->inCountry(country,()->jdbc.update("UPDATE sys_country_config_review SET payload='{\"tampered\":true}' WHERE country_id=? AND id=?",country,id(reviews.getFirst())))).hasMessageContaining("SYS_TEMPLATE_IMMUTABLE");
        ok("POST","/sys/countries/"+country+"/activate",null);
        assertThat(owner.queryForObject("SELECT status FROM sys_country WHERE id=?",String.class,country)).isEqualTo("ACTIVE");
        assertThat(owner.queryForObject("SELECT count(*) FROM md_fund_account WHERE country_id=?",Integer.class,country)).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM fin_period WHERE country_id=?",Integer.class,country)).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_user_role WHERE country_id=? AND user_id=201",Integer.class,country)).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_user_role WHERE country_id=? AND user_id=202",Integer.class,country)).isEqualTo(1);
        ok("PUT","/sys/countries/101/doc-number-rules/ORG_TEST",Map.of("prefix","SRC","datePattern","yyyyMMdd","sequenceWidth",6,"resetPeriod","NONE"));
        var nextTemplate=data(ok("POST","/sys/country-templates",Map.of("sourceCountryId",101,"changeNote","Explicit new numbering configuration")));long nextTemplateId=id(nextTemplate);ok("POST","/sys/country-templates/"+nextTemplateId+"/publish",null);
        var upgrade=data(ok("POST","/sys/template-upgrades",Map.of("countryId",country,"toTemplateId",nextTemplateId)));ok("POST","/sys/template-upgrades/"+id(upgrade)+"/confirm",null);
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_doc_number_rule WHERE country_id=? AND doc_type='ORG_TEST'",Integer.class,country)).isZero();
        var newReviews=(List<Map<String,Object>>)json.readMap(ok("GET","/sys/countries/"+country+"/reviews",null).body()).get("data");
        for(var review:newReviews)if("NEED_REVIEW".equals(review.get("status")))ok("POST","/sys/countries/"+country+"/reviews/"+id(review)+"/confirm",Map.of("comment","Reviewed numbering change for target country"));
        assertThat(owner.queryForObject("SELECT prefix FROM sys_doc_number_rule WHERE country_id=? AND doc_type='ORG_TEST'",String.class,country)).isEqualTo("SRC");
        assertThat(owner.queryForObject("SELECT count(*) FROM fin_period WHERE country_id=?",Integer.class,country)).isZero();
        ok("POST","/sys/countries/"+country+"/disable",null);assertThat(data(ok("GET","/sys/countries/"+country,null))).containsEntry("status","DISABLED");
        var disabled=data(ok("GET","/sys/countries/"+country,null));assertThat(send("PUT","/sys/countries/"+country+"/params",Map.of("version",disabled.get("version"),"name","Cannot change disabled country")).statusCode()).isEqualTo(409);
        ok("POST","/sys/countries/"+country+"/activate",null);assertThat(data(ok("GET","/sys/countries/"+country,null))).containsEntry("status","ACTIVE");

    }
    @Test void logisticsDelayParamsSaveReadAuditAndCountryIsolation()throws Exception{
        seed("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(102,'CN','China','CNY','Asia/Shanghai','ACTIVE')");
        seed("INSERT INTO sys_authz_epoch(country_id) VALUES(102)");
        var original=data(ok("GET","/sys/countries/101",null));
        assertThat(original).containsEntry("logisticsDelayToleranceHours",null);
        var saved=data(ok("PUT","/sys/countries/101/params",Map.of("version",original.get("version"),"logisticsDelayToleranceHours",48)));
        assertThat(saved).containsEntry("logisticsDelayToleranceHours",48);
        assertThat(data(ok("GET","/sys/countries/101",null))).containsEntry("logisticsDelayToleranceHours",48);
        assertThat(data(ok("GET","/sys/countries/102",null))).containsEntry("logisticsDelayToleranceHours",null);
        var config=json.readMap(owner.queryForObject("SELECT config::text FROM sys_country WHERE id=101",String.class));
        assertThat(config).containsEntry("lgs.delay.toleranceHours",48).containsEntry("sourceOnlySecret","excluded-marker");
        assertThat(owner.queryForObject("SELECT after_value->>'logisticsDelayToleranceHours' FROM sys_audit_log WHERE country_id=101 AND action='修改地区参数' ORDER BY id DESC LIMIT 1",String.class)).isEqualTo("48");
    }
    @Test void logisticsDelayParamsPreserveZeroUpperBoundaryAndOmittedField()throws Exception{
        for(int hours:List.of(0,999999)){
            var current=data(ok("GET","/sys/countries/101",null));
            var saved=data(ok("PUT","/sys/countries/101/params",Map.of("version",current.get("version"),"logisticsDelayToleranceHours",hours)));
            assertThat(saved).containsEntry("logisticsDelayToleranceHours",hours);
        }
        var current=data(ok("GET","/sys/countries/101",null));
        assertThat(data(ok("PUT","/sys/countries/101/params",Map.of("version",current.get("version"),"name","Renamed country")))).containsEntry("logisticsDelayToleranceHours",999999);
    }
    @Test void logisticsDelayParamsRejectInvalidInputsWithoutMutation()throws Exception{
        var original=data(ok("GET","/sys/countries/101",null));
        for(Object value:Arrays.asList(-1,1.5,1000000,"48",true,null)){
            var body=new HashMap<String,Object>();body.put("version",original.get("version"));body.put("logisticsDelayToleranceHours",value);
            var response=send("PUT","/sys/countries/101/params",body);
            assertThat(response.statusCode()).withFailMessage(response.body()).isEqualTo(400);
        }
        assertThat(data(ok("GET","/sys/countries/101",null))).containsEntry("version",original.get("version")).containsEntry("logisticsDelayToleranceHours",null);
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_audit_log WHERE action='修改地区参数'",Integer.class)).isZero();
    }
    @Test void logisticsDelayParamsKeepPermissionGate()throws Exception{
        seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,202,clock_timestamp()+interval '1 hour')",com.hs.jxc.sys.service.SessionService.digest("country-no-edit-fixture"));
        var request=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1/sys/countries/101/params")).header("Authorization","Bearer country-no-edit-fixture").header("Content-Type","application/json").PUT(HttpRequest.BodyPublishers.ofString("{\"version\":1,\"logisticsDelayToleranceHours\":48}")).build();
        assertThat(http.send(request,HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
        assertThat(owner.queryForObject("SELECT config->>'lgs.delay.toleranceHours' FROM sys_country WHERE id=101",String.class)).isNull();
    }
    @Test void logisticsDelayParamsKeepVersionConflictGate()throws Exception{
        var original=data(ok("GET","/sys/countries/101",null));
        ok("PUT","/sys/countries/101/params",Map.of("version",original.get("version"),"logisticsDelayToleranceHours",48));
        assertThat(send("PUT","/sys/countries/101/params",Map.of("version",original.get("version"),"logisticsDelayToleranceHours",72)).statusCode()).isEqualTo(409);
        assertThat(data(ok("GET","/sys/countries/101",null))).containsEntry("logisticsDelayToleranceHours",48);
    }
    @Test void newSysTablesHaveForceRlsAndTheStatementWriteGate(){
        for(String table:List.of("sys_country_template","sys_country_template_item","sys_country_clone_job","sys_country_config_review","sys_template_upgrade","sys_doc_number_rule","sys_doc_number_counter","sys_doc_watcher","sys_delegation")){
            assertThat(owner.queryForObject("SELECT coalesce((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=to_regclass(?)),false)",Boolean.class,table)).as(table+" RLS").isTrue();
            assertThat(owner.queryForObject("SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass(?) AND tgname='jxc_write_gate' AND tgtype=62",Integer.class,table)).as(table+" statement gate").isEqualTo(1);
        }
    }
    long id(Map<String,Object>r){return ((Number)r.get("id")).longValue();}
    @SuppressWarnings("unchecked") Map<String,Object>data(HttpResponse<String>r){return (Map<String,Object>)json.readMap(r.body()).get("data");}
    HttpResponse<String>ok(String m,String p,Map<String,Object>b)throws Exception{var r=send(m,p,b);assertThat(r.statusCode()).withFailMessage(r.body()).isEqualTo(200);return r;}
    HttpResponse<String>send(String m,String p,Map<String,Object>b)throws Exception{return http.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1"+p)).header("Authorization","Bearer country-template-fixture").header("Content-Type","application/json").method(m,b==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.write(b))).build(),HttpResponse.BodyHandlers.ofString());}
}
