package com.hs.jxc.rtn;

import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.cst.api.ProfitSourceProvider;
import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Inspection costs and settlement/reversal revenue retain their own dated immutable facts. */
@Component
public class ReturnsProfitSources implements ProfitSourceProvider {
    private final JdbcTemplate db;
    public ReturnsProfitSources(JdbcTemplate db){this.db=db;}
    public List<Fact> profitFacts(Access a,long book,LocalDate from,LocalDate to,Instant knownAt){
        var result=new ArrayList<Fact>();Timestamp cutoff=Timestamp.from(knownAt);
        String header="r.country_id,r.book_id,r.entity_id,r.return_warehouse_id warehouse_id,r.id source_id,r.doc_no,r.currency,l.product_id,l.outbound_line_id original_outbound_line_id";
        // REVERSED is a present state, not a reason to erase the original business date.
        String settled="SELECT "+header+",s.id settlement_id,s.biz_date,sl.id source_line_id,sl.qty,sl.amount FROM rtn_sales_settlement s JOIN rtn_sales_return r ON r.country_id=s.country_id AND r.id=s.return_id JOIN rtn_sales_settlement_line sl ON sl.country_id=s.country_id AND sl.settlement_id=s.id JOIN rtn_sales_return_line l ON l.country_id=sl.country_id AND l.id=sl.return_line_id WHERE s.country_id=? AND s.book_id=? AND s.created_at<=? AND s.biz_date BETWEEN ? AND ? ORDER BY s.id,sl.id";
        for(var raw:db.queryForList(settled,a.requireCountry(),book,cutoff,from,to))addSettlement(a,result,DbRows.camel(raw),true,"SALES_RETURN_SETTLEMENT");
        String reversed="SELECT "+header+",s.id settlement_id,e.biz_date,sl.id source_line_id,sl.qty,sl.amount FROM sys_biz_event e JOIN rtn_sales_settlement s ON s.country_id=e.country_id AND s.id=(e.payload->'settlement'->>'id')::bigint AND s.return_id=e.source_id JOIN rtn_sales_return r ON r.country_id=s.country_id AND r.id=s.return_id JOIN rtn_sales_settlement_line sl ON sl.country_id=s.country_id AND sl.settlement_id=s.id JOIN rtn_sales_return_line l ON l.country_id=sl.country_id AND l.id=sl.return_line_id WHERE e.country_id=? AND e.book_id=? AND e.source_type='SALES_RETURN' AND e.event_type='RTN_SALES_SETTLEMENT_REVERSED' AND e.occurred_at<=? AND e.biz_date BETWEEN ? AND ? ORDER BY e.id,sl.id";
        for(var raw:db.queryForList(reversed,a.requireCountry(),book,cutoff,from,to))addSettlement(a,result,DbRows.camel(raw),false,"SALES_RETURN_SETTLEMENT_REVERSED");
        for(var raw:db.queryForList("SELECT "+header+",i.id source_line_id,i.biz_date,i.inventory_batch_id FROM rtn_sales_inspection i JOIN rtn_sales_return r ON r.country_id=i.country_id AND r.id=i.return_id JOIN rtn_sales_return_line l ON l.country_id=i.country_id AND l.id=i.return_line_id WHERE i.country_id=? AND i.book_id=? AND i.created_at<=? AND i.biz_date BETWEEN ? AND ? ORDER BY i.id",a.requireCountry(),book,cutoff,from,to)){
            var r=DbRows.camel(raw);if(!a.canRow(r))continue;
            result.add(new Fact("SALES_RETURN_INSPECTION",n(r,"sourceId"),n(r,"sourceLineId"),r.get("docNo").toString(),n(r,"productId"),n(r,"warehouseId"),date(r),BigDecimal.ZERO,null,r.get("currency").toString(),BigDecimal.ZERO,"SALES_RETURN",n(r,"sourceLineId"),r.get("inventoryBatchId") instanceof Number b?b.longValue():null,null));
        }
        return result;
    }
    private void addSettlement(Access a,List<Fact> target,Map<String,Object> r,boolean original,String type){if(!a.canRow(r))return;BigDecimal sign=original?BigDecimal.ONE.negate():BigDecimal.ONE;target.add(new Fact(type,n(r,"sourceId"),n(r,"sourceLineId"),r.get("docNo").toString(),n(r,"productId"),n(r,"warehouseId"),date(r),d(r,"qty").multiply(sign),d(r,"amount").multiply(sign),r.get("currency").toString(),BigDecimal.ZERO,null,null,null,r.get("originalOutboundLineId") instanceof Number line?line.longValue():null));}
    private LocalDate date(Map<String,Object> r){return LocalDate.parse(r.get("bizDate").toString());}
    private long n(Map<String,Object> r,String key){return ((Number)r.get(key)).longValue();}
    private BigDecimal d(Map<String,Object> r,String key){return (BigDecimal)r.get(key);}
}
