package com.hs.jxc.fin.accounting;
import com.hs.jxc.common.api.ApiException;
import java.math.*;
import java.util.*;
/** Currency rounding for the stable order of immutable source parts. */
public final class AccountingAmounts {
    private AccountingAmounts(){}
    public static List<BigDecimal> split(BigDecimal total,List<BigDecimal> parts,int scale){
        if(total==null||parts==null||parts.isEmpty()||parts.stream().anyMatch(Objects::isNull)||parts.stream().reduce(BigDecimal.ZERO,BigDecimal::add).compareTo(total)!=0)throw new ApiException(400,"FIN_SOURCE_INCOMPLETE","来源金额明细与冻结总额不一致");
        var result=new ArrayList<BigDecimal>();BigDecimal running=BigDecimal.ZERO,previous=BigDecimal.ZERO;
        for(var part:parts){running=running.add(part);BigDecimal rounded=running.setScale(scale,RoundingMode.HALF_UP);result.add(rounded.subtract(previous));previous=rounded;}
        return List.copyOf(result);
    }
}
