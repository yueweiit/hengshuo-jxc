package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.inv.api.InventoryApi;
import com.hs.jxc.common.context.RequestContext;
import java.math.BigDecimal;
import java.time.LocalDate;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
@org.springframework.boot.test.context.SpringBootTest(classes=InventoryIT.InventoryTestApplication.class,webEnvironment=org.springframework.boot.test.context.SpringBootTest.WebEnvironment.RANDOM_PORT)
class CostSourcesIT extends BasePgIT {
 @Autowired InventoryApi inventory;
 final RequestContext actor=new RequestContext(201,101L,"cost-test",null);final LocalDate date=LocalDate.of(2026,10,15);
 @BeforeEach void fixture(){InventoryIT.seedBase();}
 InventoryApi.Inbound receipt(long line,String qty,String price,String currency){return new InventoryApi.Inbound(601,401,501,new BigDecimal(qty),BigDecimal.ZERO,BigDecimal.ZERO,new InventoryApi.Source("LGS_RECEIPT",801,line,"RCV"),date,1001L,2001L,new InventoryApi.PurchaseCost(2000,2001,currency,new BigDecimal(price),new BigDecimal(price).multiply(new BigDecimal(qty)),new BigDecimal(qty)));}
 @Test void movingAverageDoesNotDriftAfterFifoPhysicalConsumption(){
  seed("UPDATE cst_method_config SET method='MOVING_AVG'");inCountry(101,()->inventory.inbound(actor,receipt(901,"2","10","MXN")));inCountry(101,()->inventory.inbound(actor,receipt(902,"2","30","MXN")));
  inCountry(101,()->inventory.outbound(actor,new InventoryApi.Outbound(601,401,501,null,new BigDecimal("3"),null,new InventoryApi.Source("SAL_OUTBOUND",803,903,"FIRST"),date)));
  inCountry(101,()->inventory.outbound(actor,new InventoryApi.Outbound(601,401,501,null,BigDecimal.ONE,null,new InventoryApi.Source("SAL_OUTBOUND",804,904,"SECOND"),date)));
  assertThat(owner.queryForObject("SELECT amount FROM cst_cogs WHERE source_line_id=904",BigDecimal.class)).isEqualByComparingTo("20");
 }
 @Test void fullBatchOutboundPreservesFrozenSourceAmountWithoutUnitPriceRoundingLoss(){
  var input=new InventoryApi.Inbound(601,401,501,new BigDecimal("3"),BigDecimal.ZERO,BigDecimal.ZERO,new InventoryApi.Source("LGS_RECEIPT",801,901,"RCV"),date,null,2001L,new InventoryApi.PurchaseCost(2000,2001,"MXN",new BigDecimal("0.3333"),BigDecimal.ONE,new BigDecimal("3"),"PCS",BigDecimal.ONE));inCountry(101,()->inventory.inbound(actor,input));
  inCountry(101,()->inventory.outbound(actor,new InventoryApi.Outbound(601,401,501,null,new BigDecimal("3"),null,new InventoryApi.Source("SAL_OUTBOUND",803,903,"FULL"),date)));
  assertThat(owner.queryForObject("SELECT amount FROM cst_cogs",BigDecimal.class)).isEqualByComparingTo("1");
 }
 @Test void partialReturnsAbsorbOriginalCogsRoundingTail(){
  seed("INSERT INTO cst_cogs(country_id,book_id,warehouse_id,product_id,source_type,source_line_id,qty,amount,unit_cost,method,method_version,status,biz_date) VALUES(101,601,401,501,'SAL_OUTBOUND',3001,3,1,0.3333,'FIFO',1,'ESTIMATED','2026-10-15')");
  for(long line=901;line<=903;line++){long source=line;inCountry(101,()->inventory.returnIn(actor,new InventoryApi.ReturnInbound(601,401,501,BigDecimal.ONE,BigDecimal.ZERO,BigDecimal.ZERO,new InventoryApi.Source("RTN_SALES",800,source,"RETURN"),date,3001L,null,null,"original")));}
  assertThat(owner.queryForObject("SELECT sum(amount) FROM cst_cogs WHERE source_type='RTN_SALES'",BigDecimal.class)).isEqualByComparingTo("-1");
 }
 @Test void transferCarriesFrozenMovingAverageValueToDestination(){
  seed("UPDATE cst_method_config SET method='MOVING_AVG'");inCountry(101,()->inventory.inbound(actor,receipt(901,"2","10","MXN")));inCountry(101,()->inventory.inbound(actor,receipt(902,"2","30","MXN")));
  inCountry(101,()->inventory.outbound(actor,new InventoryApi.Outbound(601,401,501,null,new BigDecimal("3"),null,new InventoryApi.Source("SAL_OUTBOUND",803,903,"FIRST"),date)));
  var source=new InventoryApi.Source("INV_TRANSFER",804,904,"TRANSFER");var moved=inCountry(101,()->inventory.transferOut(actor,new InventoryApi.Outbound(601,401,501,null,BigDecimal.ONE,null,source,date)));inCountry(101,()->{inventory.transferIn(actor,601,402,501,source,moved.parts(),date);return null;});
  inCountry(101,()->inventory.outbound(actor,new InventoryApi.Outbound(601,402,501,null,BigDecimal.ONE,null,new InventoryApi.Source("SAL_OUTBOUND",805,905,"SECOND"),date)));
  assertThat(owner.queryForObject("SELECT amount FROM cst_cogs WHERE source_line_id=905",BigDecimal.class)).isEqualByComparingTo("20");
 }
 @Test void poolCompositionAllocatesRoundingCumulativelyWithoutNegativeLastPart(){
  seed("UPDATE cst_method_config SET method='MOVING_AVG'");for(long x=901;x<907;x++){long line=x;String price=x<905?"0":"0.0002";inCountry(101,()->inventory.inbound(actor,receipt(line,"1",price,"MXN")));}inCountry(101,()->inventory.outbound(actor,new InventoryApi.Outbound(601,401,501,null,BigDecimal.ONE,null,new InventoryApi.Source("SAL_OUTBOUND",803,910,"ONE"),date)));
  assertThat(owner.queryForObject("SELECT min(valued_amount) FROM cst_cogs_part WHERE part_type='VALUATION_POOL'",BigDecimal.class)).isNotNegative();assertThat(owner.queryForObject("SELECT sum(valued_amount) FROM cst_cogs_part WHERE part_type='VALUATION_POOL'",BigDecimal.class)).isEqualByComparingTo("0.0004");
 }
 @Test void splitReceiptsAbsorbTheOriginalPurchaseCurrencyRoundingTail() throws Exception {
  var pool=java.util.concurrent.Executors.newFixedThreadPool(3);var start=new java.util.concurrent.CountDownLatch(1);try{var futures=new java.util.ArrayList<java.util.concurrent.Future<?>>();for(long line=901;line<=903;line++){long source=line;long warehouse=line==902?402:401;futures.add(pool.submit(()->{start.await();inCountry(101,()->inventory.inbound(actor,new InventoryApi.Inbound(601,warehouse,501,BigDecimal.ONE,BigDecimal.ZERO,BigDecimal.ZERO,new InventoryApi.Source("LGS_RECEIPT",801,source,"PART"),date,null,2001L,new InventoryApi.PurchaseCost(2000,2001,"MXN",BigDecimal.ONE,BigDecimal.ONE,new BigDecimal("3"),"BOX",new BigDecimal("3")))));return null;}));}start.countDown();for(var future:futures)future.get(15,java.util.concurrent.TimeUnit.SECONDS);}finally{pool.shutdownNow();}
  assertThat(owner.queryForObject("SELECT sum(src_amount) FROM cst_inbound_cost",BigDecimal.class)).isEqualByComparingTo("1");assertThat(owner.queryForObject("SELECT count(*) FROM cst_inbound_cost WHERE src_amount=0.3334",Integer.class)).isEqualTo(1);
 }
 @Test void purchaseCostUsesFrozenOriginalAmountAndBaseQuantityRatio(){
  var receipt=new InventoryApi.Inbound(601,401,501,BigDecimal.ONE,BigDecimal.ZERO,BigDecimal.ZERO,new InventoryApi.Source("LGS_RECEIPT",801,901,"RCV"),date,null,2001L,new InventoryApi.PurchaseCost(2000,2001,"MXN",new BigDecimal("24"),new BigDecimal("48"),new BigDecimal("48"),"BOX",new BigDecimal("24")));
  inCountry(101,()->inventory.inbound(actor,receipt));assertThat(owner.queryForObject("SELECT src_unit_price FROM cst_inbound_cost",BigDecimal.class)).isEqualByComparingTo("24");assertThat(owner.queryForObject("SELECT src_amount FROM cst_inbound_cost",BigDecimal.class)).isEqualByComparingTo("1");assertThat(owner.queryForObject("SELECT unit_cost FROM cst_inbound_cost",BigDecimal.class)).isEqualByComparingTo("1");
 }
 @Test void methodMustExistBeforeAnyPhysicalWrite(){
  seed("DELETE FROM cst_method_config");assertThatThrownBy(()->inCountry(101,()->inventory.inbound(actor,receipt(901,"2","3","CNY")))).extracting("code").isEqualTo("CST_METHOD_REQUIRED");assertThat(owner.queryForObject("SELECT count(*) FROM inv_batch",Integer.class)).isZero();
 }
 @Test void missingRateIsPendingAndLaterRateCannotRewriteFrozenOriginalFacts(){
  inCountry(101,()->inventory.inbound(actor,receipt(901,"2","3","CNY")));
  var old=owner.queryForMap("SELECT src_amount,unit_cost,status FROM cst_inbound_cost");assertThat(old).containsEntry("status","PENDING_RATE").containsEntry("unit_cost",null);assertThat((BigDecimal)old.get("src_amount")).isEqualByComparingTo("6");
  seed("INSERT INTO md_exchange_rate(country_id,from_ccy,to_ccy,scope,rate_date,rate,status) VALUES(101,'CNY','MXN','PURCHASE_COST','2026-10-15',3,'CONFIRMED')");
  assertThat(owner.queryForMap("SELECT src_amount,unit_cost,status FROM cst_inbound_cost")).isEqualTo(old);
  inCountry(101,()->inventory.inbound(actor,receipt(902,"3","4","CNY")));
  seed("UPDATE md_exchange_rate SET rate=99 WHERE country_id=101");assertThat(owner.queryForObject("SELECT unit_cost FROM cst_inbound_cost WHERE source_line_id=902",BigDecimal.class)).isEqualByComparingTo("12");
 }
 @Test void movingAverageFreezesPoolBeforeConsumptionAndOneCogsForMultiBatch(){
  seed("UPDATE cst_method_config SET method='MOVING_AVG'");
  inCountry(101,()->inventory.inbound(actor,receipt(901,"2","10","MXN")));inCountry(101,()->inventory.inbound(actor,receipt(902,"2","30","MXN")));
  var out=new InventoryApi.Outbound(601,401,501,null,new BigDecimal("3"),null,new InventoryApi.Source("SAL_OUTBOUND",803,903,"OUT"),date);var movement=inCountry(101,()->inventory.outbound(actor,out));
  assertThat(movement.parts()).hasSize(2);assertThat(owner.queryForObject("SELECT count(*) FROM cst_cogs",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("SELECT amount FROM cst_cogs",BigDecimal.class)).isEqualByComparingTo("60");assertThat(owner.queryForObject("SELECT sum(qty) FROM cst_cogs_part WHERE part_type='VALUATION_POOL'",BigDecimal.class)).isEqualByComparingTo("4");assertThat(owner.queryForObject("SELECT pool_amount FROM cst_cogs",BigDecimal.class)).isEqualByComparingTo("80");assertThat(owner.queryForObject("SELECT amount FROM cst_valuation_pool",BigDecimal.class)).isEqualByComparingTo("20");assertThat(owner.queryForObject("SELECT sum(valued_amount) FROM cst_cogs_part WHERE part_type='VALUATION_POOL'",BigDecimal.class)).isEqualByComparingTo("80");
  inCountry(101,()->inventory.inbound(actor,receipt(904,"10","100","MXN")));assertThat(owner.queryForObject("SELECT amount FROM cst_cogs",BigDecimal.class)).isEqualByComparingTo("60");
 }
 @Test void returnedCostKeepsOriginalCogsAfterNewStock(){
  inCountry(101,()->inventory.inbound(actor,receipt(901,"5","10","MXN")));
  var out=new InventoryApi.Outbound(601,401,501,null,new BigDecimal("2"),null,new InventoryApi.Source("SAL_OUTBOUND",803,903,"OUT"),date);var original=inCountry(101,()->inventory.outbound(actor,out));
  inCountry(101,()->inventory.inbound(actor,receipt(904,"5","90","MXN")));
  inCountry(101,()->inventory.returnIn(actor,new InventoryApi.ReturnInbound(601,401,501,BigDecimal.ONE,BigDecimal.ZERO,BigDecimal.ZERO,new InventoryApi.Source("RTN_SALES",805,905,"RETURN"),date,903L,null,null,"original")));
  assertThat(owner.queryForObject("SELECT amount FROM cst_cogs WHERE source_type='RTN_SALES'",BigDecimal.class)).isEqualByComparingTo("-10");assertThat(owner.queryForObject("SELECT original_cogs_id FROM cst_cogs WHERE source_type='RTN_SALES'",Long.class)).isEqualTo(original.cogsId());
 }
 @Test void returnWithMissingOriginalCostStaysPendingAndNeverDefaultsToZero(){
  var input=new InventoryApi.ReturnInbound(601,401,501,BigDecimal.ONE,BigDecimal.ZERO,BigDecimal.ZERO,new InventoryApi.Source("RTN_SALES",900,901,"RETURN"),date,9999L,null,null,"source missing");
  inCountry(101,()->inventory.returnIn(actor,input));assertThat(owner.queryForMap("SELECT status,unit_cost,original_outbound_line_id FROM cst_inbound_cost")).containsEntry("status","PENDING_SOURCE_COST").containsEntry("unit_cost",null).containsEntry("original_outbound_line_id",9999L);
 }
}
