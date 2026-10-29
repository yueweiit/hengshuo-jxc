package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.pur.service.impl.PurchaseImportProductServiceImpl;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;

class PurchaseImportReviewIT extends PurchaseImportFixture {
    @Autowired PurchaseImportProductServiceImpl review;
    @BeforeEach void productPermissions(){owner.update("UPDATE sys_role SET permissions=permissions||'[\"md:product:view\",\"md:product:edit\"]'::jsonb WHERE id=801");}
    Map<String,Object> prepared(){var b=upload(UUID.randomUUID().toString());parse(b);return imports.get(actor,id(b));}
    long rowId(Map<String,Object>b){return ((Number)rows(b).getFirst().get("id")).longValue();}
    Map<String,Object> product(){return Map.of("productCode","NEW-IMPORT","name","Imported product","baseUnit","PCS","spec","S");}
    Map<String,Object> request(){return Map.of("version",1,"confirmNew",true,"product",product(),"unit","PCS");}
    @Test void existingZeroStockProductAndUnitCanBeConfirmedWithoutImagesOrAi(){
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_stock_summary WHERE product_id=501",Integer.class)).isZero();
        var b=prepared();var result=review.decide(actor,id(b),rowId(b),Map.of("version",1,"decision","EXISTING","productId",501,"unit","PCS"));assertThat(result).containsEntry("readiness","READY").containsEntry("matchedProductId",501L);assertThat(owner.queryForObject("SELECT count(*) FROM md_product",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("SELECT count(*) FROM md_product_unit_used",Integer.class)).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_stock_summary WHERE product_id=501",Integer.class)).isZero();
    }
    @Test void disabledCountryAndMissingUnitAreSetupWorkNotNewProducts(){
        var b=prepared();owner.update("UPDATE md_country_sku SET status='DISABLED' WHERE product_id=501");var first=review.decide(actor,id(b),rowId(b),Map.of("version",1,"decision","EXISTING","productId",501,"unit","BOX"));assertThat(first).containsEntry("readiness","NEEDS_SETUP");assertThat(first.get("setupReasons")).asString().contains("本国","单位");assertThat(owner.queryForObject("SELECT count(*) FROM md_product",Integer.class)).isEqualTo(1);
    }
    @Test void purchaseRightsCannotCreateGlobalProducts(){
        var b=prepared();assertThatThrownBy(()->review.createProduct(actor,id(b),rowId(b),request(),UUID.randomUUID().toString())).isInstanceOf(ApiException.class).extracting("status").isEqualTo(403);assertThat(owner.queryForObject("SELECT count(*) FROM md_product",Integer.class)).isEqualTo(1);
    }
    @Test void globalSuccessAndCountryFailureReturnRealIdAndRetryOnlyMissingStep(){
        var b=prepared();owner.update("UPDATE sys_user SET is_platform_admin=true WHERE id=201");String key=UUID.randomUUID().toString();
        var failure=catchThrowable(()->review.createProduct(actor,id(b),rowId(b),request(),key));assertThat(failure).isInstanceOf(ApiException.class);var details=(Map<?,?>)((ApiException)failure).getData();assertThat(details.containsKey("partialResult")).isTrue();assertThat(owner.queryForObject("SELECT count(*) FROM md_product WHERE product_code='NEW-IMPORT'",Integer.class)).isEqualTo(1);
        owner.update("UPDATE sys_role SET permissions=permissions||'[\"md:country-sku:edit\"]'::jsonb WHERE id=801");var result=review.createProduct(actor,id(b),rowId(b),request(),key);assertThat(result).containsEntry("readiness","READY");long product=((Number)result.get("matchedProductId")).longValue();assertThat(owner.queryForObject("SELECT count(*) FROM md_product WHERE product_code='NEW-IMPORT'",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("SELECT status FROM md_country_sku WHERE product_id=?",String.class,product)).isEqualTo("ENABLED");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    @Test void editingSpecificationRevokesOldConfirmationAndNeverChangesSource(){
        var b=prepared();review.decide(actor,id(b),rowId(b),Map.of("version",1,"decision","EXISTING","productId",501,"unit","PCS"));var value=values();value.put("productSpec","M");imports.saveRow(actor,id(b),rowId(b),Map.of("version",2,"values",value));var saved=rows(imports.get(actor,id(b))).getFirst();assertThat(saved).containsEntry("readiness","UNRESOLVED");assertThat(saved.get("confirmedAt")).isNull();
    }
    @Test void fakeProductAndStaleRowsCannotBeConfirmed(){
        var b=prepared();assertThatThrownBy(()->review.decide(actor,id(b),rowId(b),Map.of("version",1,"decision","EXISTING","productId",999999,"unit","PCS"))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);review.decide(actor,id(b),rowId(b),Map.of("version",1,"decision","DEFERRED"));assertThatThrownBy(()->review.decide(actor,id(b),rowId(b),Map.of("version",1,"decision","EXISTING","productId",501,"unit","PCS"))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);
    }
    @Test void concurrentSameCodeConfirmationCreatesOnlyOneGlobalProduct()throws Exception {
        var b=parsedRows(2);var saved=imports.get(actor,id(b));owner.update("UPDATE sys_user SET is_platform_admin=true WHERE id=201");owner.update("UPDATE sys_role SET permissions=permissions||'[\"md:country-sku:edit\"]'::jsonb WHERE id=801");long first=((Number)rows(saved).get(0).get("id")).longValue(),second=((Number)rows(saved).get(1).get("id")).longValue();assertThat(compete(()->review.createProduct(actor,id(b),first,request(),UUID.randomUUID().toString()),()->review.createProduct(actor,id(b),second,request(),UUID.randomUUID().toString()))).isEqualTo(1);assertThat(owner.queryForObject("SELECT count(*) FROM md_product WHERE product_code='NEW-IMPORT'",Integer.class)).isEqualTo(1);
    }
    @Test void confirmedCountryStepIsNotRepeatedWhenUnitSetupIsStillMissing(){
        var b=prepared();owner.update("UPDATE sys_user SET is_platform_admin=true WHERE id=201");owner.update("UPDATE sys_role SET permissions=permissions||'[\"md:country-sku:edit\"]'::jsonb WHERE id=801");var body=new LinkedHashMap<String,Object>(request());body.put("unit","BOX");String key=UUID.randomUUID().toString();var first=review.createProduct(actor,id(b),rowId(b),body,key);assertThat(first).containsEntry("readiness","NEEDS_SETUP");long product=((Number)first.get("matchedProductId")).longValue();owner.update("INSERT INTO md_product_unit(product_id,unit,factor_to_base) VALUES(?,'BOX',12)",product);var restored=review.createProduct(actor,id(b),rowId(b),body,key);assertThat(restored).containsEntry("readiness","READY");assertThat(owner.queryForObject("SELECT version FROM md_country_sku WHERE product_id=?",Integer.class,product)).isEqualTo(1);
    }
}
