package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.imports.ImportService;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
class MasterImportIT extends BasePgIT {
 @Autowired ImportService imports;
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
}
