package com.hs.jxc.fin.report;

import com.hs.jxc.common.api.*;
import java.util.*;

/** Finite arithmetic over accounting facts; never evaluates script or SQL supplied by a user. */
final class ReportRules {
    static final Set<String> TYPES=Set.of("BALANCE_SHEET","INCOME","CASHFLOW");
    static final Set<String> CATEGORIES=Set.of("ASSET","LIABILITY","EQUITY","INCOME","COST","EXPENSE","PROFIT_LOSS");
    private ReportRules(){}
    static String type(String value){if(value==null||!TYPES.contains(value.toUpperCase(Locale.ROOT)))throw Inputs.bad("报表类型不合法");return value.toUpperCase(Locale.ROOT);}
    static int sign(Object value){if(value==null)return 1;try{int n=new java.math.BigDecimal(value.toString()).intValueExact();if(n==1||n==-1)return n;}catch(RuntimeException ignored){}throw expression();}
    static ApiException expression(){return new ApiException(400,"FIN_REPORT_EXPRESSION_INVALID","报表仅支持期末净额、本期净发生额和前序行的加减，不支持脚本");}
    @SuppressWarnings("unchecked") static List<Map<String,Object>> maps(Object value){if(!(value instanceof List<?> list)||list.size()>200)throw Inputs.bad("报表行数不合法");for(Object row:list)if(!(row instanceof Map<?,?>))throw Inputs.bad("报表行不合法");return (List<Map<String,Object>>)(List<?>)list;}
    static List<Map<String,Object>> validate(String rule,Object value){
        if(!Set.of("CATEGORY_V1","ACCOUNT_MAP_V1").contains(rule))throw expression();
        if(rule.equals("CATEGORY_V1")){if(value!=null&&!maps(value).isEmpty())throw Inputs.bad("分类规则版本不接受自定义行");return List.of();}
        var raw=maps(value);if(raw.isEmpty())throw Inputs.bad("请配置报表行");var codes=new LinkedHashSet<String>();var out=new ArrayList<Map<String,Object>>();
        for(var row:raw){
            String code=Inputs.required(row,"code"),name=Inputs.required(row,"name"),formula=Inputs.required(row,"formula");
            if(!code.matches("[A-Z][A-Z0-9_]{0,63}")||codes.contains(code)||name.length()>200)throw Inputs.bad("报表行代码重复或格式不合法");
            if(!Set.of("CLOSING_NET","PERIOD_NET","LINE_SUM").contains(formula))throw expression();
            var line=new LinkedHashMap<String,Object>();line.put("code",code);line.put("name",name);line.put("formula",formula);line.put("sign",sign(row.get("sign")));
            if(formula.equals("LINE_SUM")){
                if(row.get("category")!=null||row.get("accountIds") instanceof List<?> ids&&!ids.isEmpty())throw expression();
                var terms=maps(row.get("terms"));if(terms.isEmpty())throw expression();var controlled=new ArrayList<Map<String,Object>>();
                for(var term:terms){String previous=Inputs.required(term,"code");if(!codes.contains(previous))throw expression();controlled.add(Map.of("code",previous,"sign",sign(term.get("sign"))));}line.put("terms",controlled);line.put("accountIds",List.of());
            }else{
                String category=Inputs.text(row,"category",null);if(category!=null&&!CATEGORIES.contains(category))throw expression();
                var ids=new LinkedHashSet<Long>();if(row.get("accountIds")!=null){if(!(row.get("accountIds") instanceof List<?> list)||list.size()>1000)throw expression();for(Object id:list)ids.add(Inputs.id(id));}
                if(category==null&&ids.isEmpty()||category!=null&&!ids.isEmpty()||row.get("terms") instanceof List<?> terms&&!terms.isEmpty())throw expression();
                line.put("category",category);line.put("accountIds",new ArrayList<>(ids));line.put("terms",List.of());
            }
            codes.add(code);out.add(line);
        }
        return out;
    }
}
