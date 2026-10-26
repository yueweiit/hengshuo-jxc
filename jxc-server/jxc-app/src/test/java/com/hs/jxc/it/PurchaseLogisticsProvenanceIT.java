package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.inv.service.ReplenishmentService;
import com.hs.jxc.sal.SalesService;
import com.hs.jxc.sys.service.SessionService;
import com.hs.jxc.workflow.service.WorkflowService;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.json.JsonMapper;

/** 原生采购来源链验收；SQL仅准备隔离基础配置和只读核对，不插库存或成本事实。 */
class PurchaseLogisticsProvenanceIT extends SupplyFixtures {
    @Autowired ReplenishmentService replenishments;
    @Autowired SalesService sales;
    @Autowired WorkflowService workflow;
    @Autowired com.hs.jxc.sys.service.AuthorizationService authorization;
    @org.springframework.boot.test.web.server.LocalServerPort int runtimePort;
    private long actor = 201;
    private String uiAction;
    private final JsonMapper json = JsonMapper.builder().build();

    @Override RequestContext c() {
        return new RequestContext(actor, 101L, "AI02-TEST", token(actor));
    }

    private String token(long user) {
        return user == 201 ? HASH : SessionService.digest("AI02-TEST-" + user);
    }

    @BeforeEach void scopedTestJobs() {
        actor = 201;
        seed("update sys_role set field_policies='{\"COST\":\"WRITE\",\"ORDER_TOTAL\":\"HIDDEN\"}' where id=202");
        permissions(202, List.of("pur:order:create", "pur:order:submit", "pur:order:view",
            "pur:order:edit", "pur:order:cancel", "pur:order:close", "inv:replenish:create",
            "inv:replenish:decide", "inv:stock:view"));
        job(211, 212, "AI02-LOGISTICS", List.of("pur:order:view", "pur:receipt:create",
            "pur:receipt:confirm", "pur:export:create", "pur:export:confirm", "lgs:shipment:create",
            "lgs:shipment:edit", "lgs:shipment:view", "lgs:shipment:dispatch", "lgs:node:record",
            "lgs:delivery:create", "lgs:delivery:dispatch", "lgs:discrepancy:handle", "lgs:hold:create",
            "lgs:hold:release", "lgs:transship:create", "lgs:fee:create", "lgs:fee:confirm"));
        job(221, 222, "AI02-WAREHOUSE", List.of("lgs:shipment:view", "lgs:receipt:confirm"));
        seed("insert into md_exchange_rate(country_id,from_ccy,to_ccy,rate_date,scope,rate,status,confirmed_by,confirmed_at) values(101,'CNY','MXN','2026-10-15','PURCHASE_COST',2.5,'CONFIRMED',201,clock_timestamp())");
        assertThat(owner.queryForList("select permissions::text from sys_role", String.class))
            .noneMatch(value -> value.contains("\"*\""));
    }

    private void permissions(long role, List<String> permissions) {
        seed("update sys_role set permissions=?::jsonb where id=?", json.writeValueAsString(permissions), role);
    }

