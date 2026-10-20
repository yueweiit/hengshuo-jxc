package com.hs.jxc.sal;

import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.cst.api.ProfitSourceProvider;
import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Outbound amounts already contain the frozen discount; receipts and orders are not revenue. */
@Component
public class SalesProfitSources implements ProfitSourceProvider {
    private final JdbcTemplate db;
    public SalesProfitSources(JdbcTemplate db){this.db=db;}
    public List<Fact> profitFacts(Access a,long book,LocalDate from,LocalDate to,Instant knownAt){
        var result=new ArrayList<Fact>();
        for(var raw:db.queryForList("SELECT h.country_id,h.book_id,h.warehouse_id,o.entity_id,o.store_id,h.id source_id,h.doc_no,h.biz_date,l.id source_line_id,l.product_id,l.qty,l.amount,o.currency,CASE WHEN o.tax_mode='EXCL' THEN 0 ELSE ol.tax_rate END tax_rate FROM sal_outbound h JOIN sal_order o ON o.country_id=h.country_id AND o.id=h.order_id JOIN sal_outbound_line l ON l.country_id=h.country_id AND l.outbound_id=h.id JOIN sal_order_line ol ON ol.country_id=l.country_id AND ol.id=l.order_line_id WHERE h.country_id=? AND h.book_id=? AND h.outbound_at IS NOT NULL AND h.outbound_at<=? AND h.biz_date BETWEEN ? AND ? ORDER BY h.id,l.id",a.requireCountry(),book,Timestamp.from(knownAt),from,to)){
            var r=DbRows.camel(raw);if(!a.canRow(r))continue;
            result.add(new Fact("SAL_OUTBOUND",n(r,"sourceId"),n(r,"sourceLineId"),r.get("docNo").toString(),n(r,"productId"),n(r,"warehouseId"),LocalDate.parse(r.get("bizDate").toString()),d(r,"qty"),d(r,"amount"),r.get("currency").toString(),d(r,"taxRate"),"SAL_OUTBOUND",n(r,"sourceLineId"),null,null));
        }
        return result;
    }
    @Override public Map<Long,Boolean> outboundTaxBases(Access a,long book,Set<Long> ids,Instant knownAt){
        if(ids.isEmpty())return Map.of();var args=new ArrayList<Object>();args.add(a.requireCountry());args.add(book);args.add(Timestamp.from(knownAt));args.addAll(ids);var out=new HashMap<Long,Boolean>();
        for(var raw:db.queryForList("SELECT h.country_id,h.book_id,h.warehouse_id,o.entity_id,o.store_id,l.id,ol.tax_rate,o.tax_mode FROM sal_outbound_line l JOIN sal_outbound h ON h.country_id=l.country_id AND h.id=l.outbound_id JOIN sal_order o ON o.country_id=h.country_id AND o.id=h.order_id JOIN sal_order_line ol ON ol.country_id=l.country_id AND ol.id=l.order_line_id WHERE l.country_id=? AND l.book_id=? AND h.outbound_at<=? AND l.id IN ("+String.join(",",Collections.nCopies(ids.size(),"?"))+")",args.toArray())){var r=DbRows.camel(raw);if(a.canRow(r))out.put(n(r,"id"),d(r,"taxRate").signum()==0||"EXCL".equals(r.get("taxMode")));}return out;
    }
    private long n(Map<String,Object> r,String key){return ((Number)r.get(key)).longValue();}
    private BigDecimal d(Map<String,Object> r,String key){return (BigDecimal)r.get(key);}
}
