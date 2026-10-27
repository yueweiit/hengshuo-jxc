package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.ap.PayablesService;
import com.hs.jxc.ar.ReceivablesService;
import com.hs.jxc.attachment.AttachmentService;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.rtn.ReturnsService;
import com.hs.jxc.sal.SalesService;
import com.hs.jxc.sys.jobs.JobApi;
import com.hs.jxc.sys.jobs.JobService;
import com.hs.jxc.sys.service.SessionService;
import com.hs.jxc.workflow.service.WorkflowService;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.boot.test.web.server.LocalServerPort;

/** AI-04: economic facts enter through existing native services; SQL prepares master data only.
 * The critical-field test attempts to corrupt a refund header; the real immutable-fact
 * trigger must reject it. No injected change is a source for a successful payment. */
class ReturnsPayablesNativeFlowIT extends SupplyFixtures {
    @Autowired PayablesService ap;
    @Autowired ReturnsService rtn;
    @Autowired SalesService sales;
    @Autowired ReceivablesService ar;
    @Autowired WorkflowService workflow;
    @Autowired AttachmentService attachments;
    @Autowired JsonCodec json;
    @Autowired JobApi jobs;
    @Autowired JobService jobService;
    @Autowired com.hs.jxc.ap.PayableRecognitionService recognition;
    @Autowired SessionService sessions;
    @LocalServerPort int port;
    final Map<String,Object> sources = new LinkedHashMap<>();
    RequestContext manager, accountant, outsider;
    @DynamicPropertySource static void storage(DynamicPropertyRegistry r) {
        r.add("jxc.storage.endpoint", MinioTestStorage::endpoint);
        r.add("jxc.storage.access-key", () -> MinioTestStorage.ACCESS);
        r.add("jxc.storage.secret-key", () -> MinioTestStorage.SECRET);
        r.add("jxc.storage.bucket", () -> MinioTestStorage.BUCKET);
    }
    @BeforeEach void nativeConfiguration() {
        sources.clear();
        NumberFixtures.seed(101,"AP_PAYMENT","AP_PREPAYMENT","AP_CREDIT_NOTE","AP_ADJUSTMENT","AP_SETTLEMENT");
        seed("update sys_doc_number_rule set prefix='AI04-'||left(prefix,15) where country_id=101");
        // An explicit, non-admin test orchestration role; separate assigned reviewers below.
        var permissions = List.of("pur:order:create","pur:order:submit","pur:receipt:create","pur:receipt:confirm",
            "pur:export:create","pur:export:confirm","pur:order:view","lgs:shipment:create","lgs:shipment:submit",
            "lgs:shipment:dispatch","lgs:node:record","lgs:shipment:view","lgs:delivery:create","lgs:delivery:dispatch",
            "lgs:receipt:create","lgs:receipt:confirm","lgs:receipt:view","lgs:fee:create","lgs:fee:confirm","lgs:discrepancy:handle",
            "sal:order:create","sal:order:submit","sal:order:view","sal:outbound:create","sal:outbound:confirm",
            "ar:receipt:create","ar:receipt:confirm","ar:writeoff:create","rtn:sales:create","rtn:sales:submit",
            "rtn:sales:receive","rtn:sales:inspect","rtn:sales:settle","rtn:refund:create","rtn:refund:pay",
            "rtn:purchase:create","rtn:purchase:ship","rtn:claim:create","rtn:claim:resolve","ap:bill:create",
            "ap:bill:confirm","ap:bill:void","ap:bill:view","ap:payment:create","ap:payment:confirm",
            "ap:prepayment:create","ap:settlement:create","ap:settlement:reverse","ap:adjustment:create",
            "ap:statement:view","ap:statement:export","ap:recognition:edit","wf:rule:edit","sys:attachment:upload","sys:attachment:view");
        seed("update sys_role set code='AI04_ORCHESTRATOR',permissions=?::jsonb,field_policies='{\"COST\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"BANK_INFO\":\"WRITE\",\"CREDIT\":\"WRITE\",\"CUSTOMER_PRICE\":\"WRITE\",\"PROFIT\":\"WRITE\"}' where id=202", json.write(permissions));
        manager = reviewer(211, "AI04_MANAGER", false);
        accountant = reviewer(212, "AI04_ACCOUNTANT", false);
        outsider = reviewer(213, "AI04_ADMIN_NEGATIVE", true);
        seed("insert into md_exchange_rate(country_id,from_ccy,to_ccy,rate_date,scope,rate,status,confirmed_by,confirmed_at) values(101,'CNY','MXN','2026-10-15','PURCHASE_COST',2.5,'CONFIRMED',201,clock_timestamp()),(101,'CNY','MXN','2026-10-15','SETTLEMENT',2.5,'CONFIRMED',201,clock_timestamp())");
        seed("insert into md_customer(id,country_id,code,name) values(1801,101,'AI04-C','AI04 synthetic customer')");
        seed("insert into md_fund_account(id,country_id,entity_id,book_id,name,account_type,currency) values(1901,101,301,601,'AI04 MXN','CASH','MXN'),(1902,101,301,601,'AI04 CNY','BANK','CNY')");
        seed("insert into ar_credit_rule(country_id,target_type,target_id,payment_mode,credit_limit,currency,effective_from) values(101,'CUSTOMER',1801,'CREDIT_ALLOWED',1000,'MXN','2026-01-01')");
        seed("insert into sal_price(country_id,product_id,price_type,unit,min_qty,price,currency,effective_from) values(101,501,'BASE','PCS',1,20,'MXN','2026-01-01')");
        seed("insert into wf_doc_type_config(country_id,doc_type,approval_required,key_fields) values(101,'SALES_ORDER',false,'[]')");
        sources.put("permissions", permissions);
    }
    RequestContext reviewer(long user, String name, boolean admin) {
        String hash = SessionService.digest(name);
        seed("insert into sys_user(id,username,password_hash,display_name,status,is_platform_admin) values(?,?,'unused',?,'ENABLED',?)",user,name,name,admin);
        seed("insert into sys_session(token_hash,user_id,expires_at) values(?,?,clock_timestamp()+interval '1 hour')",hash,user);
        seed("insert into sys_role(id,country_id,code,name,permissions,field_policies) values(?,101,?,?,'[\"wf:task:approve\",\"wf:task:view\",\"rtn:sales:create\",\"rtn:refund:create\",\"rtn:purchase:create\",\"ap:bill:view\",\"ap:adjustment:create\"]','{\"COST\":\"READ\",\"ORDER_TOTAL\":\"READ\",\"BANK_INFO\":\"READ\",\"CREDIT\":\"READ\"}')",user+100,name,name);
        seed("insert into sys_user_role(country_id,user_id,role_id) values(101,?,?)",user,user+100);
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(101,?,'COUNTRY_ALL',201)",user);
        return new RequestContext(user,101L,name,hash);
    }
    void rule(String type, boolean two) {
        var nodes = new ArrayList<Map<String,Object>>();
        nodes.add(Map.of("nodeName","店长","approverType","USER","approverRef",211,"mode","ANY"));
        if (two) nodes.add(Map.of("nodeName","会计","approverType","USER","approverRef",212,"mode","ANY"));
        var conditions=type.equals("REFUND")&&two?List.of(Map.of("field","amount","op","gte","value",50)):List.of();
        workflow.createRule(c(),Map.of("docType",type,"name","AI04 "+type,"conditions",conditions,"nodes",nodes));
    }
    long task(String type,long doc) { return owner.queryForObject("select t.id from wf_task t join wf_instance i on i.country_id=t.country_id and i.id=t.instance_id where i.doc_type=? and i.doc_id=? and t.status='PENDING' order by t.id limit 1",Long.class,type,doc); }
    void approve(String type,long doc,boolean two) {
        workflow.approve(manager,task(type,doc),"AI04 first independent review");
        if(two) workflow.approve(accountant,task(type,doc),"AI04 second independent review");
    }
    Map<String,Object> stock() {
        var d=delivery();var r=receipt(d);lgs.action(c(),"receipts",id(r),"confirm",Map.of(),key());
        assertThat(owner.queryForObject("select on_hand_qty from inv_stock_summary",BigDecimal.class)).isEqualByComparingTo("9");
        assertThat(owner.queryForObject("select unit_cost from cst_inbound_cost",BigDecimal.class)).isEqualByComparingTo("12.5");
        sources.put("delivery",d);sources.put("receipt",r);return r;
    }
    Map<String,Object> sale(int qty) {
        stock();var o=sales.create(c(),Map.of("bookId",601,"entityId",301,"customerId",1801,"orderDate","2026-10-15","paymentType","CREDIT","lines",List.of(Map.of("productId",501,"unit","PCS","qty",qty,"allocs",List.of(Map.of("warehouseId",401,"allocQty",qty))))),key());
        o=sales.submit(c(),id(o),Map.of("bizDate","2026-10-15"),key());
        attachments.upload(c(),"SAL_ORDER",id(o),"SALES_DOC","AI04-sale.txt","text/plain","AI04 native sale".getBytes(StandardCharsets.UTF_8));
        long alloc=((Number)((Map<?,?>)((List<?>)first(o).get("allocs")).getFirst()).get("id")).longValue();
        var out=sales.createOutbound(c(),Map.of("orderId",id(o),"warehouseId",401,"bizDate","2026-10-15","lines",List.of(Map.of("allocId",alloc,"qty",qty))),key());
        out=sales.confirmOutbound(c(),id(out),Map.of("bizDate","2026-10-15"),key());sources.put("order",o);sources.put("outbound",out);return out;
    }
    void collect(Map<String,Object> out,int amount) {
        var r=ar.createReceipt(c(),Map.of("customerId",1801,"fundAccountId",1901,"method","CASH","amount",amount,"bizTime","2026-10-15T12:00:00Z"),key());
        ar.receiptAction(c(),id(r),"confirm",Map.of("arrivalDate","2026-10-15"),key());
        ar.writeoff(c(),Map.of("customerId",1801,"bizDate","2026-10-15","lines",List.of(Map.of("fromType","RECEIPT","fromId",id(r),"receivableId",out.get("receivableId"),"amount",amount))),key());sources.put("customerReceipt",r);
    }
    Map<String,Object> requestReturn(Map<String,Object> out,int qty) {
        return rtn.createSales(c(),Map.of("outboundId",id(out),"returnWarehouseId",401,"reasonCode","QUALITY","responsibility","SUPPLIER","bizDate","2026-10-15","submit",true,"lines",List.of(Map.of("outboundLineId",id(first(out)),"reqQty",qty))),key());
    }
    Map<String,Object> receive(Map<String,Object> r,int qty) { return rtn.receive(c(),id(r),Map.of("bizDate","2026-10-15","waitForMore",true,"lines",List.of(Map.of("id",id(first(r)),"receivedQty",qty))),key()); }
    Map<String,Object> inspect(Map<String,Object> r,int good,int frozen) { return rtn.inspect(c(),id(r),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("id",id(first(r)),"goodQty",good,"frozenQty",frozen,"freezeType",frozen>0?"RETURN_PENDING":""))),key()); }
    Map<String,Object> fullyReturned() {
        var out=sale(5);collect(out,100);rule("SALES_RETURN",true);var r=requestReturn(out,5);approve("SALES_RETURN",id(r),true);r=receive(r,5);r=inspect(r,5,0);r=rtn.settleSales(c(),id(r),Map.of("bizDate","2026-10-15"),key());sources.put("salesReturn",r);return r;
    }
    Map<String,Object> refund(int amount) { return rtn.createRefund(c(),Map.of("bookId",601,"customerId",1801,"currency","MXN","amount",amount,"method","TRANSFER","fundAccountId",1901,"payeeInfo",Map.of("name","AI04 customer","account","AI04-TEST-ONLY"),"bizDate","2026-10-15"),key()); }
    Map<String,Object> proof(String type,long doc,String category) {return attachments.upload(c(),type,doc,category,"AI04-proof.txt","text/plain","AI04 original native payment evidence".getBytes(StandardCharsets.UTF_8));}
    Map<String,Object> purchaseBill(Map<String,Object> o,Object qty) { return ap.createBill(c(),Map.of("billDate","2026-10-15","sources",List.of(Map.of("sourceType","PUR_ORDER_LINE","sourceId",id(first(o)),"qty",qty))),key()); }
    Map<String,Object> funding(String kind,String currency,Object amount) {
        var r=ap.createFunding(c(),kind,Map.of("bookId",601,"partnerId",801,"payCurrency",currency,"payAmount",amount,"fundAccountId",currency.equals("CNY")?1902:1901,"payDate","2026-10-15"),key());
        proof(kind.equals("payments")?"AP_PAYMENT":"AP_PREPAYMENT",id(r),"PAYMENT_OUT_PROOF");
        r=ap.confirmFunding(c(),kind,id(r),Map.of("referenceNo","AI04-TEST-ONLY-"+id(r)),key());sources.put(kind+id(r),r);return r;
    }
    Map<String,Object> settle(long bill,String type,long from,Object fromAmount,Object billAmount) { return ap.settle(c(),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("billId",bill,"fromType",type,"fromId",from,"fromAmount",fromAmount,"billAmount",billAmount))),key()); }
    void amount(String sql,String expected) {assertThat(owner.queryForObject(sql,BigDecimal.class)).isEqualByComparingTo(expected);}

    @Test void returnApprovalPartialArrivalOriginalCostAndOpenArFirstComeFromNativeSources() {
        var out=sale(5);collect(out,40);rule("SALES_RETURN",true);var r=requestReturn(out,5);sources.put("salesReturn",r);
        long firstTask=task("SALES_RETURN",id(r));
        assertThatThrownBy(()->workflow.approve(accountant,firstTask,"cannot jump ahead")).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->workflow.approve(outsider,firstTask,"admin cannot substitute")).isInstanceOf(ApiException.class);
        amount("select on_hand_qty from inv_stock_summary","4");
        assertThatThrownBy(()->requestReturn(out,1)).isInstanceOf(ApiException.class);
        long doc=id(r);assertThatThrownBy(()->rtn.receive(c(),doc,Map.of("bizDate","2026-10-15","lines",List.of(Map.of("id",id(first(rtn.get(c(),"sales",doc))),"receivedQty",1))),key())).isInstanceOf(ApiException.class);
        workflow.approve(manager,firstTask,"first review");amount("select on_hand_qty from inv_stock_summary","4");
        workflow.approve(accountant,task("SALES_RETURN",doc),"second review");
        r=receive(r,3);r=inspect(r,2,1);amount("select on_hand_qty from inv_stock_summary","7");
        amount("select claimed_qty from sal_order_line","2");
        r=receive(r,5);r=inspect(r,4,1);amount("select on_hand_qty from inv_stock_summary","9");amount("select frozen_qty from inv_stock_summary","3");
        // Replayed cumulative inspection cannot post the first receipt again.
        var inspected=r;assertThatThrownBy(()->inspect(inspected,4,1)).isInstanceOf(ApiException.class);amount("select on_hand_qty from inv_stock_summary","9");
        rtn.settleSales(c(),doc,Map.of("bizDate","2026-10-15"),key());
        amount("select total_amount from rtn_sales_settlement","100");amount("select ar_offset_amount from rtn_sales_settlement","60");amount("select refundable_amount from rtn_sales_settlement","40");
        amount("select open_amount from ar_receivable","0");amount("select sum(base_purchase_amount) from cst_inbound_cost where source_type='SALES_RETURN'","62.5");
        assertThat(owner.queryForObject("select count(*) from sys_biz_event where event_type='AR_RECEIPT_CONFIRMED'",Integer.class)).isEqualTo(1);
    }
    @Test void noOriginReturnRequiresFinanceSelectedActualBatchAndExceptionApproval() {
        stock();long batch=owner.queryForObject("select id from inv_batch",Long.class);
        var b=new LinkedHashMap<String,Object>(Map.of("noOriginFlag",true,"bookId",601,"entityId",301,"customerId",1801,"currency","MXN","returnWarehouseId",401,"reasonCode","EXCEPTION","responsibility","CUSTOMER","bizDate","2026-10-15","submit",true));
        b.put("lines",List.of(Map.of("productId",501,"qty",1,"unitPrice",20)));assertThatThrownBy(()->rtn.createSales(c(),b,key())).isInstanceOf(ApiException.class);
        b.put("lines",List.of(Map.of("productId",501,"qty",1,"unitPrice",20,"costSource","BATCH","costBatchId",batch,"unitCost",999)));
        seed("insert into sys_country(id,code,name,default_currency,timezone,status) values(102,'CO','AI04 foreign','MXN','UTC','ACTIVE')");seed("insert into org_entity(id,country_id,code,name) values(302,102,'FOREIGN','Foreign')");seed("insert into org_warehouse(id,country_id,entity_id,code,name) values(402,102,302,'FOREIGN','Foreign')");
        b.put("returnWarehouseId",402);assertThatThrownBy(()->rtn.createSales(c(),b,key())).isInstanceOf(ApiException.class);b.put("returnWarehouseId",401);
        var r=rtn.createSales(c(),b,key());assertThat(r).containsEntry("status","BLOCKED");var blocked=r;assertThatThrownBy(()->receive(blocked,1)).isInstanceOf(ApiException.class);amount("select on_hand_qty from inv_stock_summary","9");
        rule("SALES_RETURN",true);r=rtn.submitSales(c(),id(r),Map.of("bizDate","2026-10-15"),key());approve("SALES_RETURN",id(r),true);r=receive(r,1);r=inspect(r,1,0);rtn.settleSales(c(),id(r),Map.of("bizDate","2026-10-15"),key());
        amount("select unit_cost from cst_inbound_cost where source_type='SALES_RETURN'","12.5");amount("select refundable_amount from rtn_sales_settlement","20");sources.put("exceptionReturn",r);
    }
    Map<String,Object> domesticReturn(Map<String,Object> o,Map<String,Object> dr) {
        rule("PURCHASE_RETURN",true);var r=rtn.createPurchase(c(),Map.of("poId",id(o),"stage","DOMESTIC","reason","AI04 unshipped quality","bizDate","2026-10-15","lines",List.of(Map.of("poLineId",id(first(o)),"sourceLineId",id(first(dr)),"qty",2))),key());
        approve("PURCHASE_RETURN",id(r),true);r=rtn.shipPurchase(c(),id(r),Map.of("bizDate","2026-10-15"),key());sources.put("purchaseReturn",r);return r;
    }
    @Test void domesticSupplierReturnCreatesNativeCreditWithoutChangingDestinationStockAndCreditCannotBeReused() {
        var o=order();var dr=domestic(o,20,0,0,true);sources.put("purchase",o);sources.put("domesticReceipt",dr);
        seed("insert into md_supplier(id,country_id,code,name,settle_currency) values(903,101,'AI04-OTHER','AI04 other supplier','CNY')");
        var other=pur.create(c(),"orders",Map.of("bookId",601,"entityId",301,"supplierId",903,"orderDate","2026-10-15","submit",true,"lines",List.of(Map.of("productId",501,"unit","PCS","qty",2,"unitPrice",99))),key());domestic(other,2,0,0,true);
        assertThatThrownBy(()->rtn.createPurchase(c(),Map.of("poId",id(other),"stage","DOMESTIC","reason","AI04 wrong supplier receipt","bizDate","2026-10-15","lines",List.of(Map.of("poLineId",id(first(other)),"sourceLineId",id(first(dr)),"qty",1))),key())).isInstanceOf(ApiException.class);
        var bill=purchaseBill(o,5);bill=ap.confirmBill(c(),id(bill),Map.of(),key());var r=domesticReturn(o,dr);
        amount("select sum(returned_qty) from pur_order_line","2");amount("select amount from ap_credit_note","10");
        assertThat(owner.queryForObject("select count(*) from inv_stock_txn",Integer.class)).isZero();
        long credit=((Number)r.get("apCreditNoteId")).longValue(),bid=id(bill);settle(bid,"CREDIT_NOTE",credit,10,10);
        amount("select paid_amount from ap_bill","10");amount("select used_amount from ap_credit_note","10");
        assertThatThrownBy(()->settle(bid,"CREDIT_NOTE",credit,1,1)).isInstanceOf(ApiException.class);
    }
    @Test void destinationSupplierReturnConsumesActualOriginalBatchAndOriginalCost() {
        stock();long po=owner.queryForObject("select id from pur_order",Long.class),line=owner.queryForObject("select id from pur_order_line",Long.class),batch=owner.queryForObject("select id from inv_batch",Long.class);
        var invoice=purchaseBill(pur.get(c(),"orders",po),10);ap.confirmBill(c(),id(invoice),Map.of(),key());
        rule("PURCHASE_RETURN",true);var body=Map.<String,Object>of("poId",po,"stage","MX_STOCK","warehouseId",401,"reason","AI04 destination quality","bizDate","2026-10-15","lines",List.of(Map.of("poLineId",line,"batchId",batch,"qty",3)));
        var r=rtn.createPurchase(c(),body,key());approve("PURCHASE_RETURN",id(r),true);var shipped=rtn.shipPurchase(c(),id(r),Map.of("bizDate","2026-10-15"),key());
        amount("select on_hand_qty from inv_stock_summary","6");amount("select amount from ap_credit_note","15");
        amount("select sum(amount) from cst_cogs where source_type='PURCHASE_RETURN'","37.5");
        settle(id(invoice),"CREDIT_NOTE",((Number)shipped.get("apCreditNoteId")).longValue(),15,15);amount("select paid_amount from ap_bill","15");amount("select used_amount from ap_credit_note","15");
        assertThatThrownBy(()->rtn.createPurchase(c(),Map.of("poId",po,"stage","MX_STOCK","warehouseId",401,"reason","over remaining","bizDate","2026-10-15","lines",List.of(Map.of("poLineId",line,"batchId",batch,"qty",5))),key())).isInstanceOf(ApiException.class);
    }
    @Test void partialArrivalKeepsItsUnreceivedClaimUntilAnExplicitFinalShortSettlement() {
        var out=sale(5);rule("SALES_RETURN",true);var r=requestReturn(out,5);approve("SALES_RETURN",id(r),true);r=receive(r,3);r=inspect(r,2,1);
        amount("select claimed_qty from sal_order_line","2");assertThatThrownBy(()->requestReturn(out,1)).isInstanceOf(ApiException.class);
        rtn.settleSales(c(),id(r),Map.of("bizDate","2026-10-15","shortReason","AI04 remaining two items will not arrive"),key());
        amount("select claimed_qty from sal_order_line","0");amount("select returned_qty from sal_order_line","3");amount("select total_amount from rtn_sales_settlement","60");amount("select on_hand_qty from inv_stock_summary","7");
    }
    @Test void destinationReturnRejectsAnotherNativePurchaseBatch() {
        stock();long po=owner.queryForObject("select id from pur_order",Long.class),line=owner.queryForObject("select id from pur_order_line",Long.class);
        var otherDelivery=delivery();var otherReceipt=receipt(otherDelivery);lgs.action(c(),"receipts",id(otherReceipt),"confirm",Map.of(),key());long wrongBatch=owner.queryForObject("select id from inv_batch order by id desc limit 1",Long.class);
        assertThatThrownBy(()->rtn.createPurchase(c(),Map.of("poId",po,"stage","MX_STOCK","warehouseId",401,"reason","AI04 wrong native PO batch","bizDate","2026-10-15","lines",List.of(Map.of("poLineId",line,"batchId",wrongBatch,"qty",1))),key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("INV_SOURCE_CONFLICT");
        assertThat(owner.queryForObject("select count(*) from rtn_purchase_return",Integer.class)).isZero();sources.put("otherReceipt",otherReceipt);
    }
    @Test void destinationReturnCannotSilentlyIgnoreAnExplicitDifferentBook() {
        stock();long po=owner.queryForObject("select id from pur_order",Long.class),line=owner.queryForObject("select id from pur_order_line",Long.class),batch=owner.queryForObject("select id from inv_batch",Long.class);
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,301,'AI04-OTHER','AI04 other book','MXN','ACTIVE')");seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(702,101,602,2026,10,'2026-10-01','2026-10-31','OPEN')");
        assertThatThrownBy(()->rtn.createPurchase(c(),Map.of("bookId",602,"poId",po,"stage","MX_STOCK","warehouseId",401,"reason","AI04 explicitly wrong book","bizDate","2026-10-15","lines",List.of(Map.of("poLineId",line,"batchId",batch,"qty",1))),key())).isInstanceOf(ApiException.class);
        assertThat(owner.queryForObject("select count(*) from rtn_purchase_return",Integer.class)).isZero();
    }
    @Test void nativePurchaseAndReceiptBillClaimsShareCapacityAndVoidReleasesIt() {
        var o=order();var dr=domestic(o,20,0,0,true);sources.put("purchase",o);sources.put("domesticReceipt",dr);
        assertThat(ap.payables(c(),Map.of())).isEmpty();var a=purchaseBill(o,3);
        var b=ap.createBill(c(),Map.of("billDate","2026-10-15","sources",List.of(Map.of("sourceType","PUR_RECEIPT_LINE","sourceId",id(first(dr)),"qty",4))),key());
        amount("select sum(amount) from ap_bill","50");assertThat(ap.payables(c(),Map.of())).isEmpty();
        assertThatThrownBy(()->purchaseBill(o,6)).isInstanceOf(ApiException.class);
        ap.voidBill(c(),id(a),Map.of("reason","AI04 release draft"),key());assertThat(purchaseBill(o,6)).containsEntry("status","DRAFT");sources.put("receiptBill",b);
    }
    @Test void sameCurrencyPartialPaymentsRequireActualConfirmationAndMatchedAccount() {
        var o=order();domestic(o,20,0,0,true);var bill=purchaseBill(o,10);bill=ap.confirmBill(c(),id(bill),Map.of(),key());long bid=id(bill);
        assertThatThrownBy(()->ap.createFunding(c(),"payments",Map.of("bookId",601,"partnerId",801,"payCurrency","CNY","payAmount",100,"fundAccountId",1901,"payDate","2026-10-15"),key())).isInstanceOf(ApiException.class);
        var pending=ap.createFunding(c(),"payments",Map.of("bookId",601,"partnerId",801,"payCurrency","CNY","payAmount",60,"fundAccountId",1902,"payDate","2026-10-15"),key());
        assertThatThrownBy(()->settle(bid,"PAYMENT",id(pending),30,30)).isInstanceOf(ApiException.class);proof("AP_PAYMENT",id(pending),"PAYMENT_OUT_PROOF");
        ap.confirmFunding(c(),"payments",id(pending),Map.of("referenceNo","AI04-PARTIAL"),key());settle(bid,"PAYMENT",id(pending),30,30);settle(bid,"PAYMENT",id(pending),30,30);
        var second=funding("payments","CNY",40);settle(bid,"PAYMENT",id(second),40,40);amount("select paid_amount from ap_bill","100");
        assertThat(owner.queryForObject("select count(*) from sys_biz_event where event_type='AP_PAYMENT_CONFIRMED'",Integer.class)).isEqualTo(2);
    }
    @Test void confirmedNativePrepaymentIsConsumedInPartsWithoutNewCashFacts() {
        var o=order();domestic(o,20,0,0,true);var b=purchaseBill(o,10);ap.confirmBill(c(),id(b),Map.of(),key());var p=funding("prepayments","CNY",50);
        settle(id(b),"PREPAYMENT",id(p),20,20);settle(id(b),"PREPAYMENT",id(p),30,30);
        amount("select paid_amount from ap_bill","50");amount("select used_amount from ap_prepayment","50");
        assertThatThrownBy(()->settle(id(b),"PREPAYMENT",id(p),1,1)).isInstanceOf(ApiException.class);
        assertThat(owner.queryForObject("select count(*) from sys_biz_event where event_type='AP_PAYMENT_CONFIRMED'",Integer.class)).isEqualTo(1);
    }
    @Test void nativeForeignCurrencyPartialSettlementHasNonzeroFxAndReversesFrozenAmounts() {
        var o=order();domestic(o,20,0,0,true);var b=purchaseBill(o,10);ap.confirmBill(c(),id(b),Map.of(),key());var p=funding("payments","MXN",200);
        var one=ap.settle(c(),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("billId",id(b),"fromType","PAYMENT","fromId",id(p),"fromAmount",new BigDecimal("66.66"),"billAmount",new BigDecimal("33.33"),"settleRate",new BigDecimal("0.5"),"rateSource","ACTUAL"))),key());
        ap.settle(c(),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("billId",id(b),"fromType","PAYMENT","fromId",id(p),"fromAmount",new BigDecimal("133.34"),"billAmount",new BigDecimal("66.67"),"settleRate",new BigDecimal("0.5"),"rateSource","ACTUAL"))),key());
        amount("select sum(bill_base_amount) from ap_fx_diff","250");amount("select sum(pay_base_amount) from ap_fx_diff","200");amount("select sum(diff_amount) from ap_fx_diff","-50");
        seed("update md_exchange_rate set rate=9 where scope='SETTLEMENT'");ap.reverse(c(),id(one),Map.of("bizDate","2026-10-15","reason","AI04 frozen reversal"),key());
        amount("select diff_amount from ap_fx_diff order by id desc limit 1","16.665");amount("select paid_amount from ap_bill","66.67");sources.put("originalSettlement",one);
    }
    @Test void actualDiscrepancyClaimsKeepCompensationAndRejectionSeparate() {
        stock();long discrepancy=owner.queryForObject("select id from lgs_discrepancy order by id limit 1",Long.class);
        lgs.action(c(),"discrepancies",discrepancy,"resolve",Map.of("resolution","CLAIM","remark","AI04 carrier responsibility; claim follows this original shortage","bizDate","2026-10-15"),key());
        var b=Map.<String,Object>of("bookId",601,"againstType","CARRIER","partnerId",802,"claimType","DAMAGE","discrepancyId",discrepancy,"qty",1,"claimAmount",10,"currency","CNY","bizDate","2026-10-15");
        var paid=rtn.createClaim(c(),b,key());rtn.resolveClaim(c(),id(paid),Map.of("result","COMPENSATED","compensatedAmount",7,"bizDate","2026-10-15"),key());
        assertThat(rtn.get(c(),"claims",id(paid))).containsEntry("partnerName","Carrier");
        var rejected=rtn.createClaim(c(),b,key());rtn.resolveClaim(c(),id(rejected),Map.of("result","REJECTED","bizDate","2026-10-15"),key());
        assertThat(owner.queryForObject("select count(*) from ap_credit_note",Integer.class)).isEqualTo(1);amount("select amount from ap_credit_note","7");
        assertThat(owner.queryForObject("select partner_type from ap_credit_note",String.class)).isEqualTo("CARRIER");sources.put("discrepancyId",discrepancy);sources.put("compensatedClaim",paid);sources.put("rejectedClaim",rejected);
        var delivery=(Map<?,?>)sources.get("delivery");var fee=lgs.create(c(),"fees",Map.of("refType","SHIPMENT","refId",delivery.get("shipmentId"),"carrierId",802,"expenseItemId",803,"currency","CNY","amount",30,"estimateFlag","ACTUAL","bizDate","2026-10-15","confirm",true),key());
        var invoice=ap.createBill(c(),Map.of("sources",List.of(Map.of("sourceType","LGS_FEE","sourceId",id(fee))),"billDate","2026-10-15"),key());
        assertThatThrownBy(()->ap.createBill(c(),Map.of("sources",List.of(Map.of("sourceType","LGS_FEE","sourceId",id(fee))),"billDate","2026-10-15"),key())).isInstanceOf(ApiException.class);
        ap.voidBill(c(),id(invoice),Map.of("reason","AI04 release logistics source"),key());invoice=ap.createBill(c(),Map.of("sources",List.of(Map.of("sourceType","LGS_FEE","sourceId",id(fee))),"billDate","2026-10-15"),key());ap.confirmBill(c(),id(invoice),Map.of(),key());
        settle(id(invoice),"CREDIT_NOTE",owner.queryForObject("select id from ap_credit_note",Long.class),7,7);amount("select paid_amount from ap_bill where status<>'VOIDED'","7");sources.put("logisticsFee",fee);
    }
    @Test void approvedAdjustmentAndNativeStatementExportKeepBalancesAndCurrentFieldMask() {
        var o=order();domestic(o,20,0,0,true);var b=purchaseBill(o,10);ap.confirmBill(c(),id(b),Map.of(),key());var p=funding("payments","CNY",40);settle(id(b),"PAYMENT",id(p),40,40);
        rule("AP_ADJUSTMENT",true);var adj=ap.adjustment(c(),Map.of("bookId",601,"entityId",301,"partnerId",801,"adjType","CREDIT","currency","CNY","amount",10,"reason","AI04 approved rebate","bizDate","2026-10-15"),key());
        assertThatThrownBy(()->ap.confirmAdjustment(c(),id(adj),Map.of(),key())).isInstanceOf(ApiException.class);approve("AP_ADJUSTMENT",id(adj),true);ap.confirmAdjustment(c(),id(adj),Map.of(),key());
        long credit=owner.queryForObject("select id from ap_credit_note",Long.class);settle(id(b),"CREDIT_NOTE",credit,10,10);
        var statement=ap.statement(c(),Map.of("bookId",601,"partnerId",801,"currency","CNY","periodStart","2026-10-01","periodEnd","2026-10-31"),key());
        assertThat(new BigDecimal(statement.get("opening").toString())).isZero();assertThat(new BigDecimal(statement.get("increase").toString())).isEqualByComparingTo("100");assertThat(new BigDecimal(statement.get("paid").toString())).isEqualByComparingTo("40");assertThat(new BigDecimal(statement.get("closing").toString())).isEqualByComparingTo("50");
        var job=jobs.enqueue(c(),"AP_STATEMENT_EXPORT",601,Map.of("statementId",id(statement)),key());jobs.run(101,id(job));assertThat(jobService.download(c(),id(job)).get("content").toString()).contains("100","40","50");
        var later=ap.statement(c(),Map.of("bookId",601,"partnerId",801,"currency","CNY","periodStart","2026-10-16","periodEnd","2026-10-31"),key());assertThat(new BigDecimal(later.get("opening").toString())).isEqualByComparingTo("50");assertThat((List<?>)later.get("details")).isEmpty();
        var otherCurrency=ap.statement(c(),Map.of("bookId",601,"partnerId",801,"currency","MXN","periodStart","2026-10-01","periodEnd","2026-10-31"),key());assertThat(new BigDecimal(otherCurrency.get("closing").toString())).isZero();assertThat((List<?>)otherCurrency.get("details")).isEmpty();
        seed("update sys_role set field_policies=jsonb_set(field_policies,'{COST}','\"HIDDEN\"'),version=version+1 where id=202");
        var saved=(Map<?,?>)((List<?>)ap.statements(c(),Map.of()).get("records")).getFirst();assertThat(saved.containsKey("closing")).isFalse();sources.put("statement",statement);
    }
    @Test void nativeReceiptRecognitionModesDraftOnlyAndStopWhenItsSubjectLosesPermission() {
        assertThat(recognition.get(c(),"PURCHASE")).containsEntry("mode","BILL_CONFIRMED");var o=order();domestic(o,20,0,0,true);assertThat(owner.queryForObject("select count(*) from ap_bill",Integer.class)).isZero();
        var manual=recognition.save(c(),"PURCHASE",Map.of("mode","MANUAL"),key());recognition.recover(101,100);assertThat(owner.queryForObject("select count(*) from ap_bill",Integer.class)).isZero();
        recognition.save(c(),"PURCHASE",Map.of("mode","RECEIPT_CONFIRMED","executionSubjectUserId",201,"version",manual.get("version")),key());recognition.recover(101,100);recognition.recover(101,100);
        assertThat(owner.queryForObject("select count(*) from ap_bill",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("select status from ap_bill",String.class)).isEqualTo("DRAFT");assertThat(ap.payables(c(),Map.of())).isEmpty();
        var second=order();domestic(second,20,0,0,true);seed("update sys_role set permissions=permissions-'ap:bill:create',version=version+1 where id=202");recognition.recover(101,100);
        assertThat(owner.queryForObject("select count(*) from ap_bill",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("select count(*) from sys_biz_event_consume where consumer='AP_RECOGNITION' and status='FAILED' and last_error is not null",Integer.class)).isGreaterThan(0);
        assertThat(recognition.check(101,"ACTIVATE").toString()).contains("AP_RECOGNITION_SUBJECT_INVALID");assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
    }
    @Test void nativeReturnCreditWithUnknownRateDoesNotTurnIntoZeroValueOrConsumeBalances() {
        seed("delete from md_exchange_rate where scope='SETTLEMENT'");var o=order();var dr=domestic(o,20,0,0,true);var b=purchaseBill(o,5);ap.confirmBill(c(),id(b),Map.of(),key());var r=domesticReturn(o,dr);long credit=((Number)r.get("apCreditNoteId")).longValue();
        assertThat(owner.queryForObject("select valuation_status from ap_credit_note",String.class)).isEqualTo("PENDING_RATE");assertThat(owner.queryForObject("select base_amount from ap_credit_note",BigDecimal.class)).isNull();
        assertThatThrownBy(()->settle(id(b),"CREDIT_NOTE",credit,10,10)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("AP_RATE_PENDING");amount("select used_amount from ap_credit_note","0");amount("select paid_amount from ap_bill","0");
    }
    @Test void nativePaymentConfirmationReplaysOnlyTheSameIntentAndNeverCreatesASecondCashFact() {
        var o=order();domestic(o,20,0,0,true);var invoice=purchaseBill(o,10);ap.confirmBill(c(),id(invoice),Map.of(),key());
        var p=ap.createFunding(c(),"payments",Map.of("bookId",601,"partnerId",801,"payCurrency","CNY","payAmount",100,"fundAccountId",1902,"payDate","2026-10-15"),key());long doc=id(p);proof("AP_PAYMENT",doc,"PAYMENT_OUT_PROOF");
        var body=Map.<String,Object>of("referenceNo","AI04-PAY-ONE");String intent=key();ap.confirmFunding(c(),"payments",doc,body,intent);assertThat(id(ap.confirmFunding(c(),"payments",doc,body,intent))).isEqualTo(doc);
        assertThatThrownBy(()->ap.confirmFunding(c(),"payments",doc,Map.of("referenceNo","AI04-PAY-CHANGED"),intent)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SYS_IDEMPOTENCY_CONFLICT");
        assertThatThrownBy(()->ap.confirmFunding(c(),"payments",doc,body,key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SYS_STATE_INVALID");
        assertThat(owner.queryForObject("select count(*) from sys_biz_event where event_type='AP_PAYMENT_CONFIRMED'",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("select reference_no from ap_payment",String.class)).isEqualTo("AI04-PAY-ONE");amount("select paid_amount from ap_bill","0");sources.put("commandProtocol","AP_PAYMENT.confirm: same intent replay / changed payload conflict / new intent no second cash fact");
    }
    @Test void nativeRefundPaymentReplaysOnlyTheSameIntentAndConsumesItsReturnCreditOnce() {
        fullyReturned();rule("REFUND",true);var r=refund(100);long doc=id(r);approve("REFUND",doc,true);proof("REFUND",doc,"REFUND_PROOF");
        var body=Map.<String,Object>of("paidAt","2026-10-15","referenceNo","AI04-REFUND-ONE");String intent=key();rtn.payRefund(c(),doc,body,intent);assertThat(id(rtn.payRefund(c(),doc,body,intent))).isEqualTo(doc);
        assertThatThrownBy(()->rtn.payRefund(c(),doc,Map.of("paidAt","2026-10-15","referenceNo","AI04-REFUND-CHANGED"),intent)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SYS_IDEMPOTENCY_CONFLICT");
        assertThatThrownBy(()->rtn.payRefund(c(),doc,body,key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SYS_STATE_INVALID");
        amount("select used_amount from ar_credit_note where refundable_flag","100");amount("select reserved_amount from ar_credit_note where refundable_flag","0");assertThat(owner.queryForObject("select count(*) from sys_biz_event where event_type='RTN_REFUND_PAID'",Integer.class)).isEqualTo(1);sources.put("commandProtocol","REFUND.pay: same intent replay / changed payload conflict / new intent no second consumption");
    }
    @ParameterizedTest @ValueSource(strings={"amount","payee_info","method"})
    void largeRefundCriticalFieldChangesAreRejectedBeforeAnOldApprovalCanBeReused(String field) {
        fullyReturned();rule("REFUND",true);workflow.configure(c(),"REFUND",Map.of("approvalRequired",true,"keyFields",List.of("amount","payeeInfo","method")));
        var r=refund(100);long doc=id(r);proof("REFUND",doc,"REFUND_PROOF");
        assertThatThrownBy(()->rtn.payRefund(c(),doc,Map.of("paidAt","2026-10-15","referenceNo","AI04-EARLY"),key())).isInstanceOf(ApiException.class);
        workflow.approve(manager,task("REFUND",doc),"first large refund review");
        assertThatThrownBy(()->workflow.approve(outsider,task("REFUND",doc),"admin bypass")).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->rtn.payRefund(c(),doc,Map.of("paidAt","2026-10-15","referenceNo","AI04-EARLY"),key())).isInstanceOf(ApiException.class);
        workflow.approve(accountant,task("REFUND",doc),"second large refund review");
        // The native document has no edit endpoint after submission. Even direct SQL must fail.
        assertThatThrownBy(()->{switch(field) {case "amount" -> seed("update rtn_refund set amount=99 where id=?",doc);case "payee_info" -> seed("update rtn_refund set payee_info='{\"name\":\"ALTERED\",\"account\":\"ALTERED\"}' where id=?",doc);case "method" -> seed("update rtn_refund set method='CASH' where id=?",doc);default -> throw new AssertionError(field);}}).hasStackTraceContaining("BUSINESS_FACT_IMMUTABLE");
        amount("select amount from rtn_refund","100");assertThat(owner.queryForObject("select method from rtn_refund",String.class)).isEqualTo("TRANSFER");
        rtn.payRefund(c(),doc,Map.of("paidAt","2026-10-15","referenceNo","AI04-UNCHANGED-APPROVAL"),key());
        amount("select used_amount from ar_credit_note where refundable_flag","100");assertThat(owner.queryForObject("select count(*) from sys_biz_event where event_type='RTN_REFUND_PAID'",Integer.class)).isEqualTo(1);sources.put("rejectedFaultInjection",field);
    }
    @Test void confirmedPaymentOriginalEvidenceIsReadableAfterRealCashierRelogin() throws Exception {
        Assumptions.assumeTrue(Boolean.getBoolean("ai04.browser"),"Explicit isolated browser runtime required");
        var o=order();var domesticReceipt=domestic(o,20,0,0,true);var bill=purchaseBill(o,10);ap.confirmBill(c(),id(bill),Map.of(),key());var payment=funding("payments","CNY",100);
        var nativeSettlement=settle(id(bill),"PAYMENT",id(payment),100,100);var prepaid=funding("prepayments","CNY",20);
        var returned=fullyReturned();rule("REFUND",true);var refunded=refund(100);approve("REFUND",id(refunded),true);proof("REFUND",id(refunded),"REFUND_PROOF");rtn.payRefund(c(),id(refunded),Map.of("paidAt","2026-10-15","referenceNo","AI04-BROWSER-REFUND"),key());
        var inventoryBeforeDomestic=owner.queryForList("select id,on_hand_qty,reserved_qty,frozen_qty,version from inv_stock_summary order by id");
        int inventoryEventsBeforeDomestic=owner.queryForObject("select count(*) from inv_stock_txn",Integer.class);
        var returnedToSupplier=domesticReturn(o,domesticReceipt);
        assertThat(owner.queryForList("select id,on_hand_qty,reserved_qty,frozen_qty,version from inv_stock_summary order by id")).as("domestic supplier return preserves existing destination stock").isEqualTo(inventoryBeforeDomestic);
        assertThat(owner.queryForObject("select count(*) from inv_stock_txn",Integer.class)).isEqualTo(inventoryEventsBeforeDomestic);
        long discrepancy=owner.queryForObject("select id from lgs_discrepancy order by id limit 1",Long.class);
        lgs.action(c(),"discrepancies",discrepancy,"resolve",Map.of("resolution","CLAIM","remark","AI04 explicit carrier claim","bizDate","2026-10-15"),key());
        var claim=rtn.createClaim(c(),Map.of("bookId",601,"againstType","CARRIER","partnerId",802,"claimType","DAMAGE","discrepancyId",discrepancy,"qty",1,"claimAmount",10,"currency","CNY","bizDate","2026-10-15"),key());rtn.resolveClaim(c(),id(claim),Map.of("result","COMPENSATED","compensatedAmount",7,"bizDate","2026-10-15"),key());
        long doc=id(payment),attachment=owner.queryForObject("select proof_attachment_id from ap_payment where id=?",Long.class,doc);
        String expectedHash=owner.queryForObject("select sha256 from sys_attachment where id=?",String.class,attachment);
        String password=UUID.randomUUID()+"-AI04";
        String viewerPassword=UUID.randomUUID()+"-AI04";seed("update sys_user set password_hash=? where id=212",sessions.encodePassword(viewerPassword));seed("update sys_role set permissions=permissions||'[\"rtn:claim:create\"]'::jsonb where id=312");
        seed("insert into sys_user(id,username,password_hash,display_name,status) values(214,'ai04_cashier',?,'AI04 cashier','ENABLED')",sessions.encodePassword(password));
        seed("insert into sys_role(id,country_id,code,name,permissions,field_policies) values(314,101,'AI04_CASHIER','AI04 cashier','[\"ap:payment:create\",\"ap:payment:confirm\"]','{\"COST\":\"READ\",\"BANK_INFO\":\"READ\"}')");
        seed("insert into sys_user_role(country_id,user_id,role_id) values(101,214,314)");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,214,'BOOK',601,201)");
        var before=owner.queryForList("select id,status,amount,used_amount,version,proof_attachment_id from ap_payment order by id");
        int events=owner.queryForObject("select count(*) from sys_biz_event",Integer.class),proofs=owner.queryForObject("select count(*) from sys_attachment",Integer.class);
        Path web=Path.of(System.getProperty("ai04.webDir")),output=Path.of(System.getProperty("ai04.evidenceDir"),"browser");Files.createDirectories(output);
        Path viteConfig=output.resolve("vite.config.mjs");Files.writeString(viteConfig,"import base from "+json.write(web.resolve("vite.config.ts").toUri().toString())+";\nexport default env=>({...base(env),cacheDir:"+json.write(output.resolve("vite-cache").toString())+"});\n",StandardCharsets.UTF_8);
        var serverBuilder=new ProcessBuilder("node",web.resolve("node_modules/vite/bin/vite.js").toString(),"--config",viteConfig.toString(),"--host","127.0.0.1","--port","16004","--strictPort").directory(web.toFile()).redirectErrorStream(true).redirectOutput(output.resolve("vite.log").toFile());
        serverBuilder.environment().put("VITE_API_TARGET","http://127.0.0.1:"+port);Process server=serverBuilder.start();
        try {
            var client=java.net.http.HttpClient.newBuilder().version(java.net.http.HttpClient.Version.HTTP_1_1).connectTimeout(java.time.Duration.ofSeconds(1)).build();boolean ready=false;
            for(int n=0;n<40;n++){if(!server.isAlive())throw new AssertionError("Isolated Vite exited; see vite.log");try{if(client.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:16004/login")).header("Accept","text/html").timeout(java.time.Duration.ofSeconds(1)).GET().build(),java.net.http.HttpResponse.BodyHandlers.discarding()).statusCode()==200){ready=true;break;}}catch(java.io.IOException ignored){/* bounded readiness polling, failure reported below */}Thread.sleep(250);}
            assertThat(ready).as("isolated web server ready").isTrue();
            var browserBuilder=new ProcessBuilder("node",web.resolve("tests/browser/ap-payment-evidence.mjs").toString(),"http://127.0.0.1:16004",String.valueOf(doc),String.valueOf(payment.get("docNo")),expectedHash,output.toString()).directory(web.toFile()).redirectErrorStream(true).redirectOutput(output.resolve("playwright.log").toFile());
            browserBuilder.environment().put("AI04_TEST_USER","ai04_cashier");browserBuilder.environment().put("AI04_TEST_PASSWORD",password);
            browserBuilder.environment().put("AI04_VIEWER_USER","AI04_ACCOUNTANT");browserBuilder.environment().put("AI04_VIEWER_PASSWORD",viewerPassword);
            String carrierCredit=owner.queryForObject("select doc_no from ap_credit_note where partner_type='CARRIER'",String.class);
            browserBuilder.environment().put("AI04_PAGE_CHECKS",json.write(List.of(Map.of("path","/returns/sales","docNo",returned.get("docNo")),Map.of("path","/returns/refunds","docNo",refunded.get("docNo")),Map.of("path","/returns/purchase","docNo",returnedToSupplier.get("docNo")),Map.of("path","/returns/claims","docNo",claim.get("docNo"),"expectedText","Carrier"),Map.of("path","/ap/bills","docNo",bill.get("docNo")),Map.of("path","/ap/prepayments","docNo",prepaid.get("docNo")),Map.of("path","/ap/settlements","docNo",nativeSettlement.get("docNo")),Map.of("path","/ap/partners/801","docNo",bill.get("docNo"),"selector",".el-timeline-item"),Map.of("path","/ap/partners/802","docNo",carrierCredit,"selector",".el-timeline-item"))));
            browserBuilder.environment().put("AI04_PLAYWRIGHT_MODULE",System.getProperty("ai04.playwrightModule"));browserBuilder.environment().put("AI04_BROWSER",System.getProperty("ai04.browserExecutable"));
            Process browser=browserBuilder.start();try{assertThat(browser.waitFor(120,java.util.concurrent.TimeUnit.SECONDS)).as("browser completes within 120 seconds").isTrue();assertThat(browser.exitValue()).as("see playwright.log").isZero();}finally{browser.descendants().forEach(ProcessHandle::destroy);browser.destroy();}
        } finally {server.descendants().forEach(ProcessHandle::destroy);server.destroy();server.waitFor(10,java.util.concurrent.TimeUnit.SECONDS);}
        assertThat(owner.queryForList("select id,status,amount,used_amount,version,proof_attachment_id from ap_payment order by id")).isEqualTo(before);
        assertThat(owner.queryForObject("select count(*) from sys_biz_event",Integer.class)).isEqualTo(events);assertThat(owner.queryForObject("select count(*) from sys_attachment",Integer.class)).isEqualTo(proofs);
        sources.put("browserPayment",payment);sources.put("proofSha256",expectedHash);
    }
    @AfterEach void saveSourceEvidence(TestInfo info) throws Exception {
        String dir=System.getProperty("ai04.evidenceDir");if(dir==null)return;
        var evidence=new LinkedHashMap<String,Object>();evidence.put("test",info.getDisplayName());evidence.put("sourceCreation","Native Purchase/Logistics/Sales/AR/Returns/AP services; master/config fixtures only; tamper explicitly labelled");evidence.put("sources",sources);evidence.put("postgresContainer",PgDatabase.PG.getContainerId());evidence.put("minioContainer",MinioTestStorage.MINIO.getContainerId());
        var facts=new LinkedHashMap<String,Object>();
        for(String table:List.of("pur_order","pur_order_line","pur_domestic_receipt_line","lgs_receipt","lgs_receipt_line","lgs_discrepancy","sal_order","sal_outbound","sal_outbound_line","ar_receivable","ar_receipt","ar_credit_note","inv_batch","inv_stock_summary","inv_stock_txn","cst_inbound_cost","cst_cogs","rtn_sales_return","rtn_sales_settlement","rtn_purchase_return","rtn_claim","rtn_refund","ap_bill","ap_bill_line","ap_credit_note","ap_payment","ap_prepayment","ap_settlement","ap_settlement_line","ap_fx_diff","wf_rule","wf_doc_type_config","wf_instance","wf_task","sys_role","sys_user_role","sys_user_data_scope","sys_biz_event","sys_biz_event_consume")) {
            var rows=new ArrayList<Map<String,Object>>();for(var row:owner.queryForList("select * from "+table)) {var simple=new LinkedHashMap<String,Object>();row.forEach((k,v)->simple.put(k,v==null?null:v.toString()));rows.add(simple);}facts.put(table,rows);
        }
        var objects=new ArrayList<Map<String,Object>>();Path objectDir=Path.of(dir,"objects");Files.createDirectories(objectDir);
        try(var client=MinioTestStorage.client()) {
            for(var item:owner.queryForList("select id,storage_key,sha256 from sys_attachment where status='VALID' and object_status='AVAILABLE'")) {
                try(var input=client.getObject(io.minio.GetObjectArgs.builder().bucket(MinioTestStorage.BUCKET).object(item.get("storage_key").toString()).build())) {
                    byte[] content=input.readAllBytes();String actual=HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(content));
                    assertThat(actual).as("actual stored object matches committed attachment %s",item.get("id")).isEqualTo(item.get("sha256"));Files.write(objectDir.resolve(actual+".bin"),content);
                    objects.add(Map.of("attachmentId",item.get("id"),"sha256",actual,"bytes",content.length));
                }
            }
        }
        evidence.put("objectVerification",objects);evidence.put("facts",facts);Files.createDirectories(Path.of(dir));String name=info.getDisplayName().replaceAll("[^A-Za-z0-9_-]","_");Files.writeString(Path.of(dir,name+".json"),json.write(evidence),StandardCharsets.UTF_8);
        var dump=new ProcessBuilder("docker","exec",PgDatabase.PG.getContainerId(),"pg_dump","-U","postgres","-d",PgDatabase.PG.getDatabaseName(),"-Fc").redirectOutput(Path.of(dir,name+".dump").toFile()).redirectError(Path.of(dir,name+".dump.log").toFile()).start();
        try{assertThat(dump.waitFor(30,java.util.concurrent.TimeUnit.SECONDS)).as("retain isolated database before fixture reset").isTrue();assertThat(dump.exitValue()).as("native PG source snapshot exported").isZero();}finally{dump.destroy();}
    }
}
