package com.hs.jxc.sys.service;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.sys.api.Access;
import org.springframework.stereotype.Service;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Shared output/input policy. Field names are explicitly registered; no heuristic regex. */
@Service
public class FieldPolicyService {
    public static final Set<String> GROUPS=Set.of("COST","CUSTOMER_PRICE","ORDER_TOTAL","BANK_INFO","PROFIT","CREDIT");
    private final Map<String,Set<String>> registry=new ConcurrentHashMap<>();
    // These names are shared by AP, AR, sales and returns; the calling DTO supplies their domain.
    private final Set<String> contextualAmounts=Set.of("openAmount","offsetAmount","refundableAmount","reservedAmount","claimedAmount","payAmount","paymentOpen","creditOpen","openAp","prepaid","cash","transfer","pending","pendingConfirm","orderAmount","outboundAmount","fxRate");
    private final Set<String> amountFields=Set.of("amount","price","unitPrice","stdPrice","manualPriceFlag","priceSource","priceRefId","priceVersionNo","rate","settleRate","fxDiff","balance","opening","increase","paid","offset","adjust","closing","totalAmount","paidAmount","unpaidAmount","discountAmount","originalAmount","baseAmount","taxAmount","lineAmount","feeAmount","settledAmount","remainingAmount","usedAmount");
    public FieldPolicyService() {
        register("COST","costSource","unitCost","cost","costAmount","totalCost","purchasePrice","purchaseUnitPrice","cogs","cogsAmount","grossProfit","grossProfitAmount","grossMargin","margin","initialUnitCost","currentUnitCost","unitCostDiff","costDiff");
        register("PROFIT","profit","profitAmount","netProfit","grossProfit","grossProfitAmount","grossMargin","contributionProfit","margin");
        register("CUSTOMER_PRICE","customerPrice","levelPrice","stdPrice","priceSource","priceRefId","priceVersionNo");
        register("BANK_INFO","referenceNo","bank","bankName","bankCode","bankAccount","bankAddress","bankAccountName","bankAccountNo","account","accountName","accountNo","accountNoMasked","fundAccountName","swiftCode","iban","payeeAccount","payeeAccountName","payeeAccountNo","payerAccount","payerAccountName","payerAccountNo");
        register("CREDIT","creditLimit","creditAmount","overdueAmount","openAr","prepaid","refundable","availableCredit","occupiedCredit","usedCredit","used","limit","available");
    }
    /** Called by trusted module configuration when a new DTO field is introduced. */
    public void register(String group,String... fieldNames) {
        if(!GROUPS.contains(group)) throw new IllegalArgumentException("Unknown field group");
        for(String field:fieldNames) if(!contextualAmounts.contains(field))registry.compute(field,(k,v)->{Set<String> s=new HashSet<>(v==null?Set.of():v);s.add(group);return Set.copyOf(s);});
    }
    public Map<String,Object> mask(Access access,Map<String,Object> row,String amountGroup) {
        validateGroup(amountGroup);
        Map<String,Object> out=new LinkedHashMap<>();
        row.forEach((key,value)->{if(groups(key,amountGroup).stream().allMatch(g->rank(access.fieldGroups().get(g))>=1)) out.put(key,copy(access,value,amountGroup));});
        return out;
    }
    private Object copy(Access a,Object value,String group) {
        if(value instanceof java.math.BigDecimal number&&number.abs().compareTo(com.hs.jxc.common.api.Inputs.PUBLIC_DECIMAL_MAX)>0)
            throw new ApiException(400,"SYS_NUMBER_RANGE","数值超过浏览器接口技术边界，请缩小查询范围或拆分单据");
        if(value instanceof Map<?,?> map) {Map<String,Object> m=new LinkedHashMap<>();map.forEach((k,v)->m.put(String.valueOf(k),v));return mask(a,m,group);}
        if(value instanceof Collection<?> list) return list.stream().map(v->copy(a,v,group)).toList();
        return value;
    }
    public void requireWrite(Access access,Map<String,Object> input,String amountGroup) {
        validateGroup(amountGroup);
        input.forEach((key,value)->{
            for(String group:groups(key,amountGroup)) if(rank(access.fieldGroups().get(group))<2) throw new ApiException(403,"SYS_FORBIDDEN","没有"+group+"字段修改权限");
            if(value instanceof Map<?,?> map) {Map<String,Object> m=new LinkedHashMap<>();map.forEach((k,v)->m.put(String.valueOf(k),v));requireWrite(access,m,amountGroup);}
            else if(value instanceof Collection<?> list) for(Object item:list) if(item instanceof Map<?,?> map) {Map<String,Object> m=new LinkedHashMap<>();map.forEach((k,v)->m.put(String.valueOf(k),v));requireWrite(access,m,amountGroup);}
        });
    }
    public static int rank(String access) {return switch(access==null?"HIDDEN":access) {case "READ"->1;case "WRITE"->2;default->0;};}
    private Set<String> groups(String field,String amountGroup) {Set<String> s=new HashSet<>(registry.getOrDefault(field,Set.of()));if(amountFields.contains(field)||contextualAmounts.contains(field))s.add(amountGroup);return s;}
    private void validateGroup(String group) {if(!GROUPS.contains(group))throw new IllegalArgumentException("Unknown amount group");}
}
