package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import java.net.URI;
import java.net.http.*;
import java.math.BigDecimal;
import java.util.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Import;
import tools.jackson.databind.json.JsonMapper;

/** The original export/shipment selectors read their owner's facts, including current draft reservations. */
@Import(CountryCalendarIT.TimeConfiguration.class)
class PurchaseSourcePresentationIT extends SupplyFixtures {
 @Autowired CountryCalendarIT.BusinessClock clock;
 @Autowired com.hs.jxc.rtn.ReturnsService returns;
 @BeforeEach void businessInstant(){clock.set("2026-10-01T01:30:00Z");}
 @Value("${local.server.port}") int port;
 final HttpClient http=HttpClient.newHttpClient();final JsonMapper json=JsonMapper.builder().build();
 @ParameterizedTest @ValueSource(booleans={true,false})
 void originalSourceDtosKeepProductOrderIdentityDimensionsAndNativePlanQuotaWithoutGetWrites(boolean forExport)throws Exception{
  seed("UPDATE md_product SET gross_weight=1,volume=0.01 WHERE id=501");seed("INSERT INTO md_product(id,product_code,name,base_unit) VALUES(502,'P2','Product 2','PCS')");seed("INSERT INTO md_country_sku(country_id,product_id) VALUES(101,502)");seed("INSERT INTO md_product_unit(product_id,unit,factor_to_base) VALUES(502,'PCS',1)");
  var po=pur.create(c(),"orders",Map.of("bookId",601,"supplierId",801,"orderDate","2026-10-15","lines",List.of(Map.of("productId",501,"unit","PCS","qty",5,"unitPrice",2),Map.of("productId",502,"unit","PCS","qty",3,"unitPrice",4))),key());po=pur.action(c(),"orders",id(po),"submit",Map.of(),key());
  var ordered=rows(po.get("lines"));var receipt=pur.create(c(),"domestic-receipts",Map.of("orderId",id(po),"receiptDate","2026-10-15","confirm",true,"lines",ordered.stream().map(line->Map.of("orderLineId",id(line),"qualifiedQty",line.get("baseQty"))).toList()),key());
  Map<String,Object> exported=null,draft=null;
  if(!forExport){exported=pur.create(c(),"export-nodes",Map.of("exportDate","2026-10-15","declarationNo","SOURCE-DISPLAY","confirm",true,"lines",rows(receipt.get("lines")).stream().map(line->Map.of("receiptLineId",id(line),"qty",line.get("qualifiedQty"))).toList()),key());draft=lgs.create(c(),"shipments",Map.of("bookId",601,"destWarehouseId",401,"carrierId",802,"transportMode","AIR","flightNo","DISPLAY","awbNo","DISPLAY","bizDate","2026-10-15","lines",List.of(Map.of("sourceLineId",id(first(exported)),"baseQty",2))),key());}
  int units=owner.queryForObject("SELECT count(*) FROM md_product_unit_used",Integer.class),events=owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class);String path=forExport?"/export-nodes/sources":"/shippable-sources";var selected=read(path);assertThat(selected).hasSize(2);
  for(var row:selected){long product=((Number)row.get("productId")).longValue();assertThat(row).containsEntry("productCode",product==501?"P":"P2").containsEntry("productName",product==501?"Product":"Product 2").containsEntry("orderNo",po.get("docNo")).containsEntry("poNo",po.get("docNo")).containsEntry("supplierName","Supplier");assertThat(row.get("poId").toString()).isEqualTo(po.get("id").toString());if(product==501){number(row,"unitWeight","1");number(row,"unitVolume","0.01");}else assertThat(row).containsEntry("unitWeight",null).containsEntry("unitVolume",null);}
  if(forExport){for(var row:selected)number(row,"exportableQty",row.get("productId").toString().equals("501")?"5":"3");}
  else{var first=selected.stream().filter(row->row.get("productId").toString().equals("501")).findFirst().orElseThrow();number(first,"qty","5");number(first,"shippedQty","0");number(first,"plannedQty","2");number(first,"remainingQty","3");var editing=read(path+"?excludeShipmentId="+id(draft));var restored=editing.stream().filter(row->row.get("productId").toString().equals("501")).findFirst().orElseThrow();number(restored,"plannedQty","0");number(restored,"remainingQty","5");assertThat(response(path+"?excludeShipmentId=2147483647").statusCode()).isEqualTo(404);
   seed("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(102,'CN','Other country','CNY','Asia/Shanghai','ACTIVE')");seed("INSERT INTO org_entity(id,country_id,code,name) VALUES(2302,102,'CN-E','Other entity')");seed("INSERT INTO org_warehouse(id,country_id,entity_id,code,name) VALUES(2403,102,2302,'CN-W','Other warehouse')");seed("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(2602,102,2302,'CN-B','Other book','CNY','ACTIVE'),(2603,101,301,'HIDDEN-B','Hidden book','MXN','ACTIVE')");seed("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(102,2602,2026,10,'2026-10-01','2026-10-31','OPEN'),(101,2603,2026,10,'2026-10-01','2026-10-31','OPEN')");seed("INSERT INTO md_logistics_provider(id,country_id,code,name,settle_currency,located_country) VALUES(2803,102,'CN-L','Other carrier','CNY','CN')");
   seed("INSERT INTO lgs_shipment(id,country_id,book_id,entity_id,biz_date,doc_no,carrier_id,dest_warehouse_id,transport_mode,created_by) VALUES(29001,102,2602,2302,'2026-10-15','FOREIGN-EXCLUDE',2803,2403,'AIR',201),(29002,101,2603,301,'2026-10-15','HIDDEN-EXCLUDE',802,401,'AIR',201)");
   assertThat(response(path+"?excludeShipmentId=29001").statusCode()).isEqualTo(404);assertThat(read(path+"?excludeShipmentId=29002")).isEmpty();
   long exportLine=id(first(exported));assertThatThrownBy(()->lgs.create(c(),"shipments",Map.of("bookId",601,"destWarehouseId",401,"carrierId",802,"transportMode","AIR","flightNo","EXCLUDE-CANNOT-BYPASS","awbNo","EXCLUDE-CANNOT-BYPASS","bizDate","2026-10-15","lines",List.of(Map.of("sourceLineId",exportLine,"baseQty",4))),key())).isInstanceOf(com.hs.jxc.common.api.ApiException.class).extracting("code").isEqualTo("LGS_SOURCE_EXCEEDED");
   seed("DELETE FROM sys_user_data_scope WHERE user_id=201");seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) VALUES(101,201,'BOOK',601,201)");assertThat(response(path+"?excludeShipmentId=29002").statusCode()).isEqualTo(404);number(read(path).stream().filter(row->row.get("productId").toString().equals("501")).findFirst().orElseThrow(),"remainingQty","3");

}
  assertThat(owner.queryForObject("SELECT count(*) FROM md_product_unit_used",Integer.class)).isEqualTo(units);assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class)).isEqualTo(events);assertThat(owner.queryForObject("SELECT count(*) FROM inv_batch",Integer.class)).isZero();
  seed("UPDATE sys_role SET permissions=?::jsonb,field_policies='{}' WHERE id=202",forExport?"[\"pur:export:create\"]":"[\"lgs:shipment:create\"]");assertThat(read(path)).hasSize(2);if(!forExport)assertThat(response(path+"?excludeShipmentId="+id(draft)).statusCode()).isEqualTo(403);
  seed("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(602,101,301,'OTHER','Other book','MXN','ACTIVE')");seed("DELETE FROM sys_user_data_scope WHERE user_id=201");seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) VALUES(101,201,'BOOK',602,201)");assertThat(read(path)).isEmpty();
 }
 @org.junit.jupiter.api.Test
 void exportSelectorKeepsOnlyPositiveBalancesWithoutRemovingHistory()throws Exception{
  var po=order();
  var exhausted=domestic(po,10,0,0,true);
  var remaining=domestic(po,10,0,0,true);
  var historicalExport=export(exhausted,10,true);
  export(remaining,4,true);
  int audits=owner.queryForObject("SELECT count(*) FROM sys_audit_log",Integer.class);
  int events=owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class);
  var facts=owner.queryForList("SELECT id,qualified_qty,exported_qty,shipped_qty,returned_qty FROM pur_domestic_receipt_line ORDER BY id");

  var selected=read("/export-nodes/sources");
  assertThat(selected).extracting(row->row.get("receiptLineId").toString())
   .containsExactly(String.valueOf(id(first(remaining))));
  number(selected.getFirst(),"exportableQty","6");
  var historicalReceipt=readObject("/domestic-receipts/"+id(exhausted));
  number(rows(historicalReceipt.get("lines")).getFirst(),"exportableQty","0");
  var historicalNode=readObject("/export-nodes/"+id(historicalExport));
  assertThat(historicalNode).containsEntry("status","CONFIRMED");
  number(rows(historicalNode.get("lines")).getFirst(),"qty","10");
  assertThat(rows(readObject("/domestic-receipts?orderId="+id(po)).get("records"))).hasSize(2);
  assertThat(rows(readObject("/export-nodes?orderId="+id(po)).get("records"))).hasSize(2);
  assertThat(owner.queryForList("SELECT id,qualified_qty,exported_qty,shipped_qty,returned_qty FROM pur_domestic_receipt_line ORDER BY id")).isEqualTo(facts);
  assertThat(owner.queryForObject("SELECT count(*) FROM sys_audit_log",Integer.class)).isEqualTo(audits);
  assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class)).isEqualTo(events);

  export(remaining,6,true);
  assertThat(read("/export-nodes/sources")).isEmpty();
  assertThat(rows(readObject("/export-nodes?orderId="+id(po)).get("records"))).hasSize(3);
  assertThat(rows(readObject("/domestic-receipts?orderId="+id(po)).get("records"))).hasSize(2);
 }
 @ParameterizedTest @CsvSource({"America/Mexico_City,2026-09-30","Asia/Shanghai,2026-10-01"})
 void nativePurchaseAndShipmentDefaultsUseConfiguredCountryDayWhileExplicitReceiptAndExportDatesRemain(String timezone,String day){
  seed("UPDATE sys_country SET timezone=? WHERE id=101",timezone);seed("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(101,601,2026,9,'2026-09-01','2026-09-30','OPEN')");
  var po=pur.create(c(),"orders",Map.of("bookId",601,"supplierId",801,"lines",List.of(Map.of("productId",501,"unit","PCS","qty",5,"unitPrice",2))),key());
  var softly=new org.assertj.core.api.SoftAssertions();softly.assertThat(po.get("orderDate").toString()).isEqualTo(day);softly.assertThat(po.get("docNo").toString()).contains(day.replace("-",""));po=pur.action(c(),"orders",id(po),"submit",Map.of(),key());
  String explicit="2026-09-30";var receipt=pur.create(c(),"domestic-receipts",Map.of("orderId",id(po),"receiptDate",explicit,"confirm",true,"lines",List.of(Map.of("orderLineId",id(first(po)),"qualifiedQty",5))),key());assertThat(receipt.get("receiptDate").toString()).isEqualTo(explicit);
  var exported=pur.create(c(),"export-nodes",Map.of("exportDate",explicit,"declarationNo","COUNTRY-DATE","confirm",true,"lines",List.of(Map.of("receiptLineId",id(first(receipt)),"qty",5))),key());assertThat(exported.get("exportDate").toString()).isEqualTo(explicit);
  var shipment=lgs.create(c(),"shipments",Map.of("bookId",601,"destWarehouseId",401,"carrierId",802,"transportMode","AIR","flightNo","LOCAL-DAY","awbNo","LOCAL-DAY","lines",List.of(Map.of("sourceLineId",id(first(exported)),"baseQty",2))),key());softly.assertThat(shipment.get("bizDate").toString()).isEqualTo(day);softly.assertThat(shipment.get("docNo").toString()).contains(day.replace("-",""));softly.assertAll();
 }
 @org.junit.jupiter.api.Test void originalPurchaseAndReceiptPagesExposeOwnerQuantitiesAndInspectionHistoryWithoutReadWrites()throws Exception{
  var po=pur.create(c(),"orders",Map.of("bookId",601,"supplierId",801,"orderDate","2026-10-15","lines",List.of(Map.of("productId",501,"unit","PCS","qty",10,"unitPrice",2))),key());po=pur.action(c(),"orders",id(po),"submit",Map.of(),key());
  var receipt=pur.create(c(),"domestic-receipts",Map.of("orderId",id(po),"receiptDate","2026-10-15","confirm",true,"lines",List.of(Map.of("orderLineId",id(first(po)),"qualifiedQty",7,"pendingInspectQty",2,"damagedQty",1))),key());
  var orders=rows(readObject("/orders").get("records"));assertThat(orders).hasSize(1);var order=orders.getFirst();assertThat(order).containsEntry("supplierName","Supplier");assertThat(order.get("productSummary").toString()).contains("P");number(order,"deliveredQty","9");number(order,"shippedQty","0");number(order,"arrivedMxQty","0");
  var selected=rows(readObject("/domestic-receipts").get("records")).getFirst();assertThat(selected).containsEntry("orderNo",po.get("docNo")).containsEntry("supplierName","Supplier");number(selected,"totalQualified","7");number(selected,"totalPending","2");number(selected,"totalDamaged","1");
  pur.convert(c(),id(first(receipt)),Map.of("toQualifiedQty",1,"toDamagedQty",1,"bizDate","2026-10-15","remark","inspection"),key());
  int events=owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class),units=owner.queryForObject("SELECT count(*) FROM md_product_unit_used",Integer.class);var detail=readObject("/domestic-receipts/"+id(receipt));number(detail,"totalQualified","8");number(detail,"totalPending","0");number(detail,"totalDamaged","2");var line=rows(detail.get("lines")).getFirst();assertThat(line).containsEntry("productCode","P").containsEntry("productName","Product");number(line,"remainingPendingQty","0");number(line,"exportableQty","8");assertThat(rows(detail.get("converts"))).hasSize(1);assertThat(rows(detail.get("converts")).getFirst()).containsEntry("productCode","P").containsEntry("remark","inspection");
  order=readObject("/orders/"+id(po));number(order,"deliveredQty","8");number(order,"shippedQty","0");number(order,"arrivedMxQty","0");number(rows(order.get("lines")).getFirst(),"undeliveredQty","2");assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class)).isEqualTo(events);assertThat(owner.queryForObject("SELECT count(*) FROM md_product_unit_used",Integer.class)).isEqualTo(units);assertThat(owner.queryForObject("SELECT count(*) FROM inv_batch",Integer.class)).isZero();
  seed("UPDATE sys_role SET permissions='[\"pur:order:view\"]',field_policies='{}' WHERE id=202");var masked=readObject("/orders/"+id(po));assertThat(masked).containsEntry("costHidden",true).containsEntry("supplierName","Supplier").doesNotContainKeys("totalAmount","taxAmount");assertThat(rows(masked.get("lines")).getFirst()).containsEntry("productCode","P").doesNotContainKeys("unitPrice","amount");number(masked,"deliveredQty","8");
  seed("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(602,101,301,'OTHER','Other book','MXN','ACTIVE')");seed("DELETE FROM sys_user_data_scope WHERE user_id=201");seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) VALUES(101,201,'BOOK',602,201)");assertThat(rows(readObject("/orders").get("records"))).isEmpty();assertThat(rows(readObject("/domestic-receipts").get("records"))).isEmpty();assertThat(response("/orders/"+id(po)).statusCode()).isEqualTo(404);assertThat(response("/domestic-receipts/"+id(receipt)).statusCode()).isEqualTo(404);
 }
 @org.junit.jupiter.api.Test void nativePurchaseSearchFiltersBeforeCountryScopedPaginationAndNeverIgnoresThePageFields()throws Exception{
  seed("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(102,'CN','Other country','CNY','Asia/Shanghai','ACTIVE')");seed("INSERT INTO org_entity(id,country_id,code,name) VALUES(2302,102,'CN-E','Other entity')");seed("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(2602,102,2302,'CN-B','Other book','CNY','ACTIVE')");seed("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(102,2602,2026,10,'2026-10-01','2026-10-31','OPEN')");seed("INSERT INTO md_supplier(id,country_id,code,name,settle_currency) VALUES(2804,102,'CN-S','Foreign supplier','CNY')");seed("INSERT INTO pur_order(id,country_id,book_id,entity_id,biz_date,doc_no,supplier_id,currency,order_date) VALUES(29004,102,2602,2302,'2026-10-15','CN-PURCHASE-ORDER-NOT-IN-THIS-COUNTRY',2804,'CNY','2026-10-15')");
  seed("INSERT INTO md_product(id,product_code,name,base_unit) VALUES(502,'FILTER-P2','Filter product','PCS')");seed("INSERT INTO md_country_sku(country_id,product_id) VALUES(101,502)");seed("INSERT INTO md_product_unit(product_id,unit,factor_to_base) VALUES(502,'PCS',1)");seed("INSERT INTO md_supplier(id,country_id,code,name,settle_currency) VALUES(804,101,'FILTER-S2','Filter supplier','CNY')");
  var orders=new ArrayList<Map<String,Object>>();for(int i=0;i<3;i++)orders.add(pur.create(c(),"orders",Map.of("bookId",601,"supplierId",i==1?804:801,"orderDate","2026-10-15","lines",List.of(Map.of("productId",i==1?502:501,"unit","PCS","qty",2,"unitPrice",2))),key()));long firstOrder=id(orders.getFirst());pur.action(c(),"orders",firstOrder,"submit",Map.of(),key());
  assertThat(rows(readObject("/orders?keyword=CN-PURCHASE-ORDER-NOT-IN-THIS-COUNTRY").get("records"))).isEmpty();var one=readObject("/orders?size=1&page=1");var two=readObject("/orders?size=1&page=2");assertThat(one.get("total").toString()).isEqualTo("3");assertThat(two.get("total")).isEqualTo(one.get("total"));assertThat(rows(one.get("records"))).hasSize(1);assertThat(rows(two.get("records"))).hasSize(1);assertThat(rows(one.get("records")).getFirst().get("id")).isNotEqualTo(rows(two.get("records")).getFirst().get("id"));assertThat(rows(readObject("/orders?size=1&page=4").get("records"))).isEmpty();
  var filtered=rows(readObject("/orders?productId=502&supplierId=804&status=DRAFT").get("records"));assertThat(filtered).hasSize(1);assertThat(filtered.getFirst().get("id").toString()).isEqualTo(orders.get(1).get("id").toString());assertThat(rows(readObject("/orders?docNo="+orders.getFirst().get("docNo")).get("records"))).hasSize(1);assertThat(rows(readObject("/orders?status=CONFIRMED").get("records"))).hasSize(1);
  var receipt=pur.create(c(),"domestic-receipts",Map.of("orderId",firstOrder,"receiptDate","2026-10-15","location","FILTER-LOCATION","confirm",true,"lines",List.of(Map.of("orderLineId",id(first(orders.getFirst())),"qualifiedQty",2))),key());pur.create(c(),"export-nodes",Map.of("exportDate","2026-10-15","declarationNo","FILTER-DECLARATION","exportPort","FILTER-PORT","confirm",true,"lines",List.of(Map.of("receiptLineId",id(first(receipt)),"qty",2))),key());
  assertThat(rows(readObject("/domestic-receipts?keyword=FILTER-LOCATION&orderId="+firstOrder).get("records"))).hasSize(1);assertThat(rows(readObject("/domestic-receipts?orderId="+id(orders.get(1))).get("records"))).isEmpty();assertThat(rows(readObject("/export-nodes?keyword=FILTER-PORT&orderId="+firstOrder).get("records"))).hasSize(1);assertThat(rows(readObject("/export-nodes?keyword=FILTER-DECLARATION&productId=502").get("records"))).isEmpty();
  int events=owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class),audits=owner.queryForObject("SELECT count(*) FROM sys_audit_log",Integer.class);for(String query:List.of("page=0","page=1000001","size=0","size=201","supplierId=not-an-id"))assertThat(response("/orders?"+query).statusCode()).as(query).isEqualTo(400);readObject("/orders?keyword=FILTER");assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class)).isEqualTo(events);assertThat(owner.queryForObject("SELECT count(*) FROM sys_audit_log",Integer.class)).isEqualTo(audits);
  seed("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(602,101,301,'FILTER-HIDDEN','Hidden book','MXN','ACTIVE')");seed("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(101,602,2026,10,'2026-10-01','2026-10-31','OPEN')");seed("INSERT INTO pur_order(id,country_id,book_id,entity_id,biz_date,doc_no,supplier_id,currency,order_date) VALUES(29003,101,602,301,'2026-10-15','HIDDEN-QUERY-ORDER',801,'CNY','2026-10-15')");seed("DELETE FROM sys_user_data_scope WHERE user_id=201");seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) VALUES(101,201,'BOOK',601,201)");assertThat(readObject("/orders?size=1").get("total").toString()).isEqualTo("3");assertThat(rows(readObject("/orders?keyword=HIDDEN-QUERY-ORDER").get("records"))).isEmpty();assertThat(readObject("/orders?bookId=602").get("total").toString()).isEqualTo("0");
 }
 @ParameterizedTest @CsvSource({"America/Mexico_City,2026-09-30,2026-10-01T01:30:00Z","America/Mexico_City,2026-09-30,2026-09-30T19:30:00-06:00","Asia/Shanghai,2026-10-01,2026-10-01T01:30:00Z","Asia/Shanghai,2026-10-01,2026-09-30T19:30:00-06:00"})
 void nativeLogisticsEventPeriodUsesCountryDayForTheSameInstantRegardlessOfClientOffset(String timezone,String localDay,String at){
  seed("UPDATE sys_country SET timezone=? WHERE id=101",timezone);seed("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(101,601,2026,9,'2026-09-01','2026-09-30','CLOSED')");
  var exported=export(domestic(order(),20,0,0,true),20,true);var shipments=new ArrayList<Map<String,Object>>();
  for(int i=0;i<4;i++){var body=new LinkedHashMap<String,Object>(Map.of("bookId",601,"destWarehouseId",401,"carrierId",802,"transportMode","SEA","vessel","TZ","voyage","1","blNo","TZ-"+i,"containerNo","OLD-"+i,"sealNo","S","lines",List.of(Map.of("sourceLineId",id(first(exported)),"baseQty",2))));body.put("bizDate","2026-10-15");body.put("submit",true);var shipment=lgs.create(c(),"shipments",body,key());shipments.add(shipment);if(i>0)lgs.action(c(),"shipments",id(shipment),"dispatch",Map.of("bizDate","2026-10-15","actualEtd","2026-10-15T15:00:00Z"),key());}
  long correctionShipment=id(shipments.get(3));lgs.action(c(),"shipments",correctionShipment,"nodes",Map.of("bizDate","2026-10-15","nodeType","EXCEPTION","actualAt","2026-10-15T16:00:00Z","remark","original"),key());long originalNode=owner.queryForObject("SELECT id FROM lgs_node WHERE shipment_id=? AND node_type='EXCEPTION'",Long.class,correctionShipment);
  var commands=List.<java.util.function.Supplier<Map<String,Object>>>of(
   ()->lgs.action(c(),"shipments",id(shipments.get(0)),"dispatch",Map.of("bizDate","2026-10-15","actualEtd",at),key()),
   ()->lgs.action(c(),"shipments",id(shipments.get(1)),"nodes",Map.of("bizDate","2026-10-15","nodeType","EXCEPTION","actualAt",at),key()),
   ()->lgs.create(c(),"transships",Map.of("shipmentId",id(shipments.get(2)),"transshipAt",at,"toContainerNo","NEW-TZ","toSealNo","NEW","lines",List.of(Map.of("shipmentLineId",id(first(shipments.get(2))),"movedQty",2))),key()),
   ()->lgs.correctNode(c(),correctionShipment,originalNode,Map.of("actualAt",at,"remark","correct time"),key()));
  var softly=new org.assertj.core.api.SoftAssertions();boolean closed=localDay.equals("2026-09-30");int nodes=owner.queryForObject("SELECT count(*) FROM lgs_node",Integer.class),containers=owner.queryForObject("SELECT count(*) FROM lgs_container",Integer.class),events=owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class);
  for(int i=0;i<commands.size();i++){Throwable failure=null;try{commands.get(i).get();}catch(Throwable error){failure=error;}if(closed){softly.assertThat(failure).as("operation %s must use closed local day",i).isInstanceOf(com.hs.jxc.common.api.ApiException.class);if(failure instanceof com.hs.jxc.common.api.ApiException api)softly.assertThat(api.getCode()).isEqualTo("FIN_PERIOD_CLOSED");}else softly.assertThat(failure).as("operation %s must use open local day",i).isNull();}
  if(closed){softly.assertThat(owner.queryForObject("SELECT count(*) FROM lgs_node",Integer.class)).isEqualTo(nodes);softly.assertThat(owner.queryForObject("SELECT count(*) FROM lgs_container",Integer.class)).isEqualTo(containers);softly.assertThat(owner.queryForObject("SELECT count(*) FROM lgs_transship",Integer.class)).isZero();softly.assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class)).isEqualTo(events);softly.assertThat(owner.queryForObject("SELECT shipped_qty FROM lgs_shipment_line WHERE shipment_id=?",BigDecimal.class,id(shipments.get(0)))).isZero();softly.assertThat(owner.queryForObject("SELECT corrected_by_id FROM lgs_node WHERE id=?",Long.class,originalNode)).isNull();}
  else{var instant=java.time.OffsetDateTime.parse(at).toInstant();softly.assertThat(owner.queryForList("SELECT biz_date FROM lgs_node WHERE actual_at=?",java.sql.Date.class,java.time.OffsetDateTime.parse(at))).hasSize(4).allMatch(day->day.toLocalDate().toString().equals(localDay));var actual=owner.queryForObject("SELECT actual_etd FROM lgs_shipment WHERE id=?",java.time.OffsetDateTime.class,id(shipments.get(0)));softly.assertThat(actual).isNotNull();if(actual!=null)softly.assertThat(actual.toInstant()).isEqualTo(instant);var transfers=owner.queryForList("SELECT biz_date,doc_no FROM lgs_transship");softly.assertThat(transfers).hasSize(1);if(!transfers.isEmpty()){softly.assertThat(transfers.getFirst().get("biz_date").toString()).isEqualTo(localDay);softly.assertThat(transfers.getFirst().get("doc_no").toString()).contains(localDay.replace("-",""));}}
  softly.assertAll();
 }
 @ParameterizedTest @CsvSource({"America/Mexico_City,2026-09-30,2026-10-01T01:30:00Z","America/Mexico_City,2026-09-30,2026-09-30T19:30:00-06:00","Asia/Shanghai,2026-10-01,2026-10-01T01:30:00Z","Asia/Shanghai,2026-10-01,2026-09-30T19:30:00-06:00"})
 void originalReturnDateParserUsesCountryPeriodInsteadOfClientOffset(String timezone,String localDay,String at){
  seed("UPDATE sys_country SET timezone=? WHERE id=101",timezone);seed("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(101,601,2026,9,'2026-09-01','2026-09-30','CLOSED')");
  var body=Map.<String,Object>of("bookId",601,"againstType","CARRIER","partnerId",802,"claimAmount",1,"currency","CNY","bizDate",at);
  if(localDay.equals("2026-09-30")){assertThatThrownBy(()->returns.createClaim(c(),body,key())).isInstanceOf(com.hs.jxc.common.api.ApiException.class).extracting("code").isEqualTo("FIN_PERIOD_CLOSED");assertThat(owner.queryForObject("SELECT count(*) FROM rtn_claim",Integer.class)).isZero();}
  else{var result=new java.util.concurrent.atomic.AtomicReference<Map<String,Object>>();assertThatCode(()->result.set(returns.createClaim(c(),body,key()))).doesNotThrowAnyException();var claim=result.get();assertThat(claim.get("bizDate").toString()).isEqualTo(localDay);assertThat(claim.get("docNo").toString()).contains(localDay.replace("-",""));}
 }
 @SuppressWarnings("unchecked") List<Map<String,Object>> rows(Object value){return (List<Map<String,Object>>)value;}
 void number(Map<String,Object> row,String field,String expected){assertThat(new BigDecimal(row.get(field).toString())).as(field).isEqualByComparingTo(expected);}
 HttpResponse<String> response(String path)throws Exception{return http.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1/pur"+path)).header("Authorization","Bearer supply-fixture").header("X-Country-Id","101").GET().build(),HttpResponse.BodyHandlers.ofString());}
 @SuppressWarnings("unchecked") Map<String,Object> readObject(String path)throws Exception{var response=response(path);assertThat(response.statusCode()).withFailMessage(response.body()).isEqualTo(200);return (Map<String,Object>)json.readValue(response.body(),Map.class).get("data");}
 List<Map<String,Object>> read(String path)throws Exception{var response=response(path);assertThat(response.statusCode()).withFailMessage(response.body()).isEqualTo(200);return rows(json.readValue(response.body(),Map.class).get("data"));}
}
