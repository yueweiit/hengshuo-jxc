package com.hs.jxc.fin.ledger;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.fin.api.FinancialReferenceProvider;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.DocumentAccessService;
import java.math.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Shared validation for manual, generated, opening and reversal entries. */
@Component
public class LedgerValidation {
    private final JdbcTemplate jdbc;private final JsonCodec json;private final List<FinancialReferenceProvider> references;private final DocumentAccessService sources;
    private static final Map<String,String> AUX=Map.ofEntries(Map.entry("CUSTOMER","customerId"),Map.entry("PARTNER","supplierId"),Map.entry("SUPPLIER","supplierId"),Map.entry("FUND","fundAccountId"),Map.entry("FUND_ACCOUNT","fundAccountId"),Map.entry("PRODUCT","productId"),Map.entry("WAREHOUSE","warehouseId"),Map.entry("STORE","storeId"),Map.entry("EXPENSE","expenseItemId"),Map.entry("EXPENSE_ITEM","expenseItemId"),Map.entry("EMPLOYEE","employeeId"));
    public LedgerValidation(JdbcTemplate jdbc,JsonCodec json,List<FinancialReferenceProvider> references,DocumentAccessService sources){this.jdbc=jdbc;this.json=json;this.references=references;this.sources=sources;}
    public Map<String,Object> account(Access a,long book,long id){var rs=jdbc.queryForList("SELECT * FROM fin_account WHERE country_id=? AND book_id=? AND id=?",a.requireCountry(),book,id);if(rs.isEmpty())throw ApiException.notFound();var r=DbRows.camel(rs.getFirst());r.put("auxTypes",json.read(r.get("auxTypes").toString(),List.class));return r;}
    public List<String> auxTypes(Object input){if(!(input instanceof List<?> list))throw Inputs.bad("auxTypes必须为数组");var out=new LinkedHashSet<String>();for(var value:list){String type=String.valueOf(value);if(!AUX.containsKey(type)&&!AUX.containsValue(type))throw Inputs.bad("未知辅助核算类型");String canonical=AUX.getOrDefault(type,type);if(!out.add(canonical))throw Inputs.bad("辅助核算类型重复");}return new ArrayList<>(out);}
    @SuppressWarnings("unchecked") public Map<String,Object> aux(Access a,long book,Map<String,Object> account,Object input){
        Map<String,Object> result=new TreeMap<>();if(input!=null){if(!(input instanceof Map<?,?> map))throw Inputs.bad("辅助项必须为对象");map.forEach((k,v)->result.put("partnerId".equals(k)?"supplierId":String.valueOf(k),v));}
        Set<String> required=new HashSet<>(auxTypes(account.get("auxTypes")));
        if(!required.containsAll(result.keySet()))throw Inputs.bad("辅助项必须符合科目配置");
        for(String field:required){if(result.get(field)==null)throw new ApiException(400,"FIN_AUX_REQUIRED","缺少辅助核算项："+field);long id=Inputs.id(result.get(field));
            var provider=references.stream().filter(p->p.supports(field)).findFirst().orElseThrow(()->Inputs.bad("辅助项尚无可信来源："+field));provider.validate(a,book,field,id);result.put(field,id);}
        return result;
    }
    public List<Map<String,Object>> lines(Access a,long book,List<Map<String,Object>> input,boolean reversal){return lines(a,book,input,reversal,false);}
    public void requireSourceAccess(Access a,Map<String,Object> line){String type=Inputs.text(line,"sourceDocType",null);Long id=line.get("sourceDocId")==null?null:Inputs.id(line.get("sourceDocId"));if((type==null)!=(id==null))throw Inputs.bad("来源类型与ID必须同时填写");if(type!=null)sources.requireDocumentAccess(a,type,id,false);}
    public List<Map<String,Object>> lines(Access a,long book,List<Map<String,Object>> input,boolean reversal,boolean trustedSource){
        String base=jdbc.queryForObject("SELECT base_currency FROM fin_book WHERE country_id=? AND id=?",String.class,a.requireCountry(),book);int scale=scale(base);
        if(input==null||input.size()<2||input.size()>1000)throw Inputs.bad("凭证需要2至1000条分录");var out=new ArrayList<Map<String,Object>>();BigDecimal debit=BigDecimal.ZERO,credit=BigDecimal.ZERO;
        for(var raw:input){long id=Inputs.id(raw.get("accountId"));var acc=account(a,book,id);if(!Boolean.TRUE.equals(acc.get("isLeaf"))||!"ENABLED".equals(acc.get("status")))throw new ApiException(400,"FIN_ACCOUNT_INVALID","请选择启用的末级科目");
            BigDecimal d=decimal(raw.getOrDefault("debit",0),scale),c=decimal(raw.getOrDefault("credit",0),scale);if((d.signum()==0)==(c.signum()==0)||!reversal&&(d.signum()<0||c.signum()<0))throw Inputs.bad("分录必须只有借方或贷方金额");
            var aux=aux(a,book,acc,raw.get("aux"));String currency=Inputs.text(raw,"currency",base);boolean fx=Boolean.TRUE.equals(acc.get("fxEnabled"));
            if(!fx&&!base.equals(currency))throw Inputs.bad("此科目未启用外币核算");scale(currency);BigDecimal rate=raw.get("rate")==null?BigDecimal.ONE:Inputs.decimal(raw.get("rate"),8,Inputs.PUBLIC_DECIMAL_MAX);if(rate.signum()<=0||base.equals(currency)&&rate.compareTo(BigDecimal.ONE)!=0)throw Inputs.bad("汇率不合法");
            if(!base.equals(currency)&&(!fx||raw.get("origAmount")==null||raw.get("rate")==null))throw Inputs.bad("外币分录必须填写原币金额和汇率");
            BigDecimal amount=d.signum()!=0?d:c;BigDecimal orig=raw.get("origAmount")==null?amount:decimal(raw.get("origAmount"),scale(currency));if(orig.multiply(rate).setScale(scale,RoundingMode.HALF_UP).compareTo(amount)!=0)throw new ApiException(400,"FIN_FX_AMOUNT_MISMATCH","本位币金额必须等于原币乘汇率");
            Long cash=raw.get("cashflowItemId")==null?null:Inputs.id(raw.get("cashflowItemId"));if((Boolean.TRUE.equals(acc.get("isCash"))||Boolean.TRUE.equals(acc.get("isBank")))&&cash==null)throw new ApiException(400,"FIN_CASHFLOW_REQUIRED","现金银行分录必须填写现金流项目");
            if(cash!=null){var items=jdbc.queryForList("SELECT direction FROM fin_cashflow_item WHERE country_id=? AND book_id=? AND id=? AND status='ENABLED'",a.requireCountry(),book,cash);if(items.isEmpty())throw ApiException.notFound();String flow=items.getFirst().get("direction").toString();if(!reversal&&((Set.of("IN","DEBIT").contains(flow)&&c.signum()>0)||(Set.of("OUT","CREDIT").contains(flow)&&d.signum()>0)))throw Inputs.bad("现金流项目方向与分录不一致");}
            String source=Inputs.text(raw,"sourceDocType",null);Long sourceId=raw.get("sourceDocId")==null?null:Inputs.id(raw.get("sourceDocId"));if((source==null)!=(sourceId==null))throw Inputs.bad("来源类型与ID必须同时填写");if(!trustedSource)requireSourceAccess(a,raw);
            var line=new LinkedHashMap<String,Object>();line.put("accountId",id);line.put("accountCode",acc.get("code"));line.put("accountName",acc.get("name"));line.put("summary",Inputs.text(raw,"summary",""));line.put("aux",aux);line.put("auxKey",jdbc.queryForObject("SELECT ?::jsonb::text",String.class,json.write(aux)));line.put("currency",currency);line.put("origAmount",orig);line.put("rate",rate);line.put("debit",d);line.put("credit",c);line.put("cashflowItemId",cash);line.put("sourceDocType",source);line.put("sourceDocId",sourceId);out.add(line);debit=debit.add(d);credit=credit.add(c);
        }
        if(debit.compareTo(credit)!=0)throw new ApiException(400,"FIN_UNBALANCED","借贷不平");return out;
    }
    public int scale(String currency){var rows=jdbc.queryForList("SELECT decimals FROM md_currency WHERE code=? AND status='ENABLED'",currency);if(rows.isEmpty())throw Inputs.bad("币种不存在或已停用");return ((Number)rows.getFirst().get("decimals")).intValue();}
    public static BigDecimal decimal(Object value,int scale){return Inputs.decimal(value,scale,Inputs.PUBLIC_DECIMAL_MAX);}
}
