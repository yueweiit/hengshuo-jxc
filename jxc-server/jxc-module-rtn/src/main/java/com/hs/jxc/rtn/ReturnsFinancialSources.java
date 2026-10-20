package com.hs.jxc.rtn;

import com.hs.jxc.ap.api.CreditNoteApi;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.common.event.OutboxPublisher;
import com.hs.jxc.cst.api.CostApi;
import com.hs.jxc.fin.api.FinancialSourceProvider;
import com.hs.jxc.fin.api.LedgerApi;
import com.hs.jxc.fin.accounting.AccountingAmounts;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import java.math.*;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Return accounting is tied to immutable inspection/settlement facts, never current cumulative totals. */
@Component
public class ReturnsFinancialSources implements FinancialSourceProvider {
    private static final Map<String,String> TABLES=Map.of("SALES_RETURN","rtn_sales_return","REFUND","rtn_refund","PURCHASE_RETURN","rtn_purchase_return","CLAIM","rtn_claim");
    private final JdbcTemplate db;private final BookResolver books;private final CostApi costs;private final CreditNoteApi credits;private final OutboxPublisher events;private final LedgerApi ledger;
    public ReturnsFinancialSources(JdbcTemplate db,BookResolver books,CostApi costs,CreditNoteApi credits,OutboxPublisher events,LedgerApi ledger){this.db=db;this.books=books;this.costs=costs;this.credits=credits;this.events=events;this.ledger=ledger;}
    public boolean supports(String type){return TABLES.containsKey(type);}
    private Map<String,Object> row(Access a,String type,long id){var rows=db.queryForList("SELECT * FROM "+TABLES.get(type)+" WHERE country_id=? AND id=?",a.requireCountry(),id);if(rows.isEmpty())throw ApiException.notFound();var r=DbRows.camel(rows.getFirst());books.resolve(a,n(r,"bookId"),null);return r;}
    public Map<String,Object> accountingFact(Access a,String event,String type,long id,int seq,LocalDate day,Map<String,Object> frozen){
        var r=row(a,type,id);var p=new LinkedHashMap<String,Object>();long book=n(r,"bookId");p.put("docNo",r.get("docNo"));p.put("baseCurrency",books.baseCurrency(a,book));for(String field:List.of("customerId","supplierId","warehouseId","currency","fundAccountId"))if(r.get(field)!=null)p.put(field,r.get(field));if(r.get("supplierId")!=null)p.put("partnerId",r.get("supplierId"));if(r.get("returnWarehouseId")!=null)p.put("warehouseId",r.get("returnWarehouseId"));
        if(type.equals("SALES_RETURN")&&event.equals("RTN_SALES_INSPECTED"))inspection(a,r,seq,day,frozen,p);
        else if(type.equals("SALES_RETURN")&&Set.of("RTN_SALES_SETTLED","RTN_SALES_SETTLEMENT_REVERSED").contains(event))settlement(a,r,event,frozen,p);
        else if(type.equals("REFUND")&&event.equals("RTN_REFUND_PAID")){if(!"PAID".equals(r.get("status"))||r.get("paidAt")==null)throw incomplete();convert(a,r,p,d(r,"amount"));}
        else if(type.equals("PURCHASE_RETURN")&&event.equals("RTN_PURCHASE_RETURN_DONE"))purchase(a,r,p);
        else if(type.equals("SALES_RETURN")&&event.equals("RTN_SALES_RECEIVED")||type.equals("CLAIM")&&Set.of("RTN_CLAIM_RESOLVED","RTN_CLAIM_DONE").contains(event)){p.put("accountingImpact","NONE");p.put("amount",BigDecimal.ZERO);}
        else throw new ApiException(409,"FIN_SOURCE_UNSUPPORTED","来源事件尚无明确会计解释");
        return Map.of("bookId",book,"sourceNo",r.get("docNo"),"payload",p);
    }
    private void inspection(Access a,Map<String,Object> r,int seq,LocalDate day,Map<String,Object> frozen,Map<String,Object> p){
        var current=inspectionIds(frozen);if(current.isEmpty())throw incomplete();Set<Long> previous=Set.of();int previousSeq=0;
        // Sequence establishes the delta even when a later entry is backdated.
        for(var e:events.history(a.requireCountry(),n(r,"bookId"),"SALES_RETURN",n(r,"id"),"RTN_SALES_INSPECTED",LocalDate.of(9999,12,31))){int s=((Number)e.get("eventSeq")).intValue();if(s<seq&&s>previousSeq){previous=inspectionIds(map(e.get("payload")));previousSeq=s;}}
        if(seq>1&&previousSeq!=seq-1)throw incomplete();if(!current.containsAll(previous))throw incomplete();var added=new LinkedHashSet<>(current);added.removeAll(previous);if(added.isEmpty())throw incomplete();
        BigDecimal total=BigDecimal.ZERO;boolean missing=false,rateMissing=false;var lines=new ArrayList<Map<String,Object>>();int scale=ledger.baseScale(a,n(r,"bookId"));
        for(long inspection:added){var matches=db.queryForList("SELECT i.*,l.product_id FROM rtn_sales_inspection i JOIN rtn_sales_return_line l ON l.country_id=i.country_id AND l.id=i.return_line_id WHERE i.country_id=? AND i.id=? AND i.return_id=? AND i.book_id=?",a.requireCountry(),inspection,r.get("id"),r.get("bookId"));if(matches.size()!=1)throw incomplete();var i=DbRows.camel(matches.getFirst());if(LocalDate.parse(i.get("bizDate").toString()).isAfter(day))throw incomplete();var c=costs.outboundCost(a.requireCountry(),"SALES_RETURN",inspection);CostApi.AccountingDelta delta=c==null?null:costs.inventoryAccountingDelta(a.requireCountry(),n(r,"bookId"),"CST_COGS",c.id(),scale);if(delta==null&&Boolean.TRUE.equals(r.get("noOriginFlag"))&&i.get("inventoryBatchId")!=null){var inbound=costs.batchCostAmount(a.requireCountry(),n(i,"inventoryBatchId"));if(inbound!=null)delta=costs.inventoryAccountingDelta(a.requireCountry(),n(r,"bookId"),"CST_INBOUND_COST",inbound.id(),scale);}if(delta==null||delta.amount()==null||delta.status().startsWith("PENDING")){missing=true;if(delta!=null&&"PENDING_RATE".equals(delta.status()))rateMissing=true;continue;}BigDecimal amount=delta.amount().negate();var line=new LinkedHashMap<String,Object>();line.put("amount",amount);line.put("originalAmount",delta.rawDelta().negate());line.put("productId",i.get("productId"));line.put("warehouseId",p.get("warehouseId"));if(i.get("inventoryBatchId")!=null)line.put("batchId",i.get("inventoryBatchId"));line.put("inspectionId",inspection);lines.add(line);total=total.add(amount);}
        p.put("amount",missing?null:total);p.put("cogsAmount",missing?null:total);p.put("costMissing",missing);p.put("rateMissing",rateMissing);p.put("costLines",lines);p.put("accountingLines",lines);p.put("inspectionIds",added);p.put("counterpart","INVENTORY");
    }
    private void settlement(Access a,Map<String,Object> r,String event,Map<String,Object> frozen,Map<String,Object> p){
        var original=map(frozen.get("settlement"));if(!(original.get("id") instanceof Number))throw incomplete();var matches=db.queryForList("SELECT * FROM rtn_sales_settlement WHERE country_id=? AND id=? AND return_id=? AND book_id=?",a.requireCountry(),original.get("id"),r.get("id"),r.get("bookId"));if(matches.size()!=1)throw incomplete();var s=DbRows.camel(matches.getFirst());BigDecimal sign=event.equals("RTN_SALES_SETTLEMENT_REVERSED")?BigDecimal.ONE.negate():BigDecimal.ONE;convert(a,r,p,d(s,"totalAmount").multiply(sign));boolean missing=Boolean.TRUE.equals(p.get("rateMissing"));BigDecimal rawOffset=d(s,"arOffsetAmount").multiply(sign),rawRefund=d(s,"refundableAmount").multiply(sign);p.put("originalOffsetAmount",rawOffset);p.put("originalRefundableAmount",rawRefund);if(missing){p.put("offsetAmount",null);p.put("refundableAmount",null);}else{var parts=AccountingAmounts.split(d(s,"totalAmount").multiply(sign),List.of(rawOffset,rawRefund),ledger.baseScale(a,n(r,"bookId")));p.put("offsetAmount",parts.get(0));p.put("refundableAmount",parts.get(1));}p.put("settlementId",s.get("id"));p.put("cashAlreadyRecognized",true);
    }
    private void purchase(Access a,Map<String,Object> r,Map<String,Object> p){
        if(!"COMPLETED".equals(r.get("status")))throw incomplete();var credit=credits.frozenBySource(a,n(r,"bookId"),"PURCHASE_RETURN",n(r,"id"));if(r.get("apCreditNoteId")==null||!Objects.equals(((Number)r.get("apCreditNoteId")).longValue(),n(credit,"id")))throw incomplete();BigDecimal ap=nullable(credit.get("baseAmount"));if(ap==null&&Objects.equals(credit.get("currency"),p.get("baseCurrency")))ap=d(credit,"amount");p.put("originalApAmount",ap);if(ap!=null)ap=ap.setScale(ledger.baseScale(a,n(r,"bookId")),RoundingMode.HALF_UP);boolean rateMissing=ap==null;boolean physical="MX_STOCK".equals(r.get("stage")),missing=false;BigDecimal cost=BigDecimal.ZERO;var lines=new ArrayList<Map<String,Object>>();
        for(var raw:db.queryForList("SELECT * FROM rtn_purchase_return_line WHERE country_id=? AND return_id=? ORDER BY id",a.requireCountry(),r.get("id"))){var l=DbRows.camel(raw);BigDecimal amount=BigDecimal.ZERO;if(physical){var c=costs.outboundCost(a.requireCountry(),"PURCHASE_RETURN",n(l,"id"));var delta=c==null?null:costs.inventoryAccountingDelta(a.requireCountry(),n(r,"bookId"),"CST_COGS",c.id(),ledger.baseScale(a,n(r,"bookId")));if(delta==null||delta.amount()==null||delta.status().startsWith("PENDING")){missing=true;if(delta!=null&&"PENDING_RATE".equals(delta.status()))rateMissing=true;continue;}amount=delta.amount().negate();}var line=new LinkedHashMap<String,Object>();line.put("amount",amount);line.put("productId",l.get("productId"));if(l.get("batchId")!=null)line.put("batchId",l.get("batchId"));lines.add(line);cost=cost.add(amount);}
        p.put("apAmount",ap);p.put("amount",ap);p.put("costAmount",missing?null:cost);p.put("differenceAmount",missing||rateMissing?null:ap.subtract(cost));p.put("costLines",lines);p.put("costMissing",missing);p.put("rateMissing",rateMissing);p.put("stage",r.get("stage"));p.put("physicalInventoryImpact",physical);p.put("creditNoteId",credit.get("id"));p.put("counterpart","PAYABLE");
    }
    public List<Map<String,Object>> balances(Access a,long book,LocalDate day,String type){
        if(!type.equals("CASH"))return List.of();String base=books.baseCurrency(a,book);int scale=ledger.baseScale(a,book);var out=new ArrayList<Map<String,Object>>();for(var raw:db.queryForList("SELECT * FROM rtn_refund WHERE country_id=? AND book_id=? AND status='PAID' AND paid_at<=? ORDER BY id",a.requireCountry(),book,day)){var r=DbRows.camel(raw);var b=new LinkedHashMap<String,Object>();BigDecimal value=d(r,"amount").negate();boolean missing=!Objects.equals(base,r.get("currency"));b.put("sourceType","REFUND");b.put("sourceId",r.get("id"));b.put("sourceNo",r.get("docNo"));b.put("bizDate",r.get("paidAt"));b.put("customerId",r.get("customerId"));b.put("fundAccountId",r.get("fundAccountId"));b.put("currency",r.get("currency"));b.put("originalAmount",value);b.put("amount",missing?null:value.setScale(scale,RoundingMode.HALF_UP));b.put("rateMissing",missing);out.add(b);}return out;
    }
    private void convert(Access a,Map<String,Object> r,Map<String,Object> p,BigDecimal value){boolean missing=!Objects.equals(r.get("currency"),p.get("baseCurrency"));p.put("originalAmount",value);p.put("amount",missing?null:value.setScale(ledger.baseScale(a,n(r,"bookId")),RoundingMode.HALF_UP));p.put("rateMissing",missing);}
    private Set<Long> inspectionIds(Map<String,Object> p){var out=new LinkedHashSet<Long>();if(p.get("inspections") instanceof List<?> list)for(Object raw:list){var i=map(raw);if(!(i.get("id") instanceof Number))throw incomplete();if(!out.add(n(i,"id")))throw incomplete();}return out;}
    @SuppressWarnings("unchecked") private Map<String,Object> map(Object value){return value instanceof Map<?,?> m?(Map<String,Object>)m:Map.of();}
    private ApiException incomplete(){return new ApiException(409,"FIN_SOURCE_INCOMPLETE","来源缺少对应历史财务事实");}
    private long n(Map<String,Object> r,String key){return ((Number)r.get(key)).longValue();}
    private BigDecimal d(Map<String,Object> r,String key){var value=nullable(r.get(key));if(value==null)throw incomplete();return value;}
    private BigDecimal nullable(Object value){return value==null?null:new BigDecimal(value.toString());}
}
