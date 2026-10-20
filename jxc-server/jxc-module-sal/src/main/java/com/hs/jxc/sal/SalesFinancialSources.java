package com.hs.jxc.sal;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.common.event.OutboxPublisher;
import com.hs.jxc.cst.api.CostApi;
import com.hs.jxc.fin.api.*;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import java.math.*;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Reads confirmed outbound economics and original cost snapshots through their owning API. */
@Component
public class SalesFinancialSources implements FinancialSourceProvider {
    private final JdbcTemplate db;private final BookResolver books;private final CostApi costs;private final LedgerApi ledger;private final OutboxPublisher events;
    public SalesFinancialSources(JdbcTemplate db,BookResolver books,CostApi costs,LedgerApi ledger,OutboxPublisher events){this.db=db;this.books=books;this.costs=costs;this.ledger=ledger;this.events=events;}
    public boolean supports(String type){return Set.of("SALES_ORDER","SAL_ORDER","SAL_OUTBOUND","SALES_OUTBOUND").contains(type);}
    public Map<String,Object> accountingFact(Access a,String event,String type,long id,int seq,LocalDate date,Map<String,Object> frozen){
        boolean outbound=type.endsWith("OUTBOUND");
        var source=row(a,outbound?"sal_outbound":"sal_order",id);
        long book=n(source,"bookId");books.resolve(a,book,null);
        var p=new LinkedHashMap<String,Object>();
        if(!outbound){p.put("accountingImpact","NONE");p.put("reason","销售订单数量与审批节点，收入及成本在实际出库时确认");}
        else {
            if(source.get("outboundAt")==null)throw new ApiException(409,"FIN_SOURCE_NOT_CONFIRMED","出库尚未确认");
            var order=row(a,"sal_order",n(source,"orderId"));
            for(String key:List.of("customerId","storeId","currency"))if(order.get(key)!=null)p.put(key,order.get(key));
            p.put("warehouseId",source.get("warehouseId"));
            Long confirmation=events.sourceEventOrder(a.requireCountry(),book,"SAL_OUTBOUND",id,"SAL_OUTBOUND_CONFIRMED",seq);if(confirmation==null)throw new ApiException(409,"FIN_SOURCE_INCOMPLETE","出库缺少对应确认事件");var confirmationOrder=new HashMap<Long,Long>();confirmationOrder.put(id,confirmation);
            int scale=ledger.baseScale(a,book);boolean rateMissing=!books.baseCurrency(a,book).equals(order.get("currency"));
            BigDecimal revenue=BigDecimal.ZERO,tax=BigDecimal.ZERO,gross=BigDecimal.ZERO,cogs=BigDecimal.ZERO;
            boolean costMissing=false;List<Map<String,Object>> costLines=new ArrayList<>(),revenueLines=new ArrayList<>();
            var lines=db.queryForList("SELECT l.*,ol.tax_rate FROM sal_outbound_line l JOIN sal_order_line ol ON ol.country_id=l.country_id AND ol.id=l.order_line_id WHERE l.country_id=? AND l.outbound_id=? ORDER BY l.id",a.requireCountry(),id).stream().map(DbRows::camel).toList();
            // One currency rounding boundary per original order, then a stable allocation inside this header.
            BigDecimal runningRaw=BigDecimal.ZERO;
            for(var candidate:db.queryForList("SELECT l.outbound_id,l.amount FROM sal_outbound_line l JOIN sal_outbound o ON o.country_id=l.country_id AND o.id=l.outbound_id WHERE l.country_id=? AND o.order_id=? AND o.outbound_at IS NOT NULL",a.requireCountry(),source.get("orderId"))){long candidateSource=((Number)candidate.get("outbound_id")).longValue();Long eventOrder=confirmationOrder.computeIfAbsent(candidateSource,key->events.sourceEventOrder(a.requireCountry(),book,"SAL_OUTBOUND",key,"SAL_OUTBOUND_CONFIRMED",1));if(eventOrder==null)throw new ApiException(409,"FIN_SOURCE_INCOMPLETE","历史出库缺少对应确认事件");if(eventOrder<confirmation)runningRaw=runningRaw.add(decimal(candidate.get("amount")));}
            BigDecimal originalAmount=BigDecimal.ZERO;
            for(var line:lines){
                BigDecimal prior=runningRaw;
                BigDecimal raw=decimal(line.get("amount")),next=prior.add(raw);runningRaw=next;originalAmount=originalAmount.add(raw);
                BigDecimal lineGross=next.setScale(scale,RoundingMode.HALF_UP).subtract(prior.setScale(scale,RoundingMode.HALF_UP));
                BigDecimal lineRevenue;
                lineRevenue=lineGross; // Existing outbound facts do not contain a separately confirmed tax amount.
                BigDecimal lineTax=BigDecimal.ZERO;
                revenue=revenue.add(lineRevenue);tax=tax.add(lineTax);gross=gross.add(lineRevenue).add(lineTax);
                revenueLines.add(Map.of("productId",line.get("productId"),"sourceLineId",line.get("id"),"amount",lineRevenue));
                var cost=costs.outboundCost(a.requireCountry(),"SAL_OUTBOUND",n(line,"id"));
                var delta=cost==null?null:costs.inventoryAccountingDelta(a.requireCountry(),book,"CST_COGS",cost.id(),scale);boolean missing=delta==null||delta.amount()==null||delta.status().startsWith("PENDING");costMissing|=missing;
                var item=new LinkedHashMap<String,Object>();item.put("productId",line.get("productId"));item.put("sourceLineId",line.get("id"));item.put("amount",missing?null:delta.amount().negate());if(delta!=null&&delta.rawDelta()!=null)item.put("originalAmount",delta.rawDelta().negate());item.put("costMissing",missing);costLines.add(item);
                if(!missing)cogs=cogs.subtract(delta.amount());
            }
            p.put("originalAmount",originalAmount);p.put("amount",rateMissing?null:gross);p.put("amountExclTax",rateMissing?null:revenue);p.put("taxAmount",rateMissing?null:tax);p.put("rateMissing",rateMissing);p.put("cogsAmount",costMissing?null:cogs);p.put("costMissing",costMissing);p.put("costLines",costLines);p.put("revenueLines",revenueLines);
            if(lines.size()==1)p.put("productId",lines.getFirst().get("productId"));
        }
        return Map.of("bookId",book,"sourceNo",source.get("docNo"),"payload",p);
    }
    private Map<String,Object> row(Access a,String table,long id){var rows=db.queryForList("SELECT * FROM "+table+" WHERE country_id=? AND id=?",a.requireCountry(),id);if(rows.isEmpty())throw ApiException.notFound();return DbRows.camel(rows.getFirst());}
    private long n(Map<String,Object>r,String key){return ((Number)r.get(key)).longValue();}
    private BigDecimal decimal(Object o){return o==null?BigDecimal.ZERO:new BigDecimal(o.toString());}
}
