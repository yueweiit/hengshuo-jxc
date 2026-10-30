package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import java.math.BigDecimal;
import java.util.*;
import com.hs.jxc.lgs.LogisticsInTransitQuery;
import com.hs.jxc.common.api.ApiException;
import java.net.URI;
import java.net.http.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** Native quantities must reach the board as warehouse/product groups, rather than raw shipment DTOs. */
class InTransitBoardIT extends SupplyFixtures {
    @Autowired LogisticsInTransitQuery board;
    @org.springframework.boot.test.web.server.LocalServerPort int port;
    @SuppressWarnings("unchecked") private List<Map<String,Object>> records(Map<String,Object> page) { return (List<Map<String,Object>>)page.get("records"); }
    @SuppressWarnings("unchecked") private List<Map<String,Object>> summaries(Map<String,Object> page) { return (List<Map<String,Object>>)page.get("summary"); }
    private void depart(Map<String,Object> sh) { lgs.action(c(),"shipments",id(sh),"dispatch",Map.of("actualEtd","2026-10-15T00:00:00Z"),key()); }
    @SuppressWarnings("unchecked")
    @Test void groupsDepartedLinesAndReturnsUnitAwareSummary() {
        var ex = export(domestic(order(), 20, 0, 0, true), 20, true);
        var one = shipment(ex, 6);
        var two = shipment(ex, 4);
        for (var sh : List.of(one, two))
            lgs.action(c(), "shipments", id(sh), "dispatch", Map.of("actualEtd", "2026-10-15T00:00:00Z"), key());
        var page = board.read(c(), Map.of());
        var records = (List<Map<String,Object>>) page.get("records");
        assertThat(records).hasSize(1);
        var row = records.getFirst();
        assertThat(row).containsEntry("warehouseId", 401L).containsEntry("productId", 501L).containsEntry("unit", "PCS");
        assertThat((BigDecimal) row.get("intlQty")).isEqualByComparingTo("10");
        assertThat((List<?>) row.get("shipments")).hasSize(2);
        assertThat((List<?>) page.get("summary")).hasSize(1);
    }

    @Test void repeatedProductSourceLinesCountOneShipmentAndDraftsDoNotContribute() {
        var domestic = domestic(order(),20,0,0,true);
        var a = export(domestic,6,true); var b = export(domestic,4,true);
        var sh = lgs.create(c(),"shipments",Map.of("bookId",601,"destWarehouseId",401,"carrierId",802,"transportMode","AIR","flightNo","F","awbNo","A","bizDate","2026-10-15","submit",true,
            "lines",List.of(Map.of("sourceLineId",id(first(a)),"baseQty",6),Map.of("sourceLineId",id(first(b)),"baseQty",4))),key());
        assertThat(records(board.read(c(),Map.of()))).isEmpty();
        depart(sh);
        var row = records(board.read(c(),Map.of())).getFirst();
        assertThat((List<?>)row.get("shipments")).hasSize(1);
        assertThat((BigDecimal)row.get("totalQty")).isEqualByComparingTo("10");
    }

    @Test void filteringPaginationAndMixedUnitsUseCompleteResults() {
        var original = shipment(export(domestic(order(),20,0,0,true),20,true),6); depart(original);
        seed("INSERT INTO md_product(id,product_code,name,base_unit) VALUES(502,'KG','Weight','KG')");
        seed("INSERT INTO md_country_sku(country_id,product_id) VALUES(101,502)");
        seed("INSERT INTO md_product_unit(product_id,unit,factor_to_base) VALUES(502,'KG',1)");
        var order = pur.create(c(),"orders",Map.of("bookId",601,"supplierId",801,"orderDate","2026-10-15","lines",List.of(Map.of("productId",502,"unit","KG","qty",5,"unitPrice",1))),key());
        order = pur.action(c(),"orders",id(order),"submit",Map.of(),key());
        var second = shipment(export(domestic(order,5,0,0,true),5,true),5); depart(second);
        var firstPage = board.read(c(),Map.of("size","1"));
        assertThat(firstPage).containsEntry("total",2).containsEntry("page",1);
        assertThat(records(firstPage)).hasSize(1);
        assertThat(summaries(firstPage)).extracting(r -> r.get("unit")).containsExactly("KG","PCS");
        var lastPage = board.read(c(),Map.of("size","1","page","9"));
        assertThat(lastPage).containsEntry("page",2).containsEntry("total",2);
        assertThat(lastPage.get("summary")).isEqualTo(firstPage.get("summary"));
        var selected = board.read(c(),Map.of("warehouseId","401","productId","502"));
        assertThat(records(selected)).hasSize(1);
        assertThat((BigDecimal)summaries(selected).getFirst().get("totalQty")).isEqualByComparingTo("5");
        assertThat(records(board.read(c(),Map.of("productId","999")))).isEmpty();
    }

