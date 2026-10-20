package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.sal.SalesService;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.*;
import tools.jackson.databind.json.JsonMapper;

/** Real source owners and persisted audit facts; every HTTP read rechecks current authority. */
class AuditQueryIT extends SupplyFixtures {
    @Autowired AuditWriter audit; @Autowired SalesService sales;
    @Value("${local.server.port}") int port;
    final HttpClient http=HttpClient.newHttpClient(); final JsonMapper json=JsonMapper.builder().build();
    @Test void documentTimelineAcceptsExistingPageAndWriterAliasesWithoutGeneralAuditPermissionAndWritesNothing() throws Exception {
        var order=order();var receipt=domestic(order,4,0,0,true);var shipment=shipment(export(receipt,4,true),2);
        seed("update sys_role set permissions='[\"pur:order:view\",\"lgs:shipment:view\"]' where id=202");
        seed("insert into sys_audit_log(country_id,user_id,action,resource_type,resource_id,after_value,occurred_at) values(101,201,'LOCAL_DATE','orders',?, '{\"name\":\"local-date\"}', '2026-10-16T01:00:00Z')",id(order));
        int audits=count("sys_audit_log"),events=count("sys_biz_event");
        var page=ok("?resourceType=purchase-order&resourceId="+id(order)+"&size=100");
        assertThat(rows(page)).hasSizeGreaterThanOrEqualTo(2);assertThat(rows(page)).allSatisfy(r->{assertThat(r).containsKeys("id","action","userName","occurredAt","resourceType","resourceId","beforeValue","afterValue");assertThat(r).containsEntry("userName","Supply");assertThat(((Number)r.get("resourceId")).longValue()).isEqualTo(id(order));});
        assertThat(rows(ok("?resourceType=PURCHASE_ORDER&resourceId="+id(order)+"&size=100"))).isEqualTo(rows(page));
        assertThat(rows(ok("?resourceType=shipment&resourceId="+id(shipment)))).isNotEmpty();
        assertThat(rows(ok("?resourceType=purchase-order&resourceId="+id(order)+"&from=2026-10-15&to=2026-10-15&action=LOCAL_DATE"))).hasSize(1);
        assertThat(get("").statusCode()).isEqualTo(403);
        assertThat(get("?resourceId="+id(order)).statusCode()).isEqualTo(400);
        assertThat(get("?resourceType=purchase-order&resourceId=9007199254740992").statusCode()).isEqualTo(400);
        seed("delete from sys_user_data_scope where user_id=201");assertThat(get("?resourceType=purchase-order&resourceId="+id(order)).statusCode()).isEqualTo(404);
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(101,201,'COUNTRY_ALL',201)");seed("update sys_role set permissions='[\"sys:audit:view\"]' where id=202");
        assertThat(get("?resourceType=purchase-order&resourceId="+id(order)).statusCode()).isEqualTo(403);
        assertThat(count("sys_audit_log")).isEqualTo(audits);assertThat(count("sys_biz_event")).isEqualTo(events);
    }
    @Test void generalListCountsOnlyCurrentlyAccessibleSourcesAndHidesUnknownSourcesOutsideCountryAll() throws Exception {
        var allowed=order();seed("insert into org_entity(id,country_id,code,name) values(302,101,'OTHER','Other')");seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,302,'OTHER','Other','MXN','ACTIVE')");seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(702,101,602,2026,10,'2026-10-01','2026-10-31','OPEN')");
        var denied=pur.create(c(),"orders",Map.of("entityId",302,"bookId",602,"supplierId",801,"orderDate","2026-10-15","lines",List.of(Map.of("productId",501,"unit","PCS","qty",1,"unitPrice",10))),key());
        append("UNREGISTERED",777,Map.of("name","unknown"),Map.of("name","unknown"),"unknown reason");
        seed("insert into sys_country(id,code,name,default_currency,timezone,status) values(102,'CN','China','CNY','Asia/Shanghai','ACTIVE')");seed("insert into sys_audit_log(country_id,user_id,action,resource_type,resource_id,after_value) values(102,201,'FOREIGN','orders',?, '{\"name\":\"foreign-secret\"}')",id(allowed));
        seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,201,'BOOK',601,201)");seed("update sys_role set permissions='[\"sys:audit:view\",\"pur:order:view\"]' where id=202");
        int visible=owner.queryForObject("select count(*) from sys_audit_log where country_id=101 and resource_type='orders' and resource_id=?",Integer.class,id(allowed));
        var page=ok("?size=1");assertThat(((Number)page.get("total")).intValue()).isEqualTo(visible);assertThat(rows(page)).hasSize(1);assertThat(ok("?size=100").toString()).doesNotContain("unknown","FOREIGN","foreign-secret");assertThat(rows(ok("?resourceType=purchase-order&size=100"))).allSatisfy(r->assertThat(((Number)r.get("resourceId")).longValue()).isNotEqualTo(id(denied)));
        seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(101,201,'COUNTRY_ALL',201)");seed("update sys_role set permissions='[\"sys:audit:view\"]' where id=202");
        var country=ok("?resourceType=UNREGISTERED&size=100");assertThat(rows(country)).hasSize(1);assertThat(rows(country).getFirst()).containsEntry("resourceType","UNREGISTERED");assertThat(rows(ok("?resourceType=purchase-order"))).isEmpty();assertThat(get("?resourceType=UNREGISTERED&resourceId=777").statusCode()).isEqualTo(404);
    }
    @Test void snapshotsUseCurrentFieldPoliciesAndAlwaysRemoveCredentialsAndEncryptedValuesRecursively() throws Exception {
        var order=order();var payload=new LinkedHashMap<String,Object>();payload.put("name","safe-name");payload.put("amount",123);payload.put("unitCost",12);payload.put("accountNo","visible-bank");payload.put("passwordHash","password-secret");payload.put("access_token","token-secret");payload.put("access_key","storage-secret");payload.put("tokenDigest","digest-secret");payload.put("account_no_encrypted","cipher-secret");payload.put("nested",List.of(Map.of("privateKey","private-secret","unit_cost",9,"name","safe-nested")));payload.put("creditEvaluation","{\"available\":444,\"password\":\"nested-secret\"}");
        append("orders",id(order),payload,payload,"mask-example");
        seed("update sys_role set permissions='[\"pur:order:view\"]',field_policies='{}' where id=202");
        var hidden=testRecord(ok("?resourceType=purchase-order&resourceId="+id(order)));var after=map(hidden.get("afterValue"));assertThat(after).containsEntry("name","safe-name").doesNotContainKeys("amount","unitCost","accountNo","creditEvaluation");assertThat(hidden.toString()).doesNotContain("password-secret","token-secret","cipher-secret","private-secret","nested-secret","storage-secret","digest-secret","unitCost=9");
        seed("update sys_role set field_policies='{\"COST\":\"READ\",\"ORDER_TOTAL\":\"READ\",\"BANK_INFO\":\"READ\",\"CREDIT\":\"READ\"}' where id=202");
        var readable=testRecord(ok("?resourceType=purchase-order&resourceId="+id(order)));assertThat(map(readable.get("afterValue"))).containsEntry("amount",123).containsEntry("accountNo","visible-bank");assertThat(readable.toString()).doesNotContain("password-secret","token-secret","cipher-secret","private-secret","nested-secret","storage-secret","digest-secret");
    }
    @Test void salesAmountsFollowSalesPolicyAndWarehouseOnlyScopeCannotReadWholeHistoricalSnapshots() throws Exception {
        seed("insert into org_warehouse(id,country_id,entity_id,code,name) values(402,101,301,'OTHER','Other warehouse')");seed("insert into md_customer(id,country_id,code,name) values(811,101,'C','Customer')");seed("insert into sal_price(country_id,product_id,price_type,unit,min_qty,price,currency,effective_from) values(101,501,'BASE','PCS',1,20,'MXN','2026-10-01')");
        var order=sales.create(c(),Map.of("entityId",301,"bookId",601,"customerId",811,"paymentType","CASH","orderDate","2026-10-15","lines",List.of(Map.of("productId",501,"unit","PCS","qty",5,"allocs",List.of(Map.of("warehouseId",401,"allocQty",2),Map.of("warehouseId",402,"allocQty",3))))),key());
        append("SALES_ORDER",id(order),null,Map.of("amount",100,"lines",List.of(Map.of("warehouseId",401,"qty",2),Map.of("warehouseId",402,"qty",3))),"OTHER-WAREHOUSE-HISTORY");
        seed("update sys_role set permissions='[\"sal:order:view\"]',field_policies='{\"COST\":\"READ\"}' where id=202");
        assertThat(map(testRecord(ok("?resourceType=sales-order&resourceId="+id(order))).get("afterValue"))).doesNotContainKeys("amount");
        seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) values(101,201,'WAREHOUSE',401,201)");seed("update sys_role set field_policies='{\"COST\":\"READ\",\"ORDER_TOTAL\":\"READ\",\"CUSTOMER_PRICE\":\"READ\"}' where id=202");
        var page=ok("?resourceType=sales-order&resourceId="+id(order));assertThat(rows(page)).isNotEmpty().allSatisfy(r->{assertThat(r.get("beforeValue")).isNull();assertThat(r.get("afterValue")).isNull();assertThat(r.get("reason")).isNull();});assertThat(page.toString()).doesNotContain("OTHER-WAREHOUSE-HISTORY","approvalKey","totalAmount");
    }
    void append(String type,long id,Object before,Object after,String reason){inCountry(101,()->{audit.append(101,201,"AUDIT_TEST",type,id,before,after,reason);return null;});}
    int count(String table){return owner.queryForObject("select count(*) from "+table,Integer.class);}
    Map<String,Object> testRecord(Map<String,Object> page){return rows(page).stream().filter(r->"AUDIT_TEST".equals(r.get("action"))).findFirst().orElseThrow();}
    @SuppressWarnings("unchecked") Map<String,Object> map(Object value){return (Map<String,Object>)value;}
    @SuppressWarnings("unchecked") List<Map<String,Object>> rows(Map<String,Object> page){return (List<Map<String,Object>>)page.get("records");}
    Map<String,Object> ok(String query)throws Exception{var response=get(query);assertThat(response.statusCode()).withFailMessage(response.body()).isEqualTo(200);return map(json.readValue(response.body(),Map.class).get("data"));}
    HttpResponse<String> get(String query)throws Exception{return http.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1/sys/audit-logs"+query)).header("Authorization","Bearer supply-fixture").header("X-Country-Id","101").GET().build(),HttpResponse.BodyHandlers.ofString());}
}
