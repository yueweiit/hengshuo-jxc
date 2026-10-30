package com.hs.jxc.pur.service.impl;

import com.hs.jxc.common.api.Inputs;
import java.time.Instant;
import java.util.*;
import static com.hs.jxc.pur.service.impl.PurchaseImportServiceImpl.list;

/** 来源原文与人的含义确认分开存储；列币种确认不修改业务表头。 */
final class PurchaseImportSourceReview {
    private static final Map<String,Set<String>> MEANINGS=Map.of(
        "IDENTIFIER",Set.of("ORDER_NUMBER","PRODUCT_CODE","OTHER"),"PHOTO",Set.of("PRODUCT_PHOTOS","OTHER"),
        "USD_AMOUNT",Set.of("USD_AMOUNT","OTHER"),"FREIGHT",Set.of("ORDER_ONCE","PER_PRODUCT","PER_UNIT","OTHER"));
    record Decision(List<Map<String,Object>> sheets,String orderNumber){}
    @SuppressWarnings("unchecked") private static Map<String,Object> object(Object value){if(!(value instanceof Map<?,?>))throw Inputs.bad("来源核对依据不完整");return new LinkedHashMap<>((Map<String,Object>)value);}
    static Decision apply(List<Map<String,Object>> sheets,Map<String,Object> input,long userId){
        if(!input.keySet().equals(Set.of("subjectId","meaning","previousMeaning")))throw Inputs.bad("含义确认只接受原文标识、含义及原确认版本");
        String id=Inputs.required(input,"subjectId"),meaning=Inputs.required(input,"meaning");
        for(var sheet:sheets){
            if(sheet.get("reviewContext")==null)continue;
            var context=object(sheet.get("reviewContext"));if(!"SourceReviewContextV1".equals(context.get("format")))throw Inputs.bad("来源核对依据版本不正确");
            for(var subject:list(context.get("subjects"))){
                String key=subject.get("id").toString();if(!id.equals(sheet.get("name")+":"+key))continue;
                if(!MEANINGS.containsKey(subject.get("kind"))||!MEANINGS.get(subject.get("kind")).contains(meaning))throw Inputs.bad("含义选项不适用于本次原文");
                // 历史来源没有确认记录是合法未确认状态，不能冒充确认成功。
                var answers=sheet.get("reviewAnswers")==null?new LinkedHashMap<String,Object>():object(sheet.get("reviewAnswers"));
                Object before=answers.containsKey(key)?object(answers.get(key)).get("meaning"):null;
                if(!Objects.equals(before,input.get("previousMeaning")))throw Inputs.conflict();
                answers.put(key,Map.of("meaning",meaning,"confirmedBy",userId,"confirmedAt",Instant.now().toString()));sheet.put("reviewAnswers",answers);
                return new Decision(sheets,meaning.equals("ORDER_NUMBER")?Inputs.required(subject,"label"):null);
            }
        }
        throw Inputs.bad("本文件中没有对应的原文依据，请重新读取");
    }
    static boolean identifierConflict(List<Map<String,Object>> sheets,String orderNumber){
        if(orderNumber==null)return false;
        for(var sheet:sheets){if(sheet.get("reviewContext")==null||sheet.get("reviewAnswers")==null)continue;
            var answers=object(sheet.get("reviewAnswers"));
            for(var subject:list(object(sheet.get("reviewContext")).get("subjects"))){
                Object answer=answers.get(subject.get("id"));
                if("IDENTIFIER".equals(subject.get("kind"))&&orderNumber.equals(subject.get("label"))&&answer!=null&&!"ORDER_NUMBER".equals(object(answer).get("meaning")))return true;
            }
        }return false;
    }
}
