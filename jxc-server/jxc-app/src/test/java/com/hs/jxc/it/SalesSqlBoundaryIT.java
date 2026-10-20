package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import java.math.BigDecimal;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
class SalesSqlBoundaryIT extends BasePgIT {
 @BeforeEach void fixture(){InventoryIT.seedBase();seed("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(602,101,301,'B2','Other Book','MXN','ACTIVE')");seed("INSERT INTO fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(702,101,602,2026,10,'2026-10-01','2026-10-31','OPEN')");seed("INSERT INTO md_product(id,product_code,name,base_unit) VALUES(502,'OTHER','Other','PCS')");seed("INSERT INTO md_country_sku(country_id,product_id) VALUES(101,502)");seed("INSERT INTO md_customer(id,country_id,code,name) VALUES(901,101,'C','Customer')");new TransactionTemplate(new DataSourceTransactionManager(owner.getDataSource())).execute(s->{
 seed("INSERT INTO sal_order(id,country_id,book_id,entity_id,customer_id,doc_no,order_date,currency,payment_type,entered_by) VALUES(1001,101,601,301,901,'SO1','2026-10-15','MXN','CASH',201),(1002,101,602,301,901,'SO2','2026-10-15','MXN','CASH',201)");
 seed("INSERT INTO sal_order_line(id,country_id,book_id,order_id,product_id,line_no,unit,factor,qty,base_qty,price,price_source,line_amount) VALUES(1101,101,601,1001,501,1,'PCS',1,5,5,1,'MANUAL',5),(1102,101,602,1002,501,1,'PCS',1,5,5,1,'MANUAL',5)");
 seed("INSERT INTO sal_order_alloc(id,country_id,book_id,order_id,order_line_id,warehouse_id,alloc_qty) VALUES(1201,101,601,1001,1101,401,5),(1202,101,602,1002,1102,401,5)");return null;});
 seed("INSERT INTO sal_outbound(id,country_id,book_id,order_id,warehouse_id,doc_no,biz_date) VALUES(1301,101,601,1001,401,'OUT1','2026-10-15'),(1302,101,601,1001,402,'OUT2','2026-10-15')");
 seed("INSERT INTO sal_outbound_line(id,country_id,book_id,outbound_id,order_line_id,alloc_id,product_id,qty,price,amount) VALUES(1401,101,601,1301,1101,1201,501,1,1,1)");
 seed("INSERT INTO inv_batch(id,country_id,book_id,product_id,batch_no,source_type,source_id,source_line_id,first_inbound_date) VALUES(2101,101,601,501,'B1','TEST',1,1,'2026-10-15'),(2102,101,602,501,'B2','TEST',2,2,'2026-10-15')");
 seed("INSERT INTO cst_cogs(id,country_id,book_id,warehouse_id,product_id,source_type,source_line_id,qty,amount,unit_cost,method,method_version,status,biz_date) VALUES(2202,101,602,401,501,'SAL_OUTBOUND',999,1,1,1,'FIFO',1,'ESTIMATED','2026-10-15')");
 seed("INSERT INTO sal_sign(id,country_id,book_id,outbound_id,signer_name,signed_at,biz_date) VALUES(1501,101,601,1301,'Signed',clock_timestamp(),'2026-10-15')");seed("INSERT INTO sal_sign_line(id,country_id,sign_id,outbound_line_id,signed_qty) VALUES(1601,101,1501,1401,1)");}
 @Test void approvedAndClosedOrderCannotHaveEconomicsRewrittenButProgressCanAdvance(){
  seed("UPDATE sal_order SET approval_status='APPROVED' WHERE id=1001");assertThatThrownBy(()->inCountry(101,()->jdbc.update("UPDATE sal_order_line SET price=2,line_amount=10 WHERE id=1101"))).hasMessageContaining("SAL_ORDER_NOT_DRAFT");
  seed("UPDATE sal_order SET approval_status='DRAFT' WHERE id=1001");seed("UPDATE fin_period SET status='CLOSED' WHERE id=701");assertThatThrownBy(()->inCountry(101,()->jdbc.update("UPDATE sal_order_line SET price=2,line_amount=10 WHERE id=1101"))).hasMessageContaining("FIN_PERIOD_CLOSED");
  inCountry(101,()->jdbc.update("UPDATE sal_order_line SET outbound_qty=1,claimed_qty=1,version=version+1 WHERE id=1101"));assertThat(owner.queryForObject("SELECT claimed_qty FROM sal_order_line WHERE id=1101",BigDecimal.class)).isEqualByComparingTo("1");
 }
 @Test void allocationMustUseItsActualOrderBook(){assertThatThrownBy(()->inCountry(101,()->jdbc.update("UPDATE sal_order_alloc SET book_id=602 WHERE id=1201"))).isInstanceOf(org.springframework.dao.DataAccessException.class);}
 @Test void outboundSourceMustMatchWarehouseProductBatchAndCogsBook(){
  assertThatThrownBy(()->inCountry(101,()->jdbc.update("UPDATE sal_outbound_line SET outbound_id=1302 WHERE id=1401"))).hasMessageContaining("SAL_OUTBOUND_SOURCE_MISMATCH");
  assertThatThrownBy(()->inCountry(101,()->jdbc.update("UPDATE sal_outbound_line SET product_id=502 WHERE id=1401"))).hasMessageContaining("SAL_OUTBOUND_SOURCE_MISMATCH");
  assertThatThrownBy(()->inCountry(101,()->jdbc.update("UPDATE sal_outbound_line SET batch_id=2102 WHERE id=1401"))).hasMessageContaining("SAL_BATCH_SOURCE_MISMATCH");
  assertThatThrownBy(()->inCountry(101,()->jdbc.update("UPDATE sal_outbound_line SET cogs_id=2202 WHERE id=1401"))).hasMessageContaining("SAL_COGS_SOURCE_MISMATCH");
 }
 @Test void originalSignedFactsCannotBeRewrittenButResolutionIsAProjection(){assertThatThrownBy(()->inCountry(101,()->jdbc.update("UPDATE sal_sign_line SET signed_qty=0 WHERE id=1601"))).isInstanceOf(org.springframework.dao.DataAccessException.class);assertThatThrownBy(()->owner.update("UPDATE sal_sign_line SET signed_qty=0 WHERE id=1601")).hasMessageContaining("JXC_IMMUTABLE_FACT");inCountry(101,()->jdbc.update("UPDATE sal_sign_line SET diff_status='RESOLVED',resolution='investigated' WHERE id=1601"));assertThat(owner.queryForObject("SELECT resolution FROM sal_sign_line WHERE id=1601",String.class)).isEqualTo("investigated");}
 @Test void allocationConservationIsCheckedWhenOnlyLineChangesAndForNewLines(){
  assertThatThrownBy(()->inCountry(101,()->jdbc.update("UPDATE sal_order_line SET qty=6,base_qty=6,line_amount=6 WHERE id=1101"))).hasMessageContaining("SAL_ALLOCATION_NOT_BALANCED");
  assertThatThrownBy(()->inCountry(101,()->jdbc.update("INSERT INTO sal_order_line(country_id,book_id,order_id,product_id,line_no,unit,factor,qty,base_qty,price,price_source,line_amount) VALUES(101,601,1001,502,2,'PCS',1,1,1,1,'MANUAL',1)"))).hasMessageContaining("SAL_ALLOCATION_NOT_BALANCED");
 }
}
