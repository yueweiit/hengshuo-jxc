package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;

import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.inv.api.InventoryApi;
import com.hs.jxc.inv.service.*;
import com.hs.jxc.sal.SalesService;
import com.hs.jxc.sal.api.SalesStatsApi;
import com.hs.jxc.sys.imports.ImportService;
import com.hs.jxc.sys.service.AuthorizationService;
import com.hs.jxc.workflow.service.WorkflowService;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.LocalDate;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;

/** 原生期初与订单来源；SQL 只准备基础配置、读取事实，不插库存或订单交易。 */
@Import(CountryCalendarIT.TimeConfiguration.class)
class NativeInventorySourceIT extends BasePgIT {
    @Autowired ImportService imports;
    @Autowired InventoryDocuments documents;
    @Autowired InventoryClassification classification;
    @Autowired InventoryAnalysisWorker worker;
    @Autowired ReplenishmentService replenishments;
    @Autowired InventoryApi inventory;
    @Autowired SalesService sales;
    @Autowired SalesStatsApi stats;
    @Autowired WorkflowService workflow;
    @Autowired AuthorizationService authorization;
    @Autowired JsonCodec json;
    @Autowired com.hs.jxc.fin.accounting.AccountingService accounting;
    @Autowired com.hs.jxc.fin.ledger.LedgerService ledger;
    @Autowired CountryCalendarIT.BusinessClock clock;
    @org.springframework.boot.test.web.server.LocalServerPort int port;

    static final String TOKEN_HASH=com.hs.jxc.sys.service.SessionService.digest("AI03-TEST-TOKEN");
    static final String REVIEW_HASH=com.hs.jxc.sys.service.SessionService.digest("AI03-REVIEW-TOKEN");
    final RequestContext actor = new RequestContext(201,101L,"AI03-TEST",TOKEN_HASH);
    final RequestContext reviewer = new RequestContext(202,101L,"AI03-REVIEW",REVIEW_HASH);
    final LocalDate day = LocalDate.of(2026,10,26);

