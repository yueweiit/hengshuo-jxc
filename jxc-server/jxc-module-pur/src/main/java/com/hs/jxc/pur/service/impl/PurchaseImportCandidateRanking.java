package com.hs.jxc.pur.service.impl;

import java.text.Normalizer;
import java.util.*;

/** 采购候选的唯一评分规则；不修改检索证据，不代替人工确认商品。 */
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
            boolean top=photo!=null&&photoScore(photo)>=THRESHOLD&&Double.compare(photoScore(photo),highestPhoto)==0;
            if(top)highest.add(id);
            var item=new LinkedHashMap<String,Object>();
            item.put("productId",id);item.put("photoScore",photo);item.put("textScore",textScore);item.put("fields",fields);
            item.put("reason",photo==null?"没有可用照片分数":photoScore(photo)<THRESHOLD?"照片分数不足80%":!top?"未进入照片最高分组":textScore==null?"没有可比较的商品文字，待人工核对":textScore<THRESHOLD?"文字综合分不足80%，待人工核对":"待比较最高文字分");
            scores.add(item);
        }
        var qualified=scores.stream().filter(s->highest.contains(s.get("productId"))&&s.get("textScore")!=null&&((Number)s.get("textScore")).doubleValue()>=THRESHOLD).toList();
        double highestText=qualified.stream().mapToDouble(s->((Number)s.get("textScore")).doubleValue()).max().orElse(-1);
        var winners=qualified.stream().filter(s->Double.compare(((Number)s.get("textScore")).doubleValue(),highestText)==0).toList();
        var recommended=completePhotoGroup&&winners.size()==1?List.of(winners.getFirst().get("productId")):List.of();
        for(var score:qualified)score.put("reason",!completePhotoGroup?"照片最高分组尚不完整，待人工核对":recommended.contains(score.get("productId"))?"照片最高组且文字最高，达到推荐门槛":winners.contains(score)?"照片及文字最高分仍并列，待人工核对":"同组其他候选文字分更高");
        var result=new LinkedHashMap<String,Object>();
        result.put("format","CandidateRankingV1");result.put("policyVersion","photo-first-text-40-40-20-v1");
        result.put("photoThreshold",THRESHOLD);result.put("textThreshold",THRESHOLD);
        result.put("weights",Map.of("productCode",40,"spec",40,"name",20));
        result.put("completePhotoGroup",completePhotoGroup);
        result.put("status",recommended.isEmpty()?"NEEDS_REVIEW":"RECOMMENDED");
        result.put("reason",!completePhotoGroup?"照片最高分组可能因检索数量上限而不完整，已保留候选待人工核对":!recommended.isEmpty()?"已按照片最高组及文字加权分选出候选，仍须人工确认商品与单位":highest.isEmpty()?"没有达到80%的照片候选，已保留原候选供人工核对":winners.size()>1?"照片及文字最高分仍并列，已保留候选待人工核对":"照片最高组没有达到80%的可比较文字分，已保留候选且不比较下一档照片");
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
