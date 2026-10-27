package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.imports.ImportService;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
class MasterImportIT extends BasePgIT {
 @Autowired ImportService imports;
 @org.springframework.beans.factory.annotation.Value("${local.server.port}") int port;
 final RequestContext actor=new RequestContext(201,101L,"master-import","a".repeat(64));
 @BeforeEach void fixture(){InventoryIT.seedBase();seed("INSERT INTO org_store(id,country_id,entity_id,code,name) VALUES(301,101,301,'S','Store')");seed("INSERT INTO sys_authz_epoch(country_id) VALUES(101)");seed("UPDATE sys_user SET is_platform_admin=true WHERE id=201");seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(repeat('a',64),201,clock_timestamp()+interval '1 hour')");seed("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(211,101,'MASTER','Master','[\"*\"]','{\"COST\":\"WRITE\",\"BANK_INFO\":\"WRITE\"}')");seed("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(101,201,211)");seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(101,201,'COUNTRY_ALL',201)");}
 Map<String,Object> confirm(String type,List<Map<String,Object>> rows){var batch=imports.create(actor,Map.of("importType",type,"rows",rows));assertThat(batch.get("status")).as(batch.toString()).isEqualTo("VALIDATED");return imports.confirm(actor,((Number)batch.get("id")).longValue(),UUID.randomUUID().toString());}
 @Test void productUnitsBarcodesAndCustomerAddressesReuseNativeCommands(){
  confirm("PRODUCT",List.of(Map.of("productCode","IMPORT","name","Imported","baseUnit","PCS","grossWeight",new java.math.BigDecimal("1.25"),"units",List.of(Map.of("unit","BOX","factorToBase",12)),"barcodes",List.of(Map.of("barcode","BOX001","unit","BOX")))));
  confirm("PRODUCT_UNIT",List.of(Map.of("productCode","IMPORT","unit","PACK","factorToBase",6),Map.of("productCode","IMPORT","unit","CARTON","factorToBase",24)));
  confirm("PRODUCT_BARCODE",List.of(Map.of("productCode","IMPORT","unit","PACK","barcode","PACK001")));
  assertThat(owner.queryForObject("SELECT count(*) FROM md_product_unit u JOIN md_product p ON p.id=u.product_id WHERE p.product_code='IMPORT'",Integer.class)).isEqualTo(4);
  assertThat(owner.queryForObject("SELECT count(*) FROM md_product_barcode b JOIN md_product p ON p.id=b.product_id WHERE p.product_code='IMPORT'",Integer.class)).isEqualTo(2);
  confirm("CUSTOMER",List.of(Map.of("code","IC","name","Import customer","storeId",301)));
  confirm("CUSTOMER_ADDRESS",List.of(Map.of("customerCode","IC","addresses",List.of(Map.of("name","Receiver","address","MX address")))));
  assertThat(owner.queryForObject("SELECT addresses::text FROM md_customer WHERE code='IC'",String.class)).contains("MX address");
 }
 @Test void invalidMasterPreviewDoesNotWriteAndStaleNativeVersionRollsBackWholeBatch(){
  var invalid=imports.create(actor,Map.of("importType","PRODUCT","rows",List.of(Map.of("productCode","BAD","name","Bad","baseUnit","PCS","units",List.of(Map.of("unit","BOX","factorToBase",0))))));
  assertThat(invalid.get("status")).isEqualTo("VALIDATION_FAILED");assertThat(owner.queryForObject("SELECT count(*) FROM md_product WHERE product_code='BAD'",Integer.class)).isZero();
  var batch=imports.create(actor,Map.of("importType","PRODUCT_UNIT","rows",List.of(Map.of("productCode","SKU","unit","BOX","factorToBase",2))));
  seed("UPDATE md_product SET version=version+1 WHERE product_code='SKU'");
  assertThatThrownBy(()->imports.confirm(actor,((Number)batch.get("id")).longValue(),UUID.randomUUID().toString())).extracting("code").isEqualTo("SYS_IMPORT_STALE");
  assertThat(owner.queryForObject("SELECT count(*) FROM sys_import_source",Integer.class)).isZero();
 }
 @Test void repeatedExplicitBaseUnitsFailPreviewWithoutWritingMasterFacts(){
  var unit=Map.of("unit","PCS","factorToBase",1);
  var batch=imports.create(actor,Map.of("importType","PRODUCT","rows",List.of(Map.of("productCode","DUPBASE","name","Duplicate base","baseUnit","PCS","units",List.of(unit,unit)))));
  assertThat(batch.get("status")).isEqualTo("VALIDATION_FAILED");
  assertThat(owner.queryForObject("SELECT count(*) FROM md_product WHERE product_code='DUPBASE'",Integer.class)).isZero();
  assertThat(owner.queryForObject("SELECT count(*) FROM sys_import_source",Integer.class)).isZero();
 }
 @Test void confirmRetryReplaysOneNativeProductAndRejectsChangedPayload() throws Exception {
  String token="AI07-master-import-http",intent=UUID.randomUUID().toString();
  seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,201,clock_timestamp()+interval '1 hour')",com.hs.jxc.sys.service.SessionService.digest(token));
  var batch=imports.create(actor,Map.of("importType","PRODUCT","rows",List.of(Map.of("productCode","AI07-RETRY","name","AI07原生导入","baseUnit","PCS"))));
  long id=((Number)batch.get("id")).longValue();
  assertThat(confirmHttp(id,token,intent,"{}").statusCode()).isEqualTo(200);
  assertThat(confirmHttp(id,token,intent,"{}").statusCode()).isEqualTo(200);
  var changed=confirmHttp(id,token,intent,"{\"rows\":[{\"productCode\":\"FORGED\"}]}");
  assertThat(changed.statusCode()).as(changed.body()).isEqualTo(400);
  assertThat(confirmHttp(id,token,UUID.randomUUID().toString(),"{}").statusCode()).isEqualTo(409);
  assertThat(owner.queryForObject("SELECT count(*) FROM md_product WHERE product_code='AI07-RETRY'",Integer.class)).isEqualTo(1);
  assertThat(owner.queryForObject("SELECT count(*) FROM md_product WHERE product_code='FORGED'",Integer.class)).isZero();
  assertThat(owner.queryForObject("SELECT count(*) FROM sys_import_source",Integer.class)).isEqualTo(1);
 }
 @org.junit.jupiter.params.ParameterizedTest
 @org.junit.jupiter.params.provider.ValueSource(strings={"PRICE","STOCK_LIMIT","CREDIT_RULE"})
 void typedCatalogImportsApplyNativeTargetsAndRejectTheWholeInvalidBatch(String type) throws Exception {
  String fieldsBefore=owner.queryForObject("SELECT field_policies::text FROM sys_role WHERE id=211",String.class);
  var row=new LinkedHashMap<String,Object>();String table;String field;
  if(type.equals("PRICE")){
   seed("UPDATE sys_role SET field_policies=field_policies||'{\"CUSTOMER_PRICE\":\"WRITE\"}'::jsonb WHERE id=211");
   row.putAll(Map.of("productCode","SKU","priceType","BASE","unit","PCS","minQty",1,"price",new java.math.BigDecimal("5.25"),"currency","MXN","taxMode","INCL","effectiveFrom","2026-10-15"));table="sal_price";field="price";
  }else if(type.equals("STOCK_LIMIT")){
   row.putAll(Map.of("warehouseCode","W","productCode","SKU","minQty",0,"maxQty",10,"alertEnabled",true));table="inv_stock_limit";field="minQty";
  }else{
   seed("UPDATE sys_role SET field_policies=field_policies||'{\"CREDIT\":\"WRITE\"}'::jsonb WHERE id=211");
   confirm("CUSTOMER",List.of(Map.of("code","AI07-CREDIT-CUSTOMER","name","AI07授信导入客户","storeId",301)));
   long customer=owner.queryForObject("SELECT id FROM md_customer WHERE code='AI07-CREDIT-CUSTOMER'",Long.class);
   row.putAll(Map.of("targetType","CUSTOMER","targetId",customer,"paymentMode","CREDIT_ALLOWED","creditLimit",100,"currency","MXN","effectiveFrom","2026-10-15","termDays",30));table="ar_credit_rule";field="creditLimit";
  }
  assertThat(imports.template(actor,type).toString()).contains(field);
  var invalidRow=new LinkedHashMap<>(row);invalidRow.put(field,-1);
  long before=owner.queryForObject("SELECT count(*) FROM "+table,Long.class);
  var invalid=imports.create(actor,Map.of("importType",type,"rows",List.of(row,invalidRow)));
  assertThat(invalid.get("status")).isEqualTo("VALIDATION_FAILED");
  assertThatThrownBy(()->imports.confirm(actor,((Number)invalid.get("id")).longValue(),UUID.randomUUID().toString())).extracting("code").isEqualTo("SYS_IMPORT_STATE");
  assertThat(owner.queryForObject("SELECT count(*) FROM "+table,Long.class)).isEqualTo(before);
  String bytes=new com.hs.jxc.common.api.JsonCodec().write(List.of(row));
  var batch=imports.create(actor,Map.of("importType",type,"sourceFileText",bytes));
  assertThat(batch).containsEntry("status","VALIDATED").containsEntry("fileSha256",com.hs.jxc.common.api.Digests.sha256(bytes));
  String intent=UUID.randomUUID().toString();long batchId=((Number)batch.get("id")).longValue();
  var result=imports.confirm(actor,batchId,intent);assertThat(result.get("status")).isEqualTo("COMPLETED");
  assertThat(((Number)imports.confirm(actor,batchId,intent).get("id")).longValue()).isEqualTo(((Number)result.get("id")).longValue());
  long target=owner.queryForObject("SELECT target_id FROM sys_import_row WHERE batch_id=?",Long.class,batchId);
  var nativeRow=owner.queryForMap("SELECT * FROM "+table+" WHERE id=?",target);
  String column=field.replaceAll("([a-z])([A-Z])","$1_$2").toLowerCase(Locale.ROOT);
  assertThat(new java.math.BigDecimal(nativeRow.get(column).toString())).isEqualByComparingTo(row.get(field).toString());
  assertThat(owner.queryForObject("SELECT count(*) FROM "+table,Long.class)).isEqualTo(before+1);
  assertThat(owner.queryForObject("SELECT count(*) FROM sys_import_source WHERE import_type=?",Integer.class,type)).isEqualTo(1);
  String directory=System.getProperty("jxc.ai07.evidence.dir");if(directory!=null){java.nio.file.Files.createDirectories(java.nio.file.Path.of(directory));java.nio.file.Files.writeString(java.nio.file.Path.of(directory,"catalog-import-"+type+".json"),new com.hs.jxc.common.api.JsonCodec().write(Map.of("type",type,"input",row,"preview",batch,"confirmed",result,"nativeTarget",nativeRow,"fieldsBefore",fieldsBefore,"fieldsAfter",owner.queryForObject("SELECT field_policies::text FROM sys_role WHERE id=211",String.class))),java.nio.charset.StandardCharsets.UTF_8);}
 }
 java.net.http.HttpResponse<String> confirmHttp(long id,String token,String key,String body) throws Exception {
  return java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+port+"/api/v1/sys/imports/"+id+"/confirm"))
   .header("Authorization","Bearer "+token).header("X-Country-Id","101").header("Content-Type","application/json").header("Idempotency-Key",key)
   .POST(java.net.http.HttpRequest.BodyPublishers.ofString(body)).build(),java.net.http.HttpResponse.BodyHandlers.ofString());
 }
}
