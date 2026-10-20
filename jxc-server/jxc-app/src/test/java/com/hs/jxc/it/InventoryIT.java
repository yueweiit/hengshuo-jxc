package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.inv.api.InventoryApi;
import com.hs.jxc.common.context.RequestContext;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
@org.springframework.boot.test.context.SpringBootTest(classes=InventoryIT.InventoryTestApplication.class,webEnvironment=org.springframework.boot.test.context.SpringBootTest.WebEnvironment.RANDOM_PORT)
class InventoryIT extends BasePgIT {
 @org.springframework.context.annotation.Configuration(proxyBeanMethods=false)
 @org.springframework.boot.autoconfigure.EnableAutoConfiguration
 @org.springframework.context.annotation.Import({com.hs.jxc.inv.service.InventoryService.class,com.hs.jxc.cst.service.CostService.class,com.hs.jxc.md.service.FxService.class,com.hs.jxc.md.service.MasterProductService.class,com.hs.jxc.fin.service.PeriodGuard.class,com.hs.jxc.sys.service.CountryLifecycle.class,com.hs.jxc.common.db.BookGate.class,com.hs.jxc.common.db.DbContext.class,com.hs.jxc.common.audit.AuditWriter.class,com.hs.jxc.common.event.OutboxPublisher.class,com.hs.jxc.common.api.JsonCodec.class,com.hs.jxc.sys.service.AuthorizationService.class})
 static class InventoryTestApplication {}

