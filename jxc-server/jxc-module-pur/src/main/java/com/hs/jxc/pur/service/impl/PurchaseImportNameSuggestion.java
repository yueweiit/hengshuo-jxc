package com.hs.jxc.pur.service.impl;

import com.hs.jxc.common.api.Inputs;
import java.util.*;

/** 图片只提供类别和可见特征；完整名称的规格由当前采购行决定。 */
public final class PurchaseImportNameSuggestion {
    private PurchaseImportNameSuggestion() {}
    public static Map<String,Object> validate(Map<String,Object> input,Object rowSpec,Set<String> sourceImages) {
        if(!input.keySet().equals(Set.of("status","category","baseName","reason","sourceKeys")))throw Inputs.bad("图片命名包含未经允许的字段");
        String status=Inputs.required(input,"status"),reason=Inputs.required(input,"reason");
        if(!Set.of("READY","NEEDS_REVIEW","NO_INPUT").contains(status)||reason.length()>2000)throw Inputs.bad("图片命名状态或原因无效");
        if(!(input.get("sourceKeys") instanceof List<?> keys)||new HashSet<>(keys).size()!=keys.size()||keys.stream().anyMatch(k->!(k instanceof String key)||!key.startsWith("SOURCE:")||!sourceImages.contains(key)))throw Inputs.bad("图片命名只能引用本行已读取的来源图");
        String category=null,base=null,name=null,spec=rowSpec==null?null:rowSpec.toString().trim();
        if(spec!=null&&spec.isEmpty())spec=null;
        if("NO_INPUT".equals(status)&&(!keys.isEmpty()||!sourceImages.isEmpty()))throw Inputs.bad("已有来源图不能声称没有命名输入");
        if(!"NO_INPUT".equals(status)&&keys.isEmpty())throw Inputs.bad("图片命名缺少实际来源图依据");
        if("READY".equals(status)) {
            category=Inputs.required(input,"category");base=Inputs.required(input,"baseName");
            if(category.length()>64||base.length()>160||!base.endsWith(category)||base.matches("(?iu).*(验收商品|测试商品|待命名商品).*"))throw Inputs.bad("商品名称须包含实际类别，不能使用验收占位名");
            String prefix=spec==null?"":spec.matches("(?i)(X{0,4}[SL]|M|[2-9]X[SL])")?spec.toUpperCase(Locale.ROOT)+"码":spec;
            name=prefix+base;if(name.length()>200)throw Inputs.bad("建议商品名称超过200字符，请核对规格和名称");
        } else if(input.get("category")!=null||input.get("baseName")!=null)throw Inputs.bad("类别待确认时不能给出确定商品名");
        var result=new LinkedHashMap<String,Object>(input);result.put("category",category);result.put("baseName",base);result.put("name",name);result.put("productSpec",spec);return result;
    }
    public static Map<String,Object> modelFields(Map<String,Object> saved) {
        var result=new LinkedHashMap<String,Object>();for(String key:List.of("status","category","baseName","reason","sourceKeys"))result.put(key,saved.get(key));return result;
    }
}
