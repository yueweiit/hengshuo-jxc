package com.hs.jxc.pur.service.impl;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.md.api.ProductImageApi;
import java.util.*;

/** 校验缓存的真实照片归属；同一特征新关联了商品时也不能继续沿用旧候选集合。 */
public final class PurchaseImportPhotoCache {
    private record Binding(long query,long feature,long image,long product,double score) {
        Map<String,Object> dto(){return Map.of("queryAssetId",query,"featureId",feature,"imageId",image,"productId",product,"score",score);}
    }
    private record Query(long query,long feature,double score) {}
    private PurchaseImportPhotoCache() {}
    @SuppressWarnings("unchecked")
    private static Binding binding(Map<String,Object> value){return new Binding(Inputs.id(value.get("queryAssetId")),Inputs.id(value.get("featureId")),Inputs.id(value.get("imageId")),Inputs.id(value.get("productId")),((Number)value.get("score")).doubleValue());}

    @SuppressWarnings("unchecked")
    public static List<Map<String,Object>> bindings(List<Map<String,Object>> candidates){
        var result=new LinkedHashSet<Binding>();
        for(var candidate:candidates)for(var hit:(List<Map<String,Object>>)candidate.get("visualEvidence")){
            var value=new LinkedHashMap<String,Object>(hit);value.put("productId",candidate.get("productId"));result.add(binding(value));
        }
        return result.stream().map(Binding::dto).toList();
    }
    @SuppressWarnings("unchecked")
    public static boolean matches(ProductImageApi images,RequestContext ctx,Map<String,Object> evidence){
        if(!(evidence.get("photoBindings") instanceof List<?> saved)||saved.isEmpty())return false;
        var expected=new HashSet<Binding>();for(Object value:saved)expected.add(binding((Map<String,Object>)value));
        String generation=Inputs.required((Map<String,Object>)evidence.get("image"),"generation");
        var queries=new LinkedHashSet<Query>();expected.forEach(value->queries.add(new Query(value.query(),value.feature(),value.score())));
        var actual=new HashSet<Binding>();
        for(var query:queries)for(var photo:images.resolveHits(ctx,generation,List.of(Map.of("featureId",query.feature(),"score",query.score()))))
            actual.add(new Binding(query.query(),Inputs.id(photo.get("featureId")),Inputs.id(photo.get("imageId")),Inputs.id(photo.get("productId")),query.score()));
        return expected.equals(actual);
    }
    static boolean sameSnapshot(JsonCodec json,Object expected,Object actual){
        return json.write(IdempotencyExecutor.canonical(expected)).equals(json.write(IdempotencyExecutor.canonical(actual)));
    }
}