    @Test void deliveringUsesActualDestinationAndBothDocumentScopes() {
        seed("INSERT INTO org_warehouse(id,country_id,entity_id,code,name) VALUES(402,101,301,'W2','Second Warehouse')");
        var sh = shipment(export(domestic(order(),20,0,0,true),20,true),10); depart(sh);
        lgs.action(c(),"shipments",id(sh),"nodes",Map.of("nodeType","ARRIVED_PORT","actualAt","2026-10-15T01:00:00Z"),key());
        lgs.action(c(),"shipments",id(sh),"nodes",Map.of("nodeType","CUSTOMS_RELEASED","actualAt","2026-10-15T02:00:00Z"),key());
        lgs.create(c(),"deliveries",Map.of("shipmentId",id(sh),"destWarehouseId",402,"bizDate","2026-10-15","dispatch",true,"dispatchedAt","2026-10-15T03:00:00Z","lines",List.of(Map.of("shipmentLineId",id(first(sh)),"dispatchQty",4))),key());
        var source = records(board.read(c(),Map.of("warehouseId","401"))).getFirst();
        var target = records(board.read(c(),Map.of("warehouseId","402"))).getFirst();
        assertThat((BigDecimal)source.get("pendingDeliveryQty")).isEqualByComparingTo("6");
        assertThat((BigDecimal)source.get("deliveringQty")).isZero();
        assertThat((BigDecimal)target.get("deliveringQty")).isEqualByComparingTo("4");
        assertThat((BigDecimal)summaries(board.read(c(),Map.of())).getFirst().get("totalQty")).isEqualByComparingTo("10");
        seed("DELETE FROM sys_user_data_scope WHERE country_id=101 AND user_id=201");
        seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) VALUES(101,201,'WAREHOUSE',401,201)");
        assertThat(records(board.read(c(),Map.of("warehouseId","402")))).isEmpty();
        seed("UPDATE sys_user_data_scope SET warehouse_id=402 WHERE country_id=101 AND user_id=201");
        assertThat(records(board.read(c(),Map.of()))).isEmpty();
    }

    @Test void resolvedDiscrepanciesDoNotRemainOpenAndNeverCountAsInTransit() {
        var receipt = receipt(delivery());
        lgs.action(c(),"receipts",id(receipt),"confirm",Map.of(),key());
        var row = records(board.read(c(),Map.of())).getFirst();
        assertThat((BigDecimal)row.get("totalQty")).isZero();
        assertThat((BigDecimal)row.get("openDiscrepancyQty")).isEqualByComparingTo("1");
        long difference = owner.queryForObject("SELECT id FROM lgs_discrepancy",Long.class);
        lgs.action(c(),"discrepancies",difference,"resolve",Map.of("resolution","CLAIM","remark","Confirmed claim","bizDate","2026-10-15"),key());
        assertThat(owner.queryForObject("SELECT discrepancy_qty FROM lgs_shipment_line",BigDecimal.class)).isEqualByComparingTo("1");
        assertThat(records(board.read(c(),Map.of()))).isEmpty();
    }

    @Test void delayConfigurationAndCompletedNodesAreNotSuccessfulEmptySubstitutes() {
        var ex = export(domestic(order(),20,0,0,true),20,true);
        var sh = lgs.create(c(),"shipments",Map.of("bookId",601,"destWarehouseId",401,"carrierId",802,"transportMode","AIR","flightNo","F","awbNo","A","bizDate","2026-10-15","plannedEta","2026-10-01T00:00:00Z","submit",true,"lines",List.of(Map.of("sourceLineId",id(first(ex)),"baseQty",10))),key());
        depart(sh);
        var missing = board.read(c(),Map.of("view","delays"));
        assertThat(missing.get("rule").toString()).contains("MISSING");
        seed("UPDATE sys_country SET config=jsonb_build_object('lgs.delay.toleranceHours','wrong') WHERE id=101");
        assertThat(board.read(c(),Map.of("view","delays")).get("rule").toString()).contains("INVALID");
        seed("UPDATE sys_country SET config=jsonb_build_object('lgs.delay.toleranceHours',0) WHERE id=101");
        var delays = board.read(c(),Map.of("view","delays","warehouseId","401","productId","501","size","1"));
        assertThat(records(delays)).hasSize(1);
        assertThat(records(delays).getFirst()).containsEntry("delayStage","到港").containsEntry("plannedAt","2026-10-01T00:00:00Z");
        assertThat((Long)records(delays).getFirst().get("delayHours")).isPositive();
        lgs.action(c(),"shipments",id(sh),"nodes",Map.of("nodeType","ARRIVED_PORT","actualAt","2026-10-15T01:00:00Z"),key());
        assertThat(records(board.read(c(),Map.of("view","delays")))).isEmpty();
    }

    @Test void invalidParametersAndMissingViewPermissionFailExplicitly() {
        for (var query : List.of(Map.of("page","0"),Map.of("size","101"),Map.of("size",""),Map.of("page","2147483648"),Map.of("warehouseId","abc"),Map.of("productId","9007199254740992"),Map.of("view","unknown"))) {
            assertThatThrownBy(() -> board.read(c(),query)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(400);
        }
        seed("UPDATE sys_role SET permissions='[\"pur:order:view\"]' WHERE id=202");
        assertThatThrownBy(() -> board.read(c(),Map.of())).isInstanceOf(ApiException.class).extracting("status").isEqualTo(403);
    }

    @Test void realHttpReturnsBoardEnvelopeWithoutWritingBusinessFacts() throws Exception {
        var sh = shipment(export(domestic(order(),20,0,0,true),20,true),6); depart(sh);
        var before = owner.queryForMap("SELECT (SELECT count(*) FROM sys_audit_log) audits,(SELECT count(*) FROM inv_batch) batches,(SELECT count(*) FROM sys_todo) todos");
        var request = HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1/lgs/in-transit?warehouseId=401&size=20"))
            .header("Authorization","Bearer supply-fixture").header("X-Country-Id","101").GET().build();
        var response = HttpClient.newHttpClient().send(request,HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        assertThat(response.body()).contains("\"summary\"","\"warehouseName\"","\"unit\":\"PCS\"").doesNotContain("unitPrice","sourceLineId");
        assertThat(owner.queryForMap("SELECT (SELECT count(*) FROM sys_audit_log) audits,(SELECT count(*) FROM inv_batch) batches,(SELECT count(*) FROM sys_todo) todos")).isEqualTo(before);
    }
}