    @BeforeEach void foundation() {
        clock.set("2026-10-26T12:00:00Z");
        InventoryIT.seedBase();
        seed("UPDATE sys_country SET config=config||'{\"enabledModules\":[\"sys\",\"org\",\"md\",\"inv\",\"sal\",\"fin\"],\"isTest\":true}'::jsonb WHERE id=101");
        seed("UPDATE sys_doc_number_rule SET prefix='AI03'||left(prefix,16) WHERE country_id=101");
        seed("INSERT INTO md_currency(code,name) VALUES('MXN','TEST Peso')");
        seed("INSERT INTO sys_authz_epoch(country_id) VALUES(101)");
        seed("INSERT INTO sys_user(id,username,password_hash,display_name) VALUES(202,'AI03-review','unused','独立审批人')");
        seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,201,clock_timestamp()+interval '2 hour'),(?,202,clock_timestamp()+interval '2 hour')",TOKEN_HASH,REVIEW_HASH);
        var permissions = List.of("sys:import:opening-stock","sys:import:confirm","md:product:view","inv:stock:view","inv:txn:view",
            "inv:transfer:create","inv:transfer:ship","inv:transfer:receive","inv:stocktake:create",
            "inv:stocktake:count","inv:stocktake:submit","inv:stocktake:approve","inv:freeze:create","inv:freeze:release",
            "inv:limit:config","inv:classify:view","inv:classify:config","inv:replenish:create","inv:replenish:decide",
            "sal:order:create","sal:order:view","sal:order:submit","sal:order:cancel","sal:price:edit");
        seed("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(211,101,'AI03-WORK','本组库存测试岗位',?::jsonb,'{\"COST\":\"WRITE\",\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"CREDIT\":\"WRITE\"}'),(212,101,'AI03-REVIEW','本组独立审批岗位','[\"inv:stock:view\"]','{\"COST\":\"READ\"}')",json.write(permissions));
        seed("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(101,201,211),(101,202,212)");
        seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(101,201,'COUNTRY_ALL',201),(101,202,'COUNTRY_ALL',201)");
        seed("INSERT INTO org_store(id,country_id,entity_id,code,name) VALUES(311,101,301,'AI03-STORE','TEST 门店')");
        seed("UPDATE org_warehouse SET store_id=311 WHERE country_id=101");
        seed("INSERT INTO md_customer(id,country_id,code,name) VALUES(801,101,'AI03-C','TEST 客户')");
        seed("INSERT INTO wf_doc_type_config(country_id,doc_type,approval_required) VALUES(101,'TRANSFER',false),(101,'SALES_ORDER',false)");
        sales.savePrice(actor,null,Map.of("productId",501,"priceType","BASE","price",20,"unit","PCS","effectiveFrom","2026-10-01"),key());
    }

    String key() { return UUID.randomUUID().toString(); }
    long id(Map<?,?> row) { return ((Number)row.get("id")).longValue(); }
    @SuppressWarnings("unchecked") List<Map<String,Object>> lines(Map<?,?> row) { return (List<Map<String,Object>>)row.get("lines"); }
    @SuppressWarnings("unchecked") Map<String,Object> record(Object value) { return (Map<String,Object>)value; }
    BigDecimal decimal(String sql, Object... args) { return owner.queryForObject(sql,BigDecimal.class,args); }
    int count(String table) { return owner.queryForObject("SELECT count(*) FROM "+table,Integer.class); }

    Map<String,Object> opening(long warehouse,long product,String quantity,String cost) {
        String no="AI03-TEST-"+UUID.randomUUID();
        var draft=imports.create(actor,Map.of("importType","OPENING_STOCK","cutoffDate","2026-10-15","rows",List.of(
            Map.of("bookId",601,"warehouseCode",warehouse==401?"W":"W2","productCode",product==501?"SKU":"AI03-P"+product,
                "qty",new BigDecimal(quantity),"unitCost",new BigDecimal(cost),"batchNo",no,"refNo",no,"sourceDate","2026-10-15"))));
        assertThat(draft).containsEntry("status","VALIDATED");
        var result=imports.confirm(actor,id(draft),key());
        assertThat(result).containsEntry("status","COMPLETED");
        var source=owner.queryForMap("SELECT r.id row_id,r.target_id,b.id batch_id,b.source_type,b.source_line_id FROM sys_import_row r JOIN inv_batch b ON b.id=r.target_id AND b.country_id=r.country_id WHERE r.batch_id=?",id(draft));
        assertThat(source.get("source_type")).isEqualTo("OPENING_STOCK");
        assertThat(source.get("source_line_id")).isEqualTo(source.get("row_id"));
        assertThat(decimal("SELECT sum(on_hand_change) FROM inv_stock_txn WHERE source_type='OPENING_STOCK' AND source_line_id=?",source.get("row_id"))).isEqualByComparingTo(quantity);
        assertThat(decimal("SELECT unit_cost FROM cst_inbound_cost WHERE source_type='OPENING_STOCK' AND source_line_id=?",source.get("row_id"))).isEqualByComparingTo(cost);
        return source;
    }

    Map<String,Object> transfer(int quantity) {
        return documents.create(actor,"transfer",Map.of("fromWarehouseId",401,"toWarehouseId",402,"plannedDate",day.toString(),"submit",true,"lines",List.of(Map.of("productId",501,"qty",quantity))),key());
    }
    Map<String,Object> action(Map<?,?> transfer,String action,Map<String,Object> body) {
        return documents.action(actor,"transfer",id(transfer),action,body,key());
    }
    void approvalRule(String type) {
        seed("INSERT INTO wf_rule(country_id,rule_key,doc_type,name,conditions,nodes,status,effective_from) VALUES(101,?,?,?,'[]','[{\"seq\":1,\"nodeName\":\"TEST 独立复核\",\"approverType\":\"USER\",\"approverRef\":202,\"mode\":\"ANY\"}]','ACTIVE',clock_timestamp()-interval '1 hour')",type,type,"AI03-TEST "+type);
    }
    void approve(String type) {
        long task=owner.queryForObject("SELECT t.id FROM wf_task t JOIN wf_instance i ON i.id=t.instance_id AND i.country_id=t.country_id WHERE i.doc_type=? AND t.status='PENDING'",Long.class,type);
        workflow.approve(reviewer,task,"AI03 独立审批通过");
    }
    Map<String,Object> order(long product,int quantity,boolean submit) {
        var order=sales.create(actor,Map.of("bookId",601,"storeId",311,"customerId",801,"paymentType","CASH","orderDate","2026-10-15","lines",List.of(Map.of("productId",product,"unit","PCS","qty",quantity,"warehouseId",401))),key());
        return submit?sales.submit(actor,id(order),Map.of("bizDate",day.toString()),key()):order;
    }

    @ParameterizedTest @ValueSource(strings={"WAREHOUSE","STORE"})
    void nativeOpeningTransferPartialReceiptRetainsBatchCostAndNeverDuplicatesShipment(String warehouseType) {
        seed("UPDATE org_warehouse SET type=? WHERE id=402",warehouseType);
        var source=opening(401,501,"10","3.25");
        var transfer=transfer(8);
        var shipped=action(transfer,"ship",Map.of());
        assertThat(decimal("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=401")).isEqualByComparingTo("2");
        assertThat(count("cst_cogs")).isZero();
        assertThatThrownBy(()->action(transfer,"ship",Map.of())).extracting("code").isEqualTo("INV_INVALID_STATE");
        long line=id(lines(shipped).getFirst());
        String receiveKey=key();
        var body=Map.<String,Object>of("lines",List.of(Map.of("lineId",line,"qty",3)));
        var partial=documents.action(actor,"transfer",id(transfer),"receive",body,receiveKey);
        documents.action(actor,"transfer",id(transfer),"receive",body,receiveKey);
        assertThat((BigDecimal)partial.get("inTransitQty")).isEqualByComparingTo("5");
        assertThat(decimal("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=402")).isEqualByComparingTo("3");
        assertThatThrownBy(()->action(transfer,"receive",Map.of("lines",List.of(Map.of("lineId",line,"qty",6))))).extracting("code").isEqualTo("INV_TRANSFER_EXCEEDS_SHIPPED");
        var received=action(transfer,"receive",Map.of("lines",List.of(Map.of("lineId",line,"qty",5))));
        assertThat(received).containsEntry("status","RECEIVED");
        assertThat(decimal("SELECT sum(on_hand_qty) FROM inv_stock_summary")).isEqualByComparingTo("10");
        assertThat(owner.queryForList("SELECT DISTINCT batch_id FROM inv_stock_txn WHERE source_type='INV_TRANSFER'",Long.class)).containsExactly(((Number)source.get("batch_id")).longValue());
        assertThat(count("inv_batch")).isEqualTo(1);
        assertThat(count("cst_inbound_cost")).isEqualTo(1);
        assertThat(count("cst_cogs")).isZero();
        assertThat(count("ar_receivable")).isZero();
    }

    @ParameterizedTest @ValueSource(strings={"FOUND","LOSS"})
    void nativeTransferDifferenceWaitsForIndependentApprovalAndPreservesSourceDeduction(String resolution) {
        opening(401,501,"3","0.3333");
        approvalRule("TRANSFER_DIFFERENCE");
        var transfer=transfer(3);var shipped=action(transfer,"ship",Map.of());long line=id(lines(shipped).getFirst());
        action(transfer,"receive",Map.of("lines",List.of(Map.of("lineId",line,"qty",1))));
        var pending=action(transfer,"close",Map.of("reason","AI03 TEST two missing","resolution",resolution));
        assertThat(pending).containsEntry("differenceStatus","PENDING_APPROVAL");
        assertThat(decimal("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=401")).isZero();
        assertThat(count("inv_transfer_loss")).isZero();
        assertThatThrownBy(()->action(transfer,"close",Map.of("resolution",resolution))).extracting("code").isEqualTo("WF_APPROVAL_REQUIRED");
        approve("TRANSFER_DIFFERENCE");
        String command=key();var close=Map.<String,Object>of("resolution",resolution);
        var result=documents.action(actor,"transfer",id(transfer),"close",close,command);
        documents.action(actor,"transfer",id(transfer),"close",close,command);
        assertThat(result).containsEntry("status","CLOSED");
        assertThat((BigDecimal)result.get("inTransitQty")).isZero();
        assertThat(decimal("SELECT sum(on_hand_qty) FROM inv_stock_summary")).isEqualByComparingTo(resolution.equals("FOUND")?"3":"1");
        assertThat(count("inv_transfer_loss")).isEqualTo(resolution.equals("FOUND")?0:1);
        if(resolution.equals("LOSS")) {
            assertThat(decimal("SELECT amount FROM cst_cogs WHERE source_type='INV_TRANSFER_LOSS'")).isEqualByComparingTo("0.6666");
            postNativeTransferLossToLedger();
        }
        else assertThat(count("cst_cogs")).isZero();
        assertThat(count("ar_receivable")).isZero();
    }

    void postNativeTransferLossToLedger() {
        seed("UPDATE sys_role SET permissions=permissions||'[\"fin:account:edit\",\"fin:mapping:edit\",\"fin:voucher:generate\",\"fin:voucher:post\",\"fin:ledger:view\"]'::jsonb WHERE id=211");
        seed("UPDATE sys_role SET permissions=permissions||'[\"fin:mapping:review\",\"fin:voucher:audit\",\"fin:ledger:view\"]'::jsonb,field_policies='{\"COST\":\"WRITE\"}' WHERE id=212");
        long inventoryAccount=id(ledger.configure(actor,601L,"accounts",null,"POST",Map.of("code","1401","name","AI03 TEST inventory","category","ASSET","direction","DEBIT","reconcileType","INVENTORY"),key()));
        long lossAccount=id(ledger.configure(actor,601L,"accounts",null,"POST",Map.of("code","6602","name","AI03 TEST transfer loss","category","EXPENSE","direction","DEBIT"),key()));
        var mapping=accounting.saveMapping(actor,null,Map.of("bookId",601,"eventType","INV_TRANSFER_DIFFERENCE_RESOLVED","lines",List.of(
            Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","accountId",lossAccount),"amountExpr","amount"),
            Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","accountId",inventoryAccount),"amountExpr","amount"))),key());
        accounting.review(reviewer,id(mapping),Map.of("version",mapping.get("version")),key());
        long event=owner.queryForObject("SELECT id FROM sys_biz_event WHERE event_type='INV_TRANSFER_DIFFERENCE_RESOLVED'",Long.class);
        String intent=key();var generated=accounting.generate(actor,event,intent);
        assertThat(accounting.generate(actor,event,intent).get("voucherId")).isEqualTo(generated.get("voucherId"));
        long voucher=((Number)generated.get("voucherId")).longValue();
        var draft=ledger.voucherGet(actor,601L,voucher);
        var audited=ledger.action(reviewer,601L,voucher,"audit",Map.of("version",draft.get("version")),key());
        ledger.action(actor,601L,voucher,"post",Map.of("version",audited.get("version")),key());
        assertThat(decimal("SELECT sum(l.debit-l.credit) FROM fin_voucher_line l JOIN fin_voucher v ON v.id=l.voucher_id AND v.country_id=l.country_id WHERE v.status='POSTED' AND l.account_id=?",lossAccount)).isEqualByComparingTo("0.67");
        assertThat(decimal("SELECT sum(l.credit-l.debit) FROM fin_voucher_line l JOIN fin_voucher v ON v.id=l.voucher_id AND v.country_id=l.country_id WHERE v.status='POSTED' AND l.account_id=?",inventoryAccount)).isEqualByComparingTo("0.67");
        assertThat(count("fin_voucher")).isEqualTo(1);
    }

    @Test void nativeReservationsAndManualFreezeAreDisjointAndPartialReleaseIsAppendOnly() {
        opening(401,501,"10","3.25");
        order(501,6,true);
        assertThat(decimal("SELECT reserved_qty FROM inv_stock_summary WHERE warehouse_id=401")).isEqualByComparingTo("6");
        assertThatThrownBy(()->documents.freeze(actor,null,Map.of("warehouseId",401,"productId",501,"qty",5,"reason","TEST overflow"),key())).extracting("code").isEqualTo("INV_INSUFFICIENT_AVAILABLE");
        documents.freeze(actor,null,Map.of("warehouseId",401,"productId",501,"qty",4,"reason","AI03 TEST pending inspection"),key());
        long freeze=owner.queryForObject("SELECT id FROM inv_freeze",Long.class);
        assertThatThrownBy(()->action(transfer(1),"ship",Map.of())).extracting("code").isEqualTo("INV_INSUFFICIENT_AVAILABLE");
        documents.freeze(actor,freeze,Map.of("qty",2,"remark","AI03 TEST inspected"),key());
        assertThat(decimal("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=401")).isEqualByComparingTo("10");
        assertThat(decimal("SELECT frozen_qty FROM inv_stock_summary WHERE warehouse_id=401")).isEqualByComparingTo("2");
        assertThat(decimal("SELECT reserved_qty FROM inv_stock_summary WHERE warehouse_id=401")).isEqualByComparingTo("6");
        assertThat(count("cst_cogs")).isZero();
    }

    @ParameterizedTest @ValueSource(strings={"LOSS","GAIN_WITH_COST"})
    void nativeStocktakeLocksOnlyItsScopeAndPostsApprovedDifferencesExactlyOnce(String scenario) {
        opening(401,501,"5","3.25");approvalRule("STOCKTAKE");
        var stocktake=documents.create(actor,"stocktake",Map.of("warehouseId",401,"productIds",List.of(501),"start",true),key());
        var before=count("inv_stock_txn");
        assertThatThrownBy(()->opening(401,501,"1","3.25")).extracting("code").isEqualTo("INV_STOCKTAKE_LOCKED");
        opening(402,501,"1","3.25");
        var line=new LinkedHashMap<String,Object>();line.put("id",id(lines(stocktake).getFirst()));line.put("countedQty",scenario.equals("LOSS")?4:6);line.put("reason","AI03 TEST physical count");
        if(scenario.equals("GAIN_WITH_COST"))line.put("unitCost",new BigDecimal("3.25"));
        documents.action(actor,"stocktake",id(stocktake),"lines",Map.of("version",stocktake.get("version"),"lines",List.of(line)),key());
        documents.action(actor,"stocktake",id(stocktake),"submit",Map.of(),key());
        assertThatThrownBy(()->documents.action(actor,"stocktake",id(stocktake),"post",Map.of(),key())).extracting("code").isEqualTo("WF_APPROVAL_REQUIRED");
        assertThat(decimal("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=401")).isEqualByComparingTo("5");
        approve("STOCKTAKE");
        String post=key();
        if(scenario.equals("GAIN_WITHOUT_COST")) {
            assertThatThrownBy(()->documents.action(actor,"stocktake",id(stocktake),"post",Map.of(),post))
                .as("INV-04：没有明确盘盈成本时必须保持阻塞，不能先增加库存再待补成本")
                .isInstanceOf(com.hs.jxc.common.api.ApiException.class).hasMessageContaining("成本");
            assertThat(decimal("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=401")).isEqualByComparingTo("5");
            return;
        }
        var result=documents.action(actor,"stocktake",id(stocktake),"post",Map.of(),post);
        documents.action(actor,"stocktake",id(stocktake),"post",Map.of(),post);
        assertThat(result).containsEntry("status","POSTED");
        assertThat(count("inv_stock_txn")).isEqualTo(before+2);
        assertThat(decimal("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=401")).isEqualByComparingTo(scenario.equals("LOSS")?"4":"6");
        assertThat(owner.queryForObject("SELECT stocktake_id FROM inv_warehouse_sku_guard WHERE warehouse_id=401",Long.class)).isNull();
    }

    @Test @EnabledIfSystemProperty(named="jxc.ai03.reproduceMissingGainCost",matches="true")
    void unpricedGainMustStayBlockedUntilBusinessDecision() {
        // 已确认 INV-04 业务矛盾的可执行复现；显式启用时必须继续报告失败。
        nativeStocktakeLocksOnlyItsScopeAndPostsApprovedDifferencesExactlyOnce("GAIN_WITHOUT_COST");
    }

    @Test void nativeAvailableChangesDriveAlertsAndLinkedReplenishmentUsesActualTransferReceipts() {
        opening(402,501,"10","3.25");
        assertThatThrownBy(()->documents.saveLimits(actor,Map.of("items",List.of(Map.of("warehouseId",401,"productId",501,"minQty",9,"maxQty",4,"alertEnabled",true))),key())).extracting("code").isEqualTo("INV_LIMIT_INVALID");
        documents.saveLimits(actor,Map.of("items",List.of(Map.of("warehouseId",401,"productId",501,"minQty",4,"maxQty",10,"alertEnabled",true))),key());
        replenishments.suggest(actor,key());int suggestions=count("inv_replenish");
        replenishments.suggest(actor,key());assertThat(count("inv_replenish")).isEqualTo(suggestions);assertThat(count("pur_order")).isZero();
        long request=owner.queryForObject("SELECT min(id) FROM inv_replenish",Long.class);
        replenishments.action(actor,request,"decide",Map.of("decidedSource","TRANSFER"),key());
        var transfer=documents.create(actor,"transfer",Map.of("fromWarehouseId",402,"toWarehouseId",401,"submit",true,"lines",List.of(Map.of("productId",501,"qty",8))),key());
        replenishments.action(actor,request,"link",Map.of("execDocType","INV_TRANSFER","execDocId",id(transfer)),key());
        var shipped=action(transfer,"ship",Map.of());long line=id(lines(shipped).getFirst());
        action(transfer,"receive",Map.of("lines",List.of(Map.of("lineId",line,"qty",3))));worker.recover(101,100);
        var rows=(List<?>)record(replenishments.list(actor)).get("records");
        var item=rows.stream().map(this::record).filter(r->id(r)==request).findFirst().orElseThrow();
        assertThat((BigDecimal)item.get("fulfilledQty")).isEqualByComparingTo("3");assertThat(item.get("status")).isEqualTo("PARTIAL");
        action(transfer,"receive",Map.of("lines",List.of(Map.of("lineId",line,"qty",5))));worker.recover(101,100);
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_stock_alert WHERE warehouse_id=401 AND status='OPEN'",Integer.class)).isZero();
        int audits=count("sys_audit_log"),alerts=count("inv_stock_alert");
        documents.query(actor,"alerts",Map.of());documents.query(actor,"alerts",Map.of());replenishments.list(actor);
        assertThat(count("sys_audit_log")).isEqualTo(audits);assertThat(count("inv_stock_alert")).isEqualTo(alerts);
    }

    @Test void nativeThresholdCrossingsIncludeReservationFreezeAboveMaximumAndZeroStock() {
        opening(401,501,"5","3.25");
        documents.saveLimits(actor,Map.of("items",List.of(Map.of("warehouseId",401,"productId",501,"minQty",4,"maxQty",6,"alertEnabled",true))),key());
        documents.freeze(actor,null,Map.of("warehouseId",401,"productId",501,"qty",2,"reason","AI03 TEST quality hold"),key());
        worker.recover(101,100);
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_stock_alert WHERE status='OPEN' AND alert_type='BELOW_MIN'",Integer.class)).isEqualTo(1);
        documents.freeze(actor,owner.queryForObject("SELECT id FROM inv_freeze",Long.class),Map.of("qty",2,"remark","AI03 TEST released"),key());
        worker.recover(101,100);assertThat(owner.queryForObject("SELECT count(*) FROM inv_stock_alert WHERE status='OPEN'",Integer.class)).isZero();
        var order=order(501,2,true);worker.recover(101,100);
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_stock_alert WHERE status='OPEN' AND alert_type='BELOW_MIN'",Integer.class)).isEqualTo(1);
        sales.cancel(actor,id(order),Map.of("reason","AI03 TEST reservation released","lines",List.of(Map.of("lineId",id(lines(order).getFirst()),"qty",2))),key(),false);
        worker.recover(101,100);assertThat(owner.queryForObject("SELECT count(*) FROM inv_stock_alert WHERE status='OPEN'",Integer.class)).isZero();
        opening(401,501,"3","3.25");worker.recover(101,100);
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_stock_alert WHERE status='OPEN' AND alert_type='ABOVE_MAX'",Integer.class)).isEqualTo(1);
        action(transfer(2),"ship",Map.of());worker.recover(101,100);
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_stock_alert WHERE status='OPEN'",Integer.class)).isZero();
        action(transfer(6),"ship",Map.of());worker.recover(101,100);
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_stock_alert WHERE status='OPEN'",Integer.class)).isEqualTo(2);
        assertThat(decimal("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=401")).isZero();
    }

    Map<String,Object> condition(String label,String stock,String order) {
        return Map.of("label",label,"priority",1,"stockOp",stock,"stockValue",5,"orderOp",order,"orderValue",5);
    }
    Map<String,Object> ruleBody(int days) {
        return new LinkedHashMap<>(Map.of("name","AI03 TEST joint classification","dimType","WAREHOUSE","periodDays",days,"conditions",List.of(
            condition("HOT_CANDIDATE","LT","GTE"),condition("SLOW_CANDIDATE","GTE","LT"),condition("WATCH","LT","LT"),condition("NORMAL","GTE","GTE"))));
    }
    void product(long product) {
        seed("INSERT INTO md_product(id,product_code,name,base_unit) VALUES(?,?,?,'PCS')",product,"AI03-P"+product,"AI03 TEST "+product);
        seed("INSERT INTO md_product_unit(product_id,unit,factor_to_base) VALUES(?,'PCS',1)",product);
        seed("INSERT INTO md_country_sku(country_id,product_id) VALUES(101,?)",product);
        sales.savePrice(actor,null,Map.of("productId",product,"priceType","BASE","price",20,"unit","PCS","effectiveFrom","2026-10-01"),key());
    }

    @Test void nativeOrdersAndStockProduceFourJointClassesWithDrilldownAndNoRuleIsUnknown() {
        assertThat(record(classification.results(actor,Map.of())).get("total")).isEqualTo(0);
        for(long product:List.of(502L,503L,504L))product(product);
        opening(401,501,"8","3.25");opening(401,502,"2","3.25");opening(401,503,"10","3.25");opening(401,504,"16","3.25");
        order(501,6,true);order(504,6,true);
        var rule=record(classification.save(actor,null,ruleBody(30)));
        var labels=owner.queryForMap("SELECT jsonb_object_agg(product_id,label)::text labels FROM inv_classify_result WHERE dim_id=401");
        assertThat(json.readMap(labels.get("labels").toString())).containsEntry("501","HOT_CANDIDATE").containsEntry("502","WATCH").containsEntry("503","SLOW_CANDIDATE").containsEntry("504","NORMAL");
        long result=owner.queryForObject("SELECT id FROM inv_classify_result WHERE dim_id=401 AND product_id=501",Long.class);
        assertThat((List<?>)classification.orders(actor,result)).hasSize(1);
        assertThat(owner.queryForObject("SELECT basis->>'orderQty' FROM inv_classify_result WHERE dim_id=401 AND product_id=502",BigDecimal.class)).isZero();
        int logs=count("inv_classify_result_log");classification.recalculate(actor,id(rule));classification.recalculate(actor,id(rule));
        assertThat(count("inv_classify_result_log")).isEqualTo(logs);
    }

    @Test void nativeDemandUsesApprovalDayExcludesDraftAndCancelsExactWarehouseAllocation() {
        opening(401,501,"20","3.25");opening(402,501,"20","3.25");order(501,100,false);
        var order=sales.create(actor,Map.of("bookId",601,"storeId",311,"customerId",801,"paymentType","CASH","orderDate","2026-10-15","lines",List.of(Map.of("productId",501,"unit","PCS","qty",10,"allocs",List.of(Map.of("warehouseId",401,"allocQty",6),Map.of("warehouseId",402,"allocQty",4))))),key());
        sales.submit(actor,id(order),Map.of("bizDate",day.toString()),key());
        sales.cancel(actor,id(order),Map.of("reason","AI03 TEST cancel two","bizDate",day.toString(),"lines",List.of(Map.of("lineId",id(lines(order).getFirst()),"qty",2))),key(),false);
        inCountry(101,()->{var a=authorization.authorize(actor);
            assertThat(stats.orders(a,"COUNTRY",101,501,LocalDate.of(2026,10,15),LocalDate.of(2026,10,15))).isEmpty();
            var country=stats.orders(a,"COUNTRY",101,501,day,day);assertThat(country).hasSize(1);
            assertThat((BigDecimal)country.getFirst().get("qty")).isEqualByComparingTo("8");assertThat((BigDecimal)country.getFirst().get("unassignedQty")).isZero();
            for(long warehouse:List.of(401L,402L))assertThat((BigDecimal)stats.orders(a,"WAREHOUSE",warehouse,501,day,day).getFirst().get("qty")).isEqualByComparingTo("4");
            assertThat(stats.orders(a,"STORE",311,501,day,day)).hasSize(1);return null;});
        assertThat(count("ar_receivable")).isZero();
    }

    @Test void nativeRuleVersionPreservesHistoryAndRejectsConflictsAndStaleUpdates() {
        opening(401,501,"10","3.25");order(501,6,true);
        var first=record(classification.save(actor,null,ruleBody(90)));long old=id(first);
        var conflicting=ruleBody(90);conflicting.put("conditions",List.of(condition("HOT_CANDIDATE","LT","GTE"),condition("WATCH","LT","GTE")));
        assertThatThrownBy(()->classification.save(actor,null,conflicting)).extracting("code").isEqualTo("INV_RULE_CONFLICT");
        var changed=ruleBody(1);changed.put("versionNo",first.get("versionNo"));changed.put("orderMetric","ORDER_COUNT");
        var next=record(classification.save(actor,old,changed));
        assertThat(next.get("versionNo")).isEqualTo(2);
        assertThatThrownBy(()->classification.save(actor,old,changed)).extracting("code").isEqualTo("SYS_VERSION_CONFLICT");
        assertThat(owner.queryForObject("SELECT status FROM inv_classify_rule WHERE id=?",String.class,old)).isEqualTo("RETIRED");
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_classify_result WHERE rule_id=?",Integer.class,old)).isEqualTo(2);
        assertThat(owner.queryForObject("SELECT basis->>'periodStart' FROM inv_classify_result WHERE rule_id=? AND dim_id=401",String.class,id(next))).isEqualTo(day.toString());
        assertThat(owner.queryForObject("SELECT label FROM inv_classify_result WHERE rule_id=? AND dim_id=401",String.class,id(next))).isEqualTo("WATCH");
        var thresholds=ruleBody(1);thresholds.put("versionNo",next.get("versionNo"));thresholds.put("orderMetric","ORDER_COUNT");
        thresholds.put("conditions",((List<?>)thresholds.get("conditions")).stream().map(this::record).map(condition->{var revised=new LinkedHashMap<String,Object>(condition);revised.put("orderValue",1);return revised;}).toList());
        var third=record(classification.save(actor,id(next),thresholds));
        assertThat(third.get("versionNo")).isEqualTo(3);
        assertThat(owner.queryForObject("SELECT label FROM inv_classify_result WHERE rule_id=? AND dim_id=401",String.class,id(third))).isEqualTo("HOT_CANDIDATE");
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_classify_result",Integer.class)).isEqualTo(6);
        assertThat((List<?>)record(classification.results(actor,Map.of())).get("records")).hasSize(2);
    }

    @Test @EnabledIfSystemProperty(named="jxc.ai03.runPages",matches="true")
    void originalInventoryPagesUseNativeSourcesAndPersistTransferAndRelease() throws Exception {
        // 打包应用使用真实时钟，页面夹具也保持同一时钟；其他日期边界测试继续固定日期。
        clock.set(java.time.Instant.now().toString());
        // 第二国家只准备可读基础配置，明确没有规则/库存；用于验证切换后旧依据不会回填。
        seed("INSERT INTO sys_country(id,code,name,default_currency,timezone,status,config) VALUES(102,'AI03B','AI03 TEST 第二国家','MXN','America/Mexico_City','ACTIVE','{\"enabledModules\":[\"sys\",\"inv\"],\"isTest\":true}')");
        seed("INSERT INTO sys_authz_epoch(country_id) VALUES(102)");
        seed("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(213,102,'AI03-SECOND-READ','TEST 第二国家分类只读岗位','[\"inv:stock:view\",\"inv:classify:view\"]','{\"COST\":\"READ\"}')");
        seed("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(102,201,213)");
        seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(102,201,'COUNTRY_ALL',201)");
        opening(401,501,"20","3.25");order(501,2,true);
        documents.freeze(actor,null,Map.of("warehouseId",401,"productId",501,"qty",2,"reason","AI03 TEST page quality hold"),key());
        var transfer=transfer(4);
        approvalRule("TRANSFER_DIFFERENCE");
        var shortage=transfer(3);var shortageShipped=action(shortage,"ship",Map.of());
        action(shortage,"receive",Map.of("lines",List.of(Map.of("lineId",id(lines(shortageShipped).getFirst()),"qty",1))));
        action(shortage,"close",Map.of("resolution","LOSS","reason","AI03 TEST 页面差异两件"));
        approvalRule("STOCKTAKE");
        var stocktake=documents.create(actor,"stocktake",Map.of("warehouseId",402,"productIds",List.of(501)),key());
        documents.saveLimits(actor,Map.of("items",List.of(Map.of("warehouseId",401,"productId",501,"minQty",14,"maxQty",20,"alertEnabled",true))),key());
        replenishments.suggest(actor,key());classification.save(actor,null,ruleBody(30));worker.recover(101,100);
        var output=Path.of(System.getProperty("jxc.ai03.pageEvidenceDir","target/ai03-page-evidence")).toAbsolutePath();Files.createDirectories(output);
        Files.writeString(output.resolve("ui-input.json"),json.write(Map.of("transferId",id(transfer),"transferNo",transfer.get("docNo"),"shortageId",id(shortage),"shortageNo",shortage.get("docNo"),"stocktakeId",id(stocktake),"stocktakeNo",stocktake.get("docNo"))),StandardCharsets.UTF_8);
        var web=Path.of(System.getProperty("jxc.ai03.webRoot","../../jxc-web")).toAbsolutePath().normalize();
        try(var docker=Boolean.getBoolean("jxc.ai03.runDocker")?InventoryDockerPageRuntime.start(web.getParent(),output):null) {
        var process=new ProcessBuilder("node",web.resolve("tests/e2e/native-inventory-source.mjs").toString(),String.valueOf(docker==null?port:18303),web.toString(),output.toString())
            .redirectErrorStream(true).redirectOutput(output.resolve("driver.log").toFile()).start();
        try {
            assertThat(process.waitFor(240,java.util.concurrent.TimeUnit.SECONDS)).as("页面驱动在四分钟内退出；见 driver.log").isTrue();
            assertThat(process.exitValue()).as(Files.readString(output.resolve("driver.log"),StandardCharsets.UTF_8)).isZero();
        } finally {
            if(process.isAlive()) {
                process.descendants().forEach(child->child.destroyForcibly());
                process.destroyForcibly().waitFor();
            }
        }
        }
        worker.recover(101,100);
        assertThat(decimal("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=401")).isEqualByComparingTo("13");
        assertThat(decimal("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=402")).isEqualByComparingTo("4");
        assertThat(decimal("SELECT frozen_qty FROM inv_stock_summary WHERE warehouse_id=401")).isEqualByComparingTo("1");
        assertThat(count("inv_batch")).isEqualTo(1);assertThat(count("cst_cogs")).isEqualTo(2);
        assertThat(decimal("SELECT amount FROM cst_cogs WHERE source_type='INV_TRANSFER_LOSS'")).isEqualByComparingTo("6.50");
        assertThat(decimal("SELECT amount FROM cst_cogs WHERE source_type='INV_STOCKTAKE'")).isEqualByComparingTo("3.25");
        assertThat(owner.queryForObject("SELECT owner_id FROM inv_stock_limit WHERE warehouse_id=401",Long.class)).isEqualTo(201L);
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_classify_rule WHERE country_id=101",Integer.class)).isEqualTo(2);
        assertThat(owner.queryForObject("SELECT version_no FROM inv_classify_rule WHERE country_id=101 AND status='ACTIVE'",Integer.class)).isEqualTo(2);
        assertThat(owner.queryForObject("SELECT period_type FROM inv_classify_rule WHERE country_id=101 AND status='ACTIVE'",String.class)).isEqualTo("CALENDAR_WEEK");
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_classify_result WHERE country_id=101 AND rule_version_no=2",Integer.class)).isEqualTo(2);
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_classify_result WHERE country_id=101 AND rule_version_no=1",Integer.class)).isEqualTo(2);
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_classify_rule WHERE country_id=102",Integer.class)).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_stock_summary WHERE country_id=102",Integer.class)).isZero();
    }

    @Test void costCallerReadsOnlyBatchIdentityThroughInventoryContract() {
        var source=opening(401,501,"5","3.25");
        long batch=((Number)source.get("batch_id")).longValue();
        seed("UPDATE sys_role SET permissions='[\"cst:cost:view\"]' WHERE id=211");
        var before=owner.queryForMap("SELECT (SELECT count(*) FROM inv_stock_txn) txns,(SELECT count(*) FROM sys_audit_log) audits,(SELECT count(*) FROM cst_inbound_cost) costs");
        assertThatThrownBy(()->inventory.batchReference(actor,601,401,batch)).isInstanceOf(IllegalStateException.class);
        var reference=inCountry(101,()->inventory.batchReference(actor,601,401,batch));
        assertThat(reference).extracting("batchNo","sourceType","sourceId","sourceLineId").containsExactly(
            owner.queryForObject("SELECT batch_no FROM inv_batch WHERE id=?",String.class,batch),"OPENING_STOCK",
            owner.queryForObject("SELECT source_id FROM inv_batch WHERE id=?",Long.class,batch),source.get("row_id"));
        for(long[] invalid:new long[][]{{602,401},{601,402}})assertThatThrownBy(()->inCountry(101,()->inventory.batchReference(actor,invalid[0],invalid[1],batch)))
            .isInstanceOf(com.hs.jxc.common.api.ApiException.class).extracting("status","code").containsExactly(404,"NOT_FOUND");
        seed("DELETE FROM sys_user_data_scope WHERE user_id=201");seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) VALUES(101,201,'WAREHOUSE',402,201)");
        assertThatThrownBy(()->inCountry(101,()->inventory.batchReference(actor,601,401,batch)))
            .isInstanceOf(com.hs.jxc.common.api.ApiException.class).extracting("status","code").containsExactly(404,"NOT_FOUND");
        assertThat(owner.queryForMap("SELECT (SELECT count(*) FROM inv_stock_txn) txns,(SELECT count(*) FROM sys_audit_log) audits,(SELECT count(*) FROM cst_inbound_cost) costs")).isEqualTo(before);
    }

    @AfterEach void saveSourceFacts(TestInfo info) throws Exception {
        var evidence=new LinkedHashMap<String,Object>();
        evidence.put("test",info.getDisplayName());evidence.put("source","ImportService OPENING_STOCK; SalesService create/submit/cancel; no direct transaction SQL fixtures");
        for(String table:List.of("sys_import_batch","sys_import_row","sys_import_source","inv_batch","inv_stock_summary","inv_stock_txn","inv_freeze","inv_transfer","inv_transfer_line","inv_transfer_difference","inv_transfer_loss","inv_stocktake","inv_stocktake_line","inv_stock_alert","inv_replenish","cst_inbound_cost","cst_transfer_cost","cst_cogs","sal_order","sal_order_line","sal_order_alloc","inv_classify_rule","inv_classify_result","inv_classify_result_log","sys_biz_event","sys_biz_event_consume","fin_voucher","fin_voucher_line","fin_event_result","wf_instance","wf_task")) {
            var rows=owner.queryForList("SELECT * FROM "+table);
            for(var row:rows)row.replaceAll((column,value)->value instanceof java.sql.Date date?date.toLocalDate().toString():value);
            evidence.put(table,rows);
        }
        var directory=Path.of(System.getProperty("jxc.ai03.evidenceDir","target/ai03-source-evidence"));Files.createDirectories(directory);
        Files.writeString(directory.resolve(info.getTestMethod().orElseThrow().getName()+"-"+UUID.randomUUID()+".json"),json.write(evidence),StandardCharsets.UTF_8);
    }
}
