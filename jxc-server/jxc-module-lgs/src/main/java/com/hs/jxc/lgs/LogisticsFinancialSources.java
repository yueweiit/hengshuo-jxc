package com.hs.jxc.lgs;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.fin.api.FinancialSourceProvider;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import java.time.LocalDate;
import java.math.*;
import com.hs.jxc.cst.api.CostApi;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
/** Fee confirmation and its rate recovery share the original authoritative source. */
@Component
public class LogisticsFinancialSources implements FinancialSourceProvider {
    private static final Map<String,String> TABLES=Map.of("SHIPMENT","lgs_shipment","LGS_RECEIPT","lgs_receipt","LGS_FEE","lgs_fee","DISCREPANCY","lgs_discrepancy","LGS_NODE","lgs_node");
    private final JdbcTemplate jdbc;private final BookResolver books;private final JsonCodec json;private final CostApi costs;private final com.hs.jxc.fin.api.LedgerApi ledger;
    public LogisticsFinancialSources(JdbcTemplate jdbc,BookResolver books,JsonCodec json,CostApi costs,com.hs.jxc.fin.api.LedgerApi ledger){this.jdbc=jdbc;this.books=books;this.json=json;this.costs=costs;this.ledger=ledger;}
    public boolean supports(String type){return TABLES.containsKey(type);}
    public Map<String,Object> accountingFact(Access a,String event,String type,long id,int seq,LocalDate day,Map<String,Object> frozen){
        var rows=jdbc.queryForList("SELECT * FROM "+TABLES.get(type)+" WHERE country_id=? AND id=?",a.requireCountry(),id);if(rows.isEmpty())throw ApiException.notFound();var r=DbRows.camel(rows.getFirst());books.resolve(a,((Number)r.get("bookId")).longValue(),null);
        var p=new LinkedHashMap<String,Object>();String no=String.valueOf(r.getOrDefault("docNo",type+"-"+id));p.put("docNo",no);
        if(type.equals("LGS_FEE")){
            if(!Set.of("CONFIRMED","ADJUSTED").contains(r.get("status")))throw new ApiException(409,"FIN_SOURCE_NOT_CONFIRMED","费用尚未确认");
            for(String key:List.of("currency","rate","expenseItemId","costTreatment","estimateFeeId","shipmentId"))if(r.get(key)!=null)p.put(key,r.get(key));p.put("partnerId",r.get("carrierId"));p.put("supplierId",r.get("carrierId"));p.put("originalAmount",r.get("amount"));
            Object amount=feeAmount(a,r);boolean rateMissing=amount==null||"PENDING_RATE".equals(r.get("costStatus"));
            if("CAPITALIZE".equals(r.get("costTreatment"))&&!event.equals("LGS_FEE_COST_READY")){
                var financial=costs.inventoryAccountingDelta(a.requireCountry(),((Number)r.get("bookId")).longValue(),"LGS_FEE",id,ledger.baseScale(a,((Number)r.get("bookId")).longValue()));
                amount=financial.amount();p.put("costMissing",amount==null&&!rateMissing);
            }
            p.put("amount",amount);p.put("rateMissing",rateMissing);
            if(!event.equals("LGS_FEE_COST_READY")){
                int scale=ledger.baseScale(a,((Number)r.get("bookId")).longValue());
                BigDecimal payable=feeAmount(a,r,scale);
                p.put("apAmount",payable);p.put("payableRecognition",true);p.put("counterpart","PAYABLE");
                p.put("differenceAmount",payable==null||amount==null?null:payable.subtract(new BigDecimal(amount.toString()).setScale(scale,RoundingMode.HALF_UP)));
            }
            // Cost service owns the capitalization/allocation completeness check and related events.
            p.put("allocationRequired","CAPITALIZE".equals(r.get("costTreatment")));p.put("allocationMissing","CAPITALIZE".equals(r.get("costTreatment"))&&!allocated(a,r,null));
            if(event.equals("LGS_FEE_COST_READY")){p.put("accountingImpact","NONE");p.remove("amount");p.put("reason","汇率就绪通知，原费用确认事件使用冻结金额生成");}
        }else{p.put("accountingImpact","NONE");p.put("reason","运输数量节点，采购成本及费用另有确认来源");}
        return Map.of("bookId",r.get("bookId"),"sourceNo",no,"payload",p);
    }
    private BigDecimal feeAmount(Access a,Map<String,Object> r){return feeAmount(a,r,null);}
    private BigDecimal feeAmount(Access a,Map<String,Object> r,Integer scale){
        if(r.get("baseAmount")==null)return null;
        BigDecimal amount=new BigDecimal(r.get("baseAmount").toString());if(scale!=null)amount=amount.setScale(scale,RoundingMode.HALF_UP);
        if(r.get("estimateFeeId")==null)return amount;
        var estimates=jdbc.queryForList("SELECT base_amount FROM lgs_fee WHERE country_id=? AND book_id=? AND id=?",a.requireCountry(),r.get("bookId"),r.get("estimateFeeId"));
        if(estimates.isEmpty()||estimates.getFirst().get("base_amount")==null)return null;
        BigDecimal estimate=new BigDecimal(estimates.getFirst().get("base_amount").toString());if(scale!=null)estimate=estimate.setScale(scale,RoundingMode.HALF_UP);return amount.subtract(estimate);
    }
    private boolean allocated(Access a,Map<String,Object> r,LocalDate asOf){
        long id=((Number)r.get("id")).longValue();
        if(r.get("actualFeeId") instanceof Number actual){
            var replacements=jdbc.queryForList("SELECT base_amount,biz_date FROM lgs_fee WHERE country_id=? AND book_id=? AND id=?",a.requireCountry(),r.get("bookId"),actual.longValue());
            if(!replacements.isEmpty()&&replacements.getFirst().get("base_amount")!=null&&(asOf==null||!((java.sql.Date)replacements.getFirst().get("biz_date")).toLocalDate().isAfter(asOf)))return allocated(a.requireCountry(),actual.longValue(),asOf);
        }
        return allocated(a.requireCountry(),id,asOf);
    }
    private boolean allocated(long country,long fee,LocalDate asOf){return asOf==null?costs.feeAllocated(country,fee):costs.feeAllocated(country,fee,asOf);}
    /** Unallocated capitalized fees remain an asset and an explicit pending item. */
    public List<Map<String,Object>> balances(Access a,long book,LocalDate day,String type){
        books.resolve(a,book,null);if(!type.equals("INVENTORY"))return List.of();
        var out=new ArrayList<Map<String,Object>>();
        for(var raw:jdbc.queryForList("SELECT * FROM lgs_fee WHERE country_id=? AND book_id=? AND biz_date<=? AND status IN ('CONFIRMED','ADJUSTED') AND cost_treatment='CAPITALIZE' ORDER BY id",a.requireCountry(),book,day)){
            var r=DbRows.camel(raw);long id=((Number)r.get("id")).longValue();
            if(allocated(a,r,day))continue;
            var item=new LinkedHashMap<String,Object>();
            item.put("sourceType","LGS_FEE");item.put("sourceId",id);item.put("sourceNo",r.get("docNo"));item.put("bizDate",r.get("bizDate"));item.put("currency",r.get("currency"));item.put("originalAmount",r.get("amount"));
            Object amount=feeAmount(a,r);
            item.put("amount",amount);item.put("rateMissing",amount==null||"PENDING_RATE".equals(r.get("costStatus")));item.put("allocationMissing",true);item.put("unallocatedAsset",true);out.add(item);
        }
        return out;
    }
}
