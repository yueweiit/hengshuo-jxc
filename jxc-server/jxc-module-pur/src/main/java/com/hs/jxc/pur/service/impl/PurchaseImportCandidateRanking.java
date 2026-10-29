package com.hs.jxc.pur.service.impl;

import java.text.Normalizer;
import java.util.*;

/** 图片大于80%取最高分，同分取返回顺序第一条；文字评分仅保留作参考。 */
public final class PurchaseImportCandidateRanking {
    private static final double THRESHOLD=0.8;
    private record Field(String key,String source,String label,int weight) {}
    private static final List<Field> FIELDS=List.of(
        new Field("productCode","suppliedProductCode","商品编号",40),
        new Field("spec","productSpec","规格",40),
        new Field("name","suppliedProductName","商品名",20));
    private PurchaseImportCandidateRanking() {}

    public static Map<String,Object> sourceInput(Map<String,Object> row) {
        var input=new LinkedHashMap<String,Object>();
        input.put("suppliedProductCode",row.get("supplied_product_code"));
        input.put("suppliedProductName",row.get("supplied_product_name"));
        input.put("productSpec",row.get("product_spec"));
        input.put("supplierProductCode",row.get("supplier_product_code"));
        return input;
    }

    public static Map<String,Object> rank(Map<String,Object> source,List<Map<String,Object>> candidates) {
        return rank(source,candidates,true);
    }
    @SuppressWarnings("unchecked")
    public static Map<String,Object> rank(Map<String,Object> source,List<Map<String,Object>> candidates,boolean completePhotoGroup) {
        var scores=new ArrayList<Map<String,Object>>();
        double highestPhoto=candidates.stream().filter(c->c.get("visualScore")!=null)
            .mapToDouble(c->photoScore(c.get("visualScore"))).max().orElse(-1);
        var highest=new ArrayList<Long>();
        for(var candidate:candidates) {
            long id=((Number)candidate.get("productId")).longValue();
            var product=(Map<String,Object>)candidate.get("product");
            var fields=new ArrayList<Map<String,Object>>();double weighted=0;int comparedWeight=0;
            for(var field:FIELDS) {
                Object original=source.get(field.source()),actual=product.get(field.key());
                String left=normalized(original),right=normalized(actual);
                Double score=left.isEmpty()||right.isEmpty()?null:similarity(left,right);
                var item=new LinkedHashMap<String,Object>();
                item.put("field",field.key());item.put("label",field.label());item.put("weight",field.weight());
                item.put("source",original);item.put("target",actual);item.put("score",score);fields.add(item);
                if(score!=null){weighted+=score*field.weight();comparedWeight+=field.weight();}
            }
            Double textScore=comparedWeight==0?null:weighted/comparedWeight;
            Object photo=candidate.get("visualScore");
            boolean top=photo!=null&&photoScore(photo)>THRESHOLD&&Double.compare(photoScore(photo),highestPhoto)==0;
            if(top)highest.add(id);
            var item=new LinkedHashMap<String,Object>();
            item.put("productId",id);item.put("photoScore",photo);item.put("textScore",textScore);item.put("fields",fields);
            item.put("reason",photo==null?"文字目录候选":photoScore(photo)<=THRESHOLD?"照片相似度未大于80%":!top?"其他候选照片相似度更高":"照片相似度最高，同分按返回顺序选择");
            scores.add(item);
        }
        var recommended=new ArrayList<Long>();
        if(!highest.isEmpty())recommended.add(highest.getFirst());
        else if(candidates.stream().noneMatch(c->c.get("visualScore")!=null)){
            candidates.stream().filter(c->c.get("textEvidence") instanceof List<?> evidence&&!evidence.isEmpty()).findFirst()
                .ifPresent(c->recommended.add(((Number)c.get("productId")).longValue()));
        }
        var result=new LinkedHashMap<String,Object>();
        result.put("format","CandidateRankingV1");result.put("policyVersion","photo-best-or-first-text-v2");
        result.put("photoThreshold",THRESHOLD);result.put("textThreshold",null);
        result.put("weights",Map.of("productCode",40,"spec",40,"name",20));
        result.put("completePhotoGroup",completePhotoGroup);
        result.put("status",recommended.isEmpty()?"NEEDS_REVIEW":"RECOMMENDED");
        result.put("reason",recommended.isEmpty()?"没有符合条件的商品，请人工核对或确认创建新品":!highest.isEmpty()?"已选择相似度大于80%的最高分商品，同分取第一条；自动确认商品与单位":"文字目录已命中，默认选择第一条并自动确认商品与单位");
        result.put("highestPhotoIds",highest);result.put("recommendedIds",recommended);result.put("scores",scores);
        return result;
    }
    private static double photoScore(Object value) {
        if(!(value instanceof Number number)||!Double.isFinite(number.doubleValue())||number.doubleValue() < -1.00001||number.doubleValue()>1.00001)throw new IllegalArgumentException("照片分数无效，不能计算推荐");
        return number.doubleValue();
    }
    static String normalized(Object value) {
        return value==null?"":Normalizer.normalize(value.toString(),Normalizer.Form.NFKC).trim().toLowerCase(Locale.ROOT);
    }
    private static double similarity(String left,String right) {
        int[] a=left.codePoints().toArray(),b=right.codePoints().toArray(),previous=new int[b.length+1];
        for(int j=0;j<=b.length;j++)previous[j]=j;
        for(int i=1;i<=a.length;i++) {
            int[] current=new int[b.length+1];current[0]=i;
            for(int j=1;j<=b.length;j++)current[j]=Math.min(Math.min(previous[j]+1,current[j-1]+1),previous[j-1]+(a[i-1]==b[j-1]?0:1));
            previous=current;
        }
        return (double)(Math.max(a.length,b.length)-previous[b.length])/Math.max(a.length,b.length);
    }
}
