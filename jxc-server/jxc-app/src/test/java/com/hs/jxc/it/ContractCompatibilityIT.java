package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.hs.jxc.sys.service.SessionService;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Real HTTP adaptation of M0 requests. Logical demo references are test-only mappings. */
class ContractCompatibilityIT extends BasePgIT {
    private static final String ADMIN_TOKEN="http-contract-admin",STORE_TOKEN="http-contract-store";
    private static final String LOGIN_PASSWORD="fixture-contract-password";
    @Value("${local.server.port}") int port;
    private final HttpClient http=HttpClient.newHttpClient();
    private final JsonMapper json=JsonMapper.builder().build();
    @BeforeEach void fixtures() {
        resetFixtures();
        owner.update("INSERT INTO md_currency(code,name) VALUES('USD','Fixture dollar'),('EUR','Fixture euro')");
        owner.update("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(90101,'HC1','HTTP country one','USD','UTC','ACTIVE'),(90102,'HC2','HTTP country two','EUR','UTC','ACTIVE')");
        owner.update("INSERT INTO sys_authz_epoch(country_id) VALUES(90101),(90102)");
        owner.update("INSERT INTO sys_user(id,username,password_hash,display_name,created_country_id) VALUES(91101,'contract-admin',?,'Contract administrator',90101),(91102,'contract-store','unused','Contract store user',90101),(91103,'contract-other','unused','Other country user',90102)",new BCryptPasswordEncoder().encode(LOGIN_PASSWORD));
        owner.update("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,91101,clock_timestamp()+interval '1 hour'),(?,91102,clock_timestamp()+interval '1 hour'),(?,91103,clock_timestamp()+interval '1 hour')",SessionService.digest(ADMIN_TOKEN),SessionService.digest(STORE_TOKEN),SessionService.digest("http-contract-other"));
        owner.update("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(91201,90101,'HTTP_ADMIN','HTTP administrator','[\"org:*\",\"md:fund-account:edit\",\"md:fund-account:view\",\"fin:book:config\"]','{\"BANK_INFO\":\"WRITE\"}'),(91202,90101,'HTTP_STORE','HTTP store','[\"md:fund-account:edit\",\"md:fund-account:view\"]','{}'),(91203,90102,'HTTP_OTHER','Other country','[\"org:*\"]','{}')");
        owner.update("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(90101,91101,91201),(90101,91102,91202),(90102,91103,91203)");
        owner.update("INSERT INTO org_entity(id,country_id,code,name) VALUES(91301,90101,'HE1','HTTP entity one'),(91302,90101,'HE2','Hidden entity')");
        owner.update("INSERT INTO org_store(id,country_id,entity_id,code,name) VALUES(91401,90101,91301,'HS1','HTTP store one'),(91402,90101,91301,'HS2','Hidden store')");
        owner.update("INSERT INTO org_warehouse(id,country_id,entity_id,store_id,code,name,type) VALUES(91501,90101,91301,91401,'HW1','HTTP warehouse','STORE')");
        owner.update("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(91701,90101,91301,'HB1','HTTP book','USD','ACTIVE')");
        owner.update("INSERT INTO md_fund_account(id,country_id,entity_id,store_id,name,account_type,currency,bank_name,account_no_encrypted) VALUES(91601,90101,91301,91401,'Fixture till','CASH','USD','Fixture bank','opaque-test-value')");
        owner.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,store_id,granted_by) VALUES(90101,91101,'COUNTRY_ALL',NULL,91101),(90101,91102,'STORE',91401,91101),(90102,91103,'COUNTRY_ALL',NULL,91103)");
    }
    @ParameterizedTest
    @ValueSource(strings={"auth-login-envelope","auth-login-invalid"})
    void sharedLoginContractsKeepTheSameEnvelope(String scenarioId)throws Exception {
        var request=scenario(scenarioId).get("requests").get(0);
        // Never import demo credentials: substitute an equivalent isolated BCrypt user.
        String password=scenarioId.equals("auth-login-envelope")?LOGIN_PASSWORD:"deliberately-wrong-fixture-value";
        var response=send("POST",request.get("path").asString(),Map.of("username","contract-admin","password",password),null,null,null);
        expect(response,request.get("expect").get("backend"));
        if(response.statusCode()==200) {
            assertThat(json.readTree(response.body()).get("data").get("token").getNodeType().name()).isEqualTo("STRING");
        }
    }
    @Test void sharedUnauthorizedCountryContractRejectsAChangedHeader()throws Exception {
        var r=scenario("unauthorized-country").get("requests").get(0);
        expect(send(r.get("method").asString(),r.get("path").asString(),null,"http-contract-other",90101L,null),r.get("expect").get("backend"));
    }
    @Test void sharedBankFieldContractHidesSensitiveFieldsOnTheOriginalEndpoint()throws Exception {
        var r=scenario("field-bank-hidden").get("requests").get(0);
        var response=send("GET",r.get("path").asString(),null,STORE_TOKEN,90101L,null);
        expect(response,r.get("expect").get("backend"));
        var record=json.readTree(response.body()).get("data").get("records").get(0);
        assertThat(record.get("id").asLong()).isEqualTo(91601);
        assertThat(record.get("accountNoEncrypted")).isNull();
        assertThat(response.body()).doesNotContain("opaque-test-value");
    }
    @Test void sharedSameIntentKeyBindsDifferentRequestsToOneEffect()throws Exception {
        var requests=scenario("same-idempotency-key-different-body").get("requests");
        // The fixture names a logical intent; the public backend header is its UUID mapping.
        String key=UUID.nameUUIDFromBytes("fixture-idem-intent".getBytes(StandardCharsets.UTF_8)).toString();
        for(var r:requests)expect(send(r.get("method").asString(),r.get("path").asString(),json.readValue(r.get("body").toString(),Map.class),ADMIN_TOKEN,90101L,key),r.get("expect").get("backend"));
        assertThat(owner.queryForObject("SELECT count(*) FROM org_entity WHERE code IN ('FIX-IDEM-A','FIX-IDEM-B')",Integer.class)).isEqualTo(1);
    }
    @Test void organizationCrudPreservesCamelCasePaginationAndStaleVersionContract()throws Exception {
        var created=send("POST","/org/entities",Map.of("code","HTTP-NEW","name","Original name","legalName","Fixture legal"),ADMIN_TOKEN,90101L,UUID.randomUUID().toString());
        assertEnvelope(created,200,"OK");var data=json.readTree(created.body()).get("data");long id=data.get("id").asLong();
        assertThat(data.get("legalName").asString()).isEqualTo("Fixture legal");assertThat(data.get("legal_name")).isNull();
        var page=send("GET","/org/entities?keyword=HTTP-NEW&page=1&size=5",null,ADMIN_TOKEN,90101L,null);assertEnvelope(page,200,"OK");
        var pagination=json.readTree(page.body()).get("data");assertThat(pagination.get("total").asLong()).isEqualTo(1);assertThat(pagination.get("page").asLong()).isEqualTo(1);assertThat(pagination.get("size").asLong()).isEqualTo(5);assertThat(pagination.get("records").size()).isEqualTo(1);
        assertEnvelope(send("PUT","/org/entities/"+id,Map.of("version",1,"name","Updated name"),ADMIN_TOKEN,90101L,null),200,"OK");
        // customer-groups is not in M1: reuse its version rule on the implemented organization master.
        var stale=scenario("stale-edit-version").get("requests").get(0).get("expect").get("backend");
        expect(send("PUT","/org/entities/"+id,Map.of("version",1,"name","must-not-save"),ADMIN_TOKEN,90101L,null),stale);
        var detail=send("GET","/org/entities/"+id,null,ADMIN_TOKEN,90101L,null);assertEnvelope(detail,200,"OK");
        assertThat(json.readTree(detail.body()).get("data").get("name").asString()).isEqualTo("Updated name");
    }
    @Test void warehouseGrantCannotReassignItsWarehouseToAnInvisibleStore()throws Exception {
        owner.update("DELETE FROM sys_user_data_scope WHERE user_id=91101");
        owner.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) VALUES(90101,91101,'WAREHOUSE',91501,91101)");
        var moved=send("PUT","/org/warehouses/91501",Map.of("version",1,"storeId",91402),ADMIN_TOKEN,90101L,null);
        assertEnvelope(moved,404,"NOT_FOUND");
        assertThat(owner.queryForObject("SELECT store_id FROM org_warehouse WHERE id=91501",Long.class)).isEqualTo(91401);
        assertEnvelope(send("PUT","/org/warehouses/91501",Map.of("version",1,"name","Allowed warehouse rename"),ADMIN_TOKEN,90101L,null),200,"OK");
    }
    @Test void registeredBusinessAndFinancialReportRoutesRespectPermissions()throws Exception {
        // M2 business and M4 financial report routes are registered; this actor has only organization/configuration grants.
        assertEnvelope(send("GET","/sal/orders",null,ADMIN_TOKEN,90101L,null),403,"SYS_FORBIDDEN");
        assertEnvelope(send("GET","/fin/vouchers",null,ADMIN_TOKEN,90101L,null),403,"SYS_FORBIDDEN");
        assertEnvelope(send("GET","/fin/reports/income",null,ADMIN_TOKEN,90101L,null),403,"SYS_FORBIDDEN");
        var duplicate=send("POST","/org/entities",Map.of("code","HE1","name","Duplicate"),ADMIN_TOKEN,90101L,UUID.randomUUID().toString());assertEnvelope(duplicate,409,"MD_DUPLICATE");
        var invalid=send("POST","/org/stores",Map.of("entityId",9007199254740992L,"code","INVALID","name","Invalid parent"),ADMIN_TOKEN,90101L,UUID.randomUUID().toString());assertEnvelope(invalid,400,"SYS_BAD_REQUEST");
    }
    private JsonNode scenario(String id)throws Exception {
        Path base=Path.of("").toAbsolutePath().normalize();Path source=null;
        while(base!=null){Path candidate=base.resolve("jxc-web/tests/contracts/http-scenarios.json");if(Files.isRegularFile(candidate)){source=candidate;break;}base=base.getParent();}
        if(source==null)throw new IllegalStateException("Shared M0 HTTP scenarios are required");
        for(var s:json.readTree(Files.readString(source)).get("scenarios"))if(id.equals(s.get("id").asString()))return s;
        throw new IllegalArgumentException("Unknown shared HTTP scenario "+id);
    }
    private void expect(HttpResponse<String> response,JsonNode expected)throws Exception {
        String code=expected.get("code")==null?null:expected.get("code").asString();assertEnvelope(response,(int)expected.get("status").asLong(),code);
        if(expected.get("absent")!=null)for(var path:expected.get("absent"))assertThat(at(json.readTree(response.body()),path.asString())).isNull();
    }
    private JsonNode at(JsonNode node,String path){for(String key:path.split("\\.")){if(node==null)return null;node=key.matches("[0-9]+")?node.get(Integer.parseInt(key)):node.get(key);}return node;}
    private void assertEnvelope(HttpResponse<String> response,int status,String code)throws Exception {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);var envelope=json.readTree(response.body());
        assertThat(envelope.get("code")).isNotNull();assertThat(envelope.get("message")).isNotNull();assertThat(envelope.get("traceId").asString()).isNotBlank();assertThat(envelope.get("data")).isNotNull();
        if(code!=null)assertThat(envelope.get("code").asString()).isEqualTo(code);
        if(status>=400)assertThat(response.body()).doesNotContain("SELECT ","INSERT ","UPDATE ","org_entity","sys_user","password_hash","account_no_encrypted","jdbc:","SQLException","stackTrace");
    }
    private HttpResponse<String> send(String method,String path,Map<String,Object> body,String token,Long country,String key)throws Exception {
        var b=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1"+path)).timeout(Duration.ofSeconds(10));
        if(token!=null)b.header("Authorization","Bearer "+token);if(country!=null)b.header("X-Country-Id",country.toString());if(key!=null)b.header("Idempotency-Key",key);
        if(body!=null)b.header("Content-Type","application/json");
        b.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        return http.send(b.build(),HttpResponse.BodyHandlers.ofString());
    }
}
