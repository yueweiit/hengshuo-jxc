package com.hs.jxc.pur.service.impl;

import com.hs.jxc.common.api.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** 只合并模型输入；行任务、候选依据与业务回写仍逐行独立。 */
final class PurchaseImportReviewBatch {
    static final int ROWS=20, MAX_BYTES=40*1024*1024;
    private PurchaseImportReviewBatch(){}
    static final class Packer {
        private final JsonCodec json;private final int maximum;private long size;
        private final List<Map<String,Object>> rows=new ArrayList<>();private final Map<String,Map<String,Object>> images=new LinkedHashMap<>();
        Packer(JsonCodec json,int maximum){this.json=json;this.maximum=maximum;size=bytes(json,body(List.of(),List.of()));}
        boolean empty(){return rows.isEmpty();}
        Map<String,Object> request(){return body(rows,new ArrayList<>(images.values()));}
        boolean add(Map<String,Object> original){
            var row=new LinkedHashMap<>(original);row.remove("images");var additions=new LinkedHashMap<String,Map<String,Object>>();
            for(var image:maps(original.get("images")))if(!images.containsKey(image.get("sha256").toString()))additions.putIfAbsent(image.get("sha256").toString(),image);
            long extra=bytes(json,row)+(rows.isEmpty()?0:1);int count=images.size();for(var image:additions.values())extra+=bytes(json,image)+(count++==0?0:1);
            if(rows.size()==ROWS||size+extra>maximum){if(!empty())return false;throw new ApiException(422,"IMAGE_REVIEW_LIMIT","单行图文核对请求仍超过允许大小，请减少原图或候选");}
            rows.add(row);images.putAll(additions);size+=extra;return true;
        }
    }
    private static long bytes(JsonCodec json,Object value){return json.write(value).getBytes(StandardCharsets.UTF_8).length;}
    private static Map<String,Object> body(List<Map<String,Object>> rows,List<Map<String,Object>> images){return Map.of("format","MatchReviewBatchV1","rows",List.copyOf(rows),"images",List.copyOf(images));}
    @SuppressWarnings("unchecked") static List<Map<String,Object>> maps(Object value){if(!(value instanceof List<?> list)||list.stream().anyMatch(v->!(v instanceof Map<?,?>)))throw invalid();return (List<Map<String,Object>>)value;}
    static ApiException invalid(){return new ApiException(502,"MODEL_BATCH_INVALID","批量模型响应格式无效，核对未完成");}
    static List<Map<String,Object>> responses(Map<String,Object> request,Map<String,Object> response){
        if(response==null||!"MatchReviewBatchResultV1".equals(response.get("format"))||!response.keySet().equals(Set.of("format","items")))throw invalid();
        var expected=maps(request.get("rows"));var allowed=new HashSet<Object>();expected.forEach(row->allowed.add(row.get("runId")));
        var replies=new LinkedHashMap<Object,List<Map<String,Object>>>();
        for(var item:maps(response.get("items"))){if(!allowed.contains(item.get("runId")))throw invalid();replies.computeIfAbsent(item.get("runId"),k->new ArrayList<>()).add(item);}
        var result=new ArrayList<Map<String,Object>>();
        for(var row:expected){
            var found=replies.get(row.get("runId"));String failure=null;Map<String,Object> item=null;
            if(found==null)failure="模型返回缺少本行核对结果";
            else if(found.size()!=1)failure="模型返回重复核对行";
            else{item=found.getFirst();if(!item.keySet().equals(Set.of("runId","rowId","inputRevision","evidenceHash","explanation"))||!(item.get("explanation") instanceof Map<?,?>)||!sameNumber(row.get("rowId"),item.get("rowId"))||!sameNumber(row.get("inputRevision"),item.get("inputRevision"))||!Objects.equals(row.get("evidenceHash"),item.get("evidenceHash")))failure="模型返回的行身份或核对依据不一致";}
            if(failure!=null){item=new LinkedHashMap<>();for(String key:List.of("runId","rowId","inputRevision","evidenceHash"))item.put(key,row.get(key));item.put("explanation",Map.of("status","FAILED","message",failure,"candidateIds",List.of()));}
            result.add(item);
        }
        return result;
    }
    private static boolean sameNumber(Object a,Object b){return a instanceof Number&&b instanceof Number&&a.toString().equals(b.toString());}
}