 @Autowired InventoryApi inventory;
 final RequestContext actor=new RequestContext(201,101L,"inventory-test",null);final LocalDate date=LocalDate.of(2026,10,15);
 @BeforeEach void fixture(){seedBase();}
 static void seedBase(){
  PgDatabase.reset();
  owner.update("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(101,'MX','Mexico','MXN','America/Mexico_City','ACTIVE')");
  owner.update("INSERT INTO sys_user(id,username,password_hash,display_name) VALUES(201,'inventory','hash','Inventory')");
  owner.update("INSERT INTO org_entity(id,country_id,code,name) VALUES(301,101,'E','Entity')");
  owner.update("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(601,101,301,'B','Book','MXN','ACTIVE')");
  owner.update("INSERT INTO fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(701,101,601,2026,10,'2026-10-01','2026-10-31','OPEN')");
  owner.update("INSERT INTO org_warehouse(id,country_id,entity_id,code,name,type) VALUES(401,101,301,'W','Warehouse','WAREHOUSE'),(402,101,301,'W2','Warehouse 2','WAREHOUSE')");
  owner.update("INSERT INTO md_product(id,product_code,name,base_unit) VALUES(501,'SKU','Product','PCS')");
  owner.update("INSERT INTO md_product_unit(product_id,unit,factor_to_base) VALUES(501,'PCS',1)");
  owner.update("INSERT INTO md_country_sku(country_id,product_id,status) VALUES(101,501,'ENABLED')");
  owner.update("INSERT INTO cst_method_config(country_id,book_id,method,effective_from) VALUES(101,601,'FIFO','2026-10-01')");
  NumberFixtures.seed(101,"CST_ADJUSTMENT","CST_EXPENSE","FIN_VOUCHER","TRANSFER","STOCKTAKE","REPLENISH","PURCHASE_ORDER","DOMESTIC_RECEIPT","EXPORT_NODE","SHIPMENT","HOLD","DELIVERY","LGS_RECEIPT","LGS_FEE","TRANSSHIP","DISCREPANCY","SALES_ORDER","SAL_OUTBOUND","AR_RECEIVABLE","AR_RECEIPT","AR_WRITEOFF","AR_CREDIT_NOTE","RTN_SALES","RTN_NO_ORIGIN","RTN_REFUND","RTN_PURCHASE","RTN_CLAIM");
 }
 InventoryApi.Inbound inbound(long line,String good,String damaged,String pending){return new InventoryApi.Inbound(601,401,501,new BigDecimal(good),new BigDecimal(damaged),new BigDecimal(pending),new InventoryApi.Source("LGS_RECEIPT",801,line,"RCV"),date,null,null,null);}
 @Test void releasedReservationRequiresNewApprovalVersionAndRetryDoesNotReReserve(){
  inCountry(101,()->inventory.inbound(actor,inbound(901,"5","0","0")));var first=new InventoryApi.Reservation(601,401,501,801,901,1001,new BigDecimal("3"),date,1);
  inCountry(101,()->{inventory.reserve(actor,first);inventory.release(actor,601,1001,new BigDecimal("3"),date);inventory.reserve(actor,first);return null;});assertThat(owner.queryForObject("SELECT reserved_qty FROM inv_stock_summary",BigDecimal.class)).isEqualByComparingTo("0");
  var revised=new InventoryApi.Reservation(601,401,501,801,901,1001,new BigDecimal("4"),date,2);inCountry(101,()->{inventory.reserve(actor,revised);inventory.reserve(actor,revised);return null;});assertThat(owner.queryForObject("SELECT reserved_qty FROM inv_stock_summary",BigDecimal.class)).isEqualByComparingTo("4");assertThat(owner.queryForObject("SELECT released_qty FROM inv_reservation",BigDecimal.class)).isEqualByComparingTo("3");
 }
 @Test void sameSourceCannotReplayAgainstAnotherWarehouse(){
  inCountry(101,()->inventory.inbound(actor,inbound(901,"5","0","0")));var source=new InventoryApi.Source("SAL_OUTBOUND",812,912,"OUT");inCountry(101,()->inventory.outbound(actor,new InventoryApi.Outbound(601,401,501,null,BigDecimal.ONE,null,source,date)));
  assertThatThrownBy(()->inCountry(101,()->inventory.outbound(actor,new InventoryApi.Outbound(601,402,501,null,BigDecimal.ONE,null,source,date)))).extracting("code").isEqualTo("INV_SOURCE_CONFLICT");
 }
 @Test void otherBookStockCannotFinanceConsumptionOfThisBookReservation(){
  seed("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(602,101,301,'B2','Book2','MXN','ACTIVE')");seed("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(101,602,2026,10,'2026-10-01','2026-10-31','OPEN')");seed("INSERT INTO cst_method_config(country_id,book_id,method,effective_from) VALUES(101,602,'FIFO','2026-10-01')");
  inCountry(101,()->inventory.inbound(actor,inbound(901,"5","0","0")));inCountry(101,()->inventory.inbound(actor,new InventoryApi.Inbound(602,401,501,new BigDecimal("5"),BigDecimal.ZERO,BigDecimal.ZERO,new InventoryApi.Source("LGS_RECEIPT",801,902,"RCV2"),date,null,null,null)));inCountry(101,()->{inventory.reserve(actor,new InventoryApi.Reservation(601,401,501,811,911,1001,new BigDecimal("5"),date));return null;});
  assertThatThrownBy(()->inCountry(101,()->inventory.outbound(actor,new InventoryApi.Outbound(601,401,501,null,BigDecimal.ONE,null,new InventoryApi.Source("SAL_OUTBOUND",812,912,"OUT"),date)))).extracting("code").isEqualTo("INV_INSUFFICIENT_AVAILABLE");assertThat(owner.queryForObject("SELECT on_hand_qty FROM inv_stock_summary",BigDecimal.class)).isEqualByComparingTo("10");
 }
 @Test void transferReceivesOriginalFifoAllocationAndOverReceiptRollsBack(){
  var batch=inCountry(101,()->inventory.inbound(actor,inbound(901,"5","0","0")));var source=new InventoryApi.Source("INV_TRANSFER",1001,1002,"TR");var shipped=inCountry(101,()->inventory.transferOut(actor,new InventoryApi.Outbound(601,401,501,null,new BigDecimal("4"),null,source,date)));assertThat(shipped.parts()).hasSize(1);
  inCountry(101,()->{inventory.transferIn(actor,601,402,501,source,List.of(new InventoryApi.Part(batch.id(),new BigDecimal("2"))),date);return null;});
  assertThatThrownBy(()->inCountry(101,()->{inventory.transferIn(actor,601,402,501,source,List.of(new InventoryApi.Part(batch.id(),new BigDecimal("3"))),date);return null;})).extracting("code").isEqualTo("INV_TRANSFER_EXCEEDS_SHIPPED");
  assertThat(owner.queryForObject("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=402",BigDecimal.class)).isEqualByComparingTo("2");assertThat(owner.queryForObject("SELECT count(*) FROM cst_cogs",Integer.class)).isZero();
  for(int part=0;part<2;part++)inCountry(101,()->{inventory.transferIn(actor,601,402,501,source,List.of(new InventoryApi.Part(batch.id(),BigDecimal.ONE)),date);return null;});
  assertThat(owner.queryForList("SELECT event_seq FROM sys_biz_event WHERE event_type='INV_STOCK_CHANGED' AND source_type='INV_TRANSFER' AND source_id=1002 ORDER BY event_seq",Integer.class)).containsExactly(1,2,3,4);
  assertThat(owner.queryForObject("SELECT on_hand_qty FROM inv_stock_summary WHERE warehouse_id=402",BigDecimal.class)).isEqualByComparingTo("4");
 }
 @Test void classifiedReceiptConservesBothLevelsAndBusinessRetry(){
  var i=inbound(901,"6","2","1");var batch=inCountry(101,()->inventory.inbound(actor,i));
  assertThat(inCountry(101,()->inventory.inbound(actor,i))).isEqualTo(batch);
  assertThat(owner.queryForMap("SELECT on_hand_qty,reserved_qty,frozen_qty FROM inv_stock_summary")).containsEntry("on_hand_qty",new BigDecimal("9.0000")).containsEntry("frozen_qty",new BigDecimal("3.0000"));
  assertThat(owner.queryForObject("SELECT sum(on_hand_qty) FROM inv_batch_balance",BigDecimal.class)).isEqualByComparingTo("9");
  assertThat(owner.queryForObject("SELECT count(*) FROM inv_freeze",Integer.class)).isEqualTo(2);
 }
 @Test void concurrentReserveNeverOversells() throws Exception {
  inCountry(101,()->inventory.inbound(actor,inbound(901,"5","0","0")));var pool=Executors.newFixedThreadPool(8);var start=new CountDownLatch(1);
  try{List<Future<Boolean>> results=new ArrayList<>();for(int j=0;j<8;j++){long alloc=1000+j;results.add(pool.submit(()->{start.await();try{inCountry(101,()->{inventory.reserve(actor,new InventoryApi.Reservation(601,401,501,801,901,alloc,BigDecimal.ONE,date));return null;});return true;}catch(com.hs.jxc.common.api.ApiException e){return false;}}));}start.countDown();int success=0;for(var f:results)if(f.get(15,TimeUnit.SECONDS))success++;assertThat(success).isEqualTo(5);assertThat(owner.queryForObject("SELECT reserved_qty FROM inv_stock_summary",BigDecimal.class)).isEqualByComparingTo("5");}finally{pool.shutdownNow();}
 }
 @Test void persistedCountLockRejectsNewReceiptAndRollbackHasNoFacts(){
  inCountry(101,()->{inventory.lockStocktake(actor,601,401,List.of(501L),1001,date);return null;});
  assertThatThrownBy(()->inCountry(101,()->inventory.inbound(actor,inbound(902,"2","0","0")))).extracting("code").isEqualTo("INV_STOCKTAKE_LOCKED");
  assertThat(owner.queryForObject("SELECT count(*) FROM inv_batch",Integer.class)).isZero();
  inCountry(101,()->{inventory.unlockStocktake(actor,401,1001);return null;});
  assertThatThrownBy(()->inCountry(101,()->{inventory.inbound(actor,inbound(902,"2","0","0"));throw new IllegalStateException("fail after inventory");})).isInstanceOf(IllegalStateException.class);
  assertThat(owner.queryForObject("SELECT count(*) FROM inv_batch",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM cst_inbound_cost",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM cst_valuation_pool",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM cst_valuation_movement",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM cst_batch_value",Integer.class)).isZero();
 }
 @Test void shipmentFifoConsumesReservationAndCapturesLineCost(){
  var b=inCountry(101,()->inventory.inbound(actor,inbound(901,"5","0","0")));
  inCountry(101,()->{inventory.reserve(actor,new InventoryApi.Reservation(601,401,501,811,911,1001,new BigDecimal("3"),date));return null;});
  var out=new InventoryApi.Outbound(601,401,501,1001L,new BigDecimal("3"),null,new InventoryApi.Source("SAL_OUTBOUND",812,912,"OUT"),date);
  var movement=inCountry(101,()->inventory.outbound(actor,out));assertThat(movement.parts()).containsExactly(new InventoryApi.Part(b.id(),new BigDecimal("3")));
  assertThat(inCountry(101,()->inventory.outbound(actor,out))).isEqualTo(movement);
  assertThat(owner.queryForObject("SELECT reserved_qty FROM inv_stock_summary",BigDecimal.class)).isEqualByComparingTo("0");assertThat(owner.queryForObject("SELECT on_hand_qty FROM inv_stock_summary",BigDecimal.class)).isEqualByComparingTo("2");
  assertThat(owner.queryForMap("SELECT status,amount FROM cst_cogs")).containsEntry("status","PENDING_SOURCE_COST").containsEntry("amount",null);
 }
}
