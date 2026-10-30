package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.cst.service.CostValuationService;
import com.hs.jxc.sal.SalesService;
import com.hs.jxc.rtn.ReturnsService;
import com.hs.jxc.attachment.AttachmentService;
import com.hs.jxc.workflow.service.WorkflowService;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** Transactions enter the real owner services; SQL seeds only master data, roles and explicit period setup. */
class CostNativeFlowIT extends SupplyFixtures {
    @Autowired CostValuationService valuation;
    @Autowired SalesService sales;
    @Autowired ReturnsService returns;
    @Autowired AttachmentService attachments;
    @Autowired WorkflowService workflow;
    @Autowired com.hs.jxc.inv.service.InventoryDocuments inventoryDocuments;
    @Autowired com.hs.jxc.sys.service.AuthorizationService authorization;
    @Autowired JsonCodec json;
    @LocalServerPort int port;
    final List<Map<String,Object>> checkpoints = new ArrayList<>();

    @DynamicPropertySource static void storage(DynamicPropertyRegistry r) {
        r.add("jxc.storage.endpoint",MinioTestStorage::endpoint);
        r.add("jxc.storage.access-key",()->MinioTestStorage.ACCESS);
        r.add("jxc.storage.secret-key",()->MinioTestStorage.SECRET);
        r.add("jxc.storage.bucket",()->MinioTestStorage.BUCKET);
    }

    @BeforeEach void salesConfiguration() {
        seed("UPDATE sys_role SET field_policies=field_policies||'{\"CUSTOMER_PRICE\":\"WRITE\",\"CREDIT\":\"WRITE\",\"PROFIT\":\"READ\"}'::jsonb WHERE id=202");
        seed("INSERT INTO md_customer(id,country_id,code,name) VALUES(1101,101,'AI05-TEST-CUSTOMER','Synthetic cost customer')");
        seed("INSERT INTO sal_price(country_id,product_id,price_type,unit,min_qty,price,currency,effective_from) VALUES(101,501,'BASE','PCS',1,20,'MXN','2026-10-01')");
        seed("INSERT INTO ar_credit_rule(country_id,target_type,target_id,payment_mode,credit_limit,currency,effective_from,term_days) VALUES(101,'CUSTOMER',1101,'CREDIT_ALLOWED',10000,'MXN','2026-01-01',30)");
        seed("INSERT INTO wf_doc_type_config(country_id,doc_type,approval_required,key_fields) VALUES(101,'SALES_ORDER',false,'[]')");
        seed("INSERT INTO fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(702,101,601,2026,11,'2026-11-01','2026-11-30','OPEN')");
    }

    Map<String,Object> nativeReceipt(int qty,String price,String currency) {
        return nativeReceipt(nativeDelivery(qty,price,currency),qty);
    }
    Map<String,Object> nativeDelivery(int qty,String price,String currency) {
        return nativeDelivery(qty,price,currency,"PCS",qty);
    }
    Map<String,Object> nativeDelivery(int qty,String price,String currency,String unit,int orderQty) {
        return nativeDelivery(qty,price,currency,unit,orderQty,qty);
    }
    Map<String,Object> nativeDelivery(int qty,String price,String currency,String unit,int orderQty,int dispatchQty) {
        var order=pur.create(c(),"orders",Map.of("entityId",301,"bookId",601,"supplierId",801,"currency",currency,"orderDate","2026-10-15","submit",true,"lines",List.of(Map.of("productId",501,"unit",unit,"qty",orderQty,"unitPrice",new BigDecimal(price)))),key());
        var domestic=domestic(order,qty,0,0,true);
        var exported=export(domestic,qty,true);
        var shipment=shipment(exported,qty);
        lgs.action(c(),"shipments",id(shipment),"dispatch",Map.of("actualEtd","2026-10-15T00:00:00Z"),key());
        for(String node:List.of("ARRIVED_PORT","CUSTOMS_RELEASED"))lgs.action(c(),"shipments",id(shipment),"nodes",Map.of("nodeType",node,"actualAt","2026-10-15T01:00:00Z"),key());
        var delivery=lgs.create(c(),"deliveries",Map.of("shipmentId",id(shipment),"bizDate","2026-10-15","dispatch",true,"lines",List.of(Map.of("shipmentLineId",id(first(shipment)),"dispatchQty",dispatchQty))),key());
        checkpoints.add(Map.of("purchase",order,"domestic",domestic,"export",exported,"shipment",shipment,"delivery",delivery));
        return delivery;
    }
    Map<String,Object> nativeReceipt(Map<String,Object> delivery,int qty) {
        var receipt=lgs.create(c(),"receipts",Map.of("deliveryId",id(delivery),"bizDate","2026-10-15","lines",List.of(Map.of("deliveryLineId",id(first(delivery)),"goodQty",qty))),key());
        receipt=lgs.action(c(),"receipts",id(receipt),"confirm",Map.of(),key());
        var cost=owner.queryForMap("SELECT * FROM cst_inbound_cost WHERE source_line_id=?",id(first(receipt)));
        checkpoints.add(Map.of("receipt",receipt,"cost",cost));
        return cost;
    }

