package com.hs.jxc.ap;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.fin.api.FinancialSourceProvider;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import java.math.*;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Accounting reads frozen original AP conversions and immutable settlement FX facts. */
@Component
public class PayablesFinancialSources implements FinancialSourceProvider {
    private final JdbcTemplate db;private final BookResolver books;private final com.hs.jxc.fin.api.LedgerApi ledger;
    public PayablesFinancialSources(JdbcTemplate db,BookResolver books,com.hs.jxc.fin.api.LedgerApi ledger){this.db=db;this.books=books;this.ledger=ledger;}
    private static final Map<String,String> TABLES=Map.of("AP_BILL","ap_bill","AP_PAYMENT","ap_payment","AP_PREPAYMENT","ap_prepayment","AP_CREDIT_NOTE","ap_credit_note","AP_SETTLEMENT","ap_settlement","AP_ADJUSTMENT","ap_adjustment");
    public boolean supports(String type){return TABLES.containsKey(type);}
    private Map<String,Object> row(Access a,String type,long id){var rows=db.queryForList("SELECT * FROM "+TABLES.get(type)+" WHERE country_id=? AND id=?",a.requireCountry(),id);if(rows.isEmpty())throw ApiException.notFound();var r=DbRows.camel(rows.getFirst());books.resolve(a,((Number)r.get("bookId")).longValue(),null);return r;}
    public Map<String,Object> accountingFact(Access a,String event,String type,long id,int seq,LocalDate date,Map<String,Object> frozen){
        var r=row(a,type,id);var p=new LinkedHashMap<String,Object>();p.put("partnerId",r.get("partnerId"));p.put("supplierId",r.get("partnerId"));p.put("partnerType",r.get("partnerType"));p.put("docNo",r.get("docNo"));
        if(type.equals("AP_SETTLEMENT")){
            var lines=financialSettlementLines(a,((Number)r.get("bookId")).longValue(),id);
            p.put("billBaseAmount",sum(lines,"billBaseAmount"));p.put("payBaseAmount",sum(lines,"payBaseAmount"));p.put("fxDiff",sum(lines,"diffAmount"));p.put("amount",p.get("billBaseAmount"));p.put("lines",lines);p.put("cashAlreadyRecognized",true);p.put("rateMissing",lines.isEmpty());
        }else{
            for(String key:List.of("amount","currency","baseCurrency","baseAmount","rate","fundAccountId"))if(r.get(key)!=null)p.put(key,r.get(key));
            p.put("originalAmount",r.get("amount"));p.put("amount",r.get("baseAmount"));p.put("rateMissing",r.get("baseAmount")==null);
            if(type.equals("AP_BILL")&&!"OTHER".equals(r.get("billType"))||type.equals("AP_CREDIT_NOTE")&&"PURCHASE_RETURN".equals(r.get("sourceType")))p.put("accountingImpact","SOURCE_CONFIRMATION");
            if(type.equals("AP_ADJUSTMENT")){p.put("accountingImpact","NONE");p.remove("amount");p.remove("baseAmount");p.put("rateMissing",false);}
            if(event.endsWith("REGISTERED")||event.endsWith("CREATED")&&!type.equals("AP_CREDIT_NOTE")||event.endsWith("RATE_READY")){p.put("accountingImpact","NONE");p.remove("amount");p.remove("baseAmount");p.put("rateMissing",false);}
        }
        if(p.get("amount")!=null)p.put("amount",decimal(p.get("amount")).setScale(ledger.baseScale(a,((Number)r.get("bookId")).longValue()),RoundingMode.HALF_UP));
        return Map.of("bookId",r.get("bookId"),"sourceNo",r.get("docNo"),"payload",p);
    }
    public List<Map<String,Object>> balances(Access a,long book,LocalDate date,String type){
        books.resolve(a,book,null);if(!Set.of("AP","CASH").contains(type))return List.of();var out=new ArrayList<Map<String,Object>>();
        if(type.equals("AP")){add(out,a,book,date,"AP_BILL","bill_date",1,"status IN ('CONFIRMED','PARTIAL_PAID','PAID')");add(out,a,book,date,"AP_CREDIT_NOTE","biz_date",-1,"status<>'VOIDED'");addSettlementFx(out,a,book,date);}
        add(out,a,book,date,"AP_PAYMENT","pay_date",-1,"status IN ('CONFIRMED','PARTIAL_SETTLED','SETTLED')");add(out,a,book,date,"AP_PREPAYMENT","pay_date",-1,"status IN ('CONFIRMED','PARTIAL_SETTLED','SETTLED','PARTIAL_USED','USED')"+(type.equals("CASH")?" AND origin_kind<>'OPENING'":""));return out;
    }
    private void addSettlementFx(List<Map<String,Object>> out,Access a,long book,LocalDate date){
        for(var settlement:db.queryForList("SELECT id,doc_no,biz_date,partner_id FROM ap_settlement WHERE country_id=? AND book_id=? AND biz_date<=? ORDER BY id",a.requireCountry(),book,date)){
            long id=((Number)settlement.get("id")).longValue();BigDecimal amount=sum(financialSettlementLines(a,book,id),"diffAmount");
            var item=new LinkedHashMap<String,Object>();item.put("sourceType","AP_SETTLEMENT");item.put("sourceId",id);item.put("sourceNo",settlement.get("doc_no"));item.put("bizDate",settlement.get("biz_date"));item.put("partnerId",settlement.get("partner_id"));item.put("amount",amount);item.put("originalAmount",BigDecimal.ZERO);item.put("rateMissing",false);out.add(item);
        }
    }
    private void add(List<Map<String,Object>> out,Access a,long book,LocalDate date,String type,String day,int sign,String state){
        for(var raw:db.queryForList("SELECT * FROM "+TABLES.get(type)+" WHERE country_id=? AND book_id=? AND "+day+"<=? AND "+state+" ORDER BY id",a.requireCountry(),book,date)){
            var r=DbRows.camel(raw);var item=new LinkedHashMap<String,Object>();item.put("sourceType",type);item.put("sourceId",r.get("id"));item.put("sourceNo",r.get("docNo"));item.put("bizDate",raw.get(day));item.put("currency",r.get("currency"));item.put("originalAmount",decimal(r.get("amount")).multiply(BigDecimal.valueOf(sign)));item.put("amount",r.get("baseAmount")==null?null:decimal(r.get("baseAmount")).setScale(ledger.baseScale(a,book),RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(sign)));item.put("rateMissing",r.get("baseAmount")==null);item.put("partnerId",r.get("partnerId"));if(r.get("fundAccountId")!=null)item.put("fundAccountId",r.get("fundAccountId"));out.add(item);
        }
    }
    /** Replay only immutable prior conversions. Reversals negate their original posting allocation. */
    private List<Map<String,Object>> financialSettlementLines(Access a,long book,long settlementId){
        int scale=ledger.baseScale(a,book);
        var all=db.queryForList("SELECT l.*,s.direction,s.reversal_of_id,f.bill_base_amount,f.pay_base_amount,f.diff_amount FROM ap_settlement_line l JOIN ap_settlement s ON s.country_id=l.country_id AND s.id=l.settlement_id JOIN ap_fx_diff f ON f.country_id=l.country_id AND f.settlement_line_id=l.id WHERE l.country_id=? AND s.book_id=? AND l.id<=(SELECT coalesce(max(id),0) FROM ap_settlement_line WHERE country_id=? AND settlement_id=?) ORDER BY l.id",a.requireCountry(),book,a.requireCountry(),settlementId).stream().map(DbRows::camel).toList();
        Map<String,BigDecimal> raw=new HashMap<>(),posted=new HashMap<>();
        Map<Long,List<Map<String,Object>>> bySettlement=new HashMap<>();
        List<Map<String,Object>> result=new ArrayList<>();
        for(var line:all){
            long sid=((Number)line.get("settlementId")).longValue();
            String bill="B:"+line.get("billId"),pay="P:"+line.get("fromType")+":"+line.get("fromId");
            BigDecimal rawBill=decimal(line.get("billBaseAmount")),rawPay=decimal(line.get("payBaseAmount"));
            BigDecimal billAmount,payAmount;
            if(((Number)line.get("direction")).intValue()<0){
                var originals=bySettlement.get(((Number)line.get("reversalOfId")).longValue());
                int ordinal=bySettlement.getOrDefault(sid,List.of()).size();
                if(originals==null||ordinal>=originals.size())throw new ApiException(409,"FIN_SOURCE_INCOMPLETE","核销冲销缺少原始金额来源");
                billAmount=decimal(originals.get(ordinal).get("billBaseAmount")).negate();
                payAmount=decimal(originals.get(ordinal).get("payBaseAmount")).negate();
            }else{
                billAmount=raw.getOrDefault(bill,BigDecimal.ZERO).add(rawBill).setScale(scale,RoundingMode.HALF_UP).subtract(posted.getOrDefault(bill,BigDecimal.ZERO));
                payAmount=raw.getOrDefault(pay,BigDecimal.ZERO).add(rawPay).setScale(scale,RoundingMode.HALF_UP).subtract(posted.getOrDefault(pay,BigDecimal.ZERO));
            }
            raw.merge(bill,rawBill,BigDecimal::add);raw.merge(pay,rawPay,BigDecimal::add);
            posted.merge(bill,billAmount,BigDecimal::add);posted.merge(pay,payAmount,BigDecimal::add);
            var financial=new LinkedHashMap<>(line);financial.put("billBaseAmount",billAmount);financial.put("payBaseAmount",payAmount);financial.put("diffAmount",payAmount.subtract(billAmount));
            bySettlement.computeIfAbsent(sid,k->new ArrayList<>()).add(financial);
            if(sid==settlementId)result.add(financial);
        }
        return result;
    }
    private BigDecimal sum(List<Map<String,Object>> rows,String key){return rows.stream().map(r->decimal(r.get(key))).reduce(BigDecimal.ZERO,BigDecimal::add);}
    private BigDecimal decimal(Object value){return value==null?BigDecimal.ZERO:new BigDecimal(value.toString());}
}
