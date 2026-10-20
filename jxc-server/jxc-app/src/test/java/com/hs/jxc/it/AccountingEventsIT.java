package com.hs.jxc.it;

import com.hs.jxc.sys.service.SessionService;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import java.math.BigDecimal;
import java.util.concurrent.*;
import com.hs.jxc.fin.accounting.AccountingService;
import com.hs.jxc.event.TransactionalEventConsumer;
import org.springframework.beans.factory.annotation.Autowired;
import com.hs.jxc.common.event.OutboxPublisher;
import com.hs.jxc.fin.api.FinancialSourceProvider;
import com.hs.jxc.sys.api.Access;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.concurrent.atomic.AtomicBoolean;
import java.time.LocalDate;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Value;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.*;

/** HTTP + real PostgreSQL contract: mapping review and generation must remain separate. */
@Import(AccountingEventsIT.ProbeConfiguration.class)
class AccountingEventsIT extends BasePgIT {
    static final String TOKEN="accounting-events-it";
    @Value("${local.server.port}") int port;
    final HttpClient http=HttpClient.newHttpClient();
    final JsonMapper json=JsonMapper.builder().build();
    @Autowired AccountingService accounting;
    @Autowired TransactionalEventConsumer consumer;
    @Autowired OutboxPublisher publisher;
    @Autowired SnapshotProbe probe;
    @BeforeEach void fixtures(){probe.reset();resetFixtures();
        seed("insert into md_currency(code,name) values('MXN','Peso')");
        seed("insert into sys_country(id,code,name,default_currency,timezone,status) values(101,'MX','Mexico','MXN','UTC','ACTIVE')");
        seed("insert into sys_authz_epoch(country_id) values(101)");NumberFixtures.seed(101,"FIN_VOUCHER","AR_RECEIPT","AR_WRITEOFF","AR_CREDIT_NOTE");
        seed("insert into sys_user(id,username,password_hash,display_name) values(201,'accounting','unused','Accounting')");
        seed("insert into sys_session(token_hash,user_id,expires_at) values(?,201,clock_timestamp()+interval '1 hour')",SessionService.digest(TOKEN));
        seed("insert into sys_role(id,country_id,code,name,permissions,field_policies) values(202,101,'FIN','Finance','[\"*\"]','{\"COST\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"BANK_INFO\":\"WRITE\",\"CUSTOMER_PRICE\":\"WRITE\",\"CREDIT\":\"WRITE\",\"PROFIT\":\"WRITE\"}')");
        seed("insert into sys_user_role(country_id,user_id,role_id) values(101,201,202)");
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(101,201,'COUNTRY_ALL',201)");
        seed("insert into org_entity(id,country_id,code,name) values(301,101,'E','Entity')");
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(601,101,301,'B','Book','MXN','ACTIVE')");
        seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(701,101,601,2026,10,'2026-10-01','2026-10-31','OPEN')");
        seed("insert into org_store(id,country_id,entity_id,code,name) values(302,101,301,'S','Store')");
        seed("insert into md_customer(id,country_id,code,name,store_id) values(801,101,'C','Customer',302)");
        seed("insert into fin_account(id,country_id,book_id,code,name,category,direction,reconcile_type,is_cash,aux_types) values(1101,101,601,'1001','Cash','ASSET','DEBIT','CASH',true,'[\"fundAccountId\"]'),(1102,101,601,'2203','Customer advances','LIABILITY','CREDIT','AR',false,'[\"customerId\"]'),(1103,101,601,'1200','Clearing','ASSET','DEBIT',NULL,false,'[]')");
        seed("insert into fin_cashflow_item(id,country_id,book_id,code,name,category,direction) values(1201,101,601,'OPERATING_RECEIPT','Customer receipt','OPERATING','IN')");
        seed("insert into md_fund_account(id,country_id,entity_id,book_id,store_id,name,account_type,currency,gl_account_id) values(901,101,301,601,302,'Till','CASH','MXN',1101)");
    }
    JsonNode send(String method,String path,Object body,String key)throws Exception{
        var request=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1"+path)).header("Authorization","Bearer "+TOKEN).header("X-Country-Id","101").header("Content-Type","application/json");
        if(key!=null)request.header("Idempotency-Key",key);
        request.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        return json.readTree(http.send(request.build(),HttpResponse.BodyHandlers.ofString()).body());
    }
    String key(){return UUID.randomUUID().toString();}
    @Test void originalMappingEndpointCreatesVersionedDraftAndRejectsExecutableExpressions()throws Exception{
        var body=Map.of("bookId",601,"eventType","AR_RECEIPT_CONFIRMED","lines",List.of(Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","code","1001"),"amountExpr","amount","auxMapping",Map.of()),Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","code","2203"),"amountExpr","amount","auxMapping",Map.of())));
        var created=send("POST","/fin/mapping-templates",body,key());
        assertThat(created.get("code").asString()).isEqualTo("OK");
        assertThat(created.get("data").get("status").asString()).isEqualTo("NEED_REVIEW");
        var invalid=Map.of("bookId",601,"eventType","AR_RECEIPT_CONFIRMED","lines",List.of(Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","code","1001"),"amountExpr","amount;System.exit(0)")));
        assertThat(send("POST","/fin/mapping-templates",invalid,key()).get("code").asString()).isEqualTo("FIN_AMOUNT_EXPRESSION_INVALID");
        assertThat(owner.queryForObject("select count(*) from fin_mapping_template",Integer.class)).isEqualTo(1);
    }
    @Test void eventListAndReconcileAreReadOnlyAndNeverInventEventsOrBalances()throws Exception{
        var events=send("GET","/fin/events?bookId=601",null,null);assertThat(events.get("code").asString()).isEqualTo("OK");
        assertThat(events.get("data").get("total").asInt()).isZero();
        var reconcile=send("GET","/fin/reconcile?bookId=601&periodId=701&type=ALL",null,null);assertThat(reconcile.get("code").asString()).isEqualTo("OK");
        assertThat(reconcile.get("data").size()).isEqualTo(4);
        probe.precisionBalances=List.of(Map.of("sourceType","PRECISION_CONTRACT","sourceId",9991L,"amount",new BigDecimal("0.005")));
        var precisionLine=new LinkedHashMap<String,Object>();precisionLine.put("sourceType","PRECISION_CONTRACT");precisionLine.put("sourceId",9991L);precisionLine.put("originalAmount",new BigDecimal("0.005"));precisionLine.put("amount",BigDecimal.ZERO);
        var summary=new LinkedHashMap<String,Object>();summary.put("bookId",601L);summary.put("sourceAccountingAmount",BigDecimal.ZERO);summary.put("details",List.of(precisionLine));probe.precisionSummary=summary;
        var explained=send("GET","/fin/reconcile?bookId=601&periodId=701&type=INVENTORY",null,null);assertThat(explained.get("code").asString()).isEqualTo("OK");var inventory=explained.get("data");assertThat(inventory.get("businessAmount").decimalValue()).isEqualByComparingTo("0.01");assertThat(inventory.get("diffAmount").decimalValue()).isEqualByComparingTo("0.01");assertThat(inventory.get("sourceAccountingAmount")).as("fixed source accounting amount is disclosed separately").isNotNull();assertThat(inventory.get("sourceAccountingAmount").decimalValue()).isZero();assertThat(inventory.get("roundingDifference").decimalValue()).isEqualByComparingTo("0.01");assertThat(inventory.get("accountingDiffAmount").decimalValue()).isZero();assertThat(inventory.get("precisionDetails").get(0).get("originalAmount").decimalValue()).isEqualByComparingTo("0.005");
        summary.put("sourceAccountingAmount",new BigDecimal("0.005"));precisionLine.put("amount",new BigDecimal("0.005"));probe.precisionSummary=summary;var fractional=send("GET","/fin/reconcile?bookId=601&periodId=701&type=INVENTORY",null,null).get("data");assertThat(fractional.get("roundingDifference").decimalValue()).isEqualByComparingTo("0.005");assertThat(fractional.get("accountingDiffAmount").decimalValue()).isEqualByComparingTo("0.005");
        summary.put("sourceAccountingAmount",BigDecimal.ZERO);precisionLine.put("amount",null);precisionLine.put("costMissing",true);probe.precisionSummary=summary;var unknown=send("GET","/fin/reconcile?bookId=601&periodId=701&type=INVENTORY",null,null).get("data");assertThat(unknown.get("sourceAccountingAmount").isNull()).isTrue();assertThat(unknown.get("roundingDifference").isNull()).isTrue();assertThat(unknown.get("accountingDiffAmount").isNull()).isTrue();assertThat(unknown.get("precisionIncomplete").asBoolean()).isTrue();
        summary.put("bookId",602L);probe.precisionSummary=summary;assertThat(send("GET","/fin/reconcile?bookId=601&periodId=701&type=INVENTORY",null,null).get("code").asString()).isEqualTo("NOT_FOUND");summary.put("bookId",601L);probe.precisionSummary=summary;
        seed("update sys_role set field_policies='{\"ORDER_TOTAL\":\"WRITE\"}' where id=202");var hidden=send("GET","/fin/reconcile?bookId=601&periodId=701&type=INVENTORY",null,null).get("data");assertThat(hidden.get("sourceAccountingAmount")).isNull();assertThat(hidden.get("precisionDetails")).isNull();
        assertThat(owner.queryForObject("select count(*) from sys_biz_event",Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from fin_account_balance",Integer.class)).isZero();
    }
    long receipt()throws Exception{
        var created=send("POST","/ar/receipts",Map.of("bookId",601,"customerId",801,"fundAccountId",901,"method","CASH","amount",100,"bizTime","2026-10-15T12:00:00Z"),key());assertThat(created.get("code").asString()).isEqualTo("OK");
        long receipt=created.get("data").get("id").asLong();
        var confirmed=send("POST","/ar/receipts/"+receipt+"/confirm",Map.of("arrivalDate","2026-10-15"),key());assertThat(confirmed.get("code").asString()).isEqualTo("OK");
        return owner.queryForObject("select id from sys_biz_event where event_type='AR_RECEIPT_CONFIRMED' and source_id=?",Long.class,receipt);
    }
    JsonNode approved(String event,String mode)throws Exception{
        var body=new LinkedHashMap<String,Object>();body.put("bookId",601);body.put("eventType",event);body.put("accountingMode",mode);
        if(mode.equals("NO_VOUCHER")){body.put("noVoucherReason","Only confirms the already recorded source; reviewed explicitly");body.put("lines",List.of());}
        else body.put("lines",List.of(Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","code",event.startsWith("AR_RECEIPT")?"1001":"1200"),"amountExpr","amount","auxMapping",Map.of(),"cashflowItemId",1201),Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","code","2203"),"amountExpr","amount","auxMapping",Map.of())));
        var created=send("POST","/fin/mapping-templates",body,key());assertThat(created.get("code").asString()).isEqualTo("OK");var tpl=created.get("data");
        var reviewed=send("POST","/fin/mapping-templates/"+tpl.get("id").asLong()+"/review",Map.of("version",tpl.get("version").asInt()),key());assertThat(reviewed.get("code").asString()).isEqualTo("OK");return reviewed.get("data");
    }
    @Test void failedGenerationRollsBackThenRetriesAndLateFailureCannotOverwriteSuccess()throws Exception{
        long event=receipt();String intent=key();
        assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),intent).get("code").asString()).isEqualTo("FIN_MAPPING_MISSING");
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from sys_idempotency where key=?",Integer.class,intent)).isZero();
        assertThat(owner.queryForObject("select last_error from sys_biz_event_consume where event_id=?",String.class,event)).isEqualTo("FIN_MAPPING_MISSING");
        approved("AR_RECEIPT_CONFIRMED","VOUCHER");
        var result=send("POST","/fin/events/"+event+"/generate",Map.of(),intent);assertThat(result.get("code").asString()).isEqualTo("OK");
        assertThat(owner.queryForObject("select status from fin_voucher",String.class)).isEqualTo("PENDING_AUDIT");
        assertThat(owner.queryForObject("select total_debit from fin_voucher",BigDecimal.class)).isEqualByComparingTo("100");
        consumer.failure(101,event,AccountingService.CONSUMER,1,"OLD_FAILURE");
        assertThat(owner.queryForObject("select status from sys_biz_event_consume where event_id=?",String.class,event)).isEqualTo("DONE");
        assertThat(owner.queryForObject("select count(*) from fin_event_result",Integer.class)).isEqualTo(1);
    }
    @Test void concurrentDeliveryAndManualClicksCreateOneVoucherAndSimulationDoesNotWrite()throws Exception{
        long event=receipt();var tpl=approved("AR_RECEIPT_CONFIRMED","VOUCHER");
        var simulated=send("POST","/fin/mapping-templates/"+tpl.get("id").asLong()+"/simulate?eventId="+event,Map.of(),null);assertThat(simulated.get("code").asString()).isEqualTo("OK");assertThat(simulated.get("data").get("saved").asBoolean()).isFalse();assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
        var pool=Executors.newFixedThreadPool(6);var start=new CountDownLatch(1);try{var fs=new ArrayList<Future<JsonNode>>();for(int i=0;i<6;i++)fs.add(pool.submit(()->{start.await();return send("POST","/fin/events/"+event+"/generate",Map.of(),key());}));start.countDown();for(var f:fs){String code=f.get(20,TimeUnit.SECONDS).get("code").asString();assertThat(code).isIn("OK","SYS_CONCURRENT_RETRY");}}finally{pool.shutdownNow();}
        assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).isEqualTo("OK");
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("select count(*) from fin_voucher_line",Integer.class)).isEqualTo(2);
        var recon=send("GET","/fin/reconcile?bookId=601&periodId=701&type=CASH",null,null).get("data");assertThat(recon.get("businessAmount").decimalValue()).isEqualByComparingTo("100");assertThat(recon.get("glAmount").decimalValue()).isZero();assertThat(recon.get("unpostedAmount").decimalValue()).isEqualByComparingTo("100");assertThat(recon.get("unposted").size()).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from fin_account_balance",Integer.class)).isZero();
    }
    @Test void economicAmountsCannotBeClearedByZeroImpactMappingAndRevokedWorkerCannotGenerate()throws Exception{
        long event=receipt();approved("AR_RECEIPT_CONFIRMED","NO_VOUCHER");
        assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).isEqualTo("FIN_NOT_ZERO_IMPACT");assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
        seed("update sys_role set permissions='[\"fin:ledger:view\"]' where id=202");
        assertThat(accounting.consumeWorker(101,201,event)).isEqualTo(TransactionalEventConsumer.Outcome.FAILED);
        assertThat(owner.queryForObject("select last_error from sys_biz_event_consume where event_id=?",String.class,event)).isEqualTo("SYS_FORBIDDEN");
    }

    @Test void failureAfterVoucherInsertRollsBackAllEffectsAndSavesOnlySanitizedDiagnosis()throws Exception{
        long event=receipt();approved("AR_RECEIPT_CONFIRMED","VOUCHER");String intent=key();
        owner.execute("create function test_fail_fin_result() returns trigger language plpgsql as $$ begin raise exception 'secret source payload must never persist'; end $$");owner.execute("create trigger test_fail_fin_result before insert on fin_event_result for each row execute function test_fail_fin_result()");
        try{assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),intent).get("code").asString()).isEqualTo("CONSUMER_FAILED");assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from fin_voucher_line",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from sys_idempotency where key=?",Integer.class,intent)).isZero();assertThat(owner.queryForObject("select last_error from sys_biz_event_consume where event_id=?",String.class,event)).isEqualTo("CONSUMER_FAILED");}
        finally{owner.execute("drop trigger test_fail_fin_result on fin_event_result");owner.execute("drop function test_fail_fin_result()");}
        assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),intent).get("code").asString()).isEqualTo("OK");
    }
    @Test void reviewedQuantityOnlyEventKeepsExplicitNoVoucherEvidenceInsteadOfZeroVoucher()throws Exception{
        seed("insert into md_supplier(id,country_id,code,name,settle_currency) values(1501,101,'SUP','Supplier','MXN')");
        seed("insert into pur_order(id,country_id,book_id,entity_id,biz_date,doc_no,status,supplier_id,currency,order_date,created_by) values(1601,101,601,301,'2026-10-15','PO-QTY','CONFIRMED',1501,'MXN','2026-10-15',201)");
        long event=inCountry(101,()->publisher.publish(101,601,"PUR_ORDER_CONFIRMED","PURCHASE_ORDER",1601,1,LocalDate.of(2026,10,15),Map.of("orderId",1601)));
        approved("PUR_ORDER_CONFIRMED","NO_VOUCHER");
        var result=send("POST","/fin/events/"+event+"/generate",Map.of(),key());assertThat(result.get("code").asString()).isEqualTo("OK");assertThat(result.get("data").get("status").asString()).isEqualTo("NO_VOUCHER");
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();assertThat(owner.queryForObject("select mapping_version from fin_event_result",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("select reason from fin_event_result",String.class)).contains("reviewed explicitly");
    }
    @Test void closedPeriodAndRequiredAuxiliaryRemainFailedRatherThanBeingInterpretedAsZero()throws Exception{
        long event=receipt();approved("AR_RECEIPT_CONFIRMED","VOUCHER");seed("update fin_account set aux_types='[\"employeeId\"]' where id=1102");
        assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).isEqualTo("FIN_AUX_REQUIRED");assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
        seed("update fin_period set status='CLOSED' where id=701");assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).isEqualTo("FIN_PERIOD_CLOSED");assertThat(owner.queryForObject("select status from sys_biz_event_consume where event_id=?",String.class,event)).isEqualTo("FAILED");
    }

    @Test void realWriteoffReversalRetainsNegativeAccountingAmounts()throws Exception{
        long receiptEvent=receipt();long receipt=owner.queryForObject("select source_id from sys_biz_event where id=?",Long.class,receiptEvent);
        seed("insert into sal_order(id,country_id,book_id,entity_id,store_id,customer_id,doc_no,order_date,currency,payment_type,entered_by,total_amount) values(1701,101,601,301,302,801,'SO-NEG','2026-10-15','MXN','CREDIT',201,100)");
        seed("insert into ar_receivable(id,country_id,book_id,customer_id,order_id,source_type,source_id,doc_no,currency,amount,open_amount,biz_date,due_date) values(1702,101,601,801,1701,'TEST',1701,'AR-NEG','MXN',100,100,'2026-10-15','2026-10-31')");
        var written=send("POST","/ar/writeoffs",Map.of("bookId",601,"customerId",801,"bizDate","2026-10-15","lines",List.of(Map.of("fromType","RECEIPT","fromId",receipt,"receivableId",1702,"amount",80))),key());assertThat(written.get("code").asString()).isEqualTo("OK");
        long original=written.get("data").get("records").get(0).get("id").asLong();var reversed=send("POST","/ar/writeoffs/"+original+"/reverse",Map.of("bizDate","2026-10-16","reason","Correct customer allocation"),key());assertThat(reversed.get("code").asString()).isEqualTo("OK");
        long event=owner.queryForObject("select id from sys_biz_event where event_type='AR_WRITEOFF_REVERSED'",Long.class);approved("AR_WRITEOFF_REVERSED","VOUCHER");
        var generated=send("POST","/fin/events/"+event+"/generate",Map.of(),key());assertThat(generated.get("code").asString()).isEqualTo("OK");assertThat(owner.queryForObject("select total_debit from fin_voucher",BigDecimal.class)).isEqualByComparingTo("-80");assertThat(owner.queryForObject("select min(orig_amount) from fin_voucher_line",BigDecimal.class)).isEqualByComparingTo("-80");
    }

    @Test void missingFrozenRateStaysFailedAndSuccessfulReplayRechecksCurrentFieldAuthority()throws Exception{
        seed("insert into md_currency(code,name) values('USD','Dollar')");seed("insert into md_fund_account(id,country_id,entity_id,book_id,store_id,name,account_type,currency,gl_account_id) values(902,101,301,601,302,'Foreign till','CASH','USD',1101)");
        // A retained foreign source with no historical conversion must not be valued from today's rate. New AR entry is base-currency-only in M2.
        seed("insert into ar_receipt(id,country_id,book_id,customer_id,store_id,fund_account_id,doc_no,currency,amount,method,status,received_by,biz_time,biz_date,arrival_date,confirmed_by,confirmed_at) values(1801,101,601,801,302,902,'RC-MISSING-RATE','USD',100,'CASH','CONFIRMED',201,'2026-10-15T12:00:00Z','2026-10-15','2026-10-15',201,clock_timestamp())");
        long foreign=inCountry(101,()->publisher.publish(101,601,"AR_RECEIPT_CONFIRMED","AR_RECEIPT",1801,1,LocalDate.of(2026,10,15),Map.of("id",1801,"customerId",801)));var mapping=approved("AR_RECEIPT_CONFIRMED","VOUCHER");
        assertThat(send("POST","/fin/events/"+foreign+"/generate",Map.of(),key()).get("code").asString()).isEqualTo("FIN_RATE_MISSING");assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
        long domestic=receipt();String intent=key();assertThat(send("POST","/fin/events/"+domestic+"/generate",Map.of(),intent).get("code").asString()).isEqualTo("OK");seed("update sys_role set field_policies='{}' where id=202");assertThat(send("POST","/fin/events/"+domestic+"/generate",Map.of(),intent).get("code").asString()).isEqualTo("SYS_FORBIDDEN");assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isEqualTo(1);assertThat(send("POST","/fin/mapping-templates/"+mapping.get("id").asLong()+"/simulate?eventId="+domestic,Map.of(),null).get("code").asString()).isEqualTo("SYS_FORBIDDEN");
    }

    @Test void reviewedMappingVersionsRetireAtomicallyAndGeneratedVoucherFreezesTheChosenVersion()throws Exception{
        var first=approved("AR_RECEIPT_CONFIRMED","VOUCHER");var second=approved("AR_RECEIPT_CONFIRMED","VOUCHER");assertThat(second.get("versionNo").asInt()).isEqualTo(2);assertThat(owner.queryForObject("select status from fin_mapping_template where id=?",String.class,first.get("id").asLong())).isEqualTo("RETIRED");
        var edit=json.readValue(first.toString(),Map.class);assertThat(send("PUT","/fin/mapping-templates/"+first.get("id").asLong(),edit,key()).get("code").asString()).isEqualTo("FIN_MAPPING_LOCKED");
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("update fin_mapping_line set amount_expr='taxAmount' where template_id=?",second.get("id").asLong());return null;})).isInstanceOf(RuntimeException.class);
        long event=receipt();assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).isEqualTo("OK");assertThat(owner.queryForObject("select mapping_version from fin_voucher",Integer.class)).isEqualTo(2);assertThat(owner.queryForObject("select mapping_version from fin_event_result",Integer.class)).isEqualTo(2);
    }

    @Test void payableRecognitionCannotUseInventoryPrecisionToUnderstateTheOriginalPrincipal()throws Exception{
        seed("insert into fin_account(id,country_id,book_id,code,name,category,direction,reconcile_type,aux_types) values(1301,101,601,'2202','Supplier payable','LIABILITY','CREDIT','AP','[]'),(1302,101,601,'6603','Configured precision difference','EXPENSE','DEBIT',NULL,'[]'),(1303,101,601,'2208','Configured GRNI','LIABILITY','CREDIT',NULL,'[]')");
        probe.payablePayload=Map.of("amount",new BigDecimal("0.01"),"apAmount",new BigDecimal("0.02"),"differenceAmount",new BigDecimal("0.01"),"payableRecognition",true);
        long event=inCountry(101,()->publisher.publish(101,601,"PAYABLE_PRECISION_CONFIRMED","PRECISION_PAYABLE",9991,1,LocalDate.of(2026,10,15),Map.of()));
        var badLines=List.of(Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","code","1200"),"amountExpr","amount"),Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","code","2202"),"amountExpr","amount"));precisionMapping(badLines);String intent=key();
        assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),intent).get("code").asString()).isEqualTo("FIN_PAYABLE_AMOUNT_MISMATCH");assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from fin_event_result",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from sys_idempotency where key=?",Integer.class,intent)).isZero();
        precisionMapping(List.of(Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","code","1200"),"amountExpr","amount"),Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","code","6603"),"amountExpr","differenceAmount"),Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","code","2202"),"amountExpr","apAmount")));
        assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),intent).get("code").asString()).isEqualTo("OK");assertThat(owner.queryForObject("select total_credit from fin_voucher",BigDecimal.class)).isEqualByComparingTo("0.02");
        precisionMapping(List.of(Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","code","1200"),"amountExpr","amount"),Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","code","2208"),"amountExpr","amount")));long clearing=inCountry(101,()->publisher.publish(101,601,"PAYABLE_PRECISION_CONFIRMED","PRECISION_PAYABLE",9991,2,LocalDate.of(2026,10,15),Map.of()));assertThat(send("POST","/fin/events/"+clearing+"/generate",Map.of(),key()).get("code").asString()).isEqualTo("OK");assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isEqualTo(2);
    }
    void precisionMapping(List<? extends Map<String,?>> rules)throws Exception{var saved=send("POST","/fin/mapping-templates",Map.of("bookId",601,"eventType","PAYABLE_PRECISION_CONFIRMED","lines",rules),key());assertThat(saved.get("code").asString()).isEqualTo("OK");var m=saved.get("data");assertThat(send("POST","/fin/mapping-templates/"+m.get("id").asLong()+"/review",Map.of("version",m.get("version").asInt()),key()).get("code").asString()).isEqualTo("OK");}

    long ownerZeroEvent(Map<String,Object> payload,int seq,Map<String,Object> outbox){
        probe.payablePayload=payload;
        return inCountry(101,()->publisher.publish(101,601,"PAYABLE_PRECISION_CONFIRMED","PRECISION_PAYABLE",9991,seq,LocalDate.of(2026,10,15),outbox));
    }
    @Test void ownerConfirmedZeroPostingUsesTheReviewedVoucherVersionWithoutInventingAVoucher()throws Exception{
        long event=ownerZeroEvent(Map.of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ZERO,"inventoryAmount",new BigDecimal("90")),1,Map.of());
        var tpl=approved("PAYABLE_PRECISION_CONFIRMED","VOUCHER");
        var simulation=send("POST","/fin/mapping-templates/"+tpl.get("id").asLong()+"/simulate?eventId="+event,Map.of(),null);
        assertThat(simulation.get("code").asString()).as("Owner explicitly confirms zero posting under the same reviewed VOUCHER template").isEqualTo("OK");
        assertThat(simulation.get("data").get("effectiveMode").asString()).isEqualTo("NO_VOUCHER");
        assertThat(simulation.get("data").get("accountingMode").asString()).isEqualTo("NO_VOUCHER");
        assertThat(simulation.get("data").get("reason").asString()).isEqualTo("SOURCE_CONFIRMATION_ZERO_POSTING");
        assertThat(simulation.get("data").get("saved").asBoolean()).isFalse();
        assertThat(owner.queryForObject("select count(*) from fin_event_result",Integer.class)).isZero();
        var pool=Executors.newFixedThreadPool(4);var start=new CountDownLatch(1);
        try{var futures=new ArrayList<Future<JsonNode>>();for(int i=0;i<4;i++)futures.add(pool.submit(()->{start.await();return send("POST","/fin/events/"+event+"/generate",Map.of(),key());}));start.countDown();for(var future:futures)assertThat(future.get(20,TimeUnit.SECONDS).get("code").asString()).isIn("OK","SYS_CONCURRENT_RETRY");}finally{pool.shutdownNow();}
        var replay=send("POST","/fin/events/"+event+"/generate",Map.of(),key());assertThat(replay.get("code").asString()).isEqualTo("OK");
        assertThat(replay.get("data").get("status").asString()).isEqualTo("NO_VOUCHER");
        assertThat(owner.queryForObject("select count(*) from fin_event_result",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
        assertThat(owner.queryForObject("select mapping_template_id from fin_event_result",Long.class)).isEqualTo(tpl.get("id").asLong());
        assertThat(owner.queryForObject("select mapping_version from fin_event_result",Integer.class)).isEqualTo(tpl.get("versionNo").asInt());
        assertThat(owner.queryForObject("select reason from fin_event_result",String.class)).isEqualTo("SOURCE_CONFIRMATION_ZERO_POSTING");
        assertThat(owner.queryForObject("select fact_hash from fin_event_result",String.class)).hasSize(64);
        assertThat(owner.queryForObject("select status from sys_biz_event_consume where event_id=? and consumer='FIN_VOUCHER'",String.class,event)).isEqualTo("DONE");
        seed("update sys_role set field_policies='{\"ORDER_TOTAL\":\"WRITE\"}' where id=202");
        probe.payablePayload=Map.of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ZERO,"postingInventoryAmount",BigDecimal.ZERO);
        assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).isEqualTo("SYS_FORBIDDEN");
    }
    @Test void zeroPostingNeverUsesMissingAmountsUnresolvedPrerequisitesOrAnOutboxFlag()throws Exception{
        var tpl=approved("PAYABLE_PRECISION_CONFIRMED","VOUCHER");int seq=0;
        var cases=new ArrayList<Map<String,Object>>();
        cases.add(Map.of("accountingImpact","SOURCE_CONFIRMATION"));
        var nullAmount=new HashMap<String,Object>();nullAmount.put("accountingImpact","SOURCE_CONFIRMATION");nullAmount.put("amount",null);cases.add(nullAmount);
        cases.add(Map.of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ZERO,"costMissing",true));
        cases.add(Map.of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ZERO,"rateMissing",true));
        cases.add(Map.of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ZERO,"allocationMissing",true));
        cases.add(Map.of("amount",BigDecimal.ZERO));
        cases.add(Map.of("accountingImpact","NONE","amount",BigDecimal.ZERO));
        cases.add(Map.of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ONE.negate()));
        cases.add(Map.of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ZERO,"payableRecognition",true,"apAmount",new BigDecimal("0.01")));
        for(var payload:cases){long event=ownerZeroEvent(payload,++seq,Map.of("accountingImpact","SOURCE_CONFIRMATION","amount",0));var response=send("POST","/fin/mapping-templates/"+tpl.get("id").asLong()+"/simulate?eventId="+event,Map.of(),null);assertThat(response.get("code").asString()).as(payload.toString()).isNotEqualTo("OK");assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).as(payload.toString()).isNotEqualTo("OK");}
        // Every configured expression must exist and individually be zero, even when amount itself is zero.
        precisionMapping(List.of(Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","code","1200"),"amountExpr","inventoryAmount"),Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","code","1200"),"amountExpr","soldAmount")));
        for(var payload:List.of(Map.<String,Object>of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ZERO,"inventoryAmount",BigDecimal.ZERO),Map.<String,Object>of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ZERO,"inventoryAmount",BigDecimal.ONE.negate(),"soldAmount",BigDecimal.ONE))){long event=ownerZeroEvent(payload,++seq,Map.of());assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).isNotEqualTo("OK");}
        assertThat(owner.queryForObject("select count(*) from fin_event_result",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
    }
    void rawZeroResult(long event,JsonNode template,long book,int version,int sequence,String reason){
        jdbc.update("INSERT INTO fin_event_result(country_id,book_id,event_id,source_event_version,mapping_template_id,mapping_version,status,reason,fact_hash,prepared_by) VALUES(101,?,?,?,?,?,'NO_VOUCHER',?,?,201)",book,event,sequence,template.get("id").asLong(),version,reason,"0".repeat(64));
    }
    @Test void zeroPostingDatabaseGuardRequiresTheCurrentFinIntentAndExactTechnicalBasisWhileWorkerReusesTheOwnerRenderer()throws Exception{
        long event=ownerZeroEvent(Map.of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ZERO),1,Map.of());var template=approved("PAYABLE_PRECISION_CONFIRMED","VOUCHER");int version=template.get("versionNo").asInt();String reason="SOURCE_CONFIRMATION_ZERO_POSTING";
        assertThatThrownBy(()->inCountry(101,()->{rawZeroResult(event,template,601,version,1,reason);return null;})).hasStackTraceContaining("FIN_EVENT_INTERPRETATION_INVALID");
        seed("INSERT INTO sys_biz_event_consume(country_id,book_id,event_id,consumer,status,attempt_count) VALUES(101,601,?,'FIN_VOUCHER','PROCESSING',1),(101,601,?,'OTHER_CONSUMER','PROCESSING',1)",event,event);
        // A committed FIN lease is not the current effect transaction.
        assertThatThrownBy(()->inCountry(101,()->{rawZeroResult(event,template,601,version,1,reason);return null;})).hasStackTraceContaining("FIN_EVENT_INTERPRETATION_INVALID");
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("UPDATE sys_biz_event_consume SET status=status WHERE event_id=? AND consumer='OTHER_CONSUMER'",event);rawZeroResult(event,template,601,version,1,reason);return null;})).hasStackTraceContaining("FIN_EVENT_INTERPRETATION_INVALID");
        for(String mismatch:List.of("reason","book","version","sequence"))assertThatThrownBy(()->inCountry(101,()->{
            jdbc.update("UPDATE sys_biz_event_consume SET status=status WHERE event_id=? AND consumer='FIN_VOUCHER'",event);
            rawZeroResult(event,template,mismatch.equals("book")?602:601,mismatch.equals("version")?version+1:version,mismatch.equals("sequence")?2:1,mismatch.equals("reason")?"Unreviewed zero":reason);return null;
        })).as(mismatch).hasStackTraceContaining("FIN_EVENT_INTERPRETATION_INVALID");
        assertThat(owner.queryForObject("SELECT count(*) FROM fin_event_result",Integer.class)).isZero();
        seed("UPDATE sys_biz_event_consume SET status='FAILED' WHERE event_id=? AND consumer='FIN_VOUCHER'",event);
        assertThat(accounting.consumeWorker(101,201,event)).isEqualTo(TransactionalEventConsumer.Outcome.DONE);
        assertThat(owner.queryForObject("SELECT status FROM fin_event_result",String.class)).isEqualTo("NO_VOUCHER");
        assertThat(owner.queryForObject("SELECT count(*) FROM fin_voucher",Integer.class)).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_idempotency WHERE endpoint LIKE '/api/v1/fin/events/%/generate'",Integer.class)).isZero();
    }
    @Test void zeroPostingRejectsOppositeOrUnknownAllocatedPartsEvenWhenTheOwnerTotalIsZero()throws Exception{
        int sequence=0;
        for(var choice:Map.of("amount","accountingLines","cogsAmount","costLines","amountExclTax","revenueLines").entrySet()){
            precisionMapping(List.of(Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","code","1200"),"amountExpr",choice.getKey()),Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","code","1200"),"amountExpr",choice.getKey())));
            long template=owner.queryForObject("select id from fin_mapping_template where event_type='PAYABLE_PRECISION_CONFIRMED' and status='ACTIVE'",Long.class);
            var parts=new ArrayList<List<Map<String,Object>>>();parts.add(List.of(Map.of("amount",BigDecimal.ONE),Map.of("amount",BigDecimal.ONE.negate())));parts.add(List.of(Map.of("amount",BigDecimal.ONE),Map.of("amount",BigDecimal.ZERO)));
            var missing=new HashMap<String,Object>();missing.put("amount",null);parts.add(List.of(missing));
            for(var split:parts){var payload=new HashMap<String,Object>();payload.put("accountingImpact","SOURCE_CONFIRMATION");payload.put("amount",BigDecimal.ZERO);payload.put(choice.getKey(),BigDecimal.ZERO);payload.put(choice.getValue(),split);long event=ownerZeroEvent(payload,++sequence,Map.of());
                var simulation=send("POST","/fin/mapping-templates/"+template+"/simulate?eventId="+event,Map.of(),null);assertThat(simulation.get("code").asString()).as(choice.getValue()+" actual frozen posting parts "+split).isNotEqualTo("OK");
                assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).isNotEqualTo("OK");
            }
        }
        assertThat(owner.queryForObject("select count(*) from fin_event_result",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
    }

    @Autowired com.hs.jxc.ar.api.ArReturnApi returnAccounting;
    @Autowired com.hs.jxc.sys.service.AuthorizationService accountingAuthorization;
    @Test void oneReviewedWriteoffTemplateKeepsReceiptPrincipalAndNativeReturnCreditNotificationSeparate()throws Exception{
        long receiptEvent=receipt();long receipt=owner.queryForObject("select source_id from sys_biz_event where id=?",Long.class,receiptEvent);
        seed("insert into sal_order(id,country_id,book_id,entity_id,store_id,customer_id,doc_no,order_date,currency,payment_type,entered_by,total_amount) values(1701,101,601,301,302,801,'SO-MIXED-WRITEOFF','2026-10-15','MXN','CREDIT',201,100)");
        seed("insert into ar_receivable(id,country_id,book_id,customer_id,order_id,source_type,source_id,doc_no,currency,amount,open_amount,biz_date,due_date) values(1702,101,601,801,1701,'TEST',1701,'AR-MIXED-WRITEOFF','MXN',100,100,'2026-10-15','2026-10-31')");
        seed("insert into fin_account(id,country_id,book_id,code,name,category,direction,reconcile_type,aux_types) values(1104,101,601,'1122','Receivables','ASSET','DEBIT','AR','[\"customerId\"]')");
        var mapping=send("POST","/fin/mapping-templates",Map.of("bookId",601,"eventType","AR_WRITEOFF_CREATED","lines",List.of(Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","code","2203"),"amountExpr","amount"),Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","code","1122"),"amountExpr","amount"))),key()).get("data");
        assertThat(send("POST","/fin/mapping-templates/"+mapping.get("id").asLong()+"/review",Map.of("version",mapping.get("version").asInt()),key()).get("code").asString()).isEqualTo("OK");
        var ordinary=send("POST","/ar/writeoffs",Map.of("bookId",601,"customerId",801,"bizDate","2026-10-15","lines",List.of(Map.of("fromType","RECEIPT","fromId",receipt,"receivableId",1702,"amount",50))),key());assertThat(ordinary.get("code").asString()).isEqualTo("OK");
        long first=owner.queryForObject("select id from sys_biz_event where event_type='AR_WRITEOFF_CREATED'",Long.class);assertThat(send("POST","/fin/events/"+first+"/generate",Map.of(),key()).get("data").get("status").asString()).isEqualTo("GENERATED");
        var context=new com.hs.jxc.common.context.RequestContext(201,101L,"native-credit-financial-contract",SessionService.digest(TOKEN));
        inCountry(101,()->{returnAccounting.settleSalesReturn(accountingAuthorization.authorize(context),601,1901,1701,801,"MXN",new BigDecimal("30"),LocalDate.of(2026,10,15));return null;});
        long credit=owner.queryForObject("select max(id) from sys_biz_event where event_type='AR_WRITEOFF_CREATED'",Long.class);assertThat(credit).isNotEqualTo(first);
        var result=send("POST","/fin/events/"+credit+"/generate",Map.of(),key());assertThat(result.get("code").asString()).isEqualTo("OK");assertThat(result.get("data").get("status").asString()).isEqualTo("NO_VOUCHER");
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("select total_debit from fin_voucher",BigDecimal.class)).isEqualByComparingTo("50");assertThat(owner.queryForObject("select count(DISTINCT mapping_template_id) from fin_event_result",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("select open_amount from ar_receivable where id=1702",BigDecimal.class)).isEqualByComparingTo("20");
    }

    @Test void zeroPostingFinalWriteFailureRollsBackInterpretationIntentAndAudit()throws Exception{
        long event=ownerZeroEvent(Map.of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ZERO),1,Map.of());approved("PAYABLE_PRECISION_CONFIRMED","VOUCHER");String intent=key();int audits=owner.queryForObject("select count(*) from sys_audit_log",Integer.class);
        owner.execute("create function test_fail_zero_fin_result() returns trigger language plpgsql as $$ begin raise exception 'private zero source must never persist'; end $$");owner.execute("create trigger test_fail_zero_fin_result after insert on fin_event_result for each row execute function test_fail_zero_fin_result()");
        try{assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),intent).get("code").asString()).isEqualTo("CONSUMER_FAILED");assertThat(owner.queryForObject("select count(*) from fin_event_result",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from sys_idempotency where key=?",Integer.class,intent)).isZero();assertThat(owner.queryForObject("select count(*) from sys_audit_log",Integer.class)).isEqualTo(audits);assertThat(owner.queryForObject("select last_error from sys_biz_event_consume where event_id=?",String.class,event)).isEqualTo("CONSUMER_FAILED");}
        finally{owner.execute("drop trigger test_fail_zero_fin_result on fin_event_result");owner.execute("drop function test_fail_zero_fin_result()");}
        assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),intent).get("code").asString()).isEqualTo("OK");
    }

    @Test void existingInterpretationKeepsItsFrozenResultWhenANewOwnerBasisGateWouldRejectGeneration()throws Exception{
        long event=ownerZeroEvent(Map.of("accountingImpact","SOURCE_CONFIRMATION","amount",BigDecimal.ZERO),1,Map.of());approved("PAYABLE_PRECISION_CONFIRMED","VOUCHER");
        assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).isEqualTo("OK");var result=owner.queryForMap("SELECT * FROM fin_event_result WHERE event_id=?",event);int calls=probe.interpretations;
        probe.rejectNewBasis=true;assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).isEqualTo("OK");assertThat(probe.interpretations).isEqualTo(calls);assertThat(owner.queryForMap("SELECT * FROM fin_event_result WHERE event_id=?",event)).isEqualTo(result);
        seed("UPDATE sys_role SET permissions='[]' WHERE country_id=101");assertThat(send("POST","/fin/events/"+event+"/generate",Map.of(),key()).get("code").asString()).isNotEqualTo("OK");
    }

    @Test void reconciliationNeverMixesASourceCommittedHalfwayThroughItsSnapshot()throws Exception{
        probe.enabled=true;var pool=Executors.newSingleThreadExecutor();try{
            var reconciliation=pool.submit(()->send("GET","/fin/reconcile?bookId=601&periodId=701&type=ALL",null,null));
            assertThat(probe.reached.await(10,TimeUnit.SECONDS)).isTrue();receipt();probe.release.countDown();
            var result=reconciliation.get(20,TimeUnit.SECONDS);assertThat(result.get("code").asString()).isEqualTo("OK");var cash=result.get("data").get(3);assertThat(cash.get("type").asString()).isEqualTo("CASH");assertThat(cash.get("businessAmount").decimalValue()).isZero();assertThat(cash.get("glAmount").decimalValue()).isZero();assertThat(cash.get("details").size()).isZero();assertThat(cash.get("ungenerated").size()).isZero();assertThat(owner.queryForObject("select count(*) from ar_receipt where status='CONFIRMED'",Integer.class)).isEqualTo(1);
        }finally{probe.enabled=false;probe.release.countDown();pool.shutdownNow();}
    }
    @TestConfiguration static class ProbeConfiguration {
        @Bean SnapshotProbe snapshotProbe(JdbcTemplate jdbc){return new SnapshotProbe(jdbc);}
    }
    /** Transaction observation and fixed precision contract fixture; no business rounding algorithm. */
    static class SnapshotProbe implements FinancialSourceProvider,Ordered {
        final JdbcTemplate jdbc;volatile boolean enabled,rejectNewBasis;volatile int interpretations;volatile Map<String,Object> precisionSummary=Map.of(),payablePayload=Map.of();volatile List<Map<String,Object>> precisionBalances=List.of();AtomicBoolean once=new AtomicBoolean();CountDownLatch reached=new CountDownLatch(1),release=new CountDownLatch(1);
        SnapshotProbe(JdbcTemplate jdbc){this.jdbc=jdbc;}
        void reset(){payablePayload=Map.of();precisionSummary=Map.of();precisionBalances=List.of();enabled=false;rejectNewBasis=false;interpretations=0;once=new AtomicBoolean();reached=new CountDownLatch(1);release=new CountDownLatch(1);}
        public int getOrder(){return Ordered.HIGHEST_PRECEDENCE;}
        public boolean supports(String type){return "PRECISION_PAYABLE".equals(type)&&!payablePayload.isEmpty();}
        public void beforeInterpretation(Access access,String eventType,String sourceType,long sourceId,long eventId){interpretations++;if(rejectNewBasis)throw new com.hs.jxc.common.api.ApiException(409,"CST_PAYABLE_BASIS_REQUIRED","new basis missing");}
        public Map<String,Object> accountingFact(Access access,String event,String type,long id,int seq,LocalDate date,Map<String,Object> frozen){if(!supports(type)||id!=9991)throw new AssertionError("Unknown fixed FIN contract fixture");return Map.of("bookId",601L,"sourceNo","PRECISION-CONTRACT","payload",payablePayload);}
        public List<Map<String,Object>> balances(Access access,long book,LocalDate asOf,String type){if(enabled&&once.compareAndSet(false,true)){jdbc.queryForObject("select 1",Integer.class);reached.countDown();try{if(!release.await(10,TimeUnit.SECONDS))throw new AssertionError("Snapshot writer did not finish");}catch(InterruptedException e){Thread.currentThread().interrupt();throw new RuntimeException(e);}}return "INVENTORY".equals(type)?precisionBalances:List.of();}
        public Map<String,Object> reconciliationPrecision(Access access,long book,LocalDate asOf,String type){return "INVENTORY".equals(type)?precisionSummary:Map.of();}
    }

}
