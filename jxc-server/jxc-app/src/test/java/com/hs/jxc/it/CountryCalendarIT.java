package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.inv.api.InventoryApi;
import com.hs.jxc.inv.service.*;
import com.hs.jxc.sal.SalesService;
import java.math.BigDecimal;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.*;

/** Same real instant, two configured country dates; original owner commands and PostgreSQL facts. */
@Import(CountryCalendarIT.TimeConfiguration.class)
class CountryCalendarIT extends BasePgIT {
 static class BusinessClock extends Clock {private volatile Instant now=Instant.parse("2026-10-01T01:30:00Z");void set(String value){now=Instant.parse(value);}public ZoneId getZone(){return ZoneOffset.UTC;}public Clock withZone(ZoneId zone){return Clock.fixed(now,zone);}public Instant instant(){return now;}}
 @TestConfiguration static class TimeConfiguration {@Bean BusinessClock countryBusinessClock(){return new BusinessClock();}}
 @Autowired com.hs.jxc.sys.service.CountryCalendar calendar;@Autowired com.hs.jxc.sys.service.AuthorizationService authorization;@Autowired SalesService sales;@Autowired ReplenishmentService replenish;@Autowired InventoryApi inventory;@Autowired InventoryClassification classification;@Autowired InventoryAnalysisWorker worker;
 @Autowired com.hs.jxc.common.api.JsonCodec json;@Autowired BusinessClock clock;@Value("${local.server.port}")int port;
 static final String TOKEN="country-calendar-native";static final String HASH=com.hs.jxc.common.api.Digests.sha256(TOKEN);
 RequestContext actor(long country){return new RequestContext(201,country,"calendar-it",HASH);}String key(){return UUID.randomUUID().toString();}long book(long country){return country==101?601:602;}long wh(long country){return country==101?401:403;}long store(long country){return country==101?311:312;}long customer(long country){return country==101?801:802;}
 @BeforeEach void fixture(){
  clock.set("2026-10-01T01:30:00Z");InventoryIT.seedBase();seed("INSERT INTO md_currency(code,name) VALUES('MXN','Peso'),('CNY','Yuan')");
  seed("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(102,'CN','China','CNY','Asia/Shanghai','ACTIVE')");
  seed("INSERT INTO sys_authz_epoch(country_id) VALUES(101),(102)");seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,201,clock_timestamp()+interval '1 hour')",HASH);
  seed("INSERT INTO org_entity(id,country_id,code,name) VALUES(302,102,'CN-E','China entity')");seed("INSERT INTO org_store(id,country_id,entity_id,code,name) VALUES(311,101,301,'S','Mexico store'),(312,102,302,'S','China store')");seed("UPDATE org_warehouse SET store_id=311 WHERE id=401");seed("INSERT INTO org_warehouse(id,country_id,entity_id,store_id,code,name) VALUES(403,102,302,312,'W','China warehouse')");
  seed("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(602,102,302,'CN-B','China book','CNY','ACTIVE')");seed("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(101,601,2026,9,'2026-09-01','2026-09-30','OPEN'),(102,602,2026,9,'2026-09-01','2026-09-30','OPEN'),(102,602,2026,10,'2026-10-01','2026-10-31','OPEN')");
  seed("UPDATE cst_method_config SET effective_from='2026-09-01' WHERE country_id=101");seed("INSERT INTO cst_method_config(country_id,book_id,method,effective_from) VALUES(102,602,'FIFO','2026-09-01')");seed("INSERT INTO md_country_sku(country_id,product_id) VALUES(102,501)");
  for(long country:List.of(101L,102L)){long role=country+110;seed("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(?,?,'CALENDAR','Calendar','[\"*\"]','{\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"COST\":\"WRITE\",\"CREDIT\":\"WRITE\"}')",role,country);seed("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(?,201,?)",country,role);seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(?,201,'COUNTRY_ALL',201)",country);seed("INSERT INTO md_customer(id,country_id,code,name) VALUES(?,?,'C','Customer')",customer(country),country);seed("INSERT INTO wf_doc_type_config(country_id,doc_type,approval_required,key_fields) VALUES(?,'SALES_ORDER',false,'[]')",country);
   String currency=country==101?"MXN":"CNY";seed("INSERT INTO sal_price(country_id,product_id,price_type,unit,min_qty,price,currency,effective_from,effective_to) VALUES(?,501,'BASE','PCS',1,10,?,'2026-09-01','2026-09-30'),(?,501,'BASE','PCS',1,20,?,'2026-10-01',null)",country,currency,country,currency);NumberFixtures.seed(country,"SALES_ORDER","REPLENISH");
   inCountry(country,()->inventory.inbound(actor(country),input(country,900+country,LocalDate.of(2026,9,15),100)));
  }
 }
 InventoryApi.Inbound input(long country,long line,LocalDate day,int qty){return new InventoryApi.Inbound(book(country),wh(country),501,BigDecimal.valueOf(qty),BigDecimal.ZERO,BigDecimal.ZERO,new InventoryApi.Source("LGS_RECEIPT",line,line,"CALENDAR"),day,null,null,null);}
 Map<String,Object> body(long country){return new LinkedHashMap<>(Map.of("bookId",book(country),"customerId",customer(country),"storeId",store(country),"paymentType","CASH","lines",List.of(Map.of("productId",501,"unit","PCS","qty",1,"warehouseId",wh(country)))));}
 @ParameterizedTest @CsvSource({"101,2026-09-30","102,2026-10-01"}) void explicitOffsetsForTheSameInstantShareTheCountryBusinessDay(long country,String expected){
  inCountry(country,()->{var a=authorization.authorize(actor(country));var dayMethod=org.junit.jupiter.api.Assertions.assertDoesNotThrow(()->com.hs.jxc.sys.service.CountryCalendar.class.getMethod("day",com.hs.jxc.sys.api.Access.class,OffsetDateTime.class),"Country calendar must own offset business-day conversion");
   for(String value:List.of("2026-10-01T01:30:00Z","2026-10-01T09:30:00+08:00","2026-09-30T19:30:00-06:00")){var date=org.junit.jupiter.api.Assertions.assertDoesNotThrow(()->(LocalDate)dayMethod.invoke(calendar,a,OffsetDateTime.parse(value)));assertThat(date).as(value).isEqualTo(LocalDate.parse(expected));}return null;});
 }
 @org.junit.jupiter.api.Test void oneTransactionKeepsOneInstantAcrossLocalMidnightAndNextTransactionRefreshes(){
  clock.set("2026-10-01T05:59:59Z");inCountry(101,()->{replenish.create(actor(101),Map.of("warehouseId",401,"productId",501,"reqQty",1),key());clock.set("2026-10-01T06:00:01Z");replenish.create(actor(101),Map.of("warehouseId",401,"productId",501,"reqQty",1),key());return null;});
  assertThat(owner.queryForList("SELECT doc_no FROM inv_replenish ORDER BY id",String.class)).hasSize(2).allMatch(number->number.contains("20260930"));
  replenish.create(actor(101),Map.of("warehouseId",401,"productId",501,"reqQty",1),key());assertThat(owner.queryForObject("SELECT doc_no FROM inv_replenish ORDER BY id DESC LIMIT 1",String.class)).contains("20261001");
 }
 @ParameterizedTest @CsvSource({"101,2026-09-30","102,2026-10-01"}) void replenishmentNumberUsesConfiguredLocalDay(long country,String day){
  replenish.create(actor(country),Map.of("warehouseId",wh(country),"productId",501,"reqQty",1),key());assertThat(owner.queryForObject("SELECT doc_no FROM inv_replenish WHERE country_id=?",String.class,country)).contains(day.replace("-",""));
 }
 @ParameterizedTest @CsvSource({"101,2026-09-30,10","102,2026-10-01,20"}) void defaultOrderAndPriceResolveUseTheSameCountryDay(long country,String day,int price){
  var order=sales.create(actor(country),body(country),key());var resolved=(Map<?,?>)sales.resolvePrice(actor(country),Map.of("customerId",String.valueOf(customer(country)),"productId","501","unit","PCS","qty","1"));
  org.assertj.core.api.SoftAssertions softly=new org.assertj.core.api.SoftAssertions();softly.assertThat(order.get("orderDate").toString()).isEqualTo(day);softly.assertThat(order.get("docNo").toString()).contains(day.replace("-",""));softly.assertThat(new BigDecimal(resolved.get("price").toString())).isEqualByComparingTo(String.valueOf(price));softly.assertAll();
 }
 @ParameterizedTest @CsvSource({"101,2026-09-30","102,2026-10-01"}) void originalStoreDailyEndpointDefaultsAfterAuthorizationToLocalDay(long country,String day)throws Exception{
  var requestBody=body(country);requestBody.put("orderDate",day);sales.create(actor(country),requestBody,key());
  var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+port+"/api/v1/sal/store-daily?storeId="+store(country))).header("Authorization","Bearer "+TOKEN).header("X-Country-Id",String.valueOf(country)).GET().build();var response=java.net.http.HttpClient.newHttpClient().send(request,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);var result=(Map<?,?>)json.readMap(response.body()).get("data");assertThat(result.get("date")).isEqualTo(day);assertThat(((Number)result.get("orderCount")).longValue()).isEqualTo(1);
 }
 @ParameterizedTest @CsvSource({"101,2026-09-30","102,2026-10-01"}) void reservationReleaseKeepsExplicitCommandDayAndDefaultCancellationLocalDay(long country,String day){
  LocalDate current=LocalDate.parse(day),explicit=current.minusDays(1);var b=body(country);b.put("orderDate",current.minusDays(2).toString());var order=sales.create(actor(country),b,key());long id=((Number)order.get("id")).longValue();order=sales.submit(actor(country),id,Map.of("bizDate",explicit.toString()),key());
  sales.update(actor(country),id,Map.of("version",order.get("version"),"bizDate",explicit.toString(),"lines",List.of(Map.of("id",((List<Map<String,Object>>)order.get("lines")).getFirst().get("id"),"productId",501,"unit","PCS","qty",2,"warehouseId",wh(country)))));
  long alloc=owner.queryForObject("SELECT id FROM sal_order_alloc WHERE order_id=?",Long.class,id);assertThat(owner.queryForObject("SELECT biz_date FROM sys_biz_event WHERE country_id=? AND source_type='INV_RESERVATION' AND source_id=? ORDER BY event_seq DESC LIMIT 1",java.sql.Date.class,country,alloc).toLocalDate()).isEqualTo(explicit);
  var other=body(country);other.put("orderDate",day);var next=sales.create(actor(country),other,key());long second=((Number)next.get("id")).longValue();sales.submit(actor(country),second,Map.of("bizDate",day),key());sales.cancel(actor(country),second,Map.of("reason","Local cancellation"),key(),true);assertThat(owner.queryForObject("SELECT biz_date FROM sys_biz_event WHERE country_id=? AND source_type='SALES_ORDER' AND source_id=? AND event_type='SAL_ORDER_QTY_CHANGED' ORDER BY event_seq DESC LIMIT 1",java.sql.Date.class,country,second).toLocalDate()).isEqualTo(current);
 }
 @ParameterizedTest @CsvSource({"101,2026-09-30","102,2026-10-01"}) void dailyClassificationKeyAndWindowShareTheCountryCalendar(long country,String day){
  var condition=Map.of("label","HOT_CANDIDATE","priority",1,"stockOp","GTE","stockValue",0,"orderOp","GTE","orderValue",0);classification.save(actor(country),null,Map.of("name","Local calendar","dimType","WAREHOUSE","periodType","CALENDAR_MONTH","conditions",List.of(condition)));inCountry(country,()->inventory.inbound(actor(country),input(country,2000+country,LocalDate.parse(day),1)));worker.daily(country);
  assertThat(owner.queryForList("SELECT trigger_ref FROM inv_classify_result_log WHERE country_id=? AND trigger='DAILY'",String.class,country)).isNotEmpty().allMatch(day::equals);assertThat(owner.queryForList("SELECT period_end FROM inv_classify_result WHERE country_id=?",java.sql.Date.class,country)).allMatch(d->d.toLocalDate().equals(LocalDate.parse(day)));
 }
}
