package com.hs.jxc.it;
import com.hs.jxc.sal.SalesService;import com.hs.jxc.ar.ReceivablesService;import com.hs.jxc.rtn.ReturnsService;import com.hs.jxc.workflow.service.WorkflowService;import com.hs.jxc.attachment.AttachmentService;import java.math.BigDecimal;import java.util.*;import org.junit.jupiter.api.Test;import org.springframework.beans.factory.annotation.Autowired;import org.springframework.test.context.DynamicPropertyRegistry;import org.springframework.test.context.DynamicPropertySource;import static org.assertj.core.api.Assertions.*;
/** One synthetic real-service transaction chain; no replacement APIs or mock business calculations. */
class M2FlowIT extends SupplyFixtures {
 @Autowired java.util.List<com.hs.jxc.fin.api.FinancialSourceProvider> financialSources;
 @Autowired SalesService sales;@Autowired ReceivablesService ar;@Autowired ReturnsService returns;@Autowired WorkflowService workflow;@Autowired AttachmentService attachments;
 @DynamicPropertySource static void storage(DynamicPropertyRegistry r){r.add("jxc.storage.endpoint",MinioTestStorage::endpoint);r.add("jxc.storage.access-key",()->MinioTestStorage.ACCESS);r.add("jxc.storage.secret-key",()->MinioTestStorage.SECRET);r.add("jxc.storage.bucket",()->MinioTestStorage.BUCKET);}
 @Autowired com.hs.jxc.sal.api.SalesStatsApi inventoryDemandStats;
 @Autowired com.hs.jxc.common.api.JsonCodec inventorySourceJson;
 @org.junit.jupiter.api.BeforeEach void prefixInventoryEvidence(){
  if(System.getProperty("jxc.ai03.evidenceDir")!=null)seed("UPDATE sys_doc_number_rule SET prefix='AI03'||left(prefix,16) WHERE country_id=101");
 }
 @Test void purchaseToCustomerRefundKeepsStockAmountsAndOriginalCostsConsistent(){
  seed("update sys_role set field_policies='{\"COST\":\"WRITE\",\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"BANK_INFO\":\"WRITE\",\"CREDIT\":\"WRITE\",\"PROFIT\":\"WRITE\"}' where id=202");
  seed("insert into md_exchange_rate(country_id,from_ccy,to_ccy,rate_date,scope,rate,status,confirmed_by,confirmed_at) values(101,'CNY','MXN','2026-10-15','PURCHASE_COST',2.5,'CONFIRMED',201,clock_timestamp())");
  var delivered=delivery();var inbound=receipt(delivered);replayNative("receipt-confirm",Map.of(),Map.of("remark","changed"),(body,intent)->lgs.action(c(),"receipts",id(inbound),"confirm",body,intent),null,1);
  seed("insert into md_customer(id,country_id,code,name) values(1801,101,'END-C','End customer')");seed("insert into md_fund_account(id,country_id,entity_id,book_id,name,account_type,currency) values(1901,101,301,601,'Cash','CASH','MXN')");
  seed("insert into ar_credit_rule(country_id,target_type,target_id,payment_mode,credit_limit,currency,effective_from) values(101,'CUSTOMER',1801,'CREDIT_ALLOWED',1000,'MXN','2026-01-01')");seed("insert into sal_price(country_id,product_id,price_type,unit,min_qty,price,currency,effective_from) values(101,501,'BASE','PCS',1,20,'MXN','2026-01-01')");seed("insert into wf_doc_type_config(country_id,doc_type,approval_required,key_fields) values(101,'SALES_ORDER',false,'[]')");
  var order=sales.create(c(),Map.of("bookId",601,"entityId",301,"customerId",1801,"orderDate","2026-10-15","paymentType","CREDIT","lines",List.of(Map.of("productId",501,"unit","PCS","qty",2,"allocs",List.of(Map.of("warehouseId",401,"allocQty",2))))),key());
  order=sales.submit(c(),id(order),Map.of("bizDate","2026-10-15"),key());attachments.upload(c(),"SAL_ORDER",id(order),"SALES_DOC","sale.txt","text/plain","Approved sale evidence".getBytes(java.nio.charset.StandardCharsets.UTF_8));
  long orderId=id(order),alloc=((Number)((Map<?,?>)((List<?>)first(order).get("allocs")).getFirst()).get("id")).longValue();var outbound=sales.createOutbound(c(),Map.of("orderId",orderId,"warehouseId",401,"bizDate","2026-10-15","lines",List.of(Map.of("allocId",alloc,"qty",2))),key());long outboundId=id(outbound);outbound=replayNative("outbound-confirm",Map.of("bizDate","2026-10-15"),Map.of("bizDate","2026-10-15","driver","changed"),(body,intent)->sales.confirmOutbound(c(),outboundId,body,intent),null,0);
  long receivable=((Number)outbound.get("receivableId")).longValue();var receipt=ar.createReceipt(c(),Map.of("customerId",1801,"fundAccountId",1901,"method","CASH","amount",50,"bizTime","2026-10-15T12:00:00Z","orders",List.of(Map.of("orderId",orderId,"plannedAmount",50))),key());replayNative("receipt-arrival",Map.of("arrivalDate","2026-10-15"),Map.of("arrivalDate","2026-10-16"),(body,intent)->ar.receiptAction(c(),id(receipt),"confirm",body,intent),null,0);var writeoffBody=Map.<String,Object>of("customerId",1801,"bizDate","2026-10-15","lines",List.of(Map.of("fromType","RECEIPT","fromId",id(receipt),"receivableId",receivable,"amount",40)));var changedWriteoff=new LinkedHashMap<>(writeoffBody);changedWriteoff.put("reason","changed");replayNative("writeoff",writeoffBody,changedWriteoff,(body,intent)->ar.writeoff(c(),body,intent),"SYS_BAD_REQUEST",0);
  // Install rules before submission; approval tasks use the same authoritative source and business callbacks.
  for(String type:List.of("SALES_RETURN","REFUND"))workflow.createRule(c(),Map.of("docType",type,"name",type,"conditions",List.of(),"nodes",List.of(Map.of("nodeName","Responsible","approverType","USER","approverRef",201,"mode","ANY"))));
  var returned=returns.createSales(c(),Map.of("outboundId",id(outbound),"returnWarehouseId",401,"reasonCode","QUALITY","responsibility","SUPPLIER","bizDate","2026-10-15","submit",true,"lines",List.of(Map.of("outboundLineId",id(first(outbound)),"reqQty",1))),key());approvePending("SALES_RETURN",id(returned));returned=returns.get(c(),"sales",id(returned));long returnLine=id(first(returned));returned=returns.receive(c(),id(returned),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("id",returnLine,"receivedQty",1))),key());returned=returns.inspect(c(),id(returned),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("id",returnLine,"goodQty",1,"frozenQty",0))),key());returned=returns.settleSales(c(),id(returned),Map.of("bizDate","2026-10-15"),key());
  var refund=returns.createRefund(c(),Map.of("bookId",601,"customerId",1801,"amount",20,"currency","MXN","fundAccountId",1901,"method","CASH","payeeInfo",Map.of("name","End customer"),"bizDate","2026-10-15"),key());approvePending("REFUND",id(refund));attachments.upload(c(),"REFUND",id(refund),"REFUND_PROOF","refund.txt","text/plain","Paid refund evidence".getBytes(java.nio.charset.StandardCharsets.UTF_8));replayNative("refund-payment",Map.of("paidAt","2026-10-15","referenceNo","SYNTHETIC-CASH-ONE"),Map.of("paidAt","2026-10-15","referenceNo","SYNTHETIC-CHANGED"),(body,intent)->returns.payRefund(c(),id(refund),body,intent),"SYS_STATE_INVALID",0);
  assertThat(owner.queryForMap("select on_hand_qty,reserved_qty,frozen_qty from inv_stock_summary")).containsEntry("on_hand_qty",new BigDecimal("8.0000")).containsEntry("reserved_qty",new BigDecimal("0.0000")).containsEntry("frozen_qty",new BigDecimal("2.0000"));
  assertThat(owner.queryForObject("select amount from ar_receivable where id=?",BigDecimal.class,receivable)).isEqualByComparingTo("40");assertThat(owner.queryForObject("select open_amount from ar_receivable where id=?",BigDecimal.class,receivable)).isZero();assertThat(owner.queryForObject("select amount-written_off_amount from ar_receipt",BigDecimal.class)).isEqualByComparingTo("10");assertThat(owner.queryForMap("select amount,used_amount,reserved_amount from ar_credit_note where refundable_flag")).containsEntry("amount",new BigDecimal("20.0000")).containsEntry("used_amount",new BigDecimal("20.0000")).containsEntry("reserved_amount",new BigDecimal("0.0000"));
  assertThat(owner.queryForObject("select sum(amount) from cst_cogs",BigDecimal.class)).isEqualByComparingTo("12.5");assertThat(owner.queryForObject("select count(*) from sys_biz_event where event_type='RTN_REFUND_PAID'",Integer.class)).isEqualTo(1);
  long financialOutbound=id(outbound);var salesFacts=inCountry(101,()->financialSources.stream().filter(p->p.supports("SAL_OUTBOUND")).findFirst().orElseThrow(()->new AssertionError("Missing sales accounting source")).accountingFact(authAccess(),"SAL_OUTBOUND_CONFIRMED","SAL_OUTBOUND",financialOutbound,1,java.time.LocalDate.of(2026,10,15),Map.of()));
  assertThat(new BigDecimal(((Map<?,?>)salesFacts.get("payload")).get("amountExclTax").toString())).isEqualByComparingTo("40");
  var cash=inCountry(101,()->financialSources.stream().flatMap(p->p.balances(authAccess(),601,java.time.LocalDate.of(2026,10,15),"CASH").stream()).toList());
  assertThat(cash.stream().map(r->new BigDecimal(r.get("amount").toString())).reduce(BigDecimal.ZERO,BigDecimal::add)).isEqualByComparingTo("30");
  postActualBusinessEventsAndReconcile();
  // 在同一原生链验证统计消费者，避免为库存统计再次执行整条采购/退货链。
  inCountry(101,()->{
   var access=authAccess();var from=java.time.LocalDate.of(2026,10,1);var through=java.time.LocalDate.of(2026,10,31);
   for(String dimension:List.of("COUNTRY","WAREHOUSE")){
    long dimensionId=dimension.equals("COUNTRY")?101:401;
    var rows=inventoryDemandStats.orders(access,dimension,dimensionId,501,from,through);assertThat(rows).hasSize(1);
    assertThat((BigDecimal)rows.getFirst().get("qty")).isEqualByComparingTo("2");
    assertThat((BigDecimal)rows.getFirst().get("outboundQty")).isEqualByComparingTo("2");
    assertThat((BigDecimal)rows.getFirst().get("returnedQty")).isEqualByComparingTo("1");
    assertThat((BigDecimal)rows.getFirst().get("unassignedQty")).isZero();
    assertThat(inventoryDemandStats.orders(access,dimension,dimensionId,501,from,through)).isEqualTo(rows);
   }
   return null;
  });
  assertThat(owner.queryForObject("SELECT count(*) FROM sal_order",Integer.class)).isEqualTo(1);
 }
 @org.junit.jupiter.api.AfterEach void saveInventorySourceFacts(org.junit.jupiter.api.TestInfo info) throws Exception {
  String directory=System.getProperty("jxc.ai03.evidenceDir");
  if(directory==null||!info.getTestMethod().orElseThrow().getName().equals("purchaseToCustomerRefundKeepsStockAmountsAndOriginalCostsConsistent"))return;
  var evidence=new LinkedHashMap<String,Object>();
  evidence.put("sourceTest","M2FlowIT.purchaseToCustomerRefundKeepsStockAmountsAndOriginalCostsConsistent");
  evidence.put("scope","本轮原生采购实收、销售出库、退货与记账；实际阶段以表中事实及执行报告为准，无直接插入交易事实");
  var tables=owner.queryForList("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'pur_%' OR tablename LIKE 'lgs_%' OR tablename LIKE 'inv_%' OR tablename LIKE 'sal_%' OR tablename IN ('cst_inbound_cost','cst_cogs','sys_biz_event','fin_voucher','fin_voucher_line','fin_event_result')) ORDER BY tablename",String.class);
  for(String table:tables){
   var rows=owner.queryForList("SELECT * FROM "+table);
   for(var row:rows)row.replaceAll((column,value)->value instanceof java.sql.Date date?date.toLocalDate().toString():value);
   evidence.put(table,rows);
  }
  var output=java.nio.file.Path.of(directory);java.nio.file.Files.createDirectories(output);
  java.nio.file.Files.writeString(output.resolve("native-purchase-receipt-outbound-return-demand.json"),inventorySourceJson.write(evidence),java.nio.charset.StandardCharsets.UTF_8);
 }
 /** Native-source command protocol checks, distinct from refresh/re-login and transport-loss tests. */
 Map<String,Object> replayNative(String command,Map<String,Object> body,Map<String,Object> changed,
     java.util.function.BiFunction<Map<String,Object>,String,Map<String,Object>> invoke,String newKeyRejection,int newKeyAuditDelta){
  String intent=key();var first=invoke.apply(body,intent);var effects=nativeEffects();long audits=owner.queryForObject("SELECT count(*) FROM sys_audit_log",Long.class);
  assertThat(id(invoke.apply(body,intent))).as(command+" same key").isEqualTo(id(first));
  assertThat(nativeEffects()).as(command+" replay effects").isEqualTo(effects);
  assertThatThrownBy(()->invoke.apply(changed,intent)).isInstanceOf(com.hs.jxc.common.api.ApiException.class).extracting("code").isEqualTo("SYS_IDEMPOTENCY_CONFLICT");
  assertThat(owner.queryForObject("SELECT count(*) FROM sys_audit_log",Long.class)).as(command+" same-key audit").isEqualTo(audits);
  if(newKeyRejection==null)assertThat(id(invoke.apply(body,key()))).as(command+" source uniqueness").isEqualTo(id(first));
  else assertThatThrownBy(()->invoke.apply(body,key())).isInstanceOf(com.hs.jxc.common.api.ApiException.class).extracting("code").isEqualTo(newKeyRejection);
  assertThat(nativeEffects()).as(command+" changed body and different key effects").isEqualTo(effects);
  assertThat(owner.queryForObject("SELECT count(*) FROM sys_audit_log",Long.class)).as(command+" independent intent audit").isEqualTo(audits+newKeyAuditDelta);
  System.out.println("AI09_NATIVE_IDEMPOTENCY "+command+" source="+id(first)+" sameKey=oneEffect changedBody=conflict differentKey="+(newKeyRejection==null?"sameSource":newKeyRejection));
  return first;
 }
 Map<String,Object> nativeEffects(){return owner.queryForMap("SELECT (SELECT count(*) FROM inv_batch) batches,(SELECT sum(on_hand_qty) FROM inv_stock_summary) stock,(SELECT sum(reserved_qty) FROM inv_stock_summary) reserved,(SELECT count(*) FROM cst_cogs) cogs_facts,(SELECT sum(amount) FROM cst_cogs) cogs_amount,(SELECT count(*) FROM ar_receivable) receivables,(SELECT sum(open_amount) FROM ar_receivable) ar_open,(SELECT count(*) FROM ar_writeoff) writeoffs,(SELECT sum(written_off_amount) FROM ar_receipt) receipt_used,(SELECT sum(used_amount) FROM ar_credit_note) credit_used,(SELECT count(*) FROM rtn_refund WHERE status='PAID') paid_refunds,(SELECT count(*) FROM sys_biz_event) events");}
 @Autowired com.hs.jxc.cst.service.CostValuationService valuation;
 @Autowired com.hs.jxc.fin.ledger.LedgerService ledger;
 @Autowired com.hs.jxc.fin.accounting.AccountingService accounting;
 @Autowired com.hs.jxc.ap.PayablesService purchaseBills;
 @Autowired com.hs.jxc.ap.CostPayableBasisService purchaseBasis;
 @Test void threeSalesCarryTheEntireFrozenCostIntoThePostedLedger(){
  seed("update sys_role set field_policies='{\"COST\":\"WRITE\",\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"BANK_INFO\":\"WRITE\",\"CREDIT\":\"WRITE\"}' where id=202");
  seed("update md_product_unit set factor_to_base=3 where product_id=501 and unit='BOX'");
  var po=pur.create(c(),"orders",Map.of("bookId",601,"entityId",301,"supplierId",801,"currency","MXN","orderDate","2026-10-15","submit",true,"lines",List.of(Map.of("productId",501,"unit","BOX","qty",1,"unitPrice",1))),key());
  var dr=domestic(po,3,0,0,true);var ex=export(dr,3,true);var sh=shipment(ex,3);
  lgs.action(c(),"shipments",id(sh),"dispatch",Map.of("actualEtd","2026-10-15T00:00:00Z"),key());
  for(String node:List.of("ARRIVED_PORT","CUSTOMS_RELEASED"))lgs.action(c(),"shipments",id(sh),"nodes",Map.of("nodeType",node,"actualAt","2026-10-15T01:00:00Z"),key());
  var d=lgs.create(c(),"deliveries",Map.of("shipmentId",id(sh),"bizDate","2026-10-15","dispatch",true,"lines",List.of(Map.of("shipmentLineId",id(first(sh)),"dispatchQty",3))),key());
  var received=lgs.create(c(),"receipts",Map.of("deliveryId",id(d),"bizDate","2026-10-15","lines",List.of(Map.of("deliveryLineId",id(first(d)),"goodQty",3))),key());
  lgs.action(c(),"receipts",id(received),"confirm",Map.of(),key());
  long inbound=owner.queryForObject("select id from cst_inbound_cost",Long.class);valuation.confirm(c(),inbound,Map.of(),key());
  // This positive fixture explicitly supplies one real PO invoice for its three base units.
  confirmedBillBasis(inbound,BigDecimal.ONE,new BigDecimal("3"));
  seed("insert into md_customer(id,country_id,code,name) values(1801,101,'TAIL-C','Tail customer')");
  seed("insert into ar_credit_rule(country_id,target_type,target_id,payment_mode,credit_limit,currency,effective_from) values(101,'CUSTOMER',1801,'CREDIT_ALLOWED',1000,'MXN','2026-01-01')");
  seed("insert into sal_price(country_id,product_id,price_type,unit,min_qty,price,currency,effective_from) values(101,501,'BASE','PCS',1,1,'MXN','2026-01-01')");
  seed("insert into wf_doc_type_config(country_id,doc_type,approval_required,key_fields) values(101,'SALES_ORDER',false,'[]')");
  seed("insert into sys_user(id,username,password_hash,display_name,status) values(211,'tail-auditor','unused','Tail auditor','ENABLED')");
  String hash=com.hs.jxc.sys.service.SessionService.digest("tail-auditor");seed("insert into sys_session(token_hash,user_id,expires_at) values(?,211,clock_timestamp()+interval '1 hour')",hash);seed("insert into sys_user_role(country_id,user_id,role_id) values(101,211,202)");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(101,211,'COUNTRY_ALL',201)");
  var auditor=new com.hs.jxc.common.context.RequestContext(211,101L,"tail-audit",hash);
  long inventory=finAccount("1401","ASSET","DEBIT","INVENTORY"),payable=finAccount("2202","LIABILITY","CREDIT","AP"),receivable=finAccount("1122","ASSET","DEBIT","AR"),revenue=finAccount("5001","INCOME","CREDIT",null),cogs=finAccount("5401","EXPENSE","DEBIT",null);
  mapping("CST_INBOUND_COST_CONFIRMED",List.of(finLine(inventory,"DEBIT","amount",null),finLine(payable,"CREDIT","amount",null)));
  mapping("SAL_OUTBOUND_CONFIRMED",List.of(finLine(receivable,"DEBIT","amountExclTax",null),finLine(revenue,"CREDIT","amountExclTax",null),finLine(cogs,"DEBIT","cogsAmount",null),finLine(inventory,"CREDIT","cogsAmount",null)));
  postPrecisionEvent(owner.queryForObject("select id from sys_biz_event where event_type='CST_INBOUND_COST_CONFIRMED'",Long.class),auditor);
  var order=sales.create(c(),Map.of("bookId",601,"entityId",301,"customerId",1801,"orderDate","2026-10-15","paymentType","CREDIT","lines",List.of(Map.of("productId",501,"unit","PCS","qty",3,"allocs",List.of(Map.of("warehouseId",401,"allocQty",3))))),key());
  order=sales.submit(c(),id(order),Map.of("bizDate","2026-10-15"),key());attachments.upload(c(),"SAL_ORDER",id(order),"SALES_DOC","tail-sale.txt","text/plain","Three confirmed split sales".getBytes(java.nio.charset.StandardCharsets.UTF_8));
  long alloc=((Number)((Map<?,?>)((List<?>)first(order).get("allocs")).getFirst()).get("id")).longValue();
  for(int n=0;n<3;n++){
   var outbound=sales.createOutbound(c(),Map.of("orderId",id(order),"warehouseId",401,"bizDate","2026-10-15","lines",List.of(Map.of("allocId",alloc,"qty",1))),key());
   sales.confirmOutbound(c(),id(outbound),Map.of("bizDate","2026-10-15"),key());
   long event=owner.queryForObject("select id from sys_biz_event where event_type='SAL_OUTBOUND_CONFIRMED' and source_id=?",Long.class,id(outbound));postPrecisionEvent(event,auditor);
   BigDecimal raw=owner.queryForObject("select amount from cst_valuation_pool",BigDecimal.class),posted=owner.queryForObject("select coalesce(sum(l.debit-l.credit),0) from fin_voucher_line l join fin_voucher v on v.country_id=l.country_id and v.id=l.voucher_id where v.status='POSTED' and l.account_id=?",BigDecimal.class,inventory);
   assertThat(posted).as("posted inventory after sale %s",n+1).isEqualByComparingTo(raw.setScale(2,java.math.RoundingMode.HALF_UP));
   var reconciliation=(Map<?,?>)accounting.reconcile(c(),Map.of("bookId",601,"periodId",701,"type","INVENTORY"));
   assertThat(new BigDecimal(reconciliation.get("diffAmount").toString())).as("currency-normalized reconciliation after sale %s",n+1).isZero();
  }
  assertThat(owner.queryForList("select amount from cst_cogs order by id",BigDecimal.class)).containsExactly(new BigDecimal("0.3333"),new BigDecimal("0.3334"),new BigDecimal("0.3333"));
  assertThat(owner.queryForObject("select sum(l.debit-l.credit) from fin_voucher_line l join fin_voucher v on v.country_id=l.country_id and v.id=l.voucher_id where v.status='POSTED' and l.account_id=?",BigDecimal.class,cogs)).isEqualByComparingTo("1");
 }
 void postPrecisionEvent(long event,com.hs.jxc.common.context.RequestContext auditor){var generated=accounting.generate(c(),event,key());long id=((Number)generated.get("voucherId")).longValue();var v=ledger.voucherGet(c(),601L,id);v=ledger.action(auditor,601L,id,"audit",Map.of("version",v.get("version")),key());ledger.action(c(),601L,id,"post",Map.of("version",v.get("version")),key());}
 void postActualBusinessEventsAndReconcile(){
  seed("insert into sys_user(id,username,password_hash,display_name,status) values(211,'flow-auditor','unused','Flow auditor','ENABLED')");
  String auditorHash=com.hs.jxc.sys.service.SessionService.digest("flow-auditor");
  seed("insert into sys_session(token_hash,user_id,expires_at) values(?,211,clock_timestamp()+interval '1 hour')",auditorHash);
  seed("insert into sys_user_role(country_id,user_id,role_id) values(101,211,202)");
  seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(101,211,'COUNTRY_ALL',201)");
  var auditor=new com.hs.jxc.common.context.RequestContext(211,101L,"flow-audit",auditorHash);
  long inventory=finAccount("1401","ASSET","DEBIT","INVENTORY"),payables=finAccount("2202","LIABILITY","CREDIT","AP"),receivable=finAccount("1122","ASSET","DEBIT","AR"),advance=finAccount("2203","LIABILITY","CREDIT","AR"),revenue=finAccount("5001","INCOME","CREDIT",null),cogs=finAccount("5401","EXPENSE","DEBIT",null),refund=finAccount("2241","LIABILITY","CREDIT",null);
  long cash=id(ledger.configure(c(),601L,"accounts",null,"POST",Map.of("code","1001","name","Cash","category","ASSET","direction","DEBIT","isCash",true,"reconcileType","CASH","auxTypes",List.of("FUND")),key()));
  long flowIn=id(ledger.configure(c(),601L,"cashflow-items",null,"POST",Map.of("code","IN","name","Collection","direction","IN"),key()));
  long flowOut=id(ledger.configure(c(),601L,"cashflow-items",null,"POST",Map.of("code","OUT","name","Refund","direction","OUT"),key()));
  mapping("CST_INBOUND_COST_CONFIRMED",List.of(finLine(inventory,"DEBIT","amount",null),finLine(payables,"CREDIT","amount",null)));
  mapping("SAL_OUTBOUND_CONFIRMED",List.of(finLine(receivable,"DEBIT","amountExclTax",null),finLine(revenue,"CREDIT","amountExclTax",null),finLine(cogs,"DEBIT","cogsAmount",null),finLine(inventory,"CREDIT","cogsAmount",null)));
  mapping("AR_RECEIPT_CONFIRMED",List.of(finLine(cash,"DEBIT","amount",flowIn),finLine(advance,"CREDIT","amount",null)));
  mapping("AR_WRITEOFF_CREATED",List.of(finLine(advance,"DEBIT","amount",null),finLine(receivable,"CREDIT","amount",null)));
  mapping("RTN_SALES_INSPECTED",List.of(finLine(cogs,"DEBIT","amount",null),finLine(inventory,"CREDIT","amount",null)));
  mapping("RTN_SALES_SETTLED",List.of(finLine(revenue,"DEBIT","amount",null),finLine(refund,"CREDIT","amount",null)));
  mapping("RTN_REFUND_PAID",List.of(finLine(refund,"DEBIT","amount",null),finLine(cash,"CREDIT","amount",flowOut)));
  // Purchase-cost and settlement rates are separate confirmed configuration bases.
  seed("insert into md_exchange_rate(country_id,from_ccy,to_ccy,rate_date,scope,rate,status,confirmed_by,confirmed_at) values(101,'CNY','MXN','2026-10-15','SETTLEMENT',2.5,'CONFIRMED',201,clock_timestamp())");
  for(long cost:owner.queryForList("select id from cst_inbound_cost where source_type='LGS_RECEIPT'",Long.class)){
   valuation.confirm(c(),cost,Map.of("bizDate","2026-10-15"),key());var immutableSource=owner.queryForMap("select * from cst_inbound_cost where id=?",cost);var immutableCogs=owner.queryForList("select * from cst_cogs order by id");long event=owner.queryForObject("select id from sys_biz_event where event_type='CST_INBOUND_COST_CONFIRMED' and source_id=?",Long.class,cost);
   assertThatThrownBy(()->accounting.generate(c(),event,key())).isInstanceOf(com.hs.jxc.common.api.ApiException.class).extracting("code").isEqualTo("CST_PAYABLE_BASIS_REQUIRED");assertThat(owner.queryForObject("select count(*) from ap_bill",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from fin_event_result",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from cst_cost_confirmation where cost_id=?",Integer.class,cost)).isEqualTo(1);assertThat(owner.queryForMap("select * from cst_inbound_cost where id=?",cost)).isEqualTo(immutableSource);assertThat(owner.queryForList("select * from cst_cogs order by id")).isEqualTo(immutableCogs);
   // Declared synthetic invoice: 4.5 original BOX = 9 PCS, CNY45 at the confirmed2.5 rate.
   // This is explicit fixture input, not a production inference from received cost.
   confirmedBillBasis(cost,new BigDecimal("4.5"),new BigDecimal("9"));
  }
  var types=List.of("CST_INBOUND_COST_CONFIRMED","SAL_OUTBOUND_CONFIRMED","AR_RECEIPT_CONFIRMED","AR_WRITEOFF_CREATED","RTN_SALES_INSPECTED","RTN_SALES_SETTLED","RTN_REFUND_PAID");
  for(var e:owner.queryForList("select id,event_type from sys_biz_event order by id"))if(types.contains(e.get("event_type"))){
    long event=((Number)e.get("id")).longValue();String intent=key();
    Map<String,Object> generated;
    try{generated=accounting.generate(c(),event,intent);}catch(com.hs.jxc.common.api.ApiException ex){throw new AssertionError("Event "+e.get("event_type")+" failed: "+owner.queryForList("select last_error from sys_biz_event_consume where event_id=?",event),ex);}
    var replay=accounting.generate(c(),event,intent);
    assertThat(replay.get("voucherId")).isEqualTo(generated.get("voucherId"));
    long voucher=((Number)generated.get("voucherId")).longValue();var v=ledger.voucherGet(c(),601L,voucher);
    assertThat(v).containsEntry("status","PENDING_AUDIT");
    v=ledger.action(auditor,601L,voucher,"audit",Map.of("version",v.get("version")),key());
    ledger.action(c(),601L,voucher,"post",Map.of("version",v.get("version")),key());
  }
  assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isEqualTo(7);
  for(String type:List.of("AR","INVENTORY","CASH")){
    var result=(Map<?,?>)accounting.reconcile(c(),Map.of("bookId",601,"periodId",701,"type",type));
    assertThat(result.get("incomplete")).as(type+" completeness").isEqualTo(false);
    assertThat(new BigDecimal(result.get("diffAmount").toString())).as(type+" source versus posted GL").isZero();
    assertThat(new BigDecimal(result.get("unpostedAmount").toString())).isZero();
  }
  // The earlier no-bill stage stayed WAITING. The explicitly confirmed invoice now supplies the same principal.
  var apResult=(Map<?,?>)accounting.reconcile(c(),Map.of("bookId",601,"periodId",701,"type","AP"));
  BigDecimal receivedCost=owner.queryForObject("select sum(base_purchase_amount) from cst_cost_confirmation",BigDecimal.class);
  assertThat(new BigDecimal(apResult.get("businessAmount").toString())).isEqualByComparingTo(receivedCost);
  assertThat(new BigDecimal(apResult.get("glAmount").toString())).isEqualByComparingTo(receivedCost);
  assertThat(new BigDecimal(apResult.get("diffAmount").toString())).isZero();
  assertThat(new BigDecimal(apResult.get("unpostedAmount").toString())).isZero();
  assertThat(ledger.ledger(c(),601L,"trial",701L,null,null,null)).containsEntry("balanced",true);
 }
 void confirmedBillBasis(long cost,BigDecimal originalInvoiceQty,BigDecimal declaredBaseQty){
  long orderLine=owner.queryForObject("select po_line_id from cst_inbound_cost where id=?",Long.class,cost);var bill=purchaseBills.createBill(c(),Map.of("billDate","2026-10-15","sources",List.of(Map.of("sourceType","PUR_ORDER_LINE","sourceId",orderLine,"qty",originalInvoiceQty))),key());bill=purchaseBills.confirmBill(c(),id(bill),Map.of("version",bill.get("version")),key());assertThat(bill.get("status")).isEqualTo("CONFIRMED");assertThat(new BigDecimal(bill.get("baseAmount").toString())).isEqualByComparingTo(owner.queryForObject("select base_purchase_amount from cst_cost_confirmation where cost_id=?",BigDecimal.class,cost));var claims=owner.queryForList("select * from ap_source_claim order by id");var linked=purchaseBasis.save(c(),cost,Map.of("version",0,"lines",List.of(Map.of("billLineId",id(first(bill)),"baseQty",declaredBaseQty))),key());assertThat(linked.get("basisStatus")).isEqualTo("READY");assertThat(owner.queryForList("select * from ap_source_claim order by id")).isEqualTo(claims);
 }
 long finAccount(String code,String category,String direction,String reconcile){var b=new LinkedHashMap<String,Object>();b.put("code",code);b.put("name",code);b.put("category",category);b.put("direction",direction);if(reconcile!=null)b.put("reconcileType",reconcile);if("AP".equals(reconcile))b.put("auxTypes",List.of("SUPPLIER"));return id(ledger.configure(c(),601L,"accounts",null,"POST",b,key()));}
 Map<String,Object> finLine(long account,String direction,String amount,Long cashflow){var l=new LinkedHashMap<String,Object>();l.put("direction",direction);l.put("accountRule",Map.of("type","FIXED","accountId",account));l.put("amountExpr",amount);if(cashflow!=null)l.put("cashflowItemId",cashflow);return l;}
 void mapping(String event,List<Map<String,Object>> lines){var m=accounting.saveMapping(c(),null,Map.of("bookId",601,"eventType",event,"lines",lines),key());accounting.review(c(),id(m),Map.of("version",m.get("version")),key());}
 @Autowired com.hs.jxc.sys.service.AuthorizationService sourceAuth;
 com.hs.jxc.sys.api.Access authAccess(){return sourceAuth.authorize(c());}
 void approvePending(String type,long doc){long task=owner.queryForObject("select t.id from wf_task t join wf_instance i on i.country_id=t.country_id and i.id=t.instance_id where i.doc_type=? and i.doc_id=? and t.status='PENDING'",Long.class,type,doc);workflow.approve(c(),task,"Verified");}
}
