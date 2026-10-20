package com.hs.jxc;
import com.hs.jxc.sys.service.FieldPolicyService;import com.hs.jxc.sys.api.*;import java.util.*;import java.time.Instant;import java.math.BigDecimal;import org.junit.jupiter.api.Test;import static org.assertj.core.api.Assertions.*;
class ContextualAmountsTest {
 @Test void identicalBalanceNamesUseTheCurrentDomainPolicyRatherThanIntersectingAllModules(){
  var fields=new FieldPolicyService();fields.register("COST","openAmount","offsetAmount");fields.register("CREDIT","openAmount","offsetAmount");
  var ar=new Access(1,1L,false,Set.of("ar:receivable:view"),Map.of("CREDIT","READ"),new DataScope(true,Set.of(),Set.of(),Set.of(),Set.of()),Instant.MAX);
  var row=Map.<String,Object>of("id",1,"openAmount",new BigDecimal("12"),"offsetAmount",new BigDecimal("2"));
  assertThat(fields.mask(ar,row,"CREDIT")).containsKeys("openAmount","offsetAmount");assertThat(fields.mask(ar,row,"COST")).doesNotContainKeys("openAmount","offsetAmount");
 }
 @Test void moduleSpecificLimitsCannotExceedTheFrozenBrowserDecimalBoundary(){
  assertThatThrownBy(()->com.hs.jxc.common.api.Inputs.decimal(new BigDecimal("100000000000.0001"),4,new BigDecimal("99999999999999"))).isInstanceOf(com.hs.jxc.common.api.ApiException.class);
  var a=new Access(1,1L,false,Set.of("*"),Map.of("ORDER_TOTAL","READ"),new DataScope(true,Set.of(),Set.of(),Set.of(),Set.of()),Instant.MAX);
  assertThatThrownBy(()->new FieldPolicyService().mask(a,Map.of("totalAmount",new BigDecimal("200000000000")),"ORDER_TOTAL")).isInstanceOf(com.hs.jxc.common.api.ApiException.class);
 }

 @Test void opaqueCostJsonAndBankReferencesCannotBypassFieldGroups(){
  var fields=new FieldPolicyService();var a=new Access(1,1L,false,Set.of("*"),Map.of("ORDER_TOTAL","READ"),new DataScope(true,Set.of(),Set.of(),Set.of(),Set.of()),Instant.MAX);
  assertThat(fields.mask(a,Map.of("id",1,"costSource","{\"originalAmount\":120}","referenceNo","bank-sensitive"),"COST")).doesNotContainKeys("costSource","referenceNo");
 }

}
