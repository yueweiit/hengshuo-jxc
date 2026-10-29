package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.pur.service.impl.PurchaseImportNameSuggestion;
import com.hs.jxc.common.api.ApiException;
import java.util.*;
import org.junit.jupiter.api.Test;

class PurchaseImportNameSuggestionTest {
    Map<String,Object> ready(String category,String baseName){return Map.of("status","READY","category",category,"baseName",baseName,"reason","来源图片可辨认实际物品","sourceKeys",List.of("SOURCE:7"));}
    @Test void explicitSizesAreComposedFromOneVisualBaseWithoutGuessing(){
        var input=ready("裤子","黑色条纹裤子");
        assertThat(PurchaseImportNameSuggestion.validate(input,"S",Set.of("SOURCE:7"))).containsEntry("name","S码黑色条纹裤子");
        assertThat(PurchaseImportNameSuggestion.validate(input,"M",Set.of("SOURCE:7"))).containsEntry("name","M码黑色条纹裤子");
        assertThat(PurchaseImportNameSuggestion.validate(input,"XXL",Set.of("SOURCE:7"))).containsEntry("name","XXL码黑色条纹裤子");
    }
    @Test void categoriesAreOpenAndDimensionsRemainLiteral(){
        assertThat(PurchaseImportNameSuggestion.validate(ready("杯垫","蓝色圆形杯垫"),null,Set.of("SOURCE:7"))).containsEntry("name","蓝色圆形杯垫");
        assertThat(PurchaseImportNameSuggestion.validate(ready("餐垫","绿色餐垫"),"30×45cm",Set.of("SOURCE:7"))).containsEntry("name","30×45cm绿色餐垫");
    }
    @Test void uncertainCategoryIsExplicitAndNeverBecomesASuccessfulEmptyName(){
        var input=new LinkedHashMap<String,Object>();input.put("status","NEEDS_REVIEW");input.put("category",null);input.put("baseName",null);input.put("sourceKeys",List.of("SOURCE:7"));input.put("reason","杯垫或餐垫用途无法区分");
        assertThat(PurchaseImportNameSuggestion.validate(input,"S",Set.of("SOURCE:7"))).containsEntry("name",null).containsEntry("status","NEEDS_REVIEW");
    }
    @Test void placeholderNamesAndMissingOrCandidateOnlyEvidenceAreRejected(){
        for(var input:List.of(ready("商品","NY-051验收商品08"),ready("杯垫","蓝色杯垫"))){
            assertThatThrownBy(()->PurchaseImportNameSuggestion.validate(input,"S",Set.of())).isInstanceOf(ApiException.class);
        }
        var input=new LinkedHashMap<>(ready("杯垫","蓝色杯垫"));input.put("sourceKeys",List.of("CANDIDATE:8"));
        assertThatThrownBy(()->PurchaseImportNameSuggestion.validate(input,"S",Set.of("SOURCE:7","CANDIDATE:8"))).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->PurchaseImportNameSuggestion.validate(ready("商品","NY-051验收商品08"),"S",Set.of("SOURCE:7"))).isInstanceOf(ApiException.class);
    }
    @Test void modelCannotOverrideTheRowSizeOrInjectOtherResultFields(){
        var input=new LinkedHashMap<>(ready("裤子","黑色条纹裤子"));input.put("productSpec","M");
        assertThatThrownBy(()->PurchaseImportNameSuggestion.validate(input,"S",Set.of("SOURCE:7"))).isInstanceOf(ApiException.class);
    }
}
