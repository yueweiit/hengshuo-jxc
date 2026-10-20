package com.hs.jxc.inv.service;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.cst.api.CostApi;
import com.hs.jxc.fin.api.FinancialSourceProvider;
import com.hs.jxc.fin.api.LedgerApi;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Inventory owns quantity notifications and frozen stocktake/transfer-loss references. */
@Component
public class InventoryFinancialSources implements FinancialSourceProvider {
    private final JdbcTemplate db;private final BookResolver books;private final CostApi costs;private final LedgerApi ledger;
    public InventoryFinancialSources(JdbcTemplate db,BookResolver books,CostApi costs,LedgerApi ledger){this.db=db;this.books=books;this.costs=costs;this.ledger=ledger;}
    public boolean supports(String type){return Set.of("INV_STOCK_CHANGED","INV_TRANSFER","INV_STOCKTAKE").contains(type);}
    public Map<String,Object> accountingFact(Access a,String event,String type,long id,int seq,LocalDate day,Map<String,Object> frozen){
        if(event.equals("INV_STOCK_CHANGED"))return quantity(a,type,id,day);
        String table=switch(type){case "INV_TRANSFER"->"inv_transfer";case "INV_STOCKTAKE"->"inv_stocktake";default->throw incomplete();};var rows=db.queryForList("SELECT * FROM "+table+" WHERE country_id=? AND id=?",a.requireCountry(),id);if(rows.isEmpty())throw ApiException.notFound();var r=DbRows.camel(rows.getFirst());books.resolve(a,n(r,"bookId"),null);var p=new LinkedHashMap<String,Object>();p.put("baseCurrency",books.baseCurrency(a,n(r,"bookId")));if(r.get("warehouseId")!=null)p.put("warehouseId",r.get("warehouseId"));
        if(event.equals("INV_STOCKTAKE_POSTED"))stocktake(a,r,p);
        else if(event.equals("INV_TRANSFER_DIFFERENCE_RESOLVED"))difference(a,r,day,frozen,p);
        else if(type.equals("INV_TRANSFER")&&Set.of("INV_TRANSFER_SHIPPED","INV_TRANSFER_RECEIVED").contains(event)){p.put("accountingImpact","NONE");p.put("amount",BigDecimal.ZERO);}
        else throw new ApiException(409,"FIN_SOURCE_UNSUPPORTED","来源事件尚无明确会计解释");
        return Map.of("bookId",r.get("bookId"),"sourceNo",r.get("docNo"),"payload",p);
    }
    private Map<String,Object> quantity(Access a,String type,long line,LocalDate day){if(type.equals("INV_RESERVATION")){var rows=db.queryForList("SELECT * FROM inv_reservation WHERE country_id=? AND alloc_id=?",a.requireCountry(),line);if(rows.isEmpty())throw incomplete();var r=DbRows.camel(rows.getFirst());books.resolve(a,n(r,"bookId"),null);return Map.of("bookId",r.get("bookId"),"sourceNo","RS"+line,"sourceDocType","INV_RESERVATION","sourceDocId",r.get("id"),"payload",Map.of("accountingImpact","NONE","amount",BigDecimal.ZERO,"warehouseId",r.get("warehouseId"),"productId",r.get("productId")));}

        if(type.equals("INV_TRANSFER_LOSS")){var losses=db.queryForList("SELECT t.book_id,t.id transfer_id,t.doc_no,l.warehouse_id,l.product_id FROM inv_transfer_loss l JOIN inv_transfer_line tl ON tl.country_id=l.country_id AND tl.id=l.transfer_line_id JOIN inv_transfer t ON t.country_id=tl.country_id AND t.id=tl.transfer_id WHERE l.country_id=? AND l.source_type=? AND l.source_line_id=? AND l.biz_date<=? ORDER BY l.id",a.requireCountry(),type,line,day);if(losses.isEmpty())throw incomplete();var loss=losses.getFirst();books.resolve(a,((Number)loss.get("book_id")).longValue(),null);return Map.of("bookId",loss.get("book_id"),"sourceNo",loss.get("doc_no"),"sourceDocType","INV_TRANSFER","sourceDocId",loss.get("transfer_id"),"payload",Map.of("accountingImpact","NONE","amount",BigDecimal.ZERO,"warehouseId",loss.get("warehouse_id"),"productId",loss.get("product_id")));}
        var rows=db.queryForList("SELECT * FROM inv_stock_txn WHERE country_id=? AND source_type=? AND source_line_id=? AND biz_date<=? ORDER BY id",a.requireCountry(),type,line,day);if(rows.isEmpty())throw incomplete();var r=DbRows.camel(rows.getFirst());books.resolve(a,n(r,"bookId"),null);for(var raw:rows){var other=DbRows.camel(raw);if(n(other,"bookId")!=n(r,"bookId")||n(other,"sourceId")!=n(r,"sourceId"))throw incomplete();}var p=new LinkedHashMap<String,Object>();p.put("accountingImpact","NONE");p.put("amount",BigDecimal.ZERO);p.put("productId",r.get("productId"));p.put("warehouseId",r.get("warehouseId"));return Map.of("bookId",r.get("bookId"),"sourceNo",r.get("sourceNo"),"sourceDocType",type,"sourceDocId",r.get("sourceId"),"payload",p);
    }
    private void stocktake(Access a,Map<String,Object> r,Map<String,Object> p){
        if(!"POSTED".equals(r.get("status")))throw incomplete();var lines=new ArrayList<Map<String,Object>>();BigDecimal total=BigDecimal.ZERO;boolean missing=false,rateMissing=false;
        for(var raw:db.queryForList("SELECT * FROM inv_stocktake_line WHERE country_id=? AND stocktake_id=? ORDER BY id",a.requireCountry(),r.get("id"))){var l=DbRows.camel(raw);if(l.get("countedQty")==null)throw incomplete();BigDecimal delta=d(l,"countedQty").subtract(d(l,"bookQty"));if(delta.signum()==0)continue;BigDecimal amount=null;String status=null;Long batch=null;
            if(delta.signum()>0){var txns=db.queryForList("SELECT DISTINCT batch_id FROM inv_stock_txn WHERE country_id=? AND book_id=? AND source_type='INV_STOCKTAKE' AND source_id=? AND source_line_id=? AND txn_type='STOCKTAKE_GAIN'",a.requireCountry(),r.get("bookId"),r.get("id"),l.get("id"));if(txns.size()!=1)throw incomplete();batch=((Number)txns.getFirst().get("batch_id")).longValue();var c=costs.batchCostAmount(a.requireCountry(),batch);if(c!=null){var costDelta=costs.inventoryAccountingDelta(a.requireCountry(),n(r,"bookId"),"CST_INBOUND_COST",c.id(),ledger.baseScale(a,n(r,"bookId")));amount=costDelta==null?null:costDelta.amount();status=costDelta==null?null:costDelta.status();}}
            else {var c=costs.outboundCost(a.requireCountry(),"INV_STOCKTAKE",n(l,"id"));if(c!=null){var costDelta=costs.inventoryAccountingDelta(a.requireCountry(),n(r,"bookId"),"CST_COGS",c.id(),ledger.baseScale(a,n(r,"bookId")));amount=costDelta==null?null:costDelta.amount();status=costDelta==null?null:costDelta.status();}if(l.get("batchId")!=null)batch=n(l,"batchId");}
            if(amount==null){missing=true;if("PENDING_RATE".equals(status))rateMissing=true;continue;}var part=new LinkedHashMap<String,Object>();part.put("productId",l.get("productId"));part.put("warehouseId",r.get("warehouseId"));if(batch!=null)part.put("batchId",batch);part.put("amount",amount);lines.add(part);total=total.add(amount);
        }
        p.put("amount",missing?null:total);p.put("cogsAmount",missing?null:total);p.put("costLines",lines);p.put("accountingLines",lines);p.put("costMissing",missing);p.put("rateMissing",rateMissing);p.put("counterpart","INVENTORY");if(lines.isEmpty()&&!missing)p.put("accountingImpact","NONE");
    }
    private void difference(Access a,Map<String,Object> r,LocalDate day,Map<String,Object> frozen,Map<String,Object> p){
        if(!(frozen.get("differenceId") instanceof Number))throw incomplete();var matches=db.queryForList("SELECT * FROM inv_transfer_difference WHERE country_id=? AND book_id=? AND transfer_id=? AND id=?",a.requireCountry(),r.get("bookId"),r.get("id"),frozen.get("differenceId"));if(matches.size()!=1)throw incomplete();var difference=DbRows.camel(matches.getFirst());if(!Objects.equals(difference.get("resolution"),frozen.get("resolution")))throw incomplete();if("FOUND".equals(difference.get("resolution"))){p.put("accountingImpact","NONE");p.put("amount",BigDecimal.ZERO);return;}if(!"LOSS".equals(difference.get("resolution"))||!"POSTED".equals(difference.get("status")))throw incomplete();
        var seen=new HashSet<Long>();var lines=new ArrayList<Map<String,Object>>();BigDecimal total=BigDecimal.ZERO;boolean missing=false,rateMissing=false;var losses=db.queryForList("SELECT * FROM inv_transfer_loss WHERE country_id=? AND book_id=? AND source_type='INV_TRANSFER_LOSS' AND source_id=? AND biz_date<=? ORDER BY id",a.requireCountry(),r.get("bookId"),difference.get("id"),day);if(losses.isEmpty())throw incomplete();
        for(var raw:losses){var l=DbRows.camel(raw);long cogs=n(l,"cogsId");if(!seen.add(cogs))continue;var c=costs.outboundCostById(a.requireCountry(),cogs);var delta=c==null?null:costs.inventoryAccountingDelta(a.requireCountry(),n(r,"bookId"),"CST_COGS",c.id(),ledger.baseScale(a,n(r,"bookId")));if(delta==null||delta.amount()==null||delta.status().startsWith("PENDING")){missing=true;if(delta!=null&&"PENDING_RATE".equals(delta.status()))rateMissing=true;continue;}var part=new LinkedHashMap<String,Object>();part.put("amount",delta.amount().negate());part.put("originalAmount",delta.rawDelta().negate());part.put("productId",l.get("productId"));part.put("warehouseId",l.get("warehouseId"));part.put("cogsId",cogs);lines.add(part);total=total.subtract(delta.amount());}
        p.put("differenceId",difference.get("id"));p.put("amount",missing?null:total);p.put("cogsAmount",missing?null:total);p.put("costLines",lines);p.put("accountingLines",lines);p.put("costMissing",missing);p.put("rateMissing",rateMissing);p.put("counterpart","INVENTORY");
    }
    @Override public List<Map<String,Object>> closingIssues(Access a,long book,LocalDate asOf){
        books.resolve(a,book,null);
        var rows=db.queryForList("SELECT id,doc_no,biz_date,status,version FROM inv_stocktake WHERE country_id=? AND book_id=? AND biz_date<=? AND status IN ('COUNTING','SUBMITTED','APPROVED') ORDER BY id",a.requireCountry(),book,asOf).stream().map(DbRows::camel).toList();
        return rows.isEmpty()?List.of():List.of(Map.of("checkCode","STOCKTAKE_PENDING","message","没有未过账的盘点调整","detail",rows));
    }
    private ApiException incomplete(){return new ApiException(409,"FIN_SOURCE_INCOMPLETE","来源缺少对应历史财务事实");}
    private long n(Map<String,Object> r,String key){return ((Number)r.get(key)).longValue();}
    private BigDecimal d(Map<String,Object> r,String key){if(r.get(key)==null)throw incomplete();return new BigDecimal(r.get(key).toString());}
}
