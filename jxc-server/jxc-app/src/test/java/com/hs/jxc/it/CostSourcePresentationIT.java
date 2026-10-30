package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.JsonCodec;
import java.net.URI;
import java.net.http.*;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;

/** Source labels and advertised batch filtering, using native procurement and receipt commands. */
class CostSourcePresentationIT extends SupplyFixtures {
    @Autowired JsonCodec json;
    @LocalServerPort int port;

    @SuppressWarnings("unchecked")
    Map<String,Object> costs(String query) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1/cst/inbound-costs?"+query))
            .header("Authorization","Bearer supply-fixture").header("X-Country-Id","101").GET().build();
        var response = HttpClient.newHttpClient().send(request,HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return (Map<String,Object>)json.readMap(response.body()).get("data");
    }

    long received() {
        var delivery = delivery();
        var receipt = receipt(delivery);
        lgs.action(c(),"receipts",id(receipt),"confirm",Map.of(),key());
        return owner.queryForObject("SELECT id FROM cst_inbound_cost",Long.class);
    }

    @Test void nativeReceiptLabelsIdentifyTheSamePurchaseReceiptAndBatchWithoutChangingCostFacts() throws Exception {
        long cost = received();
        var before = owner.queryForMap("SELECT * FROM cst_inbound_cost WHERE id=?",cost);
        var data = costs("bookId=601");
        var row = records(data).getFirst();
        assertThat(((Number)row.get("id")).longValue()).isEqualTo(cost);
        assertThat(row).containsEntry("poNo",owner.queryForObject("SELECT doc_no FROM pur_order",String.class))
            .containsEntry("receiptNo",owner.queryForObject("SELECT doc_no FROM lgs_receipt",String.class))
            .containsEntry("batchNo",owner.queryForObject("SELECT batch_no FROM inv_batch",String.class));
        assertThat(owner.queryForMap("SELECT * FROM cst_inbound_cost WHERE id=?",cost)).isEqualTo(before);
    }

    @Test void batchKeywordFiltersBeforePagingAndDoesNotTreatWildcardsAsMatches() throws Exception {
        received();
        String batch = owner.queryForObject("SELECT batch_no FROM inv_batch",String.class);
        assertThat(records(costs("keyword="+URLEncoder.encode(batch,StandardCharsets.UTF_8)))).hasSize(1);
        for (String keyword : List.of("AI05-NO-SUCH-BATCH","%","_")) {
            var result = costs("keyword="+URLEncoder.encode(keyword,StandardCharsets.UTF_8));
            assertThat(records(result)).as(keyword).isEmpty();
            assertThat(((Number)result.get("total")).longValue()).isZero();
            assertThat(((Map<?,?>)result.get("counts")).values().stream().mapToInt(value->((Number)value).intValue()).sum()).isZero();
        }
    }

    @Test void sourceLabelsAndSupplierFilteringNeverRevealAnotherWarehouse() throws Exception {
        received();
        seed("UPDATE sys_role SET permissions='[\"cst:cost:view\"]',field_policies='{\"COST\":\"READ\"}' WHERE id=202");
        seed("DELETE FROM sys_user_data_scope WHERE user_id=201");
        seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) VALUES(101,201,'WAREHOUSE',401,201)");
        assertThat(records(costs("supplierId=801"))).hasSize(1);
        assertThat(records(costs("supplierId=801")).getFirst()).containsEntry("poNo",owner.queryForObject("SELECT doc_no FROM pur_order",String.class));
        assertThat(records(costs("supplierId=999999"))).isEmpty();
        seed("DELETE FROM sys_user_data_scope WHERE user_id=201");
        seed("INSERT INTO org_warehouse(id,country_id,entity_id,code,name) VALUES(402,101,301,'AI05-OTHER','Other')");
        seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) VALUES(101,201,'WAREHOUSE',402,201)");
        assertThat(records(costs("keyword="))).isEmpty();
    }

    @SuppressWarnings("unchecked")
    List<Map<String,Object>> records(Map<String,Object> data) { return (List<Map<String,Object>>)data.get("records"); }

    @AfterEach void saveSourceEvidence(TestInfo test) throws Exception {
        String directory = System.getProperty("jxc.ai05.evidenceDir");
        if (directory == null) return;
        var evidence = new LinkedHashMap<String,Object>();
        evidence.put("method",test.getTestMethod().orElseThrow().getName());
        evidence.put("sourceSha",System.getProperty("jxc.ai05.sourceSha","UNSPECIFIED"));
        evidence.put("creation","PurchaseServiceImpl and LogisticsService native commands; configuration only is seeded");
        for (String table : List.of("pur_order","pur_order_line","pur_domestic_receipt","pur_export_node","lgs_shipment","lgs_delivery","lgs_receipt","lgs_receipt_line","inv_batch","inv_stock_txn","cst_inbound_cost"))
            evidence.put(table,owner.queryForList("SELECT * FROM "+table+" ORDER BY id"));
        Files.createDirectories(Path.of(directory));
        Files.writeString(Path.of(directory,test.getTestMethod().orElseThrow().getName()+".json"),json.write(evidence),StandardCharsets.UTF_8);
    }
}
