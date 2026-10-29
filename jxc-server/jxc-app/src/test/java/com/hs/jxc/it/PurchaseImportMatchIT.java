package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import com.hs.jxc.pur.service.impl.*;
import com.hs.jxc.pur.service.PurchaseImportRecognitionClient;
import com.hs.jxc.common.api.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

class PurchaseImportMatchIT extends PurchaseImportFixture {
    @org.springframework.beans.factory.annotation.Autowired com.hs.jxc.pur.mapper.PurchaseImportMatchMapper matchMapper;
    @Autowired PurchaseImportMatchServiceImpl matches;
    @Autowired PurchaseImportProductServiceImpl review;
    @Autowired PurchaseImportPhotoServiceImpl photos;
    @Autowired com.hs.jxc.md.api.ProductImageApi catalogImages;
    @DynamicPropertySource static void recognition(DynamicPropertyRegistry r){r.add("jxc.purchase-import.recognition.enabled",()->true);}
    @BeforeEach void matchPermissions(){owner.update("UPDATE sys_role SET permissions=permissions||'[\"md:product:view\"]'::jsonb WHERE id=801");doThrow(new ApiException(503,"N8N_UNAVAILABLE","受限识别工作流不可用")).when(parser).recognize(any(),anyString(),anyMap());}
    Map<String,Object> source(String code){var b=upload(UUID.randomUUID().toString());parse(b);if(code!=null)imports.saveRow(actor,id(b),rowId(b),Map.of("version",1,"values",values(),"matchInputs",Map.of("suppliedProductCode",code,"suppliedProductName","","supplierProductCode","")));return imports.get(actor,id(b));}
    long rowId(Map<String,Object>b){return ((Number)rows(imports.get(actor,id(b))).getFirst().get("id")).longValue();}
    UUID start(Map<String,Object>b){var result=matches.start(actor,id(b),Map.of("batchVersion",imports.get(actor,id(b)).get("version"),"rowIds",List.of(rowId(b)),"topK",5),UUID.randomUUID().toString());return UUID.fromString(((List<?>)result.get("taskIds")).getFirst().toString());}
    @SuppressWarnings("unchecked") Map<String,Object> matched(Map<String,Object>b){return (Map<String,Object>)rows(imports.get(actor,id(b))).getFirst().get("matchResult");}
    Map<String,Object> photoBatch(boolean published){owner.update("UPDATE sys_role SET permissions=permissions||'[\"md:product:edit\"]'::jsonb WHERE id=801");var b=upload(UUID.randomUUID().toString());doReturn(photoDocument()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));long image=owner.queryForObject("SELECT id FROM pur_order_import_image",Long.class);imports.associate(actor,id(b),rowId(b),image,Map.of("version",1,"association","CONFIRMED"));if(published){review.decide(actor,id(b),rowId(b),Map.of("version",2,"decision","EXISTING","productId",501,"unit","PCS"));var result=photos.publish(actor,id(b),rowId(b),Map.of("version",3,"confirmOwnership",true,"imageIds",List.of(image)),UUID.randomUUID().toString());doReturn(vector()).when(parser).embed(any(),anyString(),anyLong(),anyString());doAnswer(call->indexResult(call.getArgument(2))).when(parser).index(any(),anyString(),anyMap());tasks.execute(101,UUID.fromString(((List<?>)result.get("taskIds")).getFirst().toString()));}return imports.get(actor,id(b));}
    @SuppressWarnings("unchecked") Map<String,Object> map(Object value){return (Map<String,Object>)value;}
    @Test void sourceOnlyPhotoNamingSurvivesReloadWithoutCreatingOrRenamingProducts(){
        var b=photoBatch(false);String originalName=owner.queryForObject("SELECT name FROM md_product WHERE id=501",String.class);UUID task=start(b);
        doAnswer(call->{String credential=call.getArgument(1);matches.catalogSearch(task,credential,Map.of("operation","TEXT"));
            var evidence=matches.catalogSearch(task,credential,Map.of("operation","RESOLVE","imageResults",List.of()));
            var pictures=matches.catalogSearch(task,credential,Map.of("operation","REVIEW"));
            assertThat((List<?>)pictures.get("images")).hasSize(1);assertThat((List<?>)pictures.get("pairs")).isEmpty();
            String sourceKey=map(((List<?>)pictures.get("images")).getFirst()).get("key").toString();
            var body=new LinkedHashMap<>(callback(task,evidence,List.of()));var explanation=new LinkedHashMap<>(map(body.get("explanation")));
            explanation.put("candidateChecks",List.of());explanation.put("productNameSuggestion",Map.of("status","READY","category","裤子","baseName","黑色条纹裤子","reason","来源图可见黑色条纹裤子","sourceKeys",List.of(sourceKey)));body.put("explanation",explanation);
            matches.result(task,credential,body);return Map.of("taskId",task.toString());
        }).when(parser).recognize(any(),anyString(),anyMap());tasks.execute(101,task);
        assertThat(tasks.get(actor,task)).containsEntry("status","FAILED").containsEntry("errorCode","MATCH_COMPONENT_FAILED"); // 图库不可用仍是真实匹配失败，独立命名结果保留。
        assertThat(map(map(matched(b).get("explanation")).get("productNameSuggestion"))).containsEntry("name","S码黑色条纹裤子");
        assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("suppliedProductName",null).containsEntry("matchedProductId",null);
        assertThat(owner.queryForObject("SELECT name FROM md_product WHERE id=501",String.class)).isEqualTo(originalName);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    @Test void namedPhotoCacheRecomposesTheCurrentSizeWithoutCallingModelOrFeedingMatchingInputs(){
        var b=photoBatch(true);owner.update("UPDATE md_product SET spec='S',version=version+1 WHERE id=501");
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);
        doAnswer(call->{UUID task=call.getArgument(0);String credential=call.getArgument(1);var catalog=matches.catalogSearch(task,credential,Map.of("operation","TEXT"));
            var request=map(((List<?>)map(catalog.get("imagePlan")).get("requests")).getFirst());
            var evidence=matches.catalogSearch(task,credential,Map.of("operation","RESOLVE","imageResults",List.of(Map.of("queryAssetId",request.get("queryAssetId"),"status","FOUND","hits",List.of(Map.of("featureId",feature,"score",0.99))))));
            var pictures=matches.catalogSearch(task,credential,Map.of("operation","REVIEW"));String sourceKey=map(((List<?>)pictures.get("pairs")).getFirst()).get("sourceKey").toString();
            var body=new LinkedHashMap<>(callback(task,evidence,List.of(501L)));var explanation=new LinkedHashMap<>(map(body.get("explanation")));
            explanation.put("candidateChecks",List.of(Map.of("productId",501,"imageMatch","SAME","imageReason","照片同款","specMatch","MATCH","specReason","S一致")));
            explanation.put("productNameSuggestion",Map.of("status","READY","category","裤子","baseName","黑色条纹裤子","reason","已看来源图","sourceKeys",List.of(sourceKey)));body.put("explanation",explanation);matches.result(task,credential,body);return Map.of("taskId",task.toString());
        }).when(parser).recognize(any(),anyString(),anyMap());
        tasks.execute(101,start(b));assertThat(map(map(matched(b).get("explanation")).get("productNameSuggestion"))).containsEntry("name","S码黑色条纹裤子");
        var row=rows(imports.get(actor,id(b))).getFirst();var changed=values();changed.put("productSpec","M");imports.saveRow(actor,id(b),rowId(b),Map.of("version",row.get("version"),"values",changed));clearInvocations(parser);
        tasks.execute(101,start(b));assertThat(matched(b)).containsEntry("cacheReused",true);
        assertThat(map(map(matched(b).get("explanation")).get("productNameSuggestion"))).containsEntry("name","M码黑色条纹裤子");
        assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("suppliedProductName",null);
        verify(parser,never()).recognize(any(),anyString(),anyMap());verify(parser,never()).search(any(),anyString(),anyMap());
    }
    @Test void sourceOnlyModelFailureIsUnavailableRatherThanAClaimOfNoNamingInput(){
        var b=photoBatch(false);tasks.execute(101,start(b));
        assertThat(map(matched(b).get("explanation"))).containsEntry("status","UNAVAILABLE");
        assertThat(map(matched(b).get("explanation")).get("message")).asString().contains("N8N_UNAVAILABLE");
    }
    Map<String,Object> freshPhotoBatch(){photoBatch(true);var b=upload(UUID.randomUUID().toString());doReturn(photoDocument()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));return imports.get(actor,id(b));}
    @Test void batchSourceOnlyNamingUsesTheOriginalSourceKeyAfterSharedImagePacking(){
        var b=photoBatch(false);UUID task=start(b);
        doAnswer(call->{Map<String,Object> request=call.getArgument(2);var input=map(((List<?>)request.get("rows")).getFirst());var source=map(((List<?>)input.get("sourceImages")).getFirst());
            assertThat(source.get("sourceKey")).asString().startsWith("SOURCE:");assertThat(source.get("imageKey")).asString().startsWith("IMAGE:");
            var item=new LinkedHashMap<String,Object>();for(String key:List.of("runId","rowId","inputRevision","evidenceHash"))item.put(key,input.get(key));
            item.put("explanation",Map.of("status","READY","message","命名完成","candidateIds",List.of(),"candidateChecks",List.of(),"productNameSuggestion",Map.of("status","READY","category","裤子","baseName","黑色条纹裤子","reason","已看本行来源图片","sourceKeys",List.of(source.get("sourceKey")))));
            return Map.of("format","MatchReviewBatchResultV1","items",List.of(item));
        }).when(parser).reviewBatch(any(),anyString(),anyMap());
        matches.executeBatch(101,List.of(task),tasks);
        assertThat(map(map(matched(b).get("explanation")).get("productNameSuggestion"))).containsEntry("name","S码黑色条纹裤子");
        verify(parser,times(1)).reviewBatch(any(),anyString(),anyMap());verify(parser,never()).recognize(any(),anyString(),anyMap());
    }
    @Test void freshUnconfirmedPhotoCanRecommendBeforeOwnershipAndConfirmingReusesButRejectingDiscardsCache(){
        owner.update("UPDATE md_product SET spec='S',version=version+1 WHERE id=501");
        photoBatch(true); // Existing formal gallery belongs to the catalog, independently of this fresh source.
        var b=upload(UUID.randomUUID().toString());doReturn(photoDocument()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));
        var row=rows(imports.get(actor,id(b))).getFirst();long image=((Number)map(((List<?>)row.get("images")).getFirst()).get("id")).longValue();
        assertThat(map(((List<?>)row.get("images")).getFirst())).containsEntry("status","UNCONFIRMED");
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",1.0)))).when(parser).search(any(),anyString(),anyMap());
        tasks.execute(101,start(b));assertThat(map(matched(b).get("image"))).containsEntry("status","FOUND");assertThat(map(matched(b).get("ranking"))).containsEntry("recommendedIds",List.of(501));
        row=rows(imports.get(actor,id(b))).getFirst();assertThat(row).containsEntry("decision","EXISTING").containsEntry("readiness","READY").containsEntry("matchedProductId",501L).containsEntry("purchaseUnit","PCS").containsEntry("suppliedProductName",null);
        assertThat(((Number)matched(b).get("inputRevision")).longValue()).isEqualTo(((Number)row.get("version")).longValue());
        assertThat(map(((List<?>)row.get("images")).getFirst())).containsEntry("status","UNCONFIRMED");
        imports.associate(actor,id(b),rowId(b),image,Map.of("version",row.get("version"),"association","CONFIRMED"));clearInvocations(parser);tasks.execute(101,start(b));
        assertThat(matched(b)).containsEntry("cacheReused",true);verify(parser,never()).search(any(),anyString(),anyMap());verify(parser,times(1)).recognize(any(),anyString(),anyMap());
        row=rows(imports.get(actor,id(b))).getFirst();imports.associate(actor,id(b),rowId(b),image,Map.of("version",row.get("version"),"association","REJECTED"));tasks.execute(101,start(b));
        assertThat(map(matched(b).get("image"))).containsEntry("status","NO_INPUT");assertThat(matched(b).get("candidates")).asList().isEmpty();
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    @Test void photoRankingKeepsTextConflictAsEvidenceWithoutRequiringConfirmation(){
        var b=photoBatch(true);owner.update("UPDATE md_product SET spec='M',version=version+1 WHERE id=501");
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);
        doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",0.99)))).when(parser).search(any(),anyString(),anyMap());
        UUID run=start(b);tasks.execute(101,run);var result=matched(b);
        assertThat(map(result.get("ranking"))).containsEntry("status","RECOMMENDED").containsEntry("recommendedIds",List.of(501));
        assertThat(result.get("candidates")).asList().hasSize(1);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_candidate WHERE run_id=?",Integer.class,run)).isEqualTo(1);
        assertThat(map(matched(b).get("ranking"))).isEqualTo(map(result.get("ranking")));
    }
    @Test void changingOnlyTextReusesPhotosAndSupplementsMissingNamesWithoutSearchingAgain(){
        var b=photoBatch(true);owner.update("UPDATE md_product SET spec='M',version=version+1 WHERE id=501");
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);
        doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",0.99)))).when(parser).search(any(),anyString(),anyMap());
        UUID original=start(b);tasks.execute(101,original);
        var old=matched(b);var row=rows(imports.get(actor,id(b))).getFirst();var changed=values();changed.put("productSpec","M");
        imports.saveRow(actor,id(b),rowId(b),Map.of("version",row.get("version"),"values",changed));clearInvocations(parser);
        UUID rerun=start(b);tasks.execute(101,rerun);
        assertThat(tasks.get(actor,rerun)).containsEntry("status","SUCCEEDED");
        assertThat(map(matched(b).get("ranking"))).containsEntry("recommendedIds",List.of(501));
        assertThat(matched(b)).containsEntry("cacheReused",true).containsEntry("runId",rerun.toString());
        assertThat(map(old.get("ranking"))).containsEntry("recommendedIds",List.of(501));
        verify(parser,times(1)).recognize(any(),anyString(),anyMap());verify(parser,never()).search(any(),anyString(),anyMap());
    }
    @Test void emptyPhotoResultsCannotHideANewlySuppliedRealCatalogCode(){
        var b=photoBatch(true);doReturn(Map.of("hits",List.of())).when(parser).search(any(),anyString(),anyMap());
        tasks.execute(101,start(b));assertThat(matched(b).get("candidates")).asList().isEmpty();
        var row=rows(imports.get(actor,id(b))).getFirst();
        imports.saveRow(actor,id(b),rowId(b),Map.of("version",row.get("version"),"values",values(),"matchInputs",Map.of("suppliedProductCode","SKU","suppliedProductName","","supplierProductCode","")));
        clearInvocations(parser);tasks.execute(101,start(b));
        assertThat(map(matched(b).get("text"))).containsEntry("status","FOUND");
        assertThat(matched(b).get("candidates")).asList().hasSize(1);
        verify(parser,times(1)).recognize(any(),anyString(),anyMap());
    }
    @Test void changedSourcePhotoCannotReuseThePreviousCache(){
        var b=photoBatch(true);long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);
        doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",0.99)))).when(parser).search(any(),anyString(),anyMap());
        tasks.execute(101,start(b));owner.update("UPDATE pur_order_import_image SET image_sha256=repeat('b',64)");clearInvocations(parser);
        tasks.execute(101,start(b));verify(parser,times(1)).recognize(any(),anyString(),anyMap());verify(parser,times(1)).search(any(),anyString(),anyMap());
        assertThat(matched(b).get("cacheReused")).isNotEqualTo(true);
    }
    @Test void changedGalleryRejectsTheOldRecommendationAndForcesARealPhotoRefresh(){
        var b=photoBatch(true);long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);
        owner.update("UPDATE md_product SET spec='S',version=version+1 WHERE id=501");
        doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",0.99)))).when(parser).search(any(),anyString(),anyMap());
        UUID original=start(b);tasks.execute(101,original);var row=rows(imports.get(actor,id(b))).getFirst();
        assertThat(map(matched(b).get("ranking"))).containsEntry("recommendedIds",List.of(501));
        var rebuild=photos.rebuild(actor,id(b),UUID.randomUUID().toString());tasks.execute(101,UUID.fromString(rebuild.get("id").toString()));
        assertThatThrownBy(()->review.decide(actor,id(b),rowId(b),Map.of("version",row.get("version"),"decision","EXISTING","productId",501,"unit","PCS","runId",original.toString())))
            .isInstanceOf(ApiException.class).extracting("code").isEqualTo("MATCH_CANDIDATE_STALE");
        clearInvocations(parser);tasks.execute(101,start(b));
        verify(parser,times(1)).recognize(any(),anyString(),anyMap());verify(parser,times(1)).search(any(),anyString(),anyMap());
        assertThat(matched(b).get("cacheReused")).isNotEqualTo(true);
    }
    @Test void sharedPhotoSizesSurviveTopOneAndChangedCompetingSizeRejectsTheOldShortcut(){
        var b=photoBatch(true);owner.update("UPDATE md_product SET spec='S',version=version+1 WHERE id=501");
        owner.update("INSERT INTO md_product(id,product_code,name,base_unit,spec) VALUES(502,'SKU-M','同照片M码','PCS','M')");
        owner.update("INSERT INTO md_country_sku(country_id,product_id,status) VALUES(101,502,'ENABLED')");
        long attachment=owner.queryForObject("SELECT attachment_id FROM md_product_image WHERE product_id=501",Long.class);
        catalogImages.link(actor,502,attachment);var rebuild=photos.rebuild(actor,id(b),UUID.randomUUID().toString());tasks.execute(101,UUID.fromString(rebuild.get("id").toString()));
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);
        doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",1.0)))).when(parser).search(any(),anyString(),anyMap());
        var started=matches.start(actor,id(b),Map.of("batchVersion",imports.get(actor,id(b)).get("version"),"rowIds",List.of(rowId(b)),"topK",1),UUID.randomUUID().toString());
        UUID run=UUID.fromString(((List<?>)started.get("taskIds")).getFirst().toString());tasks.execute(101,run);
        assertThat(matched(b).get("candidates")).asList().hasSize(2);
        assertThat(map(matched(b).get("ranking"))).containsEntry("recommendedIds",List.of(501));
        owner.update("UPDATE md_product SET spec='S',version=version+1 WHERE id=502");
        var row=rows(imports.get(actor,id(b))).getFirst();
        assertThatThrownBy(()->review.decide(actor,id(b),rowId(b),Map.of("version",row.get("version"),"decision","EXISTING","productId",501,"unit","PCS","runId",run.toString())))
            .isInstanceOf(ApiException.class).extracting("code").isEqualTo("MATCH_CANDIDATE_STALE");
    }
    @Test void unqualifiedCachedCandidateRequiresExplicitManualConfirmation(){
        var b=photoBatch(true);owner.update("UPDATE md_product SET spec='M',version=version+1 WHERE id=501");
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);
        doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",0.79)))).when(parser).search(any(),anyString(),anyMap());
        UUID run=start(b);tasks.execute(101,run);var row=rows(imports.get(actor,id(b))).getFirst();
        var request=new LinkedHashMap<String,Object>(Map.of("version",row.get("version"),"decision","EXISTING","productId",501,"unit","PCS","runId",run.toString()));
        assertThatThrownBy(()->review.decide(actor,id(b),rowId(b),request)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("MATCH_MANUAL_CONFIRM_REQUIRED");
        request.put("confirmCandidate",true);assertThat(review.decide(actor,id(b),rowId(b),request)).containsEntry("readiness","READY");
    }
    @Test void photoMatchAutomaticallyUsesTheConfiguredPurchaseUnitAndReplaysWithoutAnotherDecision(){
        var b=freshPhotoBatch();owner.update("INSERT INTO md_product_unit(product_id,unit,factor_to_base,is_purchase_default) VALUES(501,'BOX',12,true)");
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",0.91)))).when(parser).search(any(),anyString(),anyMap());
        UUID run=start(b);tasks.execute(101,run);var row=rows(imports.get(actor,id(b))).getFirst();
        assertThat(row).containsEntry("readiness","READY").containsEntry("matchedProductId",501L).containsEntry("purchaseUnit","BOX");
        assertThat(row.get("productSnapshot")).asString().contains("SKU");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
        tasks.execute(101,run);assertThat(rows(imports.get(actor,id(b))).getFirst().get("version")).isEqualTo(row.get("version"));
    }
    @Test void eightyPercentPhotoRemainsUnresolvedAndDoesNotCreateANewProduct(){
        var b=freshPhotoBatch();long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);
        doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",0.8)))).when(parser).search(any(),anyString(),anyMap());tasks.execute(101,start(b));
        assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("readiness","UNRESOLVED").containsEntry("matchedProductId",null);
        assertThat(owner.queryForObject("SELECT count(*) FROM md_product",Integer.class)).isEqualTo(1);
    }
    @Test void autoSelectedProductWithoutUnitsReportsSetupInsteadOfPretendingToBeReady(){
        var b=freshPhotoBatch();owner.update("DELETE FROM md_product_unit WHERE product_id=501");
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",1.0)))).when(parser).search(any(),anyString(),anyMap());tasks.execute(101,start(b));
        assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("readiness","NEEDS_SETUP").containsEntry("matchedProductId",501L);
        assertThat(rows(imports.get(actor,id(b))).getFirst().get("setupReasons")).asString().contains("单位换算");
    }
    @Test void reviewImagesAreLimitedToFixedHitsAndSamePhotoDoesNotProveTheSize(){
        var b=photoBatch(true);owner.update("UPDATE md_product SET spec='M',version=version+1 WHERE id=501");
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);UUID task=start(b);
        doAnswer(call->{try{String credential=call.getArgument(1);var catalog=matches.catalogSearch(task,credential,Map.of("operation","TEXT"));
            assertThatThrownBy(()->matches.catalogSearch(task,credential,Map.of("operation","REVIEW","imageId",999))).isInstanceOf(ApiException.class);
            var request=map(((List<?>)map(catalog.get("imagePlan")).get("requests")).getFirst());
            var evidence=matches.catalogSearch(task,credential,Map.of("operation","RESOLVE","imageResults",List.of(Map.of("queryAssetId",request.get("queryAssetId"),"status","FOUND","hits",List.of(Map.of("featureId",feature,"score",0.99))))));
            var pictures=matches.catalogSearch(task,credential,Map.of("operation","REVIEW"));
            assertThat(pictures).containsEntry("format","ImageReviewInputV1").containsEntry("evidenceHash",evidence.get("evidenceHash"));
            assertThat((List<?>)pictures.get("images")).hasSize(2);assertThat((List<?>)pictures.get("pairs")).hasSize(1);
            assertThat(map(((List<?>)pictures.get("images")).getFirst()).get("dataUrl")).asString().startsWith("data:image/");
            var body=new LinkedHashMap<>(callback(task,evidence,List.of()));var explanation=new LinkedHashMap<>(map(body.get("explanation")));
            explanation.put("candidateChecks",List.of(Map.of("productId",501,"imageMatch","SAME","imageReason","照片同款","specMatch","CONFLICT","specReason","来源S，候选M")));body.put("explanation",explanation);
            owner.update("UPDATE md_product_image SET status='DELETED'");
            assertThatThrownBy(()->matches.result(task,credential,body)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);
            owner.update("UPDATE md_product_image SET status='ACTIVE'");
            matches.result(task,credential,body);return Map.of("taskId",task.toString());}catch(Exception error){throw new AssertionError("读取复核图片并保存结果失败",error);}
        }).when(parser).recognize(any(),anyString(),anyMap());tasks.execute(101,task);
        assertThat(tasks.get(actor,task)).as(tasks.get(actor,task).toString()).containsEntry("status","SUCCEEDED");
        assertThat(map(matched(b).get("explanation")).get("candidateChecks")).asString().contains("CONFLICT");
        assertThat(owner.queryForObject("SELECT result::text FROM pur_order_import_task WHERE id=?",String.class,task)).doesNotContain("data:image/");
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    @Test void structuredReviewCannotClaimSameWithoutReadingTheFixedImagePair(){
        var b=source("SKU");UUID task=start(b);doAnswer(call->{String credential=call.getArgument(1);matches.catalogSearch(task,credential,Map.of("operation","TEXT"));
            var evidence=matches.catalogSearch(task,credential,Map.of("operation","RESOLVE","imageResults",List.of()));var body=new LinkedHashMap<>(callback(task,evidence,List.of()));var explanation=new LinkedHashMap<>(map(body.get("explanation")));
            explanation.put("candidateChecks",List.of(Map.of("productId",501,"imageMatch","SAME","imageReason","猜测同款","specMatch","MATCH","specReason","猜测一致")));body.put("explanation",explanation);
            assertThatThrownBy(()->matches.result(task,credential,body)).isInstanceOf(ApiException.class);
            var input=matches.catalogSearch(task,credential,Map.of("operation","REVIEW"));assertThat((List<?>)input.get("pairs")).isEmpty();
            explanation.put("candidateChecks",List.of(Map.of("productId",501,"imageMatch","NO_INPUT","imageReason","没有可用配对图","specMatch","NOT_CHECKED","specReason","尚未确认同款")));matches.result(task,credential,body);return Map.of("taskId",task.toString());
        }).when(parser).recognize(any(),anyString(),anyMap());tasks.execute(101,task);assertThat(tasks.get(actor,task)).as(tasks.get(actor,task).toString()).containsEntry("status","SUCCEEDED");
        assertThat(map(matched(b).get("explanation")).get("candidateChecks")).asString().contains("NO_INPUT","NOT_CHECKED");
    }
    @Test void textOnlyCandidatesCannotDisplaceTheFaissPhotoCandidatesBeforeImageReview(){
        var b=photoBatch(true);var row=rows(b).getFirst();
        for(int n=1;n<=5;n++)owner.update("INSERT INTO md_product(id,product_code,name,base_unit,spec) VALUES(?,?,'LOOKALIKE','PCS','S')",6000+n,"LOOK-"+n);
        imports.saveRow(actor,id(b),rowId(b),Map.of("version",row.get("version"),"values",values(),"matchInputs",Map.of("suppliedProductName","LOOKALIKE","suppliedProductCode","","supplierProductCode","")));
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",0.99)))).when(parser).search(any(),anyString(),anyMap());
        tasks.execute(101,start(b));assertThat(((List<?>)matched(b).get("candidates")).stream().map(c->map(c).get("productId"))).contains(501);
    }
    @Test void textHitWithoutPhotoSurvivesWorkflowFailureAndCannotCreateBusinessData(){var b=source("SKU");UUID task=start(b);tasks.execute(101,task);var result=matched(b);assertThat(result.get("text")).asString().contains("FOUND");assertThat(result.get("image")).asString().contains("NO_INPUT");assertThat(result.get("explanation")).asString().contains("UNAVAILABLE");assertThat(result.get("candidates")).asString().contains("501");assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("readiness","READY").containsEntry("suppliedProductCode","SKU");assertThat(owner.queryForObject("SELECT count(*) FROM md_product",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();}
    @Test void noInputAndRealNoMatchRemainDifferentAndNeverMeanNewProduct(){var missing=source(null);tasks.execute(101,start(missing));assertThat(matched(missing).get("text")).asString().contains("NO_INPUT");var absent=source("NOT-IN-REAL-CATALOG");tasks.execute(101,start(absent));assertThat(matched(absent).get("text")).asString().contains("NOT_FOUND");assertThat(owner.queryForObject("SELECT count(*) FROM md_product",Integer.class)).isEqualTo(1);}
    @Test void matchingNeverOverwritesAnAlreadyConfirmedProduct(){var b=source("SKU");var row=rows(b).getFirst();review.decide(actor,id(b),rowId(b),Map.of("version",row.get("version"),"decision","EXISTING","productId",501,"unit","PCS"));UUID task=start(b);tasks.execute(101,task);assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("readiness","READY").containsEntry("matchedProductId",501L).containsEntry("purchaseUnit","PCS");}
    Map<String,Object> callback(UUID task,Map<String,Object> evidence,List<Long> ids){return Map.of("format","MatchResultV1","runId",task.toString(),"rowId",evidence.get("rowId"),"inputRevision",evidence.get("inputRevision"),"evidenceHash",evidence.get("evidenceHash"),"explanation",Map.of("status","READY","message","仅解释当前候选，仍须人工核对","candidateIds",ids));}
    @Test void fakeIdsAndChangedDuplicateCallbackAreRejectedWhileExactReplayIsSafe(){var b=source("SKU");UUID task=start(b);doAnswer(call->{String credential=call.getArgument(1);matches.catalogSearch(task,credential,Map.of("operation","TEXT"));var evidence=matches.catalogSearch(task,credential,Map.of("operation","RESOLVE","imageResults",List.of()));assertThatThrownBy(()->matches.result(task,credential,callback(task,evidence,List.of(999999L)))).isInstanceOf(ApiException.class);var body=callback(task,evidence,List.of(501L));matches.result(task,credential,body);matches.result(task,credential,body);var altered=new LinkedHashMap<>(body);altered.put("explanation",Map.of("status","READY","message","不同内容","candidateIds",List.of(501L)));assertThatThrownBy(()->matches.result(task,credential,altered)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);return Map.of("taskId",task.toString());}).when(parser).recognize(any(),anyString(),anyMap());tasks.execute(101,task);assertThat(tasks.get(actor,task)).containsEntry("status","SUCCEEDED");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_candidate",Integer.class)).isEqualTo(1);}
    @Test void oldCallbackIsStaleAndCannotOverwriteNewManualValues(){var b=source("SKU");UUID task=start(b);doAnswer(call->{String credential=call.getArgument(1);matches.catalogSearch(task,credential,Map.of("operation","TEXT"));var evidence=matches.catalogSearch(task,credential,Map.of("operation","RESOLVE","imageResults",List.of()));var changed=values();changed.put("productSpec","用户新规格");imports.saveRow(actor,id(b),rowId(b),Map.of("version",2,"values",changed));assertThatThrownBy(()->matches.result(task,credential,callback(task,evidence,List.of(501L)))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);return Map.of("taskId",task.toString());}).when(parser).recognize(any(),anyString(),anyMap());tasks.execute(101,task);assertThat(tasks.get(actor,task)).containsEntry("status","STALE");assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("productSpec","用户新规格").containsEntry("readiness","UNRESOLVED");}

    @Test void imageCandidateRetainsSpecConflictAndNeverChangesManualDecision(){var b=photoBatch(true);owner.update("UPDATE md_product SET spec='M',version=version+1 WHERE id=501");long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",0.99)))).when(parser).search(any(),anyString(),anyMap());tasks.execute(101,start(b));var result=matched(b);var candidate=map(((List<?>)result.get("candidates")).getFirst());assertThat(candidate).containsEntry("productId",501);assertThat(candidate.get("conflicts")).asString().contains("规格不同");assertThat(candidate.get("visualScore")).asString().isEqualTo("0.99");assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("readiness","READY");}
    @Test void confirmedSourcePhotoWithEmptyGalleryIsUnavailableNotNoInput(){var b=photoBatch(false);tasks.execute(101,start(b));assertThat(map(matched(b).get("image"))).containsEntry("status","UNAVAILABLE");assertThat(tasks.get(actor,UUID.fromString(matched(b).get("runId").toString()))).containsEntry("status","FAILED");verify(parser,never()).search(any(),anyString(),anyMap());}
    @Test void fakeFeatureIdIsAnErrorAndDoesNotCreateAProductCandidate(){var b=photoBatch(true);doReturn(Map.of("hits",List.of(Map.of("featureId",999999,"score",0.9)))).when(parser).search(any(),anyString(),anyMap());UUID task=start(b);tasks.execute(101,task);assertThat(tasks.get(actor,task)).containsEntry("status","FAILED");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_candidate",Integer.class)).isZero();}
    @Test void supplierCodeWithoutMappingRemainsExplicitlyUnavailable(){var b=source(null);imports.saveRow(actor,id(b),rowId(b),Map.of("version",1,"values",values(),"matchInputs",Map.of("suppliedProductCode","","suppliedProductName","","supplierProductCode","SKU")));tasks.execute(101,start(b));assertThat(map(matched(b).get("text"))).containsEntry("status","UNAVAILABLE");assertThat(matched(b).get("candidates")).asList().isEmpty();}
    @Test void explanationRetriesOriginalEvidenceWithoutSearchingImagesAgain(){var b=source("SKU");UUID original=start(b);tasks.execute(101,original);var queued=matches.explain(actor,id(b),rowId(b),Map.of("version",rows(imports.get(actor,id(b))).getFirst().get("version")),UUID.randomUUID().toString());UUID explanation=UUID.fromString(queued.get("id").toString());tasks.execute(101,explanation);assertThat(tasks.get(actor,explanation)).containsEntry("status","FAILED");tasks.retry(actor,explanation,UUID.randomUUID().toString(),null);doAnswer(call->{UUID id=call.getArgument(0);String credential=call.getArgument(1);matches.catalogSearch(id,credential,Map.of("operation","TEXT"));var evidence=matches.catalogSearch(id,credential,Map.of("operation","RESOLVE","imageResults",List.of()));matches.result(id,credential,callback(id,evidence,List.of(501L)));return Map.of("taskId",id.toString());}).when(parser).recognize(any(),anyString(),anyMap());tasks.execute(101,explanation);assertThat(tasks.get(actor,explanation)).containsEntry("status","SUCCEEDED");assertThat(matched(b)).containsEntry("runId",original.toString());assertThat(map(matched(b).get("explanation"))).containsEntry("status","READY");verify(parser,never()).search(any(),anyString(),anyMap());}
    @Test void changedMasterSnapshotOrNewerRunRejectsCandidateSelection(){var b=source("SKU");UUID original=start(b);tasks.execute(101,original);owner.update("UPDATE md_product SET spec='M',version=version+1 WHERE id=501");assertThatThrownBy(()->review.decide(actor,id(b),rowId(b),Map.of("version",rows(imports.get(actor,id(b))).getFirst().get("version"),"decision","EXISTING","productId",501,"unit","PCS","runId",original.toString()))).isInstanceOf(ApiException.class).extracting("code").isEqualTo("MATCH_CANDIDATE_STALE");UUID newer=start(b);assertThat(newer).isNotEqualTo(original);assertThatThrownBy(()->review.decide(actor,id(b),rowId(b),Map.of("version",rows(imports.get(actor,id(b))).getFirst().get("version"),"decision","EXISTING","productId",501,"unit","PCS","runId",original.toString()))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);}
    @Test void scopedToolsRenewLiveLeaseRejectSqlAndCannotReviveExpiredLease(){var b=source("SKU");UUID task=start(b);doAnswer(call->{String credential=call.getArgument(1);owner.update("UPDATE pur_order_import_task SET lease_until=clock_timestamp()+interval '1 minute' WHERE id=?",task);assertThatThrownBy(()->matches.catalogSearch(task,credential,Map.of("operation","TEXT","sql","select 1"))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(400);matches.catalogSearch(task,credential,Map.of("operation","TEXT"));assertThat(owner.queryForObject("SELECT lease_until>clock_timestamp()+interval '14 minutes' FROM pur_order_import_task WHERE id=?",Boolean.class,task)).isTrue();owner.update("UPDATE pur_order_import_task SET lease_until=clock_timestamp()-interval '1 second' WHERE id=?",task);assertThatThrownBy(()->matches.catalogSearch(task,credential,Map.of("operation","TEXT"))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(403);return Map.of("taskId",task.toString());}).when(parser).recognize(any(),anyString(),anyMap());tasks.execute(101,task);assertThat(tasks.get(actor,task)).containsEntry("status","NEEDS_REAUTH");}
    @Test void taskCredentialWorksOnlyForExactPostToolsAndNeverBecomesAnAssetWritePermission(){var b=source("SKU");UUID task=start(b);doAnswer(call->{String credential=call.getArgument(1);var http=java.net.http.HttpClient.newHttpClient();String root="http://127.0.0.1:"+port+"/internal/purchase-import/tasks/"+task;var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(root+"/catalog-search")).header("X-Purchase-Task",credential).header("Content-Type","application/json").POST(java.net.http.HttpRequest.BodyPublishers.ofString("{\"operation\":\"TEXT\"}")).build();var response=http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);assertThat(response.body()).contains("candidateIds");var wrong=java.net.http.HttpRequest.newBuilder(java.net.URI.create(root+"/assets/1")).header("X-Purchase-Task",credential).POST(java.net.http.HttpRequest.BodyPublishers.noBody()).build();assertThat(http.send(wrong,java.net.http.HttpResponse.BodyHandlers.discarding()).statusCode()).isEqualTo(401);throw new ApiException(503,"N8N_UNAVAILABLE","HTTP边界已验证");}).when(parser).recognize(any(),anyString(),anyMap());tasks.execute(101,task);assertThat(matched(b).get("candidates")).asList().hasSize(1);}

    @Test void realPythonFaissSearchResolvesScopedOriginalPhotoToCurrentProductWithoutRealModelInference()throws Exception{String python=System.getProperty("jxc.test.purchase-python");Assumptions.assumeTrue(python!=null,"显式选择解释器才运行真实HTTP/Faiss检索；查询向量是确定性夹具");var b=photoBatch(true);try(var bridge=startBridge(python,"workbench.tests.jxc_search_fixture:app")){doAnswer(call->bridge.client().index(call.getArgument(0),call.getArgument(1),call.getArgument(2))).when(parser).index(any(),anyString(),anyMap());var rebuild=photos.rebuild(actor,id(b),UUID.randomUUID().toString());tasks.execute(101,UUID.fromString(rebuild.get("id").toString()));doAnswer(call->bridge.client().search(call.getArgument(0),call.getArgument(1),call.getArgument(2))).when(parser).search(any(),anyString(),anyMap());UUID task=start(b);tasks.execute(101,task);assertThat(tasks.get(actor,task)).as(tasks.get(actor,task).toString()).containsEntry("status","SUCCEEDED");var result=matched(b);assertThat(map(result.get("image"))).containsEntry("status","FOUND");var candidate=map(((List<?>)result.get("candidates")).getFirst());assertThat(candidate).containsEntry("productId",501);assertThat(((Number)candidate.get("visualScore")).doubleValue()).isCloseTo(1.0,within(0.00001));assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();}}
    @Test void isolatedFeatureDockerCreatesAndRestoresRealTextCandidatesThroughExistingWorker()throws Exception{String image=System.getProperty("jxc.test.purchase-image");Assumptions.assumeTrue(image!=null,"显式构建M4镜像后运行受限HTTP候选验收");var b=source("SKU");try(var app=featureContainer(image,false).withEnv("JXC_PURCHASE_IMPORT_RECOGNITION_ENABLED","true").withCommand("-Xmx384m","-Dfile.encoding=UTF-8","-jar","/app/app.jar","--spring.flyway.enabled=false","--jxc.jobs.enabled=true","--jxc.jobs.recovery.delay-ms=1000")){app.start();String root="http://"+app.getHost()+":"+app.getMappedPort(8080)+"/api/v1/pur/order-imports/"+id(b);var http=java.net.http.HttpClient.newHttpClient();var body=Map.of("batchVersion",b.get("version"),"rowIds",List.of(rowId(b)),"topK",5);var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(root+"/matches")).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Content-Type","application/json").header("Idempotency-Key",UUID.randomUUID().toString()).POST(java.net.http.HttpRequest.BodyPublishers.ofString(codec.write(body))).build();var response=http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);UUID task=UUID.fromString(((List<?>)map(codec.readMap(response.body()).get("data")).get("taskIds")).getFirst().toString());for(int n=0;n<100&&Set.of("QUEUED","RUNNING").contains(tasks.get(actor,task).get("status"));n++)Thread.sleep(300);assertThat(tasks.get(actor,task)).as(app.getLogs()).containsEntry("status","SUCCEEDED");var get=java.net.http.HttpRequest.newBuilder(java.net.URI.create(root)).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").GET().build();var restored=http.send(get,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(restored.statusCode()).isEqualTo(200);assertThat(restored.body()).contains("MatchRunV1","NOT_REQUESTED","SKU","CandidateRankingV1","photo-best-or-first-text-v2").doesNotContain("credential_hash","snapshots","tokenHash");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();String expected=com.hs.jxc.attachment.AttachmentObjectStore.sha256(java.nio.file.Files.readAllBytes(java.nio.file.Path.of("target/jxc-app-0.1.0-SNAPSHOT.jar")));assertThat(app.execInContainer("sha256sum","/app/app.jar").getStdout()).startsWith(expected+" ");}}

    @Test void exactSystemCodeDoesNotDisappearBehindFirstFiftyFuzzyMatches(){for(int n=1;n<=55;n++)owner.update("INSERT INTO md_product(id,product_code,name,base_unit) VALUES(?,?,?,'PCS')",600+n,"PRE-LATE-"+n,"Other");owner.update("INSERT INTO md_product(id,product_code,name,base_unit) VALUES(9999,'LATE','SKU','PCS')");var b=source("LATE");tasks.execute(101,start(b));assertThat(matched(b).get("candidates")).asList().hasSize(1);assertThat(map(((List<?>)matched(b).get("candidates")).getFirst())).containsEntry("productId",9999);}

    @Test void oneFailedImageRetainsOtherRealHitsAndMarksPartialInsteadOfOk(){var b=photoBatch(true);owner.update("INSERT INTO pur_order_import_image(country_id,source_id,attachment_id,image_sha256,media_part,mime_type,width,height) SELECT country_id,source_id,attachment_id,repeat('a',64),'xl/media/second.png',mime_type,width,height FROM pur_order_import_image");long second=owner.queryForObject("SELECT max(id) FROM pur_order_import_image",Long.class);owner.update("INSERT INTO pur_order_import_row_image(country_id,row_id,image_id,anchor,association_status) VALUES(101,?,?,'{\"anchors\":[]}'::jsonb,'CONFIRMED')",rowId(b),second);long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);doAnswer(call->{var request=map(call.getArgument(2));if(((Number)request.get("queryAssetId")).longValue()==second)throw new ApiException(503,"SEARCH_UNAVAILABLE","第二张原图提取失败");return Map.of("hits",List.of(Map.of("featureId",feature,"score",0.9)));}).when(parser).search(any(),anyString(),anyMap());tasks.execute(101,start(b));assertThat(matched(b)).containsEntry("status","PARTIAL");assertThat(map(matched(b).get("image")).get("errors")).asList().hasSize(1);assertThat(matched(b).get("candidates")).asList().hasSize(1);}

    @Test void catalogDatabaseCallFailureIsExplicitAndCannotBecomeSuccessfulNoMatch(){var b=source("SKU");UUID task=start(b);var unavailable=mock(com.hs.jxc.md.api.MasterProductMaintenanceApi.class);doThrow(new org.springframework.dao.DataAccessResourceFailureException("fixture database unavailable")).when(unavailable).queryProductCandidates(any(),anyString(),anyBoolean(),anyInt());var tool=new PurchaseImportMatchServiceImpl(imports,tasks,parser,unavailable,mock(com.hs.jxc.md.api.ProductImageApi.class),mock(com.hs.jxc.common.idempotency.IdempotencyExecutor.class),mock(com.hs.jxc.common.audit.AuditWriter.class),matchMapper,review);doAnswer(call->{tool.catalogSearch(task,call.getArgument(1),Map.of("operation","TEXT"));return Map.of("taskId",task.toString());}).when(parser).recognize(any(),anyString(),anyMap());tasks.execute(101,task);assertThat(tasks.get(actor,task)).containsEntry("status","FAILED").containsEntry("errorCode","TASK_FAILED");assertThat(matched(b)).isNull();assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_candidate",Integer.class)).isZero();}

    @SuppressWarnings("unchecked") List<Map<String,Object>> batchRows(Object value){return (List<Map<String,Object>>)value;}
    Map<String,Object> queuedBatch(int count){return queuedBatch(count,false);}
    Map<String,Object> queuedBatch(int count,boolean largePhotos){
        photoBatch(true);owner.update("UPDATE md_product SET spec='S',version=version+1 WHERE id=501");
        var b=upload(UUID.randomUUID().toString());var doc=photoDocument();var sourceRows=new ArrayList<Map<String,Object>>();var associations=new ArrayList<Map<String,Object>>();
        var prototype=map(((List<?>)doc.get("rows")).getFirst());var association=map(((List<?>)doc.get("associations")).getFirst());
        var largeImages=new ArrayList<Map<String,Object>>();
        for(int i=0;i<count;i++){var row=new LinkedHashMap<>(prototype);row.put("sourceRow",i+2);var values=new LinkedHashMap<>(map(row.get("normalizedValues")));values.put("productSpec",i%2==0?"S":"M");row.put("normalizedValues",values);sourceRows.add(row);var link=new LinkedHashMap<>(association);link.put("sourceRow",i+2);
            if(largePhotos){var original=map(((List<?>)doc.get("images")).getFirst());byte[] png=Arrays.copyOf(Base64.getDecoder().decode(original.get("contentBase64").toString()),6*1024*1024);png[png.length-1]=(byte)i;String hash=com.hs.jxc.attachment.AttachmentObjectStore.sha256(png);largeImages.add(Map.of("imageId",hash,"sha256",hash,"mimeType","image/png","bytes",png.length,"width",1,"height",1,"mediaPart","xl/media/image"+i+".png","contentBase64",Base64.getEncoder().encodeToString(png)));link.put("imageId",hash);}
            associations.add(link);}
        if(largePhotos)doc.put("images",largeImages);
        doc.put("rows",sourceRows);doc.put("associations",associations);doReturn(doc).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);doReturn(Map.of("hits",List.of(Map.of("featureId",feature,"score",1.0)))).when(parser).search(any(),anyString(),anyMap());
        var snapshot=imports.get(actor,id(b));matches.start(actor,id(b),Map.of("batchVersion",snapshot.get("version"),"rowIds",rows(snapshot).stream().map(row->row.get("id")).toList(),"topK",5),UUID.randomUUID().toString());return b;
    }
    Map<String,Object> batchReply(Map<String,Object> row){
        var item=new LinkedHashMap<String,Object>();for(String key:List.of("runId","rowId","inputRevision","evidenceHash"))item.put(key,row.get(key));boolean same="S".equals(map(row.get("sourceInput")).get("productSpec"));
        item.put("explanation",Map.of("status","READY","message","逐行核对完成","candidateIds",same?List.of(501):List.of(),"candidateChecks",List.of(Map.of("productId",501,"imageMatch","SAME","imageReason","真实照片同款","specMatch",same?"MATCH":"CONFLICT","specReason",same?"S码一致":"M与S不同"))));return item;
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(ints={20,21,60})
    void queuedRowsUseTwentyPerModelRequestAndAtMostThreeConcurrentBatches(int count){
        var b=queuedBatch(count);var sizes=new java.util.concurrent.CopyOnWriteArrayList<Integer>();var active=new java.util.concurrent.atomic.AtomicInteger();var peak=new java.util.concurrent.atomic.AtomicInteger();var entered=new java.util.concurrent.CountDownLatch((count+19)/20);
        doAnswer(call->{var request=map(call.getArgument(2));var input=batchRows(request.get("rows"));sizes.add(input.size());assertThat((List<?>)request.get("images")).hasSize(1);assertThat(codec.write(request)).doesNotContain("credential","authorization_basis");int n=active.incrementAndGet();peak.accumulateAndGet(n,Math::max);entered.countDown();
            try{assertThat(entered.await(30,java.util.concurrent.TimeUnit.SECONDS)).isTrue();var replies=new ArrayList<>(input.stream().map(this::batchReply).toList());Collections.reverse(replies);return Map.of("format","MatchReviewBatchResultV1","items",replies);}finally{active.decrementAndGet();}
        }).when(parser).reviewBatch(any(),anyString(),anyMap());
        assertThat(tasks.recover(101,100)).isEqualTo(count);assertThat(sizes).containsExactlyInAnyOrderElementsOf(count==20?List.of(20):count==21?List.of(20,1):List.of(20,20,20));assertThat(peak.get()).isEqualTo((count+19)/20);
        for(var row:rows(imports.get(actor,id(b)))){var result=map(row.get("matchResult"));assertThat(map(result.get("explanation"))).containsEntry("status","READY");assertThat(map(((List<?>)map(result.get("explanation")).get("candidateChecks")).getFirst())).containsEntry("specMatch","S".equals(row.get("productSpec"))?"MATCH":"CONFLICT");}
        verify(parser,never()).recognize(any(),anyString(),anyMap());assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    @Test void batchMissingDuplicateAndChangedRowsCannotInvalidateTheOtherSavedRows(){
        var b=queuedBatch(4);
        doAnswer(call->{var input=batchRows(map(call.getArgument(2)).get("rows"));owner.update("UPDATE pur_order_import SET version=version+1 WHERE id=?",input.get(2).get("rowId"));return Map.of("format","MatchReviewBatchResultV1","items",List.of(batchReply(input.get(1)),batchReply(input.get(1)),batchReply(input.get(2)),batchReply(input.get(3))));}).when(parser).reviewBatch(any(),anyString(),anyMap());
        tasks.recover(101,100);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_task WHERE batch_id=? AND kind='MATCH' AND status='FAILED'",Integer.class,id(b))).isEqualTo(2);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_task WHERE batch_id=? AND kind='MATCH' AND status='STALE'",Integer.class,id(b))).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_task WHERE batch_id=? AND kind='MATCH' AND status='SUCCEEDED'",Integer.class,id(b))).isEqualTo(1);
        clearInvocations(parser);assertThat(tasks.recover(101,100)).isZero();verify(parser,never()).reviewBatch(any(),anyString(),anyMap());
    }
    @Test void oversizedRequestsRenewTheWaitingRowBeforeSendingItsNextBatch(){
        var b=queuedBatch(6,true);var waiting=new java.util.concurrent.atomic.AtomicReference<UUID>();var calls=new java.util.concurrent.atomic.AtomicInteger();
        doAnswer(call->{var request=map(call.getArgument(2));var input=batchRows(request.get("rows"));assertThat(codec.write(request).getBytes(java.nio.charset.StandardCharsets.UTF_8).length).isLessThanOrEqualTo(40*1024*1024);
            if(calls.incrementAndGet()==1){var sent=input.stream().map(row->UUID.fromString(row.get("runId").toString())).toList();var remaining=owner.queryForList("SELECT id FROM pur_order_import_task WHERE batch_id=? AND kind='MATCH' AND status='RUNNING'",UUID.class,id(b)).stream().filter(id->!sent.contains(id)).toList();assertThat(remaining).hasSize(1);waiting.set(remaining.getFirst());owner.update("UPDATE pur_order_import_task SET lease_until=clock_timestamp()+interval '1 minute',expires_at=clock_timestamp()+interval '1 minute' WHERE id=?",waiting.get());}
            else assertThat(owner.queryForObject("SELECT lease_until>clock_timestamp()+interval '14 minutes' FROM pur_order_import_task WHERE id=?",Boolean.class,waiting.get())).as("前一批等待结束后必须重新延长后续行有效期").isTrue();
            return Map.of("format","MatchReviewBatchResultV1","items",input.stream().map(this::batchReply).toList());
        }).when(parser).reviewBatch(any(),anyString(),anyMap());
        tasks.recover(101,100);assertThat(calls.get()).isEqualTo(2);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_task WHERE batch_id=? AND kind='MATCH' AND status='SUCCEEDED'",Integer.class,id(b))).isEqualTo(6);
    }
    @Autowired com.hs.jxc.sys.integrations.ExternalServiceConfig externalServices;
    @Test void changingConnectionVersionDuringPreparationSeparatesModelRequests(){
        var b=queuedBatch(20);var prepared=new java.util.concurrent.atomic.AtomicInteger();var sizes=new ArrayList<Integer>();
        long feature=owner.queryForObject("SELECT id FROM image_feature",Long.class);
        doAnswer(call->{
            if(prepared.incrementAndGet()==5)owner.update("INSERT INTO sys_external_service_revision(version,config,created_by) VALUES(1,?::jsonb,201)",codec.write(externalServices.snapshot(0)));
            return Map.of("hits",List.of(Map.of("featureId",feature,"score",1.0)));
        }).when(parser).search(any(),anyString(),anyMap());
        doAnswer(call->{
            var input=batchRows(map(call.getArgument(2)).get("rows"));sizes.add(input.size());
            var versions=input.stream().map(row->owner.queryForObject("SELECT service_config_version FROM pur_order_import_task WHERE id=?",Integer.class,UUID.fromString(row.get("runId").toString()))).distinct().toList();
            assertThat(versions).as("同一模型请求不能混用任务绑定的连接版本").hasSize(1);
            return Map.of("format","MatchReviewBatchResultV1","items",input.stream().map(this::batchReply).toList());
        }).when(parser).reviewBatch(any(),anyString(),anyMap());
        tasks.recover(101,100);assertThat(sizes).containsExactly(5,15);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_task WHERE batch_id=? AND kind='MATCH' AND status='SUCCEEDED'",Integer.class,id(b))).isEqualTo(20);
    }
}
