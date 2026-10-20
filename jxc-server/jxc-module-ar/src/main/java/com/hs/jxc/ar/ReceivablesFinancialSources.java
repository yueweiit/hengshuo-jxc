package com.hs.jxc.ar;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.common.event.OutboxPublisher;
import com.hs.jxc.fin.api.FinancialSourceProvider;
import com.hs.jxc.fin.api.LedgerApi;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import java.math.*;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Historical AR and cash facts; writeoff projections never substitute for the posted GL. */
@Component
public class ReceivablesFinancialSources implements FinancialSourceProvider {
    private static final Map<String,String> TABLES=Map.of("AR_RECEIPT","ar_receipt","AR_RECEIVABLE","ar_receivable","AR_WRITEOFF","ar_writeoff","AR_CREDIT_NOTE","ar_credit_note");
    private final JdbcTemplate db;private final BookResolver books;private final OutboxPublisher events;private final LedgerApi ledger;
    public ReceivablesFinancialSources(JdbcTemplate db,BookResolver books,OutboxPublisher events,LedgerApi ledger){this.db=db;this.books=books;this.events=events;this.ledger=ledger;}
    public boolean supports(String type){return TABLES.containsKey(type);}
    private Map<String,Object> row(Access a,String type,long id){var rows=db.queryForList("SELECT * FROM "+TABLES.get(type)+" WHERE country_id=? AND id=?",a.requireCountry(),id);if(rows.isEmpty())throw ApiException.notFound();var r=DbRows.camel(rows.getFirst());books.resolve(a,n(r,"bookId"),null);return r;}
    public Map<String,Object> accountingFact(Access a,String event,String type,long id,int seq,LocalDate day,Map<String,Object> frozen){
        var r=row(a,type,id);var p=new LinkedHashMap<String,Object>();long book=n(r,"bookId");p.put("customerId",r.get("customerId"));p.put("docNo",r.get("docNo"));p.put("currency",r.get("currency"));
        BigDecimal amount,allocatedAmount=null;int scale=ledger.baseScale(a,book);
        if(type.equals("AR_WRITEOFF")){
            var lines=db.queryForList("SELECT * FROM ar_writeoff_line WHERE country_id=? AND writeoff_id=? ORDER BY id",a.requireCountry(),id).stream().map(DbRows::camel).toList();
            amount=lines.stream().filter(l->"RECEIPT".equals(l.get("fromType"))).map(l->d(l,"amount")).reduce(BigDecimal.ZERO,BigDecimal::add);
            allocatedAmount=lines.stream().filter(l->"RECEIPT".equals(l.get("fromType"))).map(l->writeoffAmount(a,l,scale)).reduce(BigDecimal.ZERO,BigDecimal::add);
            p.put("creditNoteAmount",lines.stream().filter(l->"CREDIT_NOTE".equals(l.get("fromType"))).map(l->d(l,"amount")).reduce(BigDecimal.ZERO,BigDecimal::add));
            p.put("lines",lines);p.put("cashAlreadyRecognized",true);
            if(lines.stream().allMatch(l->"CREDIT_NOTE".equals(l.get("fromType"))))p.put("accountingImpact","SOURCE_CONFIRMATION");
        }else{
            amount=d(r,"amount");if(type.equals("AR_RECEIPT")){
                if(r.get("fundAccountId")!=null)p.put("fundAccountId",r.get("fundAccountId"));
                if(event.equals("AR_RECEIPT_VOIDED")){if(!Boolean.TRUE.equals(frozen.get("wasConfirmed"))){p.put("accountingImpact","NONE");return result(r,p);}amount=amount.negate();}
                else if(r.get("confirmedAt")==null)throw new ApiException(409,"FIN_SOURCE_NOT_CONFIRMED","收款尚未确认");
            }
        }
        if(type.equals("AR_RECEIVABLE")||type.equals("AR_CREDIT_NOTE"))p.put("accountingImpact","SOURCE_CONFIRMATION");
        p.put("originalAmount",amount);boolean missing=!Objects.equals(r.get("currency"),books.baseCurrency(a,book));p.put("rateMissing",missing);p.put("amount",missing?null:allocatedAmount!=null?allocatedAmount:type.equals("AR_RECEIVABLE")?receivableAmount(a,r,scale):amount.setScale(scale,RoundingMode.HALF_UP));return result(r,p);
    }
    private Map<String,Object> result(Map<String,Object> r,Map<String,Object> p){return Map.of("bookId",r.get("bookId"),"sourceNo",r.get("docNo"),"payload",p);}
    public List<Map<String,Object>> balances(Access a,long book,LocalDate day,String type){
        String base=books.baseCurrency(a,book);if(!Set.of("AR","CASH").contains(type))return List.of();var out=new ArrayList<Map<String,Object>>();int scale=ledger.baseScale(a,book);
        if(type.equals("AR"))for(var raw:db.queryForList("SELECT * FROM ar_receivable WHERE country_id=? AND book_id=? AND biz_date<=? ORDER BY id",a.requireCountry(),book,day)){var r=DbRows.camel(raw);var item=item(r,"AR_RECEIVABLE",date(r,"bizDate"),d(r,"amount"),base,scale);if(!Boolean.TRUE.equals(item.get("rateMissing")))item.put("amount",receivableAmount(a,r,scale));out.add(item);}
        for(var raw:db.queryForList("SELECT * FROM ar_receipt WHERE country_id=? AND book_id=? AND confirmed_at IS NOT NULL AND arrival_date<=? ORDER BY id",a.requireCountry(),book,day)){
            var r=DbRows.camel(raw);BigDecimal amount=d(r,"amount").multiply(type.equals("AR")?BigDecimal.ONE.negate():BigDecimal.ONE);
            if(!Set.of("CONFIRMED","PARTIAL_WRITTEN_OFF","WRITTEN_OFF","VOIDED").contains(r.get("status")))continue;
            out.add(item(r,"AR_RECEIPT",date(r,"arrivalDate"),amount,base,scale));
            if("VOIDED".equals(r.get("status"))){var reversals=events.history(a.requireCountry(),book,"AR_RECEIPT",n(r,"id"),"AR_RECEIPT_VOIDED",day);for(var reversed:reversals)if(Boolean.TRUE.equals(((Map<?,?>)reversed.get("payload")).get("wasConfirmed")))out.add(item(r,"AR_RECEIPT_VOIDED",LocalDate.parse(reversed.get("bizDate").toString()),amount.negate(),base,scale));}
        }
        if(type.equals("AR"))for(var raw:db.queryForList("SELECT * FROM ar_credit_note WHERE country_id=? AND book_id=? AND source_type='OPENING_ADVANCE' AND biz_date<=? ORDER BY id",a.requireCountry(),book,day)){var r=DbRows.camel(raw);out.add(item(r,"OPENING_ADVANCE",date(r,"bizDate"),d(r,"amount").negate(),base,scale));}
        if(type.equals("AR"))for(var raw:db.queryForList("SELECT w.*,coalesce(sum(l.amount),0) credit_amount FROM ar_writeoff w JOIN ar_writeoff_line l ON l.country_id=w.country_id AND l.writeoff_id=w.id AND l.from_type='CREDIT_NOTE' JOIN ar_credit_note cn ON cn.country_id=l.country_id AND cn.id=l.credit_note_id AND cn.source_type<>'OPENING_ADVANCE' WHERE w.country_id=? AND w.book_id=? AND w.biz_date<=? GROUP BY w.id ORDER BY w.id",a.requireCountry(),book,day)){
            var r=DbRows.camel(raw);out.add(item(r,"AR_CREDIT_APPLIED",date(r,"bizDate"),d(r,"creditAmount").negate(),base,scale));
        }
        return out;
    }
    private Map<String,Object> item(Map<String,Object> r,String type,LocalDate date,BigDecimal amount,String base,int scale){var out=new LinkedHashMap<String,Object>();out.put("sourceType",type);out.put("sourceId",r.get("id"));out.put("sourceNo",r.get("docNo"));out.put("bizDate",date);out.put("currency",r.get("currency"));out.put("originalAmount",amount);boolean missing=!Objects.equals(base,r.get("currency"));out.put("amount",missing?null:amount.setScale(scale,RoundingMode.HALF_UP));out.put("rateMissing",missing);out.put("customerId",r.get("customerId"));if(r.get("fundAccountId")!=null)out.put("fundAccountId",r.get("fundAccountId"));return out;}
    /** Frozen allocation history: reversals negate their original cents, later allocations absorb any remainder. */
    private BigDecimal writeoffAmount(Access a,Map<String,Object> target,int scale){
        BigDecimal rawTotal=BigDecimal.ZERO,allocatedTotal=BigDecimal.ZERO;var originals=new HashMap<String,BigDecimal>();var originalAmounts=new HashMap<String,BigDecimal>();
        for(var raw:db.queryForList("SELECT l.*,w.reversal_of_id FROM ar_writeoff_line l JOIN ar_writeoff w ON w.country_id=l.country_id AND w.id=l.writeoff_id WHERE l.country_id=? AND l.book_id=? AND l.from_type=? AND l.from_id=? AND l.id<=? ORDER BY l.id",a.requireCountry(),target.get("bookId"),target.get("fromType"),target.get("fromId"),target.get("id"))){var l=DbRows.camel(raw);BigDecimal value=d(l,"amount");rawTotal=rawTotal.add(value);BigDecimal allocated;String suffix=":"+l.get("receivableId")+":"+l.get("orderId");
            if(l.get("reversalOfId")!=null){String key=l.get("reversalOfId")+suffix;var previous=originals.get(key);var original=originalAmounts.get(key);if(previous==null||original==null||original.negate().compareTo(value)!=0)throw new ApiException(409,"FIN_SOURCE_INCOMPLETE","冲销缺少对应冻结核销分配");allocated=previous.negate();}
            else{allocated=rawTotal.setScale(scale,RoundingMode.HALF_UP).subtract(allocatedTotal);String key=l.get("writeoffId")+suffix;if(originals.putIfAbsent(key,allocated)!=null)throw new ApiException(409,"FIN_SOURCE_INCOMPLETE","来源核销分配不能唯一识别");originalAmounts.put(key,value);}
            allocatedTotal=allocatedTotal.add(allocated);if(n(l,"id")==n(target,"id"))return allocated;
        }
        throw new ApiException(409,"FIN_SOURCE_INCOMPLETE","来源缺少冻结核销分配");
    }
    private BigDecimal receivableAmount(Access a,Map<String,Object> r,int scale){BigDecimal prior=db.queryForObject("SELECT coalesce(sum(amount),0) FROM ar_receivable WHERE country_id=? AND book_id=? AND order_id=? AND id<?",BigDecimal.class,a.requireCountry(),r.get("bookId"),r.get("orderId"),r.get("id"));return prior.add(d(r,"amount")).setScale(scale,RoundingMode.HALF_UP).subtract(prior.setScale(scale,RoundingMode.HALF_UP));}
    private BigDecimal d(Map<String,Object> r,String key){Object value=r.get(key);return value==null?BigDecimal.ZERO:new BigDecimal(value.toString());}
    private long n(Map<String,Object> r,String key){return ((Number)r.get(key)).longValue();}
    private LocalDate date(Map<String,Object> r,String key){return LocalDate.parse(r.get(key).toString());}
}
