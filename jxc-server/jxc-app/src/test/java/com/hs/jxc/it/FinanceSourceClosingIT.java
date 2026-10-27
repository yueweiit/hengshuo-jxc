package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;

import java.math.BigDecimal;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import tools.jackson.databind.json.JsonMapper;

/** AI-06: native receipt -> event -> posted ledger -> real close -> frozen export.
 * Only identity/master configuration is seeded. No financial transaction or snapshot is seeded.
 */
class FinanceSourceClosingIT extends SupplyFixtures {
    @Value("${local.server.port}") int port;
    @Autowired com.hs.jxc.sys.jobs.JobApi jobs;
    @Autowired org.springframework.context.ApplicationContext applicationContext;
    @Autowired com.hs.jxc.fin.closing.ClosingService closing;
    @Autowired com.hs.jxc.fin.report.ReportService reports;
    @Autowired com.hs.jxc.sys.imports.ImportService imports;
    @org.springframework.test.context.DynamicPropertySource
    static void storage(org.springframework.test.context.DynamicPropertyRegistry registry) { M2FlowIT.storage(registry); }
    final HttpClient http = HttpClient.newHttpClient();
    final JsonMapper json = JsonMapper.builder().build();

    @Test void nativeSupplyWritesStayFrozenAfterActualClosing() throws Exception {
        // Reuse the existing native PO -> receipt -> sale -> return -> refund fixture,
        // including its seven independently audited vouchers and four reconciliations.
        var flow = new M2FlowIT();
        applicationContext.getAutowireCapableBeanFactory().autowireBean(flow);
        flow.purchaseToCustomerRefundKeepsStockAmountsAndOriginalCostsConsistent();
        var auditor = new com.hs.jxc.common.context.RequestContext(211,101L,"AI06-close-review",com.hs.jxc.sys.service.SessionService.digest("flow-auditor"));
        var originalOutbound = owner.queryForMap("select id from sal_outbound");
        long originalLine = owner.queryForObject("select id from sal_outbound_line where outbound_id=?",Long.class,originalOutbound.get("id"));
        var returned = flow.returns.createSales(c(),Map.of("outboundId",originalOutbound.get("id"),"returnWarehouseId",401,"reasonCode","QUALITY","responsibility","SUPPLIER","bizDate","2026-10-15","submit",true,"lines",List.of(Map.of("outboundLineId",originalLine,"reqQty",1))),key());
        flow.approvePending("SALES_RETURN",id(returned));
        returned = flow.returns.get(c(),"sales",id(returned));
        long returnLine = id(first(returned));
        flow.returns.receive(c(),id(returned),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("id",returnLine,"receivedQty",1))),key());
        flow.returns.inspect(c(),id(returned),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("id",returnLine,"goodQty",1,"frozenQty",0))),key());
        flow.returns.settleSales(c(),id(returned),Map.of("bizDate","2026-10-15"),key());
        for(long event:owner.queryForList("select id from sys_biz_event where source_id=? and event_type in ('RTN_SALES_INSPECTED','RTN_SALES_SETTLED') order by id",Long.class,id(returned))) flow.postPrecisionEvent(event,auditor);
        var pendingRefund = flow.returns.createRefund(c(),Map.of("bookId",601,"customerId",1801,"amount",1,"currency","MXN","fundAccountId",1901,"method","CASH","payeeInfo",Map.of("name","AI06 customer"),"bizDate","2026-10-15"),key());
        flow.approvePending("REFUND",id(pendingRefund));
        flow.attachments.upload(c(),"REFUND",id(pendingRefund),"REFUND_PROOF","AI06-refund.txt","text/plain","AI06 pending refund proof".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        NumberFixtures.seed(101,"AP_PAYMENT");
        var pendingPayment = flow.purchaseBills.createFunding(c(),"payments",Map.of("bookId",601,"partnerId",801,"fundAccountId",1901,"currency","MXN","amount",1,"payDate","2026-10-15"),key());
        flow.attachments.upload(c(),"AP_PAYMENT",id(pendingPayment),"PAYMENT_OUT_PROOF","AI06-payment.txt","text/plain","AI06 pending payment proof".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        var pendingReceipt = receipt(delivery());
        var order = flow.sales.create(c(),Map.of("bookId",601,"entityId",301,"customerId",1801,"orderDate","2026-10-15","paymentType","CREDIT","lines",List.of(Map.of("productId",501,"unit","PCS","qty",1,"allocs",List.of(Map.of("warehouseId",401,"allocQty",1))))),key());
        order = flow.sales.submit(c(),id(order),Map.of("bizDate","2026-10-15"),key());
        flow.attachments.upload(c(),"SAL_ORDER",id(order),"SALES_DOC","AI06-pending-sale.txt","text/plain","AI06 native pending outbound".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        long allocation = ((Number)((Map<?,?>)((List<?>)first(order).get("allocs")).getFirst()).get("id")).longValue();
        var outbound = flow.sales.createOutbound(c(),Map.of("orderId",id(order),"warehouseId",401,"bizDate","2026-10-15","lines",List.of(Map.of("allocId",allocation,"qty",1))),key());
        for(String type:List.of("BALANCE_SHEET","INCOME")) {
            var template = reports.save(c(),601L,null,Map.of("reportType",type,"name","AI06 native close "+type,"rule","CATEGORY_V1"),key());
            reports.review(auditor,601L,id(template),Map.of("version",template.get("version")),key());
        }
        long asset = flow.finAccount("1101","ASSET","DEBIT",null), equity = flow.finAccount("3001","EQUITY","CREDIT",null);
        var batch = imports.create(c(),Map.of("importType","OPENING_GL","cutoffDate","2026-09-30","rows",List.of(Map.of("bookId",601,"accountId",asset,"amount",1,"refNo","AI06-CLOSED-D"),Map.of("bookId",601,"accountId",equity,"amount",1,"refNo","AI06-CLOSED-C"))));
        assertThat(batch).containsEntry("status","VALIDATED");
        // Quantity notifications and confirmations of already posted sources still require
        // reviewed interpretation. Complete them through the existing consumer, never SQL.
        var noPostingTypes=Set.of("PUR_DOMESTIC_RECEIPT_CONFIRMED","LGS_NODE_RECORDED","LGS_SHIPMENT_DISPATCHED","INV_STOCK_CHANGED","LGS_RECEIPT_CONFIRMED","SAL_ORDER_APPROVED","AR_RECEIVABLE_CREATED","RTN_SALES_RECEIVED","AP_BILL_CONFIRMED");
        var pendingEvents=owner.queryForList("select e.id,e.event_type from sys_biz_event e left join fin_event_result r on r.event_id=e.id and r.country_id=e.country_id where r.id is null order by e.id");
        for(String type:pendingEvents.stream().map(e->e.get("event_type").toString()).distinct().toList()) {
            assertThat(noPostingTypes).as("Only verified quantity/already-posted source confirmations may skip a voucher").contains(type);
            var mapping=flow.accounting.saveMapping(c(),null,Map.of("bookId",601,"eventType",type,"accountingMode","NO_VOUCHER","noVoucherReason","AI06：数量通知或已记账来源确认，金额由成本、出库及收退款凭证承接","lines",List.of()),key());
            flow.accounting.review(auditor,id(mapping),Map.of("version",mapping.get("version")),key());
        }
        for(var event:pendingEvents)assertThat(flow.accounting.generate(c(),((Number)event.get("id")).longValue(),key())).containsEntry("status","NO_VOUCHER");
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isEqualTo(9);
        assertThat(closing.check(c(),701,Map.of("bookId",601),key())).containsEntry("canClose",true);
        assertThat(closing.close(c(),701,Map.of("bookId",601),key())).containsEntry("closeGeneration",1);
        var before = nativeFrozenFacts();
        long receipt = id(pendingReceipt);
        long cost = owner.queryForObject("select source_id from sys_biz_event where country_id=101 and book_id=601 and source_type='CST_INBOUND_COST' and event_type='CST_INBOUND_COST_CONFIRMED'",Long.class);
        var commands = new LinkedHashMap<String,org.assertj.core.api.ThrowableAssert.ThrowingCallable>();
        commands.put("LGS_RECEIPT_CONFIRM",()->lgs.action(c(),"receipts",receipt,"confirm",Map.of(),key()));
        commands.put("SAL_OUTBOUND_CONFIRM",()->flow.sales.confirmOutbound(c(),id(outbound),Map.of("bizDate","2026-10-15"),key()));
        commands.put("AP_PAYMENT_CREATE",()->flow.purchaseBills.createFunding(c(),"payments",Map.of("bookId",601,"partnerId",801,"fundAccountId",1901,"currency","MXN","amount",1,"payDate","2026-10-15"),key()));
        commands.put("AP_PAYMENT_CONFIRM",()->flow.purchaseBills.confirmFunding(c(),"payments",id(pendingPayment),Map.of("version",pendingPayment.get("version"),"referenceNo","AI06-CLOSED-PAYMENT"),key()));
        commands.put("REFUND_CREATE",()->flow.returns.createRefund(c(),Map.of("bookId",601,"customerId",1801,"amount",1,"currency","MXN","fundAccountId",1901,"method","CASH","payeeInfo",Map.of("name","AI06 customer"),"bizDate","2026-10-15"),key()));
        commands.put("REFUND_PAY",()->flow.returns.payRefund(c(),id(pendingRefund),Map.of("paidAt","2026-10-15","referenceNo","AI06-CLOSED-REFUND"),key()));
        commands.put("COST_CONFIRM",()->flow.valuation.confirm(c(),cost,Map.of("bizDate","2026-10-15"),key()));
        for(var command:commands.entrySet()) {
            assertThatThrownBy(command.getValue()).as(command.getKey()).isInstanceOf(com.hs.jxc.common.api.ApiException.class).extracting("code").isEqualTo("FIN_PERIOD_CLOSED");
            assertThat(nativeFrozenFacts()).as(command.getKey()+" has no transaction or stock effects").isEqualTo(before);
        }
        assertThatThrownBy(()->imports.confirm(c(),id(batch),key())).hasMessageContaining("开放期间");
        assertThat(nativeFrozenFacts()).isEqualTo(before);
        assertThat(owner.queryForObject("select count(*) from fin_opening_balance",Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from sys_import_source",Integer.class)).isZero();
        assertThat(imports.detail(c(),id(batch))).containsEntry("status","VALIDATED");
        assertThat(closing.close(c(),701,Map.of("bookId",601),key())).containsEntry("duplicate",true).containsEntry("closeGeneration",1);
        assertThat(owner.queryForObject("select count(*) from fin_snapshot",Integer.class)).isEqualTo(3);
        System.out.println("AI06_NATIVE_LOCKS_VERIFIED "+json.writeValueAsString(Map.of("receiptId",receipt,"outboundId",id(outbound),"costId",cost,"importBatchId",id(batch),"commands",commands.keySet(),"stock",before.get("stock"),"voucherCount",((List<?>)before.get("vouchers")).size(),"payment",owner.queryForMap("select id,doc_no,status,amount from ap_payment where id=?",id(pendingPayment)),"refund",owner.queryForMap("select id,doc_no,status,amount from rtn_refund where id=?",id(pendingRefund)))));
    }

    Map<String,Object> nativeFrozenFacts() {
        return Map.of("stock",owner.queryForList("select * from inv_stock_summary order by id"),
            "movements",owner.queryForList("select * from inv_stock_txn order by id"),
            "events",owner.queryForList("select * from sys_biz_event order by id"),
            "vouchers",owner.queryForList("select * from fin_voucher order by id"),
            "payments",owner.queryForList("select * from ap_payment order by id"),
            "refunds",owner.queryForList("select * from rtn_refund order by id"),
            "costs",Map.of("confirmations",owner.queryForList("select * from cst_cost_confirmation order by country_id,cost_id"),"cogs",owner.queryForList("select * from cst_cogs order by id"),"pools",owner.queryForList("select * from cst_valuation_pool order by country_id,book_id,warehouse_id,product_id")),
            "outbounds",owner.queryForList("select * from sal_outbound order by id"),
            "receipts",owner.queryForList("select * from lgs_receipt order by id"),
            "creditNotes",owner.queryForList("select * from ar_credit_note order by id"));
    }

    @Test void nativeReceiptRetainsItsSourceThroughGenerationClosingAndExport() throws Exception {
        seed("update sys_role set permissions='[\"fin:*\",\"ar:receipt:*\",\"pur:order:create\"]',field_policies='{\"COST\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"BANK_INFO\":\"WRITE\",\"PROFIT\":\"WRITE\"}' where id=202");
        seed("insert into sys_user(id,username,password_hash,display_name,status) values(211,'AI06-auditor','unused','AI06独立复核员','ENABLED')");
        seed("insert into sys_session(token_hash,user_id,expires_at) values(?,211,clock_timestamp()+interval '1 hour')",com.hs.jxc.sys.service.SessionService.digest("AI06-auditor"));
        seed("insert into sys_user_role(country_id,user_id,role_id) values(101,211,202)");
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,211,'BOOK',601,201)");
        seed("insert into md_customer(id,country_id,code,name) values(1801,101,'AI06-C','AI06合成客户')");

        long cash = id(ok(201,"POST","/fin/accounts",Map.of("bookId",601,"code","1001","name","AI06现金","category","ASSET","direction","DEBIT","isCash",true,"reconcileType","CASH","auxTypes",List.of("FUND"))));
        long advance = id(ok(201,"POST","/fin/accounts",Map.of("bookId",601,"code","2203","name","AI06预收","category","LIABILITY","direction","CREDIT","reconcileType","AR")));
        long flow = id(ok(201,"POST","/fin/cashflow-items",Map.of("bookId",601,"code","AI06-IN","name","AI06实收","direction","IN")));
        seed("insert into md_fund_account(id,country_id,entity_id,book_id,name,account_type,currency,gl_account_id) values(1901,101,301,601,'AI06现金账户','CASH','MXN',?)",cash);
        for (String type : List.of("BALANCE_SHEET","INCOME")) {
            var template = ok(201,"POST","/fin/report-templates",Map.of("bookId",601,"reportType",type,"name","AI06 "+type,"rule","CATEGORY_V1"));
            ok(211,"POST","/fin/report-templates/"+id(template)+"/review",Map.of("bookId",601,"version",template.get("version")));
        }

        var input = Map.<String,Object>of("bookId",601,"customerId",1801,"fundAccountId",1901,"method","CASH","amount",42,"bizTime","2026-10-15T12:00:00Z");
        var receipt = ok(201,"POST","/ar/receipts",input);
        long receiptId = id(receipt);
        ok(201,"POST","/ar/receipts/"+receiptId+"/confirm",Map.of("arrivalDate","2026-10-15"));
        long event = owner.queryForObject("select id from sys_biz_event where source_type='AR_RECEIPT' and source_id=? and event_type='AR_RECEIPT_CONFIRMED'",Long.class,receiptId);
        assertThat(owner.queryForObject("select amount from ar_receipt where id=?",BigDecimal.class,receiptId)).isEqualByComparingTo("42");
        assertThat(check("EVENTS_OPEN")).containsEntry("result","FAIL");
        var missing = call(201,"POST","/fin/events/"+event+"/generate",Map.of());
        assertThat(missing.statusCode()).isEqualTo(400);
        assertThat(missing.body()).contains("FIN_MAPPING_MISSING");
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from fin_event_result",Integer.class)).isZero();

        var mapping = ok(201,"POST","/fin/mapping-templates",Map.of("bookId",601,"eventType","AR_RECEIPT_CONFIRMED","lines",List.of(
            Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","accountId",cash),"amountExpr","amount","cashflowItemId",flow),
            Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","accountId",advance),"amountExpr","amount"))));
        assertThat(call(201,"POST","/fin/events/"+event+"/generate",Map.of()).body()).contains("FIN_MAPPING_MISSING");
        ok(211,"POST","/fin/mapping-templates/"+id(mapping)+"/review",Map.of("bookId",601,"version",mapping.get("version")));
        var generated = ok(201,"POST","/fin/events/"+event+"/generate",Map.of());
        long voucherId = ((Number)generated.get("voucherId")).longValue();
        var voucher = ok(201,"GET","/fin/vouchers/"+voucherId+"?bookId=601",null);
        assertThat(voucher).containsEntry("status","PENDING_AUDIT");
        assertThat(check("EVENTS_OPEN")).containsEntry("result","PASS");
        assertThat(check("UNPOSTED")).containsEntry("result","FAIL");
        var reconciliation = ok(201,"GET","/fin/reconcile?bookId=601&periodId=701&type=CASH",null);
        assertThat((List<?>)reconciliation.get("unposted")).hasSize(1);
        assertThat((List<?>)reconciliation.get("ungenerated")).isEmpty();
        voucher = ok(211,"POST","/fin/vouchers/"+voucherId+"/audit?bookId=601",Map.of("version",voucher.get("version")));
        voucher = ok(201,"POST","/fin/vouchers/"+voucherId+"/post?bookId=601",Map.of("version",voucher.get("version")));
        assertThat(voucher).containsEntry("status","POSTED");
        assertThat(ok(201,"POST","/fin/events/"+event+"/generate",Map.of()).get("voucherId")).isEqualTo(generated.get("voucherId"));
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isEqualTo(1);
        for (String type : List.of("AR","AP","INVENTORY","CASH")) {
            var recon = ok(201,"GET","/fin/reconcile?bookId=601&periodId=701&type="+type,null);
            assertThat(recon).containsEntry("incomplete",false);
            assertThat(new BigDecimal(recon.get("diffAmount").toString())).as(type).isZero();
        }
        var detail = ok(201,"GET","/fin/ledgers/detail?bookId=601&periodId=701&accountId="+cash,null);
        var line = rows(detail.get("lines")).getFirst();
        assertThat(((Number)line.get("voucherId")).longValue()).isEqualTo(voucherId);
        assertThat(line).containsEntry("sourceDocType","AR_RECEIPT");
        assertThat(((Number)line.get("sourceDocId")).longValue()).isEqualTo(receiptId);
        var journal = ok(201,"GET","/fin/ledgers/journal?bookId=601&periodId=701&fundAccountId=1901",null);
        assertThat(rows(journal.get("lines"))).hasSize(1);
        assertThat(amount(ok(201,"GET","/fin/reports/CASHFLOW?bookId=601&periodId=701",null),"AI06-IN")).isEqualByComparingTo("42");
        assertThat(ok(201,"GET","/fin/reports/BALANCE_SHEET?bookId=601&periodId=701",null)).containsEntry("balanced",true);
        assertThat(amount(ok(201,"GET","/fin/reports/INCOME?bookId=601&periodId=701",null),"PROFIT")).isZero();

        long pendingReceipt = id(ok(201,"POST","/ar/receipts",input));
        assertThat(ok(201,"POST","/fin/periods/701/close-check",Map.of("bookId",601))).containsEntry("canClose",true);
        var closed = ok(201,"POST","/fin/periods/701/close",Map.of("bookId",601));
        assertThat(closed).containsEntry("closeGeneration",1);
        assertThat(owner.queryForObject("select status from fin_period where id=701",String.class)).isEqualTo("CLOSED");
        assertThat(owner.queryForObject("select count(*) from fin_snapshot where period_id=701",Integer.class)).isEqualTo(3);
        assertThat(call(201,"POST","/ar/receipts/"+pendingReceipt+"/confirm",Map.of("arrivalDate","2026-10-15")).body()).contains("FIN_PERIOD_CLOSED");
        assertThatThrownBy(()->pur.create(c(),"orders",Map.of(
            "bookId",601,"entityId",301,"supplierId",801,"orderDate","2026-10-15","currency","CNY",
            "lines",List.of(Map.of("productId",501,"unit","PCS","qty",1,"unitPrice",10))),key()))
            .isInstanceOf(com.hs.jxc.common.api.ApiException.class).extracting("code").isEqualTo("FIN_PERIOD_CLOSED");
        assertThat(owner.queryForObject("select count(*) from pur_order",Integer.class)).isZero();
        assertThat(call(201,"POST","/fin/vouchers?bookId=601",Map.of("voucherDate","2026-10-15","lines",List.of(Map.of("accountId",cash,"debit",1,"aux",Map.of("fundAccountId",1901),"cashflowItemId",flow),Map.of("accountId",advance,"credit",1)))).body()).contains("FIN_PERIOD_CLOSED");
        assertThat(ok(201,"GET","/fin/ledgers/detail?bookId=601&periodId=701&accountId="+cash,null)).containsEntry("source","CLOSED_SNAPSHOT");
        var frozenReport = ok(201,"GET","/fin/reports/CASHFLOW?bookId=601&periodId=701",null);
        assertThat(frozenReport).containsEntry("source","SNAPSHOT").containsEntry("closeGeneration",1);
        assertThat(amount(frozenReport,"AI06-IN")).isEqualByComparingTo("42");
        long finished = export(); jobs.run(101,finished);
        var file = ok(201,"GET","/sys/jobs/"+finished+"/download",null);
        assertThat(file.get("content").toString()).contains("42");
        String stored = owner.queryForObject("select content::text from sys_job_result where job_id=?",String.class,finished);
        long delayed = export();
        ok(201,"POST","/fin/periods/701/reopen",Map.of("bookId",601,"reason","AI06重新核对"));
        assertThat(owner.queryForObject("select count(*) from fin_snapshot where period_id=701",Integer.class)).isEqualTo(3);
        ok(201,"POST","/fin/periods/701/close",Map.of("bookId",601));
        jobs.run(101,delayed);
        assertThat(ok(201,"GET","/sys/jobs/"+delayed,null)).containsEntry("status","FAILED").containsEntry("lastError","JOB_CONTEXT_CHANGED");
        assertThat(owner.queryForObject("select content::text from sys_job_result where job_id=?",String.class,finished)).isEqualTo(stored);
        assertThat(ok(201,"GET","/sys/jobs/"+finished+"/download",null).get("content")).isEqualTo(file.get("content"));
        assertThat(owner.queryForObject("select count(*) from fin_snapshot where period_id=701",Integer.class)).isEqualTo(6);
        // The selected book is a checked context, not a new accounting payload or idempotency hash.
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,301,'AI06-OTHER','AI06另一账套','MXN','ACTIVE')");
        String legacyIntent=key(),generatePath="/fin/events/"+event+"/generate";
        for(Object body:new Object[]{null,Map.of(),Map.of("bookId",601)}) {
            var replay=call(201,"POST",generatePath,body,legacyIntent);
            assertThat(replay.statusCode()).withFailMessage(replay.body()).isEqualTo(200);
            var replayData=(Map<?,?>)json.readValue(replay.body(),Map.class).get("data");
            assertThat(((Number)replayData.get("voucherId")).longValue()).isEqualTo(voucherId);
        }
        assertThat(call(201,"POST",generatePath,Map.of("bookId",601,"amount",99),legacyIntent).statusCode()).isEqualTo(400);
        assertThat(call(201,"POST",generatePath,Map.of("bookId",602),legacyIntent).statusCode()).isEqualTo(404);
        assertThat(call(201,"POST",generatePath,Map.of("bookId","601"),legacyIntent).statusCode()).isEqualTo(400);
        var another=call(201,"POST",generatePath,Map.of("bookId",601),key());
        assertThat(another.statusCode()).withFailMessage(another.body()).isEqualTo(200);
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isEqualTo(1);
        System.out.println("AI06_GENERATE_INPUT_CONTRACT_VERIFIED event="+event+" voucher="+voucherId+" legacyEmptyAndPageBook=sameVoucher illegalField=400 wrongExistingBook=404 differentKey=oneVoucher");
        seed("update sys_role set permissions='[\"fin:report:view\"]' where id=202");
        assertThat(call(201,"GET","/sys/jobs/"+finished+"/download",null).statusCode()).isEqualTo(403);
        System.out.println("AI06_SOURCE_VERIFIED "+json.writeValueAsString(Map.of("receipt",receiptId,"receiptNo",receipt.get("docNo"),"event",event,"voucher",voucherId,"amountMXN",42,"finishedJob",finished,"staleJob",delayed,"closeGenerations",2)));
    }

    long export() throws Exception { var job=ok(201,"POST","/fin/reports/CASHFLOW/export",Map.of("bookId",601,"periodId",701));return ((Number)job.get("jobId")).longValue(); }
    Map<String,Object> check(String code) throws Exception { return rows(ok(201,"POST","/fin/periods/701/close-check",Map.of("bookId",601)).get("checks")).stream().filter(r->code.equals(r.get("checkCode"))).findFirst().orElseThrow(); }
    BigDecimal amount(Map<String,Object> report,String code) { return new BigDecimal(rows(report.get("lines")).stream().filter(r->code.equals(r.get("code"))).findFirst().orElseThrow().get("amount").toString()); }
    @SuppressWarnings("unchecked") List<Map<String,Object>> rows(Object value) { return (List<Map<String,Object>>)value; }
    @SuppressWarnings("unchecked") Map<String,Object> ok(int user,String method,String path,Object body) throws Exception { var r=call(user,method,path,body);assertThat(r.statusCode()).withFailMessage(r.body()).isEqualTo(200);return (Map<String,Object>)json.readValue(r.body(),Map.class).get("data"); }
    HttpResponse<String> call(int user,String method,String path,Object body) throws Exception {
        return call(user,method,path,body,key());
    }
    HttpResponse<String> call(int user,String method,String path,Object body,String intent) throws Exception {
        String token=user==211?"AI06-auditor":"supply-fixture";
        var b=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1"+path)).header("Authorization","Bearer "+token).header("X-Country-Id","101").header("Content-Type","application/json").header("Idempotency-Key",intent);
        b.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        return http.send(b.build(),HttpResponse.BodyHandlers.ofString());
    }
}