    private void job(long user, long role, String code, List<String> permissions) {
        seed("insert into sys_user(id,username,password_hash,display_name,status) values(?,?,'unused',?,'ENABLED')", user, code, code);
        seed("insert into sys_session(token_hash,user_id,expires_at) values(?,?,clock_timestamp()+interval '1 hour')", token(user), user);
        seed("insert into sys_role(id,country_id,code,name,permissions,field_policies) values(?,101,?,?,?::jsonb,'{\"COST\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\"}')", role, code, code, json.writeValueAsString(permissions));
        seed("insert into sys_user_role(country_id,user_id,role_id) values(101,?,?)", user, role);
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,?,'BOOK',601,201)", user);
        if (Set.of(211L, 221L, 231L).contains(user))
            seed("insert into sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) values(101,?,'WAREHOUSE',401,201)", user);
    }

    private Map<String,Object> purchase(String unit, int qty, int price) {
        actor = 201;
        var order = pur.create(c(), "orders", Map.of("bookId", 601, "supplierId", 801,
            "orderDate", "2026-10-15", "remark", "AI02-TEST", "lines",
            List.of(Map.of("productId", 501, "unit", unit, "qty", qty, "unitPrice", price))), key());
        return pur.action(c(), "orders", id(order), "submit", Map.of(), key());
    }

    private Map<String,Object> depart(Map<String,Object> shipment) {
        lgs.action(c(), "shipments", id(shipment), "dispatch", Map.of("actualEtd", "2026-10-15T00:00:00Z"), key());
        lgs.action(c(), "shipments", id(shipment), "nodes", Map.of("nodeType", "ARRIVED_PORT", "actualAt", "2026-10-15T01:00:00Z"), key());
        return lgs.action(c(), "shipments", id(shipment), "nodes", Map.of("nodeType", "CUSTOMS_RELEASED", "actualAt", "2026-10-15T02:00:00Z"), key());
    }

    private Map<String,Object> deliver(Map<String,Object> shipment, int qty) {
        actor = 211;
        return lgs.create(c(), "deliveries", Map.of("shipmentId", id(shipment), "bizDate", "2026-10-15",
            "dispatch", true, "dispatchedAt", "2026-10-15T03:00:00Z", "lines",
            List.of(Map.of("shipmentLineId", id(first(shipment)), "dispatchQty", qty))), key());
    }

    private Map<String,Object> receive(Map<String,Object> delivery, int good, int damaged, int pending, int shortage) {
        actor = 221;
        var receipt = lgs.create(c(), "receipts", Map.of("deliveryId", id(delivery), "bizDate", "2026-10-15",
            "lines", List.of(Map.of("deliveryLineId", id(first(delivery)), "goodQty", good,
                "damagedQty", damaged, "pendingInspectQty", pending, "shortQty", shortage))), key());
        return lgs.action(c(), "receipts", id(receipt), "confirm", Map.of(), key());
    }

    private void quantity(String sql, String expected, Object... args) {
        assertThat(owner.queryForObject(sql, BigDecimal.class, args)).isEqualByComparingTo(expected);
    }

    private void conserved(long shipment) {
        assertThat(owner.queryForObject("select bool_and(shipped_qty=intl_qty+pending_delivery_qty+on_hold_qty+delivering_qty+received_good_qty+received_frozen_qty+discrepancy_qty) from lgs_shipment_line where shipment_id=?", Boolean.class, shipment)).isTrue();
    }

    /** 可选本轮证据目录；保存逐行来源、金额和权限，绝不输出token或密码。 */
    private void evidence(String name) throws Exception {
        String directory = System.getProperty("ai02.evidenceDir");
        if (directory == null) return;
        var snapshot = new LinkedHashMap<String,Object>();
        snapshot.put("scenario", name);
        snapshot.put("uiAction", uiAction);
        snapshot.put("creationPath", "PurchaseService -> LogisticsService -> InventoryApi native inbound");
        for (String table : List.of("pur_order", "pur_order_line", "pur_domestic_receipt", "pur_domestic_receipt_line",
            "pur_inspect_convert", "pur_export_node", "pur_export_node_line", "lgs_shipment", "lgs_shipment_line",
            "lgs_delivery", "lgs_delivery_line", "lgs_receipt", "lgs_receipt_line", "lgs_discrepancy",
            "lgs_container", "lgs_transship", "lgs_transship_line", "lgs_hold", "lgs_hold_line", "lgs_hold_release", "lgs_fee", "lgs_node",
            "inv_batch", "inv_stock_summary", "cst_inbound_cost", "inv_replenish", "inv_replenish_link",
            "sal_order", "sal_order_line", "wf_instance", "wf_task"))
            snapshot.put(table, owner.queryForList("select * from " + table));
        snapshot.put("events", owner.queryForList("select id,event_type,source_type,source_id from sys_biz_event order by id"));
        snapshot.put("testJobGrants", owner.queryForList("select id,code,permissions,field_policies from sys_role order by id"));
        snapshot.put("testJobScopes", owner.queryForList("select user_id,scope_type,book_id,warehouse_id,store_id from sys_user_data_scope order by user_id,scope_type"));
        Path target = Path.of(directory, name + ".json");
        Files.createDirectories(target.getParent());
        Files.writeString(target, json.writerWithDefaultPrettyPrinter().writeValueAsString(snapshot), StandardCharsets.UTF_8);
        String browserScript = System.getProperty("ai02.browserScript");
        if (browserScript != null) {
            var browser = new ProcessBuilder("node", browserScript, target.toString(), String.valueOf(runtimePort),
                System.getProperty("ai02.frontendDir"), System.getProperty("ai02.playwrightModule"))
                .redirectErrorStream(true).redirectOutput(Path.of(directory, name + "-browser.log").toFile()).start();
            try {
                assertThat(browser.waitFor(120, TimeUnit.SECONDS)).as("独立页面核验应在120秒内退出").isTrue();
                assertThat(browser.exitValue()).as("页面核验日志：" + name + "-browser.log").isZero();
            } finally {
                if (browser.isAlive()) {
                    browser.descendants().forEach(ProcessHandle::destroyForcibly);
                    browser.destroyForcibly();
                }
            }
        }
    }

    @Test void shortage50to48AndLaterArrivalOnlyAddsTheMissingTwoWithOriginalCost() throws Exception {
        var order = purchase("BOX", 25, 10);
        actor = 211;
        var domestic = domestic(order, 50, 0, 0, true);
        assertThat(owner.queryForObject("select count(*) from inv_batch", Integer.class)).isZero();
        var export = export(domestic, 50, true);
        var shipment = shipment(export, 50);
        depart(shipment);
        assertThat(owner.queryForObject("select count(*) from inv_batch", Integer.class)).isZero();
        var receipt = receive(deliver(shipment, 50), 48, 0, 0, 2);
        quantity("select on_hand_qty from inv_stock_summary", "48");
        quantity("select frozen_qty from inv_stock_summary", "0");
        quantity("select src_amount from cst_inbound_cost", "240");
        assertThat(owner.queryForMap("select status,qty from lgs_discrepancy")).containsEntry("status", "OPEN");
        quantity("select qty from lgs_discrepancy", "2");
        assertThat(((Number)first(receipt).get("invBatchId")).longValue()).isPositive();
        conserved(id(shipment));
        evidence("PUR08-shortage-before-later-arrival");
        actor = 211;
        long discrepancy = owner.queryForObject("select id from lgs_discrepancy", Long.class);
        lgs.action(c(), "discrepancies", discrepancy, "resolve", Map.of("resolution", "LATER_ARRIVED", "remark", "AI02-TEST later arrival", "bizDate", "2026-10-15"), key());
        quantity("select on_hand_qty from inv_stock_summary", "48");
        receive(deliver(shipment, 2), 2, 0, 0, 0);
        quantity("select on_hand_qty from inv_stock_summary", "50");
        quantity("select sum(src_amount) from cst_inbound_cost", "250");
        assertThat(owner.queryForObject("select count(*) from inv_batch", Integer.class)).isEqualTo(2);
        assertThat(owner.queryForObject("select status from lgs_discrepancy", String.class)).isEqualTo("RESOLVED");
        quantity("select arrived_mx_qty from pur_order_line", "50");
        conserved(id(shipment));
        evidence("PUR10-later-arrival-original-source");
    }

    @Test void mixedReceiptOnlyStocksPhysicalQuantitiesAndFreezesDamagedAndPending() throws Exception {
        var order = purchase("PCS", 50, 7);
        actor = 211;
        var shipment = shipment(export(domestic(order, 50, 0, 0, true), 50, true), 50);
        depart(shipment);
        receive(deliver(shipment, 50), 43, 3, 2, 2);
        quantity("select on_hand_qty from inv_stock_summary", "48");
        quantity("select frozen_qty from inv_stock_summary", "5");
        quantity("select on_hand_qty-frozen_qty from inv_stock_summary", "43");
        quantity("select src_amount from cst_inbound_cost", "336");
        quantity("select qty from lgs_discrepancy where status='OPEN'", "2");
        quantity("select arrived_mx_qty from pur_order_line", "48");
        conserved(id(shipment));
        evidence("PUR09-mixed-receipt");
    }

    @Test void splitDomesticInspectionAndConfiguredDirectSourcesShareOneQualifiedQuota() throws Exception {
        var order = purchase("PCS", 20, 10);
        actor = 211;
        var firstReceipt = domestic(order, 6, 4, 1, true);
        var secondReceipt = domestic(order, 10, 0, 0, true);
        pur.convert(c(), id(first(firstReceipt)), Map.of("toQualifiedQty", 3, "toDamagedQty", 1, "bizDate", "2026-10-15", "remark", "AI02-TEST inspection"), key());
        quantity("select qualified_qty from pur_order_line", "19");
        quantity("select pending_inspect_qty from pur_order_line", "0");
        quantity("select damaged_qty from pur_order_line", "2");
        quantity("select qualified_qty from pur_domestic_receipt_line where id=?", "6", id(first(firstReceipt)));
        assertThat(owner.queryForObject("select count(*) from inv_batch", Integer.class)).isZero();
        var body = new LinkedHashMap<String,Object>(Map.of("bookId", 601, "destWarehouseId", 401,
            "carrierId", 802, "transportMode", "AIR", "flightNo", "AI02-F", "awbNo", "AI02-AWB",
            "lines", List.of(Map.of("sourceType", "DOMESTIC_RECEIPT_LINE", "sourceLineId", id(first(firstReceipt)), "baseQty", 1))));
        assertThatThrownBy(() -> lgs.create(c(), "shipments", body, key())).isInstanceOf(ApiException.class).hasMessageContaining("出口");
        seed("update sys_country set config=jsonb_set(config,'{pur.export.required}','false'::jsonb) where id=101");
        var direct = lgs.create(c(), "shipments", body, key());
        export(firstReceipt, 8, true);
        assertThatThrownBy(() -> export(firstReceipt, 2, true)).isInstanceOf(ApiException.class);
        assertThat(owner.queryForObject("select count(*) from lgs_shipment", Integer.class)).isEqualTo(1);
        assertThat(first(direct)).containsEntry("sourceType", "DOMESTIC_RECEIPT_LINE");
        assertThat(pur.get(c(), "domestic-receipts", id(secondReceipt))).containsEntry("status", "CONFIRMED");
        evidence("PUR01-PUR02-inspection-source-quota");
    }

    @Test void mixedPurchaseUnitsKeepEachReceiptCostOnItsOwnPurchaseLine() throws Exception {
        var one = purchase("BOX", 5, 10);
        var two = purchase("PCS", 5, 7);
        actor = 211;
        var a = export(domestic(one, 10, 0, 0, true), 10, true);
        var b = export(domestic(two, 5, 0, 0, true), 5, true);
        var shipment = lgs.create(c(), "shipments", Map.of("bookId", 601, "destWarehouseId", 401,
            "carrierId", 802, "transportMode", "AIR", "flightNo", "AI02-F", "awbNo", "AI02-MIX",
            "submit", true, "bizDate", "2026-10-15", "lines", List.of(
                Map.of("sourceLineId", id(first(a)), "baseQty", 10),
                Map.of("sourceLineId", id(first(b)), "baseQty", 5))), key());
        depart(shipment);
        var lines = rows(shipment.get("lines"));
        var delivery = lgs.create(c(), "deliveries", Map.of("shipmentId", id(shipment), "dispatch", true,
            "bizDate", "2026-10-15", "dispatchedAt", "2026-10-15T03:00:00Z", "lines",
            lines.stream().map(line -> Map.of("shipmentLineId", line.get("id"), "dispatchQty", line.get("baseQty"))).toList()), key());
        actor = 221;
        var receipt = lgs.create(c(), "receipts", Map.of("deliveryId", id(delivery), "bizDate", "2026-10-15",
            "lines", rows(delivery.get("lines")).stream().map(line -> Map.of("deliveryLineId", line.get("id"), "goodQty", line.get("dispatchQty"))).toList()), key());
        lgs.action(c(), "receipts", id(receipt), "confirm", Map.of(), key());
        quantity("select on_hand_qty from inv_stock_summary", "15");
        quantity("select sum(c.src_amount) from cst_inbound_cost c join inv_batch b on b.id=c.batch_id where b.po_line_id=?", "50", id(first(one)));
        quantity("select sum(c.src_amount) from cst_inbound_cost c join inv_batch b on b.id=c.batch_id where b.po_line_id=?", "35", id(first(two)));
        quantity("select base_purchase_amount from cst_inbound_cost where po_line_id=?", "125", id(first(one)));
        quantity("select base_purchase_amount from cst_inbound_cost where po_line_id=?", "87.5", id(first(two)));
        conserved(id(shipment));
        evidence("PUR03-mixed-source-unit-cost");
    }

    @Test void financialOrderReferenceIncludesItsNativeNumberWithoutExposingPrices() {
        var order = purchase("PCS", 1, 7);
        inCountry(101, () -> {
            var reference = pur.financialOrderReference(authorization.authorize(c()), 601, id(order));
            assertThat(reference).containsEntry("docNo", order.get("docNo"));
            assertThat(reference).doesNotContainKeys("lines", "totalAmount", "unitPrice");
            return null;
        });
    }

    @Test void receiptCostReferenceRechecksItsTypedSourceAndScopeWithoutLogisticsPermissionOrWrites() {
        var order = purchase("PCS", 2, 7);
        actor = 211;
        var shipment = shipment(export(domestic(order, 2, 0, 0, true), 2, true), 2);
        depart(shipment);
        var receipt = receive(deliver(shipment, 2), 2, 0, 0, 0);
        long receiptLine = id(first(receipt));
        var before = owner.queryForMap("select (select count(*) from sys_biz_event) events,(select count(*) from sys_audit_log) audits,(select count(*) from inv_batch) batches");
        actor = 201;
        permissions(202, List.of("cst:cost:view"));
        inCountry(101, () -> {
            var access = authorization.authorize(c());
            assertThat(access.has("cst:cost:view")).isTrue();
            assertThat(access.has("lgs:shipment:view")).isFalse();
            assertThat(lgs.receiptCostReference(access, 601, receiptLine))
                .containsExactlyInAnyOrderEntriesOf(Map.of("receiptId", id(receipt), "receiptNo", receipt.get("docNo")));
            return null;
        });
        assertThatThrownBy(() -> inCountry(101, () -> lgs.receiptCostReference(authorization.authorize(c()), 602, receiptLine)))
            .isInstanceOf(ApiException.class).extracting("code").isEqualTo("NOT_FOUND");
        assertThatThrownBy(() -> inCountry(101, () -> lgs.receiptCostReference(authorization.authorize(c()), 601, receiptLine + 9999)))
            .isInstanceOf(ApiException.class).extracting("code").isEqualTo("NOT_FOUND");
        seed("insert into org_warehouse(id,country_id,entity_id,code,name) values(402,101,301,'AI02-OTHER','Other warehouse')");
        seed("delete from sys_user_data_scope where user_id=201");
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) values(101,201,'WAREHOUSE',402,201)");
        assertThatThrownBy(() -> inCountry(101, () -> lgs.receiptCostReference(authorization.authorize(c()), 601, receiptLine)))
            .isInstanceOf(ApiException.class).extracting("code").isEqualTo("NOT_FOUND");
        seed("update sys_user_data_scope set warehouse_id=401 where user_id=201");
        inCountry(101, () -> {
            assertThat(lgs.receiptCostReference(authorization.authorize(c()), 601, receiptLine)).containsEntry("receiptNo", receipt.get("docNo"));
            return null;
        });
        assertThat(owner.queryForMap("select (select count(*) from sys_biz_event) events,(select count(*) from sys_audit_log) audits,(select count(*) from inv_batch) batches")).isEqualTo(before);
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledIfSystemProperty(named="ai02.browserScript", matches=".+")
    void nativePreparedDocumentsAreSubmittedAndConfirmedByTheirActualPageJobs() throws Exception {
        actor = 201;
        var order = pur.create(c(), "orders", Map.of("bookId", 601, "supplierId", 801, "orderDate", "2026-10-15",
            "lines", List.of(Map.of("productId", 501, "unit", "BOX", "qty", 25, "unitPrice", 10))), key());
        uiAction = "submitPurchase";
        evidence("UI-purchase-draft-submit");
        order = pur.get(c(), "orders", id(order));
        assertThat(order).containsEntry("status", "CONFIRMED");
        assertThat(owner.queryForObject("select submitted_by from wf_instance", Long.class)).isEqualTo(201);
        actor = 211;
        var domestic = domestic(order, 50, 0, 0, false);
        uiAction = "confirmDomestic";
        evidence("UI-domestic-receipt-confirm");
        domestic = pur.get(c(), "domestic-receipts", id(domestic));
        assertThat(domestic).containsEntry("status", "CONFIRMED");
        quantity("select qualified_qty from pur_order_line", "50");
        assertThat(owner.queryForObject("select count(*) from inv_batch", Integer.class)).isZero();
        var shipment = shipment(export(domestic, 50, true), 50);
        depart(shipment);
        var delivery = deliver(shipment, 50);
        actor = 221;
        lgs.create(c(), "receipts", Map.of("deliveryId", id(delivery), "bizDate", "2026-10-15", "lines",
            List.of(Map.of("deliveryLineId", id(first(delivery)), "goodQty", 48, "shortQty", 2))), key());
        uiAction = "confirmReceipt";
        evidence("UI-warehouse-receipt-confirm");
        quantity("select on_hand_qty from inv_stock_summary", "48");
        quantity("select frozen_qty from inv_stock_summary", "0");
        quantity("select src_amount from cst_inbound_cost", "240");
        quantity("select qty from lgs_discrepancy where status='OPEN'", "2");
        assertThat(owner.queryForObject("select confirmed_by from lgs_receipt", Long.class)).isEqualTo(221);
        assertThat(owner.queryForObject("select count(*) from inv_batch", Integer.class)).isEqualTo(1);
        conserved(id(shipment));
        uiAction = null;
        evidence("UI-native-flow-after-page-confirmations");
    }

    @Test void salesDemandRemainsTextWhileReplenishmentPurchaseAndReceiptUseTypedLinks() throws Exception {
        NumberFixtures.seed(101, "REPLENISH");
        job(231, 232, "AI02-SALES", List.of("sal:order:create", "sal:order:submit", "sal:order:view"));
        seed("insert into org_store(id,country_id,entity_id,code,name) values(305,101,301,'AI02-TEST-STORE','AI02-TEST store')");
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,store_id,granted_by) values(101,231,'STORE',305,201)");
        seed("insert into md_customer(id,country_id,code,name,store_id) values(804,101,'AI02-TEST-CUSTOMER','AI02-TEST customer',305)");
        seed("insert into sal_price(country_id,product_id,price_type,unit,min_qty,price,currency,effective_from) values(101,501,'BASE','PCS',1,20,'MXN','2026-10-01')");
        seed("insert into wf_doc_type_config(country_id,doc_type,approval_required,key_fields) values(101,'SALES_ORDER',false,'[]')");
        actor = 231;
        var demand = sales.create(c(), Map.of("bookId", 601, "customerId", 804, "paymentType", "CASH",
            "orderDate", "2026-10-15", "lines", List.of(Map.of("productId", 501, "unit", "PCS", "qty", 10, "warehouseId", 401))), key());
        actor = 201;
        String reason = "AI02-TEST sales demand " + demand.get("docNo");
        var request = (Map<?,?>) replenishments.create(c(), Map.of("warehouseId", 401, "productId", 501,
            "reqQty", 10, "suggestedSource", "PURCHASE", "reason", reason), key());
        long requestId = ((Number) request.get("id")).longValue();
        replenishments.action(c(), requestId, "decide", Map.of("decidedSource", "PURCHASE", "note", "AI02-TEST"), key());
        var purchase = purchase("PCS", 10, 7);
        replenishments.action(c(), requestId, "link", Map.of("execDocType", "PUR_ORDER", "execDocId", id(purchase)), key());
        var beforeReceipt = rows(((Map<?,?>) replenishments.list(c())).get("records")).getFirst();
        assertThat((BigDecimal) beforeReceipt.get("fulfilledQty")).isZero();
        assertThat(owner.queryForMap("select exec_doc_type,exec_doc_id,exec_line_id from inv_replenish_link"))
            .containsEntry("exec_doc_type", "PUR_ORDER").containsEntry("exec_doc_id", id(purchase))
            .containsEntry("exec_line_id", id(first(purchase)));
        actor = 211;
        var shipment = shipment(export(domestic(purchase, 10, 0, 0, true), 10, true), 10);
        depart(shipment);
        receive(deliver(shipment, 10), 10, 0, 0, 0);
        actor = 201;
        var listed = rows(((Map<?,?>) replenishments.list(c())).get("records")).getFirst();
        assertThat(listed).containsEntry("reason", reason).containsEntry("status", "FULFILLED");
        assertThat((BigDecimal) listed.get("fulfilledQty")).isEqualByComparingTo("10");
        assertThat(listed).doesNotContainKeys("salesOrderId", "salesOrderLineId");
        actor = 231;
        sales.submit(c(), id(demand), Map.of("bizDate", "2026-10-15"), key());
        quantity("select reserved_qty from inv_stock_summary", "10");
        evidence("GAP06-native-demand-replenishment-purchase");
    }

    private void configureTwoStagePurchaseRule() {
        job(241, 242, "AI02-WORKFLOW-ADMIN", List.of("wf:rule:edit"));
        seed("delete from sys_user_data_scope where user_id=241");
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(101,241,'COUNTRY_ALL',201)");
        job(251, 252, "AI02-PURCHASE-MANAGER", List.of("pur:order:view"));
        job(261, 262, "AI02-FINANCE-REVIEW", List.of("pur:order:view"));
        actor = 241;
        workflow.configure(c(), "PURCHASE_ORDER", Map.of("version", 1, "approvalRequired", true,
            "keyFields", List.of("supplierId", "paymentTerms", "lines")));
        var manager = Map.of("nodeName", "AI02 manager", "approverType", "USER", "approverRef", 251, "mode", "ANY");
        var finance = Map.of("nodeName", "AI02 finance", "approverType", "USER", "approverRef", 261, "mode", "ANY");
        workflow.createRule(c(), Map.of("docType", "PURCHASE_ORDER", "name", "AI02-TEST above 100 CNY",
            "priority", 1, "conditions", List.of(Map.of("field", "amount", "op", "gt", "value", 100)), "nodes", List.of(manager, finance)));
        workflow.createRule(c(), Map.of("docType", "PURCHASE_ORDER", "name", "AI02-TEST up to 100 CNY",
            "priority", 2, "conditions", List.of(), "nodes", List.of(manager)));
    }

    private void approvePurchase(long order) {
        for (long reviewer : List.of(251L, 261L)) {
            actor = reviewer;
            var tasks = owner.queryForList("select t.id from wf_task t join wf_instance i on i.id=t.instance_id where i.doc_id=? and t.assignee_id=? and t.status='PENDING' and i.status='PENDING'", Long.class, order, reviewer);
            for (long task : tasks) workflow.approve(c(), task, "AI02-TEST assigned review");
        }
    }

    @Test void configuredThresholdKeepsEqualityAtOneNodeAndHigherAmountsNeedFinanceBeforeReceipt() throws Exception {
        configureTwoStagePurchaseRule();
        for (int amount : List.of(99, 100, 101)) {
            var purchase = purchase("PCS", 1, amount);
            assertThat(purchase).containsEntry("status", "PENDING_APPROVAL");
            actor = 251;
            long managerTask = owner.queryForObject("select t.id from wf_task t join wf_instance i on i.id=t.instance_id where i.doc_id=? and t.assignee_id=251 and t.status='PENDING'", Long.class, id(purchase));
            workflow.approve(c(), managerTask, "AI02-TEST manager");
            actor = 211;
            if (amount > 100) {
                assertThatThrownBy(() -> domestic(purchase, 1, 0, 0, true)).isInstanceOf(ApiException.class);
                assertThat(owner.queryForObject("select count(*) from pur_domestic_receipt where order_id=?", Integer.class, id(purchase))).isZero();
                actor = 261;
                long financeTask = owner.queryForObject("select t.id from wf_task t join wf_instance i on i.id=t.instance_id where i.doc_id=? and t.assignee_id=261 and t.status='PENDING'", Long.class, id(purchase));
                workflow.approve(c(), financeTask, "AI02-TEST finance");
                actor = 211;
            }
            domestic(purchase, 1, 0, 0, true);
        }
        assertThat(owner.queryForObject("select count(*) from wf_task where assignee_id=261", Integer.class)).isEqualTo(1);
        evidence("PUR12-configured-threshold-three-boundaries");
    }

    @Test void supplierPriceAndPaymentChangesInvalidateTheOldApprovalBeforeAnyDelivery() throws Exception {
        configureTwoStagePurchaseRule();
        var order = purchase("PCS", 1, 101);
        approvePurchase(id(order));
        actor = 201;
        var approved = pur.get(c(), "orders", id(order));
        assertThat(approved).containsEntry("status", "CONFIRMED");
        seed("insert into md_supplier(id,country_id,code,name,settle_currency) values(805,101,'AI02-TEST-S2','AI02-TEST supplier two','CNY')");
        var changed = pur.update(c(), "orders", id(order), Map.of("version", approved.get("version"),
            "supplierId", 805, "paymentTerms", "NET30", "lines", List.of(Map.of("productId", 501, "unit", "PCS", "qty", 1, "unitPrice", 102))));
        assertThat(changed).containsEntry("status", "DRAFT");
        assertThat(owner.queryForObject("select status from wf_instance where doc_id=?", String.class, id(order))).isEqualTo("INVALIDATED");
        actor = 211;
        assertThatThrownBy(() -> domestic(changed, 1, 0, 0, true)).isInstanceOf(ApiException.class);
        actor = 201;
        pur.action(c(), "orders", id(changed), "submit", Map.of(), key());
        approvePurchase(id(changed));
        actor = 211;
        domestic(changed, 1, 0, 0, true);
        assertThat(owner.queryForObject("select count(*) from wf_task where assignee_id=261 and status='APPROVED'", Integer.class)).isEqualTo(2);
        evidence("PUR12-key-economic-fields-reapproval");
    }

    @Test void cancellationAndClosePreserveAlreadyReceivedSourcesAndOnlyCancelUndeliveredQuantity() throws Exception {
        var purchase = purchase("PCS", 20, 7);
        actor = 211;
        var source = domestic(purchase, 6, 0, 0, true);
        actor = 201;
        pur.action(c(), "orders", id(purchase), "cancel-lines", Map.of("bizDate", "2026-10-15", "reason", "AI02-TEST partial cancellation",
            "lines", List.of(Map.of("orderLineId", id(first(purchase)), "cancelQty", 4))), key());
        quantity("select cancelled_qty from pur_order_line", "4");
        actor = 211;
        assertThatThrownBy(() -> domestic(purchase, 11, 0, 0, true)).isInstanceOf(ApiException.class);
        actor = 201;
        pur.action(c(), "orders", id(purchase), "close", Map.of("bizDate", "2026-10-15", "reason", "AI02-TEST close remaining"), key());
        quantity("select cancelled_qty from pur_order_line", "14");
        quantity("select qualified_qty from pur_order_line", "6");
        assertThat(pur.get(c(), "orders", id(purchase))).containsEntry("status", "CLOSED");
        actor = 211;
        assertThatThrownBy(() -> domestic(purchase, 1, 0, 0, true)).isInstanceOf(ApiException.class);
        assertThat(pur.get(c(), "domestic-receipts", id(source))).containsEntry("status", "CONFIRMED");
        assertThat(owner.queryForObject("select count(*) from pur_order_cancel", Integer.class)).isEqualTo(2);
        evidence("PUR04-partial-cancel-close-original-source");
    }

    @Test void airDepartureNeedsAirIdentityAndSeaMissingFieldsCannotLeavePartialShipments() throws Exception {
        var purchase = purchase("PCS", 20, 7);
        actor = 211;
        var source = export(domestic(purchase, 20, 0, 0, true), 20, true);
        var invalidSea = Map.<String,Object>of("bookId", 601, "destWarehouseId", 401, "carrierId", 802,
            "transportMode", "SEA", "lines", List.of(Map.of("sourceLineId", id(first(source)), "baseQty", 20)));
        assertThatThrownBy(() -> lgs.create(c(), "shipments", invalidSea, key())).isInstanceOf(ApiException.class).hasMessageContaining("vessel");
        assertThat(owner.queryForObject("select count(*) from lgs_shipment", Integer.class)).isZero();
        var air = shipment(source, 20);
        lgs.action(c(), "shipments", id(air), "dispatch", Map.of("actualEtd", "2026-10-15T00:00:00Z"), key());
        quantity("select intl_qty from lgs_shipment_line", "20");
        assertThat(owner.queryForObject("select count(*) from inv_batch", Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from lgs_container", Integer.class)).isZero();
        conserved(id(air));
        evidence("PUR05-air-departure-no-saleable-stock");
    }

    @Test void transshipDifferenceAndPartialHoldReleaseKeepEveryTransitBucketNonnegativeAndConserved() throws Exception {
        var purchase = purchase("PCS", 20, 7);
        actor = 211;
        var source = export(domestic(purchase, 20, 0, 0, true), 20, true);
        var body = new LinkedHashMap<String,Object>(Map.of("bookId", 601, "destWarehouseId", 401, "carrierId", 802,
            "transportMode", "SEA", "vessel", "AI02-V", "voyage", "1", "blNo", "AI02-BL", "containerNo", "AI02-OLD",
            "sealNo", "AI02-SEAL", "lines", List.of(Map.of("sourceLineId", id(first(source)), "baseQty", 20))));
        body.put("submit", true);
        var shipment = lgs.create(c(), "shipments", body, key());
        depart(shipment);
        lgs.create(c(), "transships", Map.of("shipmentId", id(shipment), "toContainerNo", "AI02-NEW", "toSealNo", "AI02-N",
            "transshipAt", "2026-10-15T02:00:00Z", "lines", List.of(Map.of("shipmentLineId", id(first(shipment)), "movedQty", 18))), key());
        assertThat(owner.queryForObject("select count(*) from lgs_container", Integer.class)).isEqualTo(2);
        quantity("select discrepancy_qty from lgs_shipment_line", "2");
        var hold = lgs.create(c(), "holds", Map.of("shipmentId", id(shipment), "reasonCode", "CUSTOMS", "parkLocation", "AI02-Port",
            "ownerId", 211, "reviewDate", "2026-10-15", "lines", List.of(Map.of("shipmentLineId", id(first(shipment)), "holdQty", 8))), key());
        var release = Map.of("holdLineId", id(first(hold)), "qty", 3);
        assertThatThrownBy(() -> lgs.action(c(), "holds", id(hold), "release", Map.of("lines", List.of(release, release)), key())).isInstanceOf(ApiException.class);
        lgs.action(c(), "holds", id(hold), "release", Map.of("lines", List.of(release)), key());
        var fee = lgs.create(c(), "fees", Map.of("shipmentId", id(shipment), "refType", "HOLD", "refId", id(hold), "carrierId", 802,
            "expenseItemId", 803, "currency", "CNY", "amount", 25, "estimateFlag", "ACTUAL", "bizDate", "2026-10-15"), key());
        lgs.action(c(), "fees", id(fee), "confirm", Map.of(), key());
        quantity("select base_amount from lgs_fee", "62.5");
        quantity("select on_hold_qty from lgs_shipment_line", "5");
        quantity("select pending_delivery_qty from lgs_shipment_line", "13");
        assertThatThrownBy(() -> deliver(shipment, 14)).isInstanceOf(ApiException.class);
        conserved(id(shipment));
        assertThat(owner.queryForObject("select count(*) from inv_batch", Integer.class)).isZero();
        evidence("PUR06-PUR07-transship-hold-release-fee");
    }

    @SuppressWarnings("unchecked") private List<Map<String,Object>> rows(Object value) {
        return (List<Map<String,Object>>) value;
    }
}
