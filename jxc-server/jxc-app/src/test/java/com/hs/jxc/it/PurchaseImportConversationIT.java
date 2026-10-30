package com.hs.jxc.it;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class PurchaseImportConversationIT extends PurchaseImportFixture {
    Map<String,Object> identifierSource(){var b=upload(UUID.randomUUID().toString());var doc=document();((Map<String,Object>)rows(doc).getFirst().get("normalizedValues")).put("sourceOrderNo",null);
        doc.put("sheets",List.of(Map.of("name","采购","role","PURCHASE","reviewContext",Map.of("format","SourceReviewContextV1","columns",List.of(),"imageCount",0,"subjects",List.of(Map.of("id","title:A1","kind","IDENTIFIER","label","NY-051","examples",List.of("NY-051")))))));
        doReturn(doc).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));return imports.get(actor,id(b));}
    Map<String,Object> meaning(String subject,String value,String before){var m=new LinkedHashMap<String,Object>();m.put("subjectId",subject);m.put("meaning",value);m.put("previousMeaning",before);return m;}
    @Test void confirmedTitleUsesOriginalValueAndReclassificationBlocksWrongOrderNumber(){
        var b=identifierSource();var body=answer(b,"sourceOrderNo","NY-051");body.put("interpretation",meaning("采购:title:A1","ORDER_NUMBER",null));var saved=imports.confirmReview(actor,id(b),body,UUID.randomUUID().toString());
        assertThat(rows(saved).getFirst()).containsEntry("sourceOrderNo","NY-051");
        body=answer(saved,"sourceOrderNo","unused");body.put("changes",List.of());body.put("interpretation",meaning("采购:title:A1","PRODUCT_CODE","ORDER_NUMBER"));var changed=imports.confirmReview(actor,id(b),body,UUID.randomUUID().toString());
        var preview=draftService.previews(actor,id(b),Map.of("batchVersion",changed.get("version")));assertThat(groups(preview).getFirst().get("errors").toString()).contains("不是采购单号");
    }
    @org.springframework.beans.factory.annotation.Autowired com.hs.jxc.pur.service.impl.PurchaseImportDraftServiceImpl draftService;
    @Test void sourceMeaningRejectsBusinessValuesUnrelatedToOriginalText(){var b=identifierSource();var body=answer(b,"sourceOrderNo","伪造新单号");body.put("interpretation",meaning("采购:title:A1","ORDER_NUMBER",null));
        assertThatThrownBy(()->imports.confirmReview(actor,id(b),body,UUID.randomUUID().toString())).hasMessageContaining("夹带");assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("sourceOrderNo",null);}
    @Test void sourceMeaningIsSavedSeparatelyAndUsdDoesNotChangeBusinessHeader(){
        var b=upload(UUID.randomUUID().toString());var doc=document();var context=Map.of("format","SourceReviewContextV1","subjects",List.of(Map.of("id","column:K","kind","USD_AMOUNT","label","cost usd","examples",List.of("12.25"))));
        doc.put("sheets",List.of(Map.of("name","采购","role","PURCHASE","reviewContext",context)));
        doReturn(doc).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));var saved=imports.get(actor,id(b));
        var body=answer(saved,"sourceOrderNo","unused");body.put("changes",List.of());var meaning=new LinkedHashMap<String,Object>();meaning.put("subjectId","采购:column:K");meaning.put("meaning","USD_AMOUNT");meaning.put("previousMeaning",null);body.put("interpretation",meaning);
        var result=imports.confirmReview(actor,id(b),body,UUID.randomUUID().toString());assertThat(result.get("header")).isEqualTo(saved.get("header"));
        var source=((List<Map<String,Object>>)result.get("sources")).getFirst();assertThat(source.get("sheets").toString()).contains("reviewAnswers").contains("USD_AMOUNT");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    @Test void featureImageExposesConfirmedReviewApiWithoutCreatingPurchase() throws Exception {
        String image=System.getProperty("jxc.test.purchase-image");org.junit.jupiter.api.Assumptions.assumeTrue(image!=null,"Docker接口验证须显式指定特性镜像");
        var b=identifierSource();var body=answer(b,"sourceOrderNo","NY-051");body.put("interpretation",meaning("采购:title:A1","ORDER_NUMBER",null));String key=UUID.randomUUID().toString();
        try(var app=featureContainer(image,false)){app.start();var http=java.net.http.HttpClient.newHttpClient();String url="http://"+app.getHost()+":"+app.getMappedPort(8080)+"/api/v1/pur/order-imports/"+id(b)+"/review";
            var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(url)).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Idempotency-Key",key).header("Content-Type","application/json").POST(java.net.http.HttpRequest.BodyPublishers.ofString(new com.hs.jxc.common.api.JsonCodec().write(body))).build();
            assertThat(http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(200);
            assertThat(http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(200);
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import WHERE source_order_no='NY-051'",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
        }
    }
    Map<String,Object> pending(){var b=upload(UUID.randomUUID().toString());var doc=document();
        ((Map<String,Object>)rows(doc).getFirst().get("normalizedValues")).put("sourceOrderNo",null);
        doReturn(doc).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));return imports.get(actor,id(b));}
    Map<String,Object> answer(Map<String,Object> b,String field,String value){var r=rows(b).getFirst();var source=((List<Map<String,Object>>)b.get("sources")).getFirst();return new LinkedHashMap<>(Map.of("sourceId",source.get("id"),"fileSha256",source.get("fileSha256"),"batchVersion",b.get("version"),"confirm",true,"changes",List.of(Map.of("rowId",r.get("id"),"version",r.get("version"),"values",Map.of(field,value)))));}
    @Test void confirmedAnswerUpdatesOriginalRowAndSameKeyNeverDuplicates(){var b=pending();var body=answer(b,"sourceOrderNo","NY-051");String key=UUID.randomUUID().toString();
        var updated=imports.confirmReview(actor,id(b),body,key);assertThat(rows(updated).getFirst()).containsEntry("sourceOrderNo","NY-051");
        imports.confirmReview(actor,id(b),body,key);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT field_origins->>'sourceOrderNo' FROM pur_order_import",String.class)).isEqualTo("MANUAL");}
    @Test void conversationCannotOverwriteExistingValues(){var b=pending();assertThatThrownBy(()->imports.confirmReview(actor,id(b),answer(b,"productSpec","L"),UUID.randomUUID().toString())).hasMessageContaining("已有值");assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("productSpec","S");}
    @Test void wrongSourceOrStaleVersionCannotApply(){var b=pending();var bad=answer(b,"sourceOrderNo","NY-051");bad.put("fileSha256","0".repeat(64));assertThatThrownBy(()->imports.confirmReview(actor,id(b),bad,UUID.randomUUID().toString())).hasMessageContaining("来源");
        var stale=answer(b,"sourceOrderNo","NY-051");stale.put("batchVersion",999);assertThatThrownBy(()->imports.confirmReview(actor,id(b),stale,UUID.randomUUID().toString())).isInstanceOf(com.hs.jxc.common.api.ApiException.class);}
    @Test void duplicateOrInvalidChangesRollBackWholeConfirmation(){var b=pending();var body=answer(b,"sourceOrderNo","NY-051");var change=((List<?>)body.get("changes")).getFirst();body.put("changes",List.of(change,change));
        assertThatThrownBy(()->imports.confirmReview(actor,id(b),body,UUID.randomUUID().toString())).hasMessageContaining("重复");assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("sourceOrderNo",null);}
}