    Map<String,Object> nativeSale(int qty,String date) {
        var order=sales.create(c(),Map.of("entityId",301,"bookId",601,"customerId",1101,"paymentType","CREDIT","orderDate",date,"lines",List.of(Map.of("productId",501,"unit","PCS","qty",qty,"warehouseId",401))),key());
        order=sales.submit(c(),id(order),Map.of("bizDate",date),key());
        attachments.upload(c(),"SAL_ORDER",id(order),"SALES_DOC","AI05-TEST-sale.txt","text/plain","AI05 synthetic sales evidence".getBytes(StandardCharsets.UTF_8));
        var allocation=(Map<?,?>)((List<?>)first(order).get("allocs")).getFirst();
        var outbound=sales.createOutbound(c(),Map.of("orderId",id(order),"warehouseId",401,"bizDate",date,"confirm",true,"lines",List.of(Map.of("allocId",allocation.get("id"),"qty",qty))),key());
        checkpoints.add(Map.of("salesOrder",order,"outbound",outbound));
        return outbound;
    }

    Map<String,Object> fee(long shipment,String amount,String flag,Long estimate) {
        var body=new HashMap<String,Object>(Map.of("refType","SHIPMENT","refId",shipment,"carrierId",802,"expenseItemId",803,"currency","MXN","amount",new BigDecimal(amount),"estimateFlag",flag,"bizDate","2026-10-15","confirm",true));
        if(estimate!=null)body.put("estimateFeeId",estimate);
        return lgs.create(c(),"fees",body,key());
    }
    long shipmentId(){return owner.queryForObject("SELECT id FROM lgs_shipment ORDER BY id LIMIT 1",Long.class);}
    long costId(Map<String,Object> cost){return ((Number)cost.get("id")).longValue();}
    Map<String,Object> allocate(long fee,String basis,String date){return valuation.createAllocation(c(),Map.of("feeId",fee,"basis",basis,"bizDate",date),key());}
    void confirmAllocation(Map<String,Object> allocation,String date){valuation.allocationAction(c(),id(allocation),"confirm",Map.of("bizDate",date),key());}
    void amount(String sql,String expected){assertThat(owner.queryForObject(sql,BigDecimal.class)).as(sql).isEqualByComparingTo(expected);}
    @SuppressWarnings("unchecked") Map<String,Object> http(String method,String path,Map<String,Object> body)throws Exception{
        var builder=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1/"+path)).header("Authorization","Bearer supply-fixture").header("X-Country-Id","101").header("Idempotency-Key",key()).header("Content-Type","application/json");
        builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.write(body)));
        var response=HttpClient.newHttpClient().send(builder.build(),HttpResponse.BodyHandlers.ofString());
        var result=json.readMap(response.body());result.put("httpStatus",response.statusCode());checkpoints.add(Map.of("path",path,"response",result));return result;
    }
    @SuppressWarnings("unchecked") Map<String,Object> ok(String method,String path,Map<String,Object> body)throws Exception{
        var result=http(method,path,body);assertThat(result.get("httpStatus")).as(result.toString()).isEqualTo(200);return (Map<String,Object>)result.get("data");
    }
    void confirmedRate(String date,int value)throws Exception{
        var rate=ok("POST","md/exchange-rates",Map.of("fromCcy","CNY","toCcy","MXN","rateDate",date,"scope","PURCHASE_COST","rate",value));
        ok("POST","md/exchange-rates/"+id(rate)+"/confirm",Map.of());
    }

    @Test void missingRateRecoversThroughNativeRateConfirmationAndKeepsReceiptSnapshot()throws Exception{
        var cost=nativeReceipt(10,"2","CNY");long id=costId(cost);
        assertThat(cost).containsEntry("status","PENDING_RATE").containsEntry("unit_cost",null);
        assertThat(http("POST","cst/inbound-costs/"+id+"/confirm",Map.of()).get("httpStatus")).isEqualTo(409);
        nativeSale(4,"2026-10-15");
        var originalCogs=owner.queryForMap("SELECT * FROM cst_cogs");
        var missingProfit=(Map<?,?>)((List<?>)ok("GET","cst/profit?bookId=601&periodId=701",null).get("rows")).getFirst();
        assertThat(missingProfit.get("completeness")).isEqualTo("INSUFFICIENT");
        assertThat(missingProfit.get("cogsAmount")).isNull();
        if(System.getProperty("jxc.ai05.readBrowserDriver")!=null)runBrowser(System.getProperty("jxc.ai05.readBrowserDriver"),Path.of(System.getProperty("jxc.ai05.evidenceDir"),"pending-rate-pages"),0,"READ");
        confirmedRate("2026-10-15",3);
        ok("POST","cst/inbound-costs/"+id+"/confirm",Map.of());
        amount("SELECT base_purchase_amount FROM cst_cost_confirmation","60");
        assertThat(owner.queryForMap("SELECT * FROM cst_inbound_cost WHERE id=?",id)).isEqualTo(cost);
        assertThat(owner.queryForMap("SELECT * FROM cst_cogs")).isEqualTo(originalCogs);
        var recoveredProfit=(Map<?,?>)((List<?>)ok("GET","cst/profit?bookId=601&periodId=701",null).get("rows")).getFirst();
        assertThat(new BigDecimal(recoveredProfit.get("cogsAmount").toString())).isEqualByComparingTo("24");
        assertThat(new BigDecimal(recoveredProfit.get("netSalesAmount").toString())).isEqualByComparingTo("80");
        assertThat(http("PUT","cst/method?bookId=601",Map.of("method","MOVING_AVG","effectiveFrom","2026-10-01","version",1)).get("code")).isEqualTo("CST_METHOD_LOCKED");
    }

    @ParameterizedTest @CsvSource({"FIFO,50,30","MOVING_AVG,60,20"})
    void nativeTwoPriceReceiptsUseConfiguredValueAndKeepFrozenSales(String method,String firstCost,String remainder)throws Exception{
        ok("PUT","cst/method?bookId=601",Map.of("method",method,"effectiveFrom","2026-10-01","version",1));
        nativeReceipt(2,"10","MXN");nativeReceipt(2,"30","MXN");
        nativeSale(3,"2026-10-15");amount("SELECT amount FROM cst_cogs",firstCost);amount("SELECT amount FROM cst_valuation_pool",remainder);
        var original=owner.queryForMap("SELECT * FROM cst_cogs");nativeReceipt(2,"100","MXN");
        assertThat(owner.queryForMap("SELECT * FROM cst_cogs")).isEqualTo(original);
        amount("SELECT sum(amount) FROM ar_receivable","60");
    }

    @ParameterizedTest @ValueSource(strings={"QTY","VALUE","WEIGHT","VOLUME"})
    void nativeFeeUsesOriginalAllocationEntryAndOneEffectiveCapitalization(String basis){
        seed("UPDATE md_product SET gross_weight=2,volume=3 WHERE id=501");
        nativeReceipt(10,"2","MXN");var fee=fee(shipmentId(),"9","ACTUAL",null);var allocation=allocate(id(fee),basis,"2026-10-15");
        confirmAllocation(allocation,"2026-10-15");confirmAllocation(allocation,"2026-10-15");
        amount("SELECT sum(amount) FROM cst_fee_allocation_line","9");amount("SELECT sum(amount) FROM cst_valuation_change","9");
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_fee_allocation_claim",Integer.class)).isEqualTo(1);
        amount("SELECT amount FROM cst_valuation_pool","29");
    }

    @ParameterizedTest @CsvSource({"135,45","45,-45"})
    void nativeActualReplacementAddsOnlySignedDifference(String actual,String difference){
        nativeReceipt(10,"2","MXN");var estimated=fee(shipmentId(),"90","ESTIMATE",null);confirmAllocation(allocate(id(estimated),"QTY","2026-10-15"),"2026-10-15");
        nativeSale(4,"2026-10-15");var replacement=fee(shipmentId(),actual,"ACTUAL",id(estimated));
        lgs.action(c(),"fees",id(replacement),"confirm",Map.of(),key());
        amount("SELECT sum(amount) FROM cst_valuation_change",actual);
        amount("SELECT diff_amount FROM lgs_fee WHERE estimate_fee_id IS NOT NULL",difference);
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_allocation_relation",Integer.class)).isEqualTo(1);
        assertThatThrownBy(()->allocate(id(replacement),"QTY","2026-10-15")).isInstanceOf(ApiException.class);
    }

    @Test void nativeReturnResaleAndLateFeeConserveCurrentInventoryAndNetSoldProfit()throws Exception{
        nativeReceipt(10,"2","MXN");var outbound=nativeSale(4,"2026-10-15");var original=owner.queryForMap("SELECT * FROM cst_cogs");
        workflow.createRule(c(),Map.of("docType","SALES_RETURN","name","AI05 cost return","conditions",List.of(),"nodes",List.of(Map.of("nodeName","Finance","approverType","USER","approverRef",201,"mode","ANY"))));
        var returned=returns.createSales(c(),Map.of("orderId",outbound.get("orderId"),"outboundId",id(outbound),"returnWarehouseId",401,"reasonCode","QUALITY","responsibility","SUPPLIER","bizDate","2026-10-16","submit",true,"lines",List.of(Map.of("outboundLineId",id(first(outbound)),"qty",1))),key());
        workflow.approve(c(),owner.queryForObject("SELECT id FROM wf_task WHERE status='PENDING'",Long.class),"AI05 source checked");
        returns.receive(c(),id(returned),Map.of("bizDate","2026-10-16","waitForMore",true,"lines",List.of(Map.of("id",id(first(returned)),"receivedQty",1))),key());
        returns.inspect(c(),id(returned),Map.of("bizDate","2026-10-16","lines",List.of(Map.of("id",id(first(returned)),"goodQty",1,"frozenQty",0,"freezeType",""))),key());
        returns.settleSales(c(),id(returned),Map.of("bizDate","2026-10-16"),key());nativeSale(1,"2026-10-16");
        var fee=fee(shipmentId(),"90","ACTUAL",null);confirmAllocation(allocate(id(fee),"QTY","2026-10-16"),"2026-10-16");
        amount("SELECT sum(inventory_amount) FROM cst_valuation_change","54");amount("SELECT sum(sold_amount) FROM cst_valuation_change","36");
        amount("SELECT amount FROM cst_valuation_pool","66");amount("SELECT sum(amount) FROM cst_cogs","8");
        assertThat(owner.queryForMap("SELECT * FROM cst_cogs WHERE id=?",original.get("id"))).isEqualTo(original);
        var profit=ok("GET","cst/profit?bookId=601&periodId=701",null);
        var product=(Map<?,?>)((List<?>)profit.get("rows")).getFirst();
        assertThat(new BigDecimal(product.get("cogsAmount").toString())).isEqualByComparingTo("44");
        assertThat(new BigDecimal(product.get("netSalesAmount").toString())).isEqualByComparingTo("80");
        assertThat(profit.get("disclaimer").toString()).contains("未包含线下营销费用");
    }

    @Test void nativeExpensesKeepBothCurrenciesAndDoNotRecountCapitalizedFees()throws Exception{
        nativeReceipt(10,"2","MXN");nativeSale(4,"2026-10-15");
        seed("INSERT INTO md_expense_item(id,country_id,code,name,cost_treatment) VALUES(804,101,'AI05-DIRECT','Direct','DIRECT_SELLING'),(805,101,'AI05-PERIOD','Period','PERIOD_EXPENSE')");
        confirmedRate("2026-10-15",2);
        var direct=valuation.createExpense(c(),Map.of("bookId",601,"expenseItemId",804,"currency","CNY","amount",3,"bizDate","2026-10-15","lines",List.of(Map.of("productId",501,"amount",3))),key());
        var frozen=owner.queryForMap("SELECT * FROM cst_expense_record WHERE id=?",id(direct));
        confirmedRate("2026-10-16",9);
        assertThat(owner.queryForMap("SELECT * FROM cst_expense_record WHERE id=?",id(direct))).isEqualTo(frozen);
        valuation.createExpense(c(),Map.of("bookId",601,"expenseItemId",805,"currency","MXN","amount",2,"bizDate","2026-10-15","lines",List.of(Map.of("productId",501,"amount",2))),key());
        assertThatThrownBy(()->valuation.createExpense(c(),Map.of("bookId",601,"expenseItemId",803,"currency","MXN","amount",90,"bizDate","2026-10-15"),key())).isInstanceOf(ApiException.class);
        var profit=ok("GET","cst/profit?bookId=601&periodId=701",null);var product=(Map<?,?>)((List<?>)profit.get("rows")).getFirst();
        assertThat(new BigDecimal(product.get("contributionProfit").toString())).isEqualByComparingTo("64");
        amount("SELECT sum(l.amount) FROM cst_expense_alloc_line l JOIN cst_expense_record e ON e.id=l.expense_id WHERE e.currency='CNY'","3");
        amount("SELECT sum(l.amount) FROM cst_expense_alloc_line l JOIN cst_expense_record e ON e.id=l.expense_id WHERE e.currency='MXN'","2");
        amount("SELECT sum(base_amount) FROM cst_expense_alloc_line","8");
    }

    @Test void nativeReceiptCannotWriteStockBeforeMethodConfiguration()throws Exception{
        seed("DELETE FROM cst_method_config");
        assertThatThrownBy(()->nativeReceipt(3,"2","MXN")).isInstanceOf(ApiException.class).extracting("code").isEqualTo("CST_METHOD_REQUIRED");
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_batch",Integer.class)).isZero();
        assertThat(owner.queryForObject("SELECT status FROM lgs_receipt",String.class)).isEqualTo("DRAFT");
        ok("PUT","cst/method?bookId=601",Map.of("method","FIFO","effectiveFrom","2026-10-01"));
        long receipt=owner.queryForObject("SELECT id FROM lgs_receipt",Long.class);
        lgs.action(c(),"receipts",receipt,"confirm",Map.of(),key());
        amount("SELECT sum(qty) FROM cst_inbound_cost","3");amount("SELECT amount FROM cst_valuation_pool","6");
    }

    @Test void nativeReverseAndReallocationAppendFactsWithOnlyOneCurrentClaim(){
        nativeReceipt(10,"2","MXN");var fee=fee(shipmentId(),"9","ACTUAL",null);
        var first=allocate(id(fee),"QTY","2026-10-15");confirmAllocation(first,"2026-10-15");
        valuation.allocationAction(c(),id(first),"reverse",Map.of("reason","AI05 native reallocation","bizDate","2026-10-16"),key());
        amount("SELECT sum(amount) FROM cst_valuation_change","0");
        var second=allocate(id(fee),"QTY","2026-10-16");confirmAllocation(second,"2026-10-16");
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_fee_allocation_claim",Integer.class)).isEqualTo(1);
        amount("SELECT sum(amount) FROM cst_valuation_change","9");
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_valuation_change",Integer.class)).isEqualTo(3);
    }

    @Test void nativeFeeBeforeTwoPartialReceiptsRemainsAnExplicitUnallocatedAsset(){
        var delivery=nativeDelivery(10,"2","MXN","PCS",10,4);var fee=fee(shipmentId(),"9","ACTUAL",null);
        assertThatThrownBy(()->allocate(id(fee),"QTY","2026-10-15")).isInstanceOf(ApiException.class).extracting("code").isEqualTo("CST_RECEIPT_REQUIRED");
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_fee_allocation",Integer.class)).isZero();
        nativeReceipt(delivery,4);
        long line=owner.queryForObject("SELECT id FROM lgs_shipment_line",Long.class);
        var later=lgs.create(c(),"deliveries",Map.of("shipmentId",shipmentId(),"bizDate","2026-10-15","dispatch",true,"lines",List.of(Map.of("shipmentLineId",line,"dispatchQty",6))),key());
        nativeReceipt(later,6);
        var allocation=allocate(id(fee),"QTY","2026-10-15");confirmAllocation(allocation,"2026-10-15");
        amount("SELECT sum(qty) FROM cst_inbound_cost","10");amount("SELECT sum(amount) FROM cst_fee_allocation_line","9");
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_fee_allocation_line",Integer.class)).isEqualTo(2);
        amount("SELECT amount FROM cst_valuation_pool","29");
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event WHERE event_type='LGS_FEE_CONFIRMED'",Integer.class)).isEqualTo(1);
    }

    @Test void nativeOneBoxCostOfOneSurvivesThreeSeparateSales(){
        seed("UPDATE md_product_unit SET factor_to_base=3 WHERE product_id=501 AND unit='BOX'");
        nativeReceipt(nativeDelivery(3,"1","MXN","BOX",1),3);
        for(int i=0;i<3;i++)nativeSale(1,"2026-10-15");
        amount("SELECT sum(src_amount) FROM cst_inbound_cost","1");amount("SELECT sum(amount) FROM cst_cogs","1");
        amount("SELECT amount FROM cst_valuation_pool","0");
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_cogs",Integer.class)).isEqualTo(3);
        assertThat(owner.queryForObject("SELECT min(amount) FROM cst_cogs",BigDecimal.class)).isPositive();
    }

    @Test void nativeManualAllocationRequiresOriginalApprovalBeforeConfirmation(){
        var cost=nativeReceipt(10,"2","MXN");var fee=fee(shipmentId(),"9","ACTUAL",null);
        workflow.createRule(c(),Map.of("docType","COST_ALLOCATION","name","AI05 manual basis","conditions",List.of(),"nodes",List.of(Map.of("nodeName","Finance","approverType","USER","approverRef",201,"mode","ANY"))));
        var allocation=valuation.createAllocation(c(),Map.of("feeId",id(fee),"basis","MANUAL","bizDate","2026-10-15","targets",List.of(Map.of("batchId",cost.get("batch_id"),"ratio",1))),key());
        assertThatThrownBy(()->confirmAllocation(allocation,"2026-10-15")).isInstanceOf(ApiException.class);
        workflow.approve(c(),owner.queryForObject("SELECT id FROM wf_task WHERE status='PENDING'",Long.class),"AI05 approved synthetic ratio");
        confirmAllocation(allocation,"2026-10-15");amount("SELECT sum(amount) FROM cst_valuation_change","9");
    }

    @Test void nativeAllocationIntentReplaysRejectsChangedBodyAndCannotClaimFeeTwice(){
        nativeReceipt(10,"2","MXN");var fee=fee(shipmentId(),"9","ACTUAL",null);
        var body=Map.<String,Object>of("feeId",id(fee),"basis","QTY","bizDate","2026-10-15");
        String intent=key();var first=valuation.createAllocation(c(),body,intent);
        assertThat(id(valuation.createAllocation(c(),body,intent))).isEqualTo(id(first));
        assertThatThrownBy(()->valuation.createAllocation(c(),Map.of("feeId",id(fee),"basis","VALUE","bizDate","2026-10-15"),intent)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);
        var competing=valuation.createAllocation(c(),body,key());
        String confirmation=key();var date=Map.<String,Object>of("bizDate","2026-10-15");
        valuation.allocationAction(c(),id(first),"confirm",date,confirmation);
        valuation.allocationAction(c(),id(first),"confirm",date,confirmation);
        assertThatThrownBy(()->valuation.allocationAction(c(),id(competing),"confirm",date,key())).isInstanceOf(ApiException.class);
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_fee_allocation_claim",Integer.class)).isEqualTo(1);
        amount("SELECT sum(amount) FROM cst_valuation_change","9");
    }

    @Test void nativeMixedBatchConfirmationKeepsPendingAndUnavailableItemsExplicit()throws Exception{
        long good=costId(nativeReceipt(2,"10","MXN")),pending=costId(nativeReceipt(2,"10","CNY"));
        var result=ok("POST","cst/inbound-costs/batch-confirm",Map.of("ids",List.of(good,pending,999999L)));
        assertThat(((List<?>)result.get("confirmed")).stream().map(value->((Number)value).longValue()).toList()).containsExactly(good);
        assertThat((List<?>)result.get("failed")).hasSize(2);
        assertThat(result.get("failed").toString()).contains("CST_RATE_MISSING");
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_cost_confirmation",Integer.class)).isEqualTo(1);
        seed("DELETE FROM sys_user_data_scope WHERE user_id=201");
        seed("INSERT INTO org_warehouse(id,country_id,entity_id,code,name) VALUES(402,101,301,'AI05-RESTRICTED','Restricted')");
        seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) VALUES(101,201,'WAREHOUSE',402,201)");
        var hidden=ok("POST","cst/inbound-costs/batch-confirm",Map.of("ids",List.of(good,999999L)));
        assertThat((List<?>)hidden.get("confirmed")).isEmpty();
        var failures=(List<Map<String,Object>>)hidden.get("failed");
        assertThat(failures).hasSize(2);assertThat(failures.get(0).get("reason")).isEqualTo(failures.get(1).get("reason"));
    }

    @Test void nativeApprovedAdjustmentAppendsInOpenPeriodAndKeepsClosedSource(){
        var cost=nativeReceipt(10,"2","MXN");long batch=((Number)cost.get("batch_id")).longValue();
        workflow.createRule(c(),Map.of("docType","COST_ADJUSTMENT","name","AI05 finance approval","conditions",List.of(),"nodes",List.of(Map.of("nodeName","Finance","approverType","USER","approverRef",201,"mode","ANY"))));
        seed("UPDATE fin_period SET status='CLOSED' WHERE id=701");
        assertThatThrownBy(()->valuation.createAdjustment(c(),Map.of("batchId",batch,"amount",1,"target","INVENTORY","reason","AI05 closed period","bizDate","2026-10-15"),key())).isInstanceOf(ApiException.class);
        var adjustment=valuation.createAdjustment(c(),Map.of("batchId",batch,"amount",new BigDecimal("1.005"),"target","INVENTORY","reason","AI05 late source correction","bizDate","2026-11-01"),key());
        assertThatThrownBy(()->valuation.confirmAdjustment(c(),id(adjustment),Map.of(),key())).isInstanceOf(ApiException.class);
        workflow.approve(c(),owner.queryForObject("SELECT id FROM wf_task WHERE status='PENDING'",Long.class),"AI05 approved original evidence");
        String intent=key();valuation.confirmAdjustment(c(),id(adjustment),Map.of(),intent);valuation.confirmAdjustment(c(),id(adjustment),Map.of(),intent);
        amount("SELECT sum(amount) FROM cst_valuation_change","1.005");
        assertThat(owner.queryForMap("SELECT * FROM cst_inbound_cost WHERE id=?",costId(cost))).isEqualTo(cost);
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_valuation_change WHERE biz_date<'2026-11-01'",Integer.class)).isZero();
        assertThat(new BigDecimal(valuation.trace(c(),batch,Map.of("asOf","2026-10-31")).get("unitCost").toString())).isEqualByComparingTo("2");
    }

    @Test void nativeCostPagesUseTheSameSourceAndWriteThroughOriginalCommands()throws Exception{
        String driver=System.getProperty("jxc.ai05.browserDriver");
        Assumptions.assumeTrue(driver!=null,"Optional real browser acceptance requires the explicit local driver");
        nativeReceipt(10,"2","MXN");nativeSale(4,"2026-10-15");
        var fee=fee(shipmentId(),"9","ACTUAL",null);
        seed("INSERT INTO md_expense_item(id,country_id,code,name,cost_treatment) VALUES(804,101,'AI05-DIRECT','Direct','DIRECT_SELLING'),(805,101,'AI05-PERIOD','Period','PERIOD_EXPENSE')");
        runBrowser(driver,Path.of(System.getProperty("jxc.ai05.evidenceDir"),"write-pages"),id(fee),"WRITE");
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_cost_confirmation",Integer.class)).isEqualTo(1);
        amount("SELECT sum(amount) FROM cst_valuation_change","9");
        String backup=System.getProperty("jxc.ai05.dockerBackup");
        if(backup!=null){
            var dump=PgDatabase.PG.execInContainer("pg_dump","-U","postgres","-d","jxc_m01_test");
            assertThat(dump.getExitCode()).as("private native-source backup").isZero();
            Files.writeString(Path.of(backup),dump.getStdout(),StandardCharsets.UTF_8);
        }
    }

    @ParameterizedTest @ValueSource(strings={"FIFO","MOVING_AVG"})
    void nativeLateFeeFollowsRealTransferAndPartialReceipt(String method){
        seed("UPDATE cst_method_config SET method=?",method);
        nativeReceipt(10,"2","MXN");nativeSale(2,"2026-10-15");
        var frozen=owner.queryForMap("SELECT * FROM cst_cogs");
        seed("INSERT INTO org_warehouse(id,country_id,entity_id,code,name) VALUES(402,101,301,'AI05-DEST','AI05 destination')");
        NumberFixtures.seed(101,"TRANSFER");
        seed("INSERT INTO wf_doc_type_config(country_id,doc_type,approval_required) VALUES(101,'TRANSFER',false)");
        var transfer=inventoryDocuments.create(c(),"transfer",Map.of("fromWarehouseId",401,"toWarehouseId",402,"plannedDate","2026-10-15","submit",true,"lines",List.of(Map.of("productId",501,"qty",4))),key());
        transfer=inventoryDocuments.action(c(),"transfer",id(transfer),"ship",Map.of("bizDate","2026-10-15"),key());
        var originalTransfer=owner.queryForMap("SELECT * FROM cst_transfer_cost");
        var fee=fee(shipmentId(),"9","ACTUAL",null);confirmAllocation(allocate(id(fee),"QTY","2026-10-15"),"2026-10-15");
        amount("SELECT sum(sold_amount) FROM cst_valuation_change","1.8");
        var received=inventoryDocuments.action(c(),"transfer",id(transfer),"receive",Map.of("bizDate","2026-10-15","lines",List.of(Map.of("lineId",id(first(transfer)),"qty",2))),key());
        checkpoints.add(Map.of("transfer",received));
        amount("SELECT amount FROM cst_valuation_pool WHERE warehouse_id=401","11.6");
        amount("SELECT amount FROM cst_valuation_pool WHERE warehouse_id=402","5.8");
        var assets=inCountry(101,()->valuation.balances(authorization.authorize(c()),601,java.time.LocalDate.of(2026,10,15),"INVENTORY"));
        assertThat(assets.stream().map(row->new BigDecimal(row.get("amount").toString())).reduce(BigDecimal.ZERO,BigDecimal::add)).isEqualByComparingTo("23.2");
        assertThat(owner.queryForMap("SELECT * FROM cst_cogs")).isEqualTo(frozen);
        assertThat(owner.queryForMap("SELECT * FROM cst_transfer_cost")).isEqualTo(originalTransfer);
    }

    void runBrowser(String driver,Path output,long fee,String mode)throws Exception{
        Files.createDirectories(output);
        var builder=new ProcessBuilder("node.exe",driver,String.valueOf(port),output.toString(),String.valueOf(fee),System.getProperty("jxc.ai05.webDist"),System.getProperty("jxc.ai05.playwrightModule"),mode);
        builder.environment().put("JXC_AI05_TEST_TOKEN","supply-fixture");
        if(System.getProperty("jxc.ai05.chromium")!=null)builder.environment().put("JXC_AI05_CHROMIUM",System.getProperty("jxc.ai05.chromium"));
        builder.redirectErrorStream(true);builder.redirectOutput(output.resolve("browser-driver.log").toFile());
        var process=builder.start();
        try {
            assertThat(process.waitFor(150,java.util.concurrent.TimeUnit.SECONDS)).as("browser driver deadline").isTrue();
            assertThat(process.exitValue()).as("Inspect browser-driver.log for first failing page").isZero();
        } finally {if(process.isAlive())process.destroyForcibly();}
    }

    @AfterEach void evidence(TestInfo test)throws Exception{
        String directory=System.getProperty("jxc.ai05.evidenceDir");if(directory==null)return;
        var result=new LinkedHashMap<String,Object>();result.put("method",test.getTestMethod().orElseThrow().getName());result.put("case",test.getDisplayName());result.put("sourceSha",System.getProperty("jxc.ai05.sourceSha","UNSPECIFIED"));result.put("checkpoints",checkpoints);
        for(String table:List.of("pur_order","pur_order_line","pur_domestic_receipt","pur_domestic_receipt_line","pur_export_node","pur_export_node_line","lgs_shipment","lgs_shipment_line","lgs_delivery","lgs_delivery_line","lgs_receipt","lgs_receipt_line","inv_batch","inv_stock_txn","inv_transfer","inv_transfer_line","cst_transfer_cost","cst_transfer_cost_part","cst_valuation_movement","cst_inbound_cost","cst_cost_confirmation","cst_cogs","cst_cogs_part","cst_cogs_completion","cst_movement_completion","cst_valuation_pool","cst_valuation_change","lgs_fee","cst_fee_allocation","cst_fee_allocation_line","cst_fee_allocation_claim","cst_allocation_relation","sal_order","sal_outbound","ar_receivable","rtn_sales_return","rtn_sales_settlement","cst_expense_record","cst_expense_alloc_line","sys_biz_event"))result.put(table,owner.queryForList("SELECT * FROM "+table+" t ORDER BY to_jsonb(t)::text"));
        Files.createDirectories(Path.of(directory));String suffix=Integer.toUnsignedString(test.getDisplayName().hashCode());Files.writeString(Path.of(directory,test.getTestMethod().orElseThrow().getName()+"-"+suffix+".json"),json.write(result),StandardCharsets.UTF_8);
        if(System.getProperty("jxc.ai05.readBrowserDriver")!=null&&!test.getTestMethod().orElseThrow().getName().equals("nativeCostPagesUseTheSameSourceAndWriteThroughOriginalCommands"))
            runBrowser(System.getProperty("jxc.ai05.readBrowserDriver"),Path.of(directory,test.getTestMethod().orElseThrow().getName()+"-"+suffix+"-pages"),0,"READ");
    }
}
