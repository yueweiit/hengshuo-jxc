package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.inv.api.InventoryApi;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.*;
import java.time.LocalDate;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;

/** Candidate selection exercises the real HTTP authorization and PostgreSQL inventory facts. */
class CostAdjustmentBatchIT extends SupplyFixtures {
    @Autowired InventoryApi inventory;
    @Autowired JsonCodec json;
    @LocalServerPort int port;
    final LocalDate date = LocalDate.of(2026, 10, 15);

    long inbound(long line, String currency) {
        return inCountry(101, () -> inventory.inbound(c(), new InventoryApi.Inbound(
            601, 401, 501, BigDecimal.TEN, BigDecimal.ZERO, BigDecimal.ZERO,
            new InventoryApi.Source("LGS_RECEIPT", 801, line, "RCV"), date, null, null,
            new InventoryApi.PurchaseCost(2000, line, currency, new BigDecimal("2"), new BigDecimal("20"), BigDecimal.TEN)))).id();
    }

    Map<String, Object> get(String query) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/cst/adjustment-batches?" + query))
            .header("Authorization", "Bearer supply-fixture").header("X-Country-Id", "101").GET().build();
        var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
        var result = json.readMap(response.body());
        result.put("httpStatus", response.statusCode());
        return result;
    }

    @SuppressWarnings("unchecked") Map<String, Object> data(String query) throws Exception {
        var response = get(query);
        assertThat(response.get("httpStatus")).as(response.toString()).isEqualTo(200);
        return (Map<String, Object>) response.get("data");
    }
    @SuppressWarnings("unchecked") List<Map<String, Object>> records(Map<String, Object> result) {
        return (List<Map<String, Object>>) result.get("records");
    }

    @Test void candidatesShowRecognizableBatchProductBookAndActualRemainderWithoutWritingAdjustments() throws Exception {
        long batch = inbound(901, "MXN");
        seed("UPDATE inv_batch SET batch_no='COST-PICK-001' WHERE id=?", batch);
        inCountry(101, () -> inventory.outbound(c(), new InventoryApi.Outbound(601, 401, 501, null, new BigDecimal("3"), null,
            new InventoryApi.Source("SAL_OUTBOUND", 803, 902, "OUT"), date)));
        var row = records(data("target=INVENTORY")).getFirst();
        assertThat(((Number) row.get("batchId")).longValue()).isEqualTo(batch);
        assertThat(row).containsEntry("batchNo", "COST-PICK-001").containsEntry("productCode", "P")
            .containsEntry("productName", "Product").containsEntry("bookName", "Book")
            .containsEntry("warehouseName", "Mexico Warehouse").containsEntry("baseCurrency", "MXN").containsEntry("selectable", true);
        assertThat(new BigDecimal(row.get("onHandQty").toString())).isEqualByComparingTo("7");
        assertThat(new BigDecimal(row.get("unitCost").toString())).isEqualByComparingTo("2");
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_cost_adjustment", Integer.class)).isZero();
    }

    @Test void soldOutBatchRemainsSelectableForCogsButExplainsWhyInventoryCannotBeAdjusted() throws Exception {
        inbound(901, "MXN");
        inCountry(101, () -> inventory.outbound(c(), new InventoryApi.Outbound(601, 401, 501, null, BigDecimal.TEN, null,
            new InventoryApi.Source("SAL_OUTBOUND", 803, 902, "OUT"), date)));
        var inventoryRow = records(data("target=INVENTORY")).getFirst();
        assertThat(inventoryRow).containsEntry("selectable", false);
        assertThat(inventoryRow.get("unavailableReason").toString()).contains("库存");
        assertThat(records(data("target=COGS")).getFirst()).containsEntry("selectable", true);
    }

    @Test void missingRateNeverBecomesZeroCostOrASelectableBatch() throws Exception {
        inbound(901, "CNY");
        for (String target : List.of("INVENTORY", "COGS")) {
            var row = records(data("target=" + target)).getFirst();
            assertThat(row).containsEntry("selectable", false).containsEntry("unitCost", null);
            assertThat(row.get("unavailableReason").toString()).contains("成本");
        }
    }

    @Test void searchAndPaginationOperateOnAllCandidatesAndTreatPercentAsLiteralText() throws Exception {
        long a = inbound(901, "MXN"), b = inbound(902, "MXN");
        seed("UPDATE inv_batch SET batch_no='PICK-A' WHERE id=?", a);
        seed("UPDATE inv_batch SET batch_no='PICK-B' WHERE id=?", b);
        var second = data("keyword=PICK&size=1&page=2&bookId=601&warehouseId=401");
        assertThat(((Number) second.get("total")).intValue()).isEqualTo(2);
        assertThat(records(second)).singleElement().satisfies(r -> assertThat(r).containsEntry("batchNo", "PICK-A"));
        assertThat(records(data("keyword=Product"))).hasSize(2);
        assertThat(records(data("keyword=%25"))).isEmpty();
        assertThat(records(data("bookId=999"))).isEmpty();
        assertThat(records(data("warehouseId=999"))).isEmpty();
    }

    @Test void partialWarehouseAuthorityCannotSelectOrLearnTheRemainderOfACrossWarehouseBatch() throws Exception {
        long multi = inbound(901, "MXN"), local = inbound(902, "MXN");
        seed("INSERT INTO org_warehouse(id,country_id,entity_id,code,name) VALUES(402,101,301,'PRIVATE','Private Warehouse')");
        var source = new InventoryApi.Source("INV_TRANSFER", 9900, 9901, "TRANSFER");
        inCountry(101, () -> {
            inventory.transferOut(c(), new InventoryApi.Outbound(601, 401, 501, null, BigDecimal.ONE, multi, source, date));
            inventory.transferIn(c(), 601, 402, 501, source, List.of(new InventoryApi.Part(multi, BigDecimal.ONE)), date);
            return null;
        });
        seed("DELETE FROM sys_user_data_scope WHERE user_id=201");
        seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) VALUES(101,201,'WAREHOUSE',401,201)");
        var result = data("target=INVENTORY");
        assertThat(records(result)).singleElement().satisfies(r -> assertThat(((Number) r.get("batchId")).longValue()).isEqualTo(local));
        assertThat(json.write(result)).doesNotContain("Private Warehouse");
    }

    @Test void adjustmentCreatePermissionCanQueryWithoutUnrelatedInventoryOrGeneralCostViewPermission() throws Exception {
        inbound(901, "MXN");
        seed("UPDATE sys_role SET permissions='[\"cst:adjustment:create\"]' WHERE id=202");
        assertThat(records(data("target=INVENTORY"))).hasSize(1);
        seed("UPDATE sys_role SET field_policies='{\"COST\":\"HIDDEN\"}' WHERE id=202");
        assertThat(get("target=INVENTORY").get("httpStatus")).isEqualTo(403);
        seed("UPDATE sys_role SET permissions='[\"inv:stock:view\"]',field_policies='{\"COST\":\"WRITE\"}' WHERE id=202");
        assertThat(get("target=INVENTORY").get("httpStatus")).isEqualTo(403);
    }

    @Test void invalidTargetsPagingAndIdentifiersReturnErrorsInsteadOfEmptySuccess() throws Exception {
        for (String query : List.of("target=UNKNOWN", "page=0", "page=abc", "size=0", "size=201", "bookId=0", "warehouseId=bad")) {
            assertThat(get(query).get("httpStatus")).as(query).isEqualTo(400);
        }
    }
}
