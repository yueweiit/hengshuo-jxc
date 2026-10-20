package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.*;
import com.hs.jxc.md.CustomerMasterService;
import com.hs.jxc.md.controller.ProductFxController;
import com.hs.jxc.md.api.MasterProductApi;
import java.math.BigDecimal;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
class MasterDataIT extends BasePgIT {
 @Autowired CustomerMasterService customers;@Autowired MasterProductApi products;@Autowired ProductFxController productController;
 @LocalServerPort int port;@Autowired tools.jackson.databind.ObjectMapper json;
 final RequestContext actor=new RequestContext(201,101L,"master-test","a".repeat(64));
 @BeforeEach void fixture(){InventoryIT.seedBase();seed("INSERT INTO md_currency(code,name) VALUES('MXN','Peso')");seed("INSERT INTO sys_authz_epoch(country_id) VALUES(101)");seed("UPDATE sys_user SET is_platform_admin=true WHERE id=201");seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(repeat('a',64),201,clock_timestamp()+interval '1 hour')");seed("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(211,101,'MD','Master','[\"md:product:view\",\"md:product:edit\",\"md:country-sku:edit\",\"md:customer:view\",\"md:customer:edit\"]','{\"BANK_INFO\":\"WRITE\"}')");seed("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(101,201,211)");seed("INSERT INTO org_store(id,country_id,entity_id,code,name) VALUES(501,101,301,'STORE','Store')");seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,store_id,granted_by) VALUES(101,201,'STORE',501,201)");}
 String key(){return UUID.randomUUID().toString();}
 @SuppressWarnings("unchecked") Map<String,Object> expenseApi(String method,String path,Map<String,Object> body)throws Exception{
  var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+port+"/api/v1"+path)).header("Authorization","Bearer master-expense-http").header("X-Country-Id","101").header("Content-Type","application/json").header("Idempotency-Key",key()).method(method,body==null?java.net.http.HttpRequest.BodyPublishers.noBody():java.net.http.HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
  var response=java.net.http.HttpClient.newHttpClient().send(request,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);return (Map<String,Object>)json.readValue(response.body(),Map.class).get("data");
 }
 @ParameterizedTest @ValueSource(strings={"CAPITALIZE","EXPENSE","PERIOD_EXPENSE","DIRECT_SELLING"})
 void nativeExpenseItemConfigurationSupportsExistingTreatmentsAndDirectSellingUse(String treatment)throws Exception{
  seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,201,clock_timestamp()+interval '1 hour')",com.hs.jxc.common.api.Digests.sha256("master-expense-http"));
  seed("UPDATE sys_role SET permissions=permissions||'[\"md:expense-item:edit\",\"cst:expense:create\",\"cst:expense:confirm\"]'::jsonb,field_policies=field_policies||'{\"COST\":\"WRITE\"}'::jsonb WHERE id=211");
  seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(101,201,'COUNTRY_ALL',201)");
  var body=new LinkedHashMap<String,Object>(Map.of("bookId",601,"code","EXPENSE_"+treatment,"name","Native "+treatment,"costTreatment",treatment,"feeCategory","OTHER"));
  var item=expenseApi("POST","/md/expense-items",body);long id=((Number)item.get("id")).longValue();
  assertThat(expenseApi("GET","/md/expense-items/"+id,null).get("costTreatment")).isEqualTo(treatment);
  body.put("version",item.get("version"));body.put("name","Updated "+treatment);assertThat(expenseApi("PUT","/md/expense-items/"+id,body).get("costTreatment")).isEqualTo(treatment);
  if(!treatment.equals("CAPITALIZE")){
   var expense=expenseApi("POST","/cst/expenses",Map.of("bookId",601,"expenseItemId",id,"currency","MXN","amount",new BigDecimal("12.34"),"bizDate","2026-10-15","lines",treatment.equals("DIRECT_SELLING")?List.of(Map.of("productId",501,"amount",new BigDecimal("12.34"))):List.of()));
   assertThat(expense.get("treatment")).isEqualTo(treatment.equals("DIRECT_SELLING")?treatment:"PERIOD_EXPENSE");
   assertThat(new BigDecimal(expense.get("baseAmount").toString())).isEqualByComparingTo("12.34");
   if(treatment.equals("DIRECT_SELLING"))assertThat(owner.queryForObject("SELECT sum(amount) FROM cst_expense_alloc_line WHERE expense_id=?",BigDecimal.class,expense.get("id"))).isEqualByComparingTo("12.34");
  }
 }
 @Test void productDimensionsRoundTripAndInvalidUpdateDoesNotCommit(){
  RequestContextHolder.set(actor);
  try {
   var body=new LinkedHashMap<String,Object>(Map.of("productCode","DIMENSION","name","Measured product","baseUnit","PCS","grossWeight",new BigDecimal("1.2345"),"volume",new BigDecimal("0.0678")));
   var first=(Map<?,?>)productController.productCreate(body,key()).data();long id=((Number)first.get("id")).longValue();
   assertThat(new BigDecimal(first.get("grossWeight").toString())).isEqualByComparingTo("1.2345");
   assertThat(new BigDecimal(first.get("volume").toString())).isEqualByComparingTo("0.0678");
   body.put("version",first.get("version"));body.put("grossWeight",new BigDecimal("2.5000"));
   var changed=(Map<?,?>)productController.productUpdate(id,body,key()).data();
   assertThat(new BigDecimal(changed.get("grossWeight").toString())).isEqualByComparingTo("2.5");
   body.put("version",changed.get("version"));body.put("volume",new BigDecimal("-1"));
   assertThatThrownBy(()->productController.productUpdate(id,body,key())).isInstanceOf(ApiException.class);
   assertThat(owner.queryForObject("SELECT volume FROM md_product WHERE id=?",BigDecimal.class,id)).isEqualByComparingTo("0.0678");
  } finally {RequestContextHolder.clear();}
 }
 @Test void customerSameIntentReplaysAndCurrentStoreScopeControlsListAndDetail(){var body=Map.<String,Object>of("code","C","name","Customer","storeId",501,"addresses",List.of(Map.of("contact","Test")));String intent=key();var first=customers.save(actor,"customers",null,body,intent);var replay=customers.save(actor,"customers",null,body,intent);long id=((Number)first.get("id")).longValue();assertThat(((Number)replay.get("id")).longValue()).isEqualTo(id);assertThat(customers.get(actor,"customers",id).get("addresses")).isInstanceOf(List.class);seed("DELETE FROM sys_user_data_scope WHERE user_id=201");assertThatThrownBy(()->customers.get(actor,"customers",id)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);assertThat(((Map<?,?>)customers.list(actor,"customers",Map.of())).get("total")).isEqualTo(0L);}
 @Test void missingBankKeyRejectsRawAccountAndNeverCommitsMaskedOnlySubstitute(){var customer=customers.save(actor,"customers",null,Map.of("code","C","name","Customer","storeId",501),key());long id=((Number)customer.get("id")).longValue();assertThatThrownBy(()->customers.saveBank(actor,id,null,Map.of("bankName","Bank","accountName","Customer","accountNo","1234567890123","currency","MXN"),key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("MD_BANK_ENCRYPTION_REQUIRED");assertThat(owner.queryForObject("SELECT count(*) FROM md_customer_bank",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT coalesce(string_agg(after_value::text,''),'') FROM sys_audit_log",String.class)).doesNotContain("1234567890123");}
 @Test void globalUnitConversionIsExplicitAndUsedFactorCannotBeChanged(){RequestContextHolder.set(actor);try{var body=Map.<String,Object>of("productCode","GLOBAL","name","Global product","baseUnit","PCS","units",List.of(Map.of("unit","BOX","factorToBase",new BigDecimal("24"))),"barcodes",List.of(Map.of("barcode","GLOBAL-BOX","unit","BOX")));var envelope=productController.productCreate(body,key());var first=(Map<?,?>)envelope.data();long id=((Number)first.get("id")).longValue();productController.sku(id,Map.of("enabled",true),key());inCountry(101,()->{var p=products.requireEnabled(101,id,"BOX");assertThat(products.toBase(p,BigDecimal.ONE)).isEqualByComparingTo("24");assertThatThrownBy(()->products.requireEnabled(101,id,"MISSING")).isInstanceOf(ApiException.class);return null;});var changed=new LinkedHashMap<>(body);changed.put("version",first.get("version"));changed.put("units",List.of(Map.of("unit","BOX","factorToBase",new BigDecimal("25"))));assertThatThrownBy(()->productController.productUpdate(id,changed,key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("MD_REFERENCED");assertThat(owner.queryForObject("SELECT factor_to_base FROM md_product_unit WHERE product_id=? AND unit='BOX'",BigDecimal.class,id)).isEqualByComparingTo("24");}finally{RequestContextHolder.clear();}}
}
