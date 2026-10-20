package com.hs.jxc.it;
import com.hs.jxc.ar.ReceivablesService;import com.hs.jxc.common.context.RequestContext;import com.hs.jxc.common.api.ApiException;import com.hs.jxc.sys.service.*;import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;import java.time.LocalDate;import java.util.*;import java.util.concurrent.*;import java.util.function.Supplier;
import org.junit.jupiter.api.*;import org.springframework.beans.factory.annotation.Autowired;import static org.assertj.core.api.Assertions.*;
class ReceivablesIT extends BasePgIT {
 @Autowired ReceivablesService ar;@Autowired AuthorizationService auth;
 static final String HASH=SessionService.digest("ar-fixture");final LocalDate day=LocalDate.of(2026,10,15);
 RequestContext c(){return new RequestContext(201,101L,"ar-it",HASH);}String key(){return UUID.randomUUID().toString();}long id(Map<String,Object>r){return ((Number)r.get("id")).longValue();}
 <T>T authorized(java.util.function.Function<Access,T> f){return tx.execute(s->f.apply(auth.authorize(c())));}
 @BeforeEach void data(){resetFixtures();
 seed("insert into md_currency(code,name) values('MXN','Peso')");seed("insert into sys_country(id,code,name,default_currency,timezone,status) values(101,'MX','Mexico','MXN','America/Mexico_City','ACTIVE')");seed("insert into sys_authz_epoch(country_id) values(101)");NumberFixtures.seed(101,"PURCHASE_ORDER","DOMESTIC_RECEIPT","EXPORT_NODE","SHIPMENT","HOLD","DELIVERY","LGS_RECEIPT","LGS_FEE","TRANSSHIP","DISCREPANCY","SALES_ORDER","SAL_OUTBOUND","AR_RECEIVABLE","AR_RECEIPT","AR_WRITEOFF","AR_CREDIT_NOTE","RTN_SALES","RTN_NO_ORIGIN","RTN_REFUND","RTN_PURCHASE","RTN_CLAIM");seed("insert into sys_user(id,username,password_hash,display_name) values(201,'ar','unused','AR')");seed("insert into sys_session(token_hash,user_id,expires_at) values(?,201,clock_timestamp()+interval '1 hour')",HASH);
 seed("insert into sys_role(id,country_id,code,name,permissions,field_policies) values(202,101,'AR','AR','[\"*\"]','{\"COST\":\"WRITE\",\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"BANK_INFO\":\"WRITE\",\"CREDIT\":\"WRITE\",\"PROFIT\":\"WRITE\"}')");seed("insert into sys_user_role(country_id,user_id,role_id) values(101,201,202)");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(101,201,'COUNTRY_ALL',201)");
 seed("insert into org_entity(id,country_id,code,name) values(301,101,'E','Entity')");seed("insert into org_store(id,country_id,entity_id,code,name) values(302,101,301,'S','Store')");seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(601,101,301,'B','Book','MXN','ACTIVE')");seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(701,101,601,2026,10,'2026-10-01','2026-10-31','OPEN'),(702,101,601,2026,11,'2026-11-01','2026-11-30','OPEN')");
 seed("insert into md_customer(id,country_id,code,name,store_id) values(801,101,'C','Customer',302)");
 seed("insert into md_fund_account(id,country_id,entity_id,book_id,store_id,name,account_type,currency) values(901,101,301,601,302,'Cash','CASH','MXN')");
 for(int i=0;i<2;i++)seed("insert into sal_order(id,country_id,book_id,entity_id,store_id,customer_id,doc_no,order_date,currency,payment_type,entered_by,total_amount) values(?,101,601,301,302,801,?,'2026-10-15','MXN','CREDIT',201,100)",1001+i,"SO"+i);
 seed("insert into ar_credit_rule(country_id,target_type,target_id,payment_mode,credit_limit,currency,effective_from) values(101,'CUSTOMER',801,'CREDIT_ALLOWED',100,'MXN','2026-01-01')");
 }
 Map<String,Object> receipt(int amount){return ar.createReceipt(c(),Map.of("bookId",601,"customerId",801,"fundAccountId",901,"method","CASH","amount",amount,"bizTime","2026-10-15T12:00:00Z"),key());}
 long receivable(long order,int amount){return seedReturning("insert into ar_receivable(country_id,book_id,customer_id,order_id,source_type,source_id,doc_no,currency,amount,open_amount,biz_date,due_date) values(101,601,801,?,'TEST',?,?, 'MXN',?,?,'2026-10-15','2026-11-15') returning id",order,order,"AR"+order,amount,amount);}
 long seedReturning(String sql,Object...args){return owner.queryForObject(sql,Long.class,args);}
 Map<String,Object> allocation(long receipt,long target,int amount){return Map.of("customerId",801,"bookId",601,"bizDate","2026-10-15","lines",List.of(Map.of("fromType","RECEIPT","fromId",receipt,"receivableId",target,"amount",amount)));}
 @Test void concurrentOrdersCannotOverbookOneCustomerAcrossRequests()throws Exception{
  int success=compete(()->authorized(a->{ar.reserveOrder(a,601,801,"MXN",1001,new BigDecimal("80"));return true;}),()->authorized(a->{ar.reserveOrder(a,601,801,"MXN",1002,new BigDecimal("80"));return true;}));assertThat(success).isEqualTo(1);
  assertThat(owner.queryForObject("select sum(amount-released_amount) from ar_credit_occupation",BigDecimal.class)).isEqualByComparingTo("80");
 }
 @Test void confirmationIsIdempotentAndOutboxFailureRollsBackThenSameKeyRetries(){
  var r=receipt(100);String key=key();owner.execute("create function test_reject_ar_event() returns trigger language plpgsql as $$ begin if NEW.event_type='AR_RECEIPT_CONFIRMED' then raise exception 'injected AR event failure'; end if; return NEW; end $$");owner.execute("create trigger test_reject_ar_event before insert on sys_biz_event for each row execute function test_reject_ar_event()");
  try{assertThatThrownBy(()->ar.receiptAction(c(),id(r),"confirm",Map.of("arrivalDate","2026-10-15"),key)).isInstanceOf(RuntimeException.class);assertThat(owner.queryForObject("select status from ar_receipt",String.class)).isEqualTo("PENDING_CONFIRM");assertThat(owner.queryForObject("select count(*) from sys_idempotency where key=?",Integer.class,key)).isZero();}finally{owner.execute("drop trigger test_reject_ar_event on sys_biz_event");owner.execute("drop function test_reject_ar_event()");}
  ar.receiptAction(c(),id(r),"confirm",Map.of("arrivalDate","2026-10-15"),key);ar.receiptAction(c(),id(r),"confirm",Map.of("arrivalDate","2026-10-15"),key);
  assertThat(owner.queryForObject("select count(*) from sys_biz_event where event_type='AR_RECEIPT_CONFIRMED'",Integer.class)).isEqualTo(1);
  assertThatThrownBy(()->ar.receiptAction(c(),id(r),"confirm",Map.of("arrivalDate","2026-11-01"),key)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SYS_IDEMPOTENCY_CONFLICT");
 }
 @Test void concurrentWriteoffsNeverSpendReceiptTwiceAndReverseAppendsOriginalFacts()throws Exception{
  long r=id(receipt(100));ar.receiptAction(c(),r,"confirm",Map.of("arrivalDate","2026-10-15"),key());long a=receivable(1001,100),b=receivable(1002,100);
  assertThat(compete(()->ar.writeoff(c(),allocation(r,a,80),key()),()->ar.writeoff(c(),allocation(r,b,80),key()))).isEqualTo(1);
  long original=owner.queryForObject("select id from ar_writeoff",Long.class);seed("update fin_period set status='CLOSED' where id=701");
  var reverse=ar.reverse(c(),original,Map.of("bizDate","2026-11-02","reason","客户更正"),key());
  assertThat(owner.queryForObject("select written_off_amount from ar_receipt",BigDecimal.class)).isEqualByComparingTo("0");assertThat(owner.queryForObject("select sum(amount) from ar_writeoff_line",BigDecimal.class)).isEqualByComparingTo("0");assertThat(owner.queryForObject("select amount from ar_writeoff_line where writeoff_id=?",BigDecimal.class,id(reverse))).isEqualByComparingTo("-80");
 }
 @Test void overallocatedMultiLineWriteoffRollsBackEverySourceAndTarget(){
  long r=id(receipt(100));ar.receiptAction(c(),r,"confirm",Map.of("arrivalDate","2026-10-15"),key());long a=receivable(1001,100),b=receivable(1002,100);
  var lines=List.of(Map.of("fromType","RECEIPT","fromId",r,"receivableId",a,"amount",60),Map.of("fromType","RECEIPT","fromId",r,"receivableId",b,"amount",60));String key=key();
  assertThatThrownBy(()->ar.writeoff(c(),Map.of("customerId",801,"bookId",601,"bizDate","2026-10-15","lines",lines),key)).isInstanceOf(ApiException.class);
  assertThat(owner.queryForObject("select count(*) from ar_writeoff",Integer.class)).isZero();assertThat(owner.queryForObject("select sum(written_off_amount) from ar_receivable",BigDecimal.class)).isEqualByComparingTo("0");assertThat(owner.queryForObject("select count(*) from sys_idempotency where key=?",Integer.class,key)).isZero();
 }
 @Test void returnSettlementOffsetsOpenReceivableThenReservesRefundWithoutOverspend()throws Exception{
  receivable(1001,40);var s=authorized(a->ar.settleSalesReturn(a,601,1101,1001,801,"MXN",new BigDecimal("100"),day));assertThat(s.offsetAmount()).isEqualByComparingTo("40");assertThat(s.refundableAmount()).isEqualByComparingTo("60");assertThat((BigDecimal)authorized(a->ar.paymentForOrder(a,601,1001))).as("native return credit offsets are not receipt payments").isZero();
  long note=owner.queryForObject("select id from ar_credit_note where purpose='REFUND'",Long.class);
  assertThat(compete(()->authorized(a->{ar.reserveRefund(a,601,801,"MXN",note,1201,new BigDecimal("50"),day);return true;}),()->authorized(a->{ar.reserveRefund(a,601,801,"MXN",note,1202,new BigDecimal("50"),day);return true;}))).isEqualTo(1);
  assertThatThrownBy(()->authorized(a->{ar.reverseSalesReturn(a,601,1101,day);return true;})).isInstanceOf(ApiException.class);
  assertThat(owner.queryForObject("select reserved_amount from ar_credit_note where id=?",BigDecimal.class,note)).isEqualByComparingTo("50");
 }
 @Test void closedPeriodConfirmationIsRejectedAndSqlCannotCreateClosedDateFacts(){
  var r=receipt(100);seed("update fin_period set status='CLOSED' where id=701");assertThatThrownBy(()->ar.receiptAction(c(),id(r),"confirm",Map.of("arrivalDate","2026-10-15"),key())).isInstanceOf(ApiException.class);
  assertThatThrownBy(()->inCountry(101,()->jdbc.update("insert into ar_credit_note(country_id,book_id,customer_id,source_type,source_id,purpose,doc_no,currency,amount,refundable_flag,biz_date) values(101,601,801,'TEST',1301,'REFUND','CN','MXN',10,true,'2026-10-15')"))).isInstanceOf(RuntimeException.class);
 }
 @Test void customerCreditGateIsSharedAcrossBooks()throws Exception{
  seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,301,'B2','Second book','MXN','ACTIVE')");seed("insert into fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(101,602,2026,10,'2026-10-01','2026-10-31','OPEN')");seed("update sal_order set book_id=602 where id=1002");
  assertThat(compete(()->authorized(a->{ar.reserveOrder(a,601,801,"MXN",1001,new BigDecimal("80"));return true;}),()->authorized(a->{ar.reserveOrder(a,602,801,"MXN",1002,new BigDecimal("80"));return true;}))).isEqualTo(1);
  assertThat(owner.queryForObject("select count(*) from ar_customer_currency",Integer.class)).isEqualTo(1);
 }
 @Test void changingOrderCustomerCannotReuseOldCustomersConfirmedPrepayment(){
  var r=ar.createReceipt(c(),Map.of("customerId",801,"fundAccountId",901,"method","CASH","amount",100,"bizTime","2026-10-15T12:00:00Z","orders",List.of(Map.of("orderId",1001,"plannedAmount",100))),key());ar.receiptAction(c(),id(r),"confirm",Map.of("arrivalDate","2026-10-15"),key());
  assertThat((Boolean)authorized(a->ar.cashCovered(a,601,801,1001,new BigDecimal("100")))).isTrue();seed("insert into md_customer(id,country_id,code,name,store_id) values(802,101,'C2','Other customer',302)");seed("update sal_order set customer_id=802 where id=1001");
  assertThat((Boolean)authorized(a->ar.cashCovered(a,601,802,1001,BigDecimal.ONE))).isFalse();assertThat((BigDecimal)authorized(a->ar.allocated(a,601,1001))).isEqualByComparingTo("0");assertThat((BigDecimal)authorized(a->ar.paymentForOrder(a,601,1001))).as("the new payment display cannot reuse another current customer's receipt").isZero();assertThat((BigDecimal)authorized(a->ar.paymentForOrder(a,602,1001))).isZero();
 }
 @Test void statementUsesFrozenWriteoffReversalFactsAndPreservesArrayContract(){
  long r=id(receipt(100));ar.receiptAction(c(),r,"confirm",Map.of("arrivalDate","2026-10-15"),key());long target=receivable(1001,100);var written=ar.writeoff(c(),allocation(r,target,60),key());long original=((Number)((Map<?,?>)((List<?>)written.get("records")).getFirst()).get("id")).longValue();ar.reverse(c(),original,Map.of("bizDate","2026-11-02","reason","correction"),key());
  var statement=ar.statement(c(),Map.of("bookId",601,"customerId",801,"periodStart","2026-10-01","periodEnd","2026-11-30"),key());assertThat(new BigDecimal(statement.get("closing").toString())).isEqualByComparingTo("100");assertThat(statement.get("details")).isInstanceOf(List.class);assertThat(ar.customerView(c(),801,"timeline",Map.of())).isInstanceOf(List.class);
 }
 @Test void refundApiRejectsPrecisionBeforeSqlAndDuplicateReturnMustKeepSourceIdentity(){
  var settled=authorized(a->ar.settleNoOriginReturn(a,601,1101,801,"MXN",new BigDecimal("100"),day));long note=settled.creditNoteIds().getFirst();
  assertThatThrownBy(()->authorized(a->{ar.reserveRefund(a,601,801,"MXN",note,1201,new BigDecimal("1.00001"),day);return true;})).isInstanceOf(ApiException.class);assertThat(owner.queryForObject("select reserved_amount from ar_credit_note",BigDecimal.class)).isEqualByComparingTo("0");
  assertThatThrownBy(()->authorized(a->ar.settleSalesReturn(a,601,1101,1001,801,"MXN",new BigDecimal("100"),day))).isInstanceOf(ApiException.class);
 }
 int compete(Callable<?> one,Callable<?> two)throws Exception{var pool=Executors.newFixedThreadPool(2);var start=new CountDownLatch(1);try{var fs=List.of(pool.submit(()->{start.await();return one.call();}),pool.submit(()->{start.await();return two.call();}));start.countDown();int n=0;for(var f:fs)try{f.get(20,TimeUnit.SECONDS);n++;}catch(ExecutionException e){if(!(e.getCause() instanceof ApiException))throw e;}return n;}finally{pool.shutdownNow();}}
}
