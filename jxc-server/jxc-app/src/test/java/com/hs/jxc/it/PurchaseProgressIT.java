package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Value;
import tools.jackson.databind.json.JsonMapper;

/** Real owner APIs create facts; the HTTP progress read must preserve source, row and field scope. */
class PurchaseProgressIT extends SupplyFixtures {
    @org.springframework.beans.factory.annotation.Autowired com.hs.jxc.sys.service.AuthorizationService sourceAuthorization;
    @Value("${local.server.port}") int port;
    final HttpClient http=HttpClient.newHttpClient();final JsonMapper json=JsonMapper.builder().build();
    @Test void progressAggregatesOnlyCurrentOrderLinesAcrossMixedExportShipmentAndReceiptWithoutWrites() throws Exception {
        var one=order();var two=order();var domesticOne=domestic(one,8,0,0,true);var domesticTwo=domestic(two,8,0,0,true);
        var export=pur.create(c(),"export-nodes",Map.of("exportDate","2026-10-15","declarationNo","DECL-MIXED","confirm",true,"lines",List.of(Map.of("receiptLineId",id(first(domesticOne)),"qty",4),Map.of("receiptLineId",id(first(domesticTwo)),"qty",4))),key());
        inCountry(101,()->{var a=sourceAuthorization.authorize(c());assertThat(pur.logisticsSourceReference(a,601,id(one),"EXPORT_NODE_LINE",id(first(export)))).containsEntry("poNo",one.get("docNo")).containsEntry("sourceNo",export.get("docNo")).hasSize(2);assertThat(pur.logisticsSourceReference(a,601,id(one),"DOMESTIC_RECEIPT_LINE",id(first(domesticOne)))).containsEntry("poNo",one.get("docNo")).containsEntry("sourceNo",domesticOne.get("docNo"));return null;});
        assertThatThrownBy(()->inCountry(101,()->pur.logisticsSourceReference(sourceAuthorization.authorize(c()),601,id(two),"EXPORT_NODE_LINE",id(first(export))))).isInstanceOf(com.hs.jxc.common.api.ApiException.class);
        assertThatThrownBy(()->inCountry(101,()->pur.logisticsSourceReference(sourceAuthorization.authorize(c()),602,id(one),"EXPORT_NODE_LINE",id(first(export))))).isInstanceOf(com.hs.jxc.common.api.ApiException.class);
        var shipment=lgs.create(c(),"shipments",Map.of("bookId",601,"destWarehouseId",401,"carrierId",802,"transportMode","AIR","flightNo","F1","awbNo","MIXED-AWB","bizDate","2026-10-15","submit",true,"lines",lines(export).stream().map(l->Map.of("sourceLineId",l.get("id"),"baseQty",4)).toList()),key());
        lgs.action(c(),"shipments",id(shipment),"dispatch",Map.of("actualEtd","2026-10-15T00:00:00Z"),key());lgs.action(c(),"shipments",id(shipment),"nodes",Map.of("nodeType","ARRIVED_PORT","actualAt","2026-10-15T01:00:00Z"),key());lgs.action(c(),"shipments",id(shipment),"nodes",Map.of("nodeType","CUSTOMS_RELEASED","actualAt","2026-10-15T02:00:00Z"),key());
        var delivery=lgs.create(c(),"deliveries",Map.of("shipmentId",id(shipment),"bizDate","2026-10-15","dispatch",true,"dispatchedAt","2026-10-15T03:00:00Z","lines",lines(shipment).stream().map(l->Map.of("shipmentLineId",l.get("id"),"dispatchQty",2)).toList()),key());
        var receipt=lgs.create(c(),"receipts",Map.of("deliveryId",id(delivery),"bizDate","2026-10-15","lines",lines(delivery).stream().map(l->Map.of("deliveryLineId",l.get("id"),"goodQty",2)).toList()),key());lgs.action(c(),"receipts",id(receipt),"confirm",Map.of(),key());
        pur.action(c(),"orders",id(one),"cancel-lines",Map.of("bizDate","2026-10-15","reason","CURRENT-ORDER-CANCEL","lines",List.of(Map.of("orderLineId",id(first(one)),"cancelQty",1))),key());pur.action(c(),"orders",id(two),"cancel-lines",Map.of("bizDate","2026-10-15","reason","OTHER-ORDER-CANCEL","lines",List.of(Map.of("orderLineId",id(first(two)),"cancelQty",1))),key());
        // A read of historical facts must still work after the country SKU is disabled.
        seed("update md_country_sku set status='DISABLED' where country_id=101 and product_id=501");
        seed("update md_supplier set status='DISABLED' where id=801");seed("update org_entity set status='DISABLED' where id=301");
        int events=owner.queryForObject("select count(*) from sys_biz_event",Integer.class),batches=owner.queryForObject("select count(*) from inv_batch",Integer.class);
        var result=data(ok(id(one)));assertThat(result).containsKeys("order","receipts","exports","shipments","mxReceipts","cancels");assertId(map(result.get("order")),"id",id(one));
        assertThat(map(result.get("order"))).containsEntry("supplierName","Supplier").containsEntry("entityName","Entity").containsEntry("createdByName","Supply");
        assertThat(new java.math.BigDecimal(first(map(result.get("order"))).get("undeliveredQty").toString())).isEqualByComparingTo("11");
        for(String key:List.of("receipts","exports","shipments","mxReceipts","cancels"))assertThat(list(result.get(key))).as(key).hasSize(1);
        assertThat(list(result.get("receipts")).getFirst()).containsEntry("receiptDate","2026-10-15");
        assertThat(lines(list(result.get("exports")).getFirst())).hasSize(1);assertThat(lines(list(result.get("exports")).getFirst()).getFirst()).containsEntry("productCode","P");assertId(lines(list(result.get("exports")).getFirst()).getFirst(),"orderLineId",id(first(one)));
        var selectedShipment=list(result.get("shipments")).getFirst();assertThat(lines(selectedShipment)).hasSize(1);assertThat(lines(selectedShipment).getFirst()).containsEntry("productCode","P");assertId(lines(selectedShipment).getFirst(),"poId",id(one));assertId(lines(selectedShipment).getFirst(),"poLineId",id(first(one)));
        assertThat(list(result.get("mxReceipts")).getFirst()).containsEntry("receiptNo",receipt.get("docNo")).containsEntry("warehouseName","Mexico Warehouse").containsEntry("productCode","P");assertId(list(result.get("mxReceipts")).getFirst(),"poLineId",id(first(one)));
        assertThat(list(result.get("cancels")).getFirst()).containsEntry("reason","CURRENT-ORDER-CANCEL").containsEntry("cancelledByName","Supply").containsKey("cancelledAt");assertThat(result.toString()).doesNotContain("OTHER-ORDER-CANCEL");
        assertThat(owner.queryForObject("select count(*) from sys_biz_event",Integer.class)).isEqualTo(events);assertThat(owner.queryForObject("select count(*) from inv_batch",Integer.class)).isEqualTo(batches);
        domestic(one,11,0,0,true);
        assertThat(new java.math.BigDecimal(first(map(data(ok(id(one))).get("order"))).get("undeliveredQty").toString())).as("receipt plus prior cancellation completes delivery").isZero();
    }
    @Test void progressRechecksBookWarehousePermissionAndCostPolicy() throws Exception {
        var one=order();var domestic=domestic(one,8,0,0,true);var export=export(domestic,4,true);shipment(export,2);
        seed("insert into org_entity(id,country_id,code,name) values(302,101,'OTHER','Other entity')");seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,302,'OTHER','Other book','MXN','ACTIVE')");seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(702,101,602,2026,10,'2026-10-01','2026-10-31','OPEN')");
        var two=pur.create(c(),"orders",Map.of("entityId",302,"bookId",602,"supplierId",801,"orderDate","2026-10-15","lines",List.of(Map.of("productId",501,"unit","PCS","qty",1,"unitPrice",10))),key());
        seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,201,'BOOK',601,201)");seed("update sys_role set permissions='[\"pur:order:view\"]',field_policies='{}' where id=202");
        var result=data(ok(id(one)));assertThat(first(map(result.get("order")))).containsKey("undeliveredQty");assertThat(new java.math.BigDecimal(first(map(result.get("order"))).get("undeliveredQty").toString())).isEqualByComparingTo("12");assertThat(map(result.get("order"))).containsEntry("supplierName","Supplier").containsEntry("entityName","Entity").containsEntry("createdByName","Supply");assertThat(map(result.get("order"))).doesNotContainKeys("totalAmount");assertThat(lines(map(result.get("order"))).getFirst()).doesNotContainKeys("unitPrice","amount");assertThat(list(result.get("shipments"))).hasSize(1);assertThat(get(id(two)).statusCode()).isEqualTo(404);
        seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) values(101,201,'WAREHOUSE',401,201)");assertThat(get(id(one)).statusCode()).isEqualTo(404);
        seed("update sys_role set permissions='[]' where id=202");assertThat(get(id(one)).statusCode()).isEqualTo(403);
    }
    void assertId(Map<String,Object> row,String key,long expected){assertThat(((Number)row.get(key)).longValue()).as(key).isEqualTo(expected);}
    @SuppressWarnings("unchecked") Map<String,Object> map(Object raw){return (Map<String,Object>)raw;}
    @SuppressWarnings("unchecked") List<Map<String,Object>> list(Object raw){return (List<Map<String,Object>>)raw;}
    List<Map<String,Object>> lines(Map<String,Object> raw){return list(raw.get("lines"));}
    Map<String,Object> data(HttpResponse<String> response){return map(json.readValue(response.body(),Map.class).get("data"));}
    HttpResponse<String> ok(long id) throws Exception {var response=get(id);assertThat(response.statusCode()).withFailMessage(response.body()).isEqualTo(200);return response;}
    HttpResponse<String> get(long id) throws Exception {return http.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1/pur/orders/"+id+"/progress")).header("Authorization","Bearer supply-fixture").header("X-Country-Id","101").GET().build(),HttpResponse.BodyHandlers.ofString());}
}
