package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import java.net.URI;
import java.net.http.*;
import java.math.BigDecimal;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Value;
import tools.jackson.databind.json.JsonMapper;

/** Original logistics pages read authoritative owner facts, with no display-time writes. */
class ShipmentPresentationIT extends SupplyFixtures {
    @Value("${local.server.port}") int port;
    final HttpClient http=HttpClient.newHttpClient();final JsonMapper json=JsonMapper.builder().build();
    @Test void receivedShipmentPresentationKeepsConservedQuantitiesAndSourceLabelsWithHistoricalSku() throws Exception {
        var delivery=delivery();var receipt=receipt(delivery);lgs.action(c(),"receipts",id(receipt),"confirm",Map.of(),key());
        long shipment=((Number)delivery.get("shipmentId")).longValue();
        seed("update md_country_sku set status='DISABLED' where country_id=101 and product_id=501");
        int events=owner.queryForObject("select count(*) from sys_biz_event",Integer.class),units=owner.queryForObject("select count(*) from md_product_unit_used",Integer.class);
        var detail=data(ok("/shipments/"+shipment));
        assertThat(detail).containsEntry("carrierName","Carrier").containsEntry("destWarehouseName","Mexico Warehouse").containsEntry("createdByName","Supply");
        var line=first(detail);assertThat(line).containsEntry("productCode","P").containsEntry("productName","Product").containsEntry("identityOk",true).containsEntry("quantityBalanced",true);
        assertThat(line.get("poNo")).isEqualTo(owner.queryForObject("select doc_no from pur_order",String.class));assertThat(line.get("sourceNo")).isEqualTo(owner.queryForObject("select doc_no from pur_export_node",String.class));assertThat(detail.get("poNos")).isEqualTo(line.get("poNo"));
        var totals=map(detail.get("totals"));number(totals,"shippedQty","10");number(totals,"receivedGoodQty","7");number(totals,"receivedFrozenQty","2");number(totals,"discrepancyQty","1");assertThat(detail).containsEntry("identityOk",true);
        var nodes=list(detail.get("nodes"));assertThat(nodes).allSatisfy(node->assertThat(node).containsEntry("operatorName","Supply").containsKeys("nodeLabel","corrected","correctsEventId"));assertThat(nodes).extracting(n->n.get("nodeLabel")).contains("离港","到港","放行","派送","实收");
        var related=data(ok("/shipments/"+shipment+"/related"));var presentedDelivery=list(related.get("deliveries")).getFirst();assertThat(presentedDelivery).containsEntry("warehouseName","Mexico Warehouse").containsEntry("receiptNo",receipt.get("docNo"));number(presentedDelivery,"totalQty","10");number(presentedDelivery,"receivedQty","9");
        var presentedReceipt=list(related.get("receipts")).getFirst();assertThat(presentedReceipt).containsEntry("warehouseName","Mexico Warehouse");number(presentedReceipt,"totalDispatch","10");number(presentedReceipt,"totalGood","7");number(presentedReceipt,"totalFrozen","2");number(presentedReceipt,"totalShort","1");
        var quantities=data(ok("/shipments/"+shipment+"/quantities"));assertThat(quantities).containsEntry("identityOk",true).containsKeys("lines","totals");assertThat(first(quantities)).containsEntry("identityOk",true);
        assertThat(owner.queryForObject("select count(*) from sys_biz_event",Integer.class)).isEqualTo(events);assertThat(owner.queryForObject("select count(*) from md_product_unit_used",Integer.class)).isEqualTo(units);
    }
    @Test void presentationRechecksEveryRelatedWarehouseAndMasksCostWithoutExtraMasterPermission() throws Exception {
        var shipmentFact=shipment(export(domestic(order(),20,0,0,true),20,true),20);long shipment=id(shipmentFact);
        lgs.action(c(),"shipments",shipment,"dispatch",Map.of("actualEtd","2026-10-15T00:00:00Z"),key());lgs.action(c(),"shipments",shipment,"nodes",Map.of("nodeType","ARRIVED_PORT","actualAt","2026-10-15T01:00:00Z"),key());lgs.action(c(),"shipments",shipment,"nodes",Map.of("nodeType","CUSTOMS_RELEASED","actualAt","2026-10-15T02:00:00Z"),key());
        var delivery=lgs.create(c(),"deliveries",Map.of("shipmentId",shipment,"bizDate","2026-10-15","dispatch",true,"lines",List.of(Map.of("shipmentLineId",id(first(shipmentFact)),"dispatchQty",10))),key());
        seed("insert into org_warehouse(id,country_id,entity_id,code,name) values(402,101,301,'OTHER','Other Warehouse')");
        // A different destination can be related to an authorized shipment. Its document still needs its own scope.
        var other=lgs.create(c(),"deliveries",Map.of("shipmentId",shipment,"destWarehouseId",402,"bizDate","2026-10-15","lines",List.of(Map.of("shipmentLineId",first(lgs.get(c(),"shipments",shipment)).get("id"),"dispatchQty",1))),key());
        var fee=lgs.create(c(),"fees",Map.of("refType","SHIPMENT","refId",shipment,"carrierId",802,"expenseItemId",803,"currency","MXN","amount",10,"estimateFlag","ACTUAL","bizDate","2026-10-15"),key());
        seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) values(101,201,'WAREHOUSE',401,201)");seed("update sys_role set permissions='[\"lgs:shipment:view\"]',field_policies='{}' where id=202");
        var detail=data(ok("/shipments/"+shipment));assertThat(detail).containsEntry("carrierName","Carrier");assertThat(first(detail)).containsEntry("productCode","P").containsEntry("identityOk",true);
        var related=data(ok("/shipments/"+shipment+"/related"));assertThat(list(related.get("deliveries"))).hasSize(1).allSatisfy(row->assertThat(row.get("id").toString()).isEqualTo(delivery.get("id").toString()));assertThat(related.toString()).doesNotContain("Other Warehouse",other.get("docNo").toString());
        seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,201,'BOOK',601,201)");
        var outputFee=list(data(ok("/shipments/"+shipment+"/related")).get("fees")).getFirst();assertThat(outputFee.get("id").toString()).isEqualTo(fee.get("id").toString());assertThat(outputFee).containsEntry("expenseItemName","Freight").containsEntry("carrierName","Carrier").doesNotContainKeys("amount","baseAmount","costSource","fxRate");
        seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) values(101,201,'WAREHOUSE',402,201)");assertThat(get("/shipments/"+shipment).statusCode()).isEqualTo(404);
        seed("update sys_role set permissions='[]' where id=202");assertThat(get("/shipments/"+shipment).statusCode()).isEqualTo(403);
    }
    void number(Map<String,Object> row,String key,String expected){assertThat(new BigDecimal(row.get(key).toString())).as(key).isEqualByComparingTo(expected);}
    @SuppressWarnings("unchecked") Map<String,Object> map(Object value){return (Map<String,Object>)value;}
    @SuppressWarnings("unchecked") List<Map<String,Object>> list(Object value){return (List<Map<String,Object>>)value;}
    Map<String,Object> data(HttpResponse<String> response){return map(json.readValue(response.body(),Map.class).get("data"));}
    HttpResponse<String> ok(String path)throws Exception{var response=get(path);assertThat(response.statusCode()).withFailMessage(response.body()).isEqualTo(200);return response;}
    HttpResponse<String> get(String path)throws Exception{return http.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1/lgs"+path)).header("Authorization","Bearer supply-fixture").header("X-Country-Id","101").GET().build(),HttpResponse.BodyHandlers.ofString());}
}
