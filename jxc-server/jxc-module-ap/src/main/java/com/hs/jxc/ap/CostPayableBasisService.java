package com.hs.jxc.ap;

import com.hs.jxc.ap.api.CostPayableBasisApi;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.cst.api.CostPurchaseReference;
import com.hs.jxc.fin.accounting.AccountingAmounts;
import com.hs.jxc.fin.api.LedgerApi;
import com.hs.jxc.fin.api.PeriodApi;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.*;
import java.math.*;
import java.time.LocalDate;
import java.util.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Explicit physical-cost to confirmed-bill assignments. AP claims remain the only bill capacity. */
@Service
public class CostPayableBasisService implements CostPayableBasisApi {
    private static final BigDecimal ZERO=BigDecimal.ZERO;
    private static final List<String> SOURCE_FIELDS=List.of("costId","bookId","warehouseId","productId","batchId","poId","poLineId","qty","srcCurrency","srcAmount","baseCurrency","basePurchaseAmount","rate","rateId","rateDate","rateVersion","confirmedBizDate");
    private final JdbcTemplate db;private final JsonCodec json;private final AuthorizationService auth;private final FieldPolicyService fields;private final DocumentAccessService docs;
    private final ObjectProvider<CostPurchaseReference> costs;private final LedgerApi ledger;private final PeriodApi periods;private final IdempotencyExecutor idem;private final AuditWriter audit;private final TransactionTemplate tx;
    public CostPayableBasisService(JdbcTemplate db,JsonCodec json,AuthorizationService auth,FieldPolicyService fields,DocumentAccessService docs,ObjectProvider<CostPurchaseReference> costs,LedgerApi ledger,PeriodApi periods,IdempotencyExecutor idem,AuditWriter audit,PlatformTransactionManager tm){
        this.db=db;this.json=json;this.auth=auth;this.fields=fields;this.docs=docs;this.costs=costs;this.ledger=ledger;this.periods=periods;this.idem=idem;this.audit=audit;tx=new TransactionTemplate(tm);
        fields.register("COST","principalAmount","billAmount","billBaseAmount","lineAmount","assignedQty","remainingQty","billQty","availableQty");
    }
    private static long id(Map<String,Object> m,String k){return Inputs.id(m.get(k));}
    private static BigDecimal n(Object v){return v==null?null:new BigDecimal(v.toString());}
    private static BigDecimal n(Map<String,Object> m,String k){return n(m.get(k));}
    private static ApiException failure(String code,String message){return new ApiException(409,code,message);}
    private static long version(Map<String,Object> body){if(body.get("version")==null)throw Inputs.bad("请提供关联版本");BigDecimal value=Inputs.decimal(body.get("version"),0,BigDecimal.valueOf(9007199254740991L));if(value.signum()<0)throw Inputs.bad("关联版本不合法");return value.longValueExact();}
    private Map<String,Object> source(Access a,long cost){return costs.getObject().purchaseReference(a,cost);}
    private Map<String,Object> sourceBasis(Map<String,Object> source){var result=new LinkedHashMap<String,Object>();for(String f:SOURCE_FIELDS)result.put(f,source.get(f));return result;}
    private Map<String,Object> header(Access a,long cost){var rows=db.queryForList("SELECT * FROM ap_cost_assignment WHERE country_id=? AND cost_id=?",a.requireCountry(),cost);return rows.isEmpty()?null:DbRows.camel(rows.getFirst());}
    private List<Map<String,Object>> assigned(Access a,long assignment){return db.queryForList("SELECT * FROM ap_cost_assignment_line WHERE country_id=? AND assignment_id=? ORDER BY id",a.requireCountry(),assignment).stream().map(DbRows::camel).toList();}
    private boolean legacy(Access a,long cost){return Boolean.TRUE.equals(db.queryForObject("SELECT EXISTS(SELECT 1 FROM fin_event_result r JOIN sys_biz_event e ON e.country_id=r.country_id AND e.id=r.event_id WHERE e.country_id=? AND e.source_type='CST_INBOUND_COST' AND e.source_id=? AND e.event_type='CST_INBOUND_COST_CONFIRMED')",Boolean.class,a.requireCountry(),cost));}
    private void lock(Access a,long book){db.queryForObject("SELECT jxc_ap_cost_basis_lock(?,?)",Object.class,a.requireCountry(),book);}
    private void costRead(Access a){if(FieldPolicyService.rank(a.fieldGroups().get("COST"))<1)throw ApiException.forbidden();}
    private void costWrite(Access a){if(FieldPolicyService.rank(a.fieldGroups().get("COST"))<2)throw ApiException.forbidden();}
    private Map<String,Object> bill(Access a,long line,boolean lock){return bill(a,line,lock,true);}
    private Map<String,Object> bill(Access a,long line,boolean lock,boolean authorize){
        var rows=db.queryForList("SELECT b.*,l.id bill_line_id,l.amount line_amount,l.canonical_source_type,l.canonical_source_id,l.product_id,cl.qty canonical_qty FROM ap_bill_line l JOIN ap_bill b ON b.country_id=l.country_id AND b.id=l.bill_id JOIN ap_source_claim cl ON cl.country_id=l.country_id AND cl.bill_line_id=l.id AND cl.source_type='PUR_ORDER_LINE_BASE' AND cl.source_id=l.canonical_source_id AND cl.effective WHERE l.country_id=? AND l.id=?"+(lock?" FOR UPDATE OF b,l,cl":""),a.requireCountry(),line);
        if(rows.isEmpty())throw ApiException.notFound();var result=DbRows.camel(rows.getFirst());if(authorize)a.requireRow(result);return result;
    }
    private String incompatibility(Map<String,Object> source,Map<String,Object> bill){
        if(!Set.of("CONFIRMED","PARTIAL_PAID","PAID").contains(bill.get("status")))return "账单尚未确认";
        if(!"PURCHASE".equals(bill.get("billType"))||!"SUPPLIER".equals(bill.get("partnerType"))||id(bill,"bookId")!=id(source,"bookId")||id(bill,"partnerId")!=id(source,"supplierId")||id(bill,"productId")!=id(source,"productId")||!"PUR_ORDER_LINE_BASE".equals(bill.get("canonicalSourceType"))||id(bill,"canonicalSourceId")!=id(source,"poLineId"))return "账单与成本的账套、供应商或规范采购来源不一致";
        if(!Boolean.TRUE.equals(source.get("confirmed"))||source.get("basePurchaseAmount")==null)return "成本尚未确认";
        if(!"READY".equals(bill.get("valuationStatus"))||bill.get("baseAmount")==null||bill.get("rate")==null||source.get("rate")==null)return "成本或账单缺少冻结汇率依据";
        if(!Objects.equals(source.get("srcCurrency"),bill.get("currency"))||!Objects.equals(source.get("baseCurrency"),bill.get("baseCurrency"))||n(source,"rate").compareTo(n(bill,"rate"))!=0)return "账单与成本的冻结币种或汇率依据不兼容，等待复核；不能作为精度差或已实现汇差";
        // Original currency unit economics must also match; equality is checked before posting precision.
        BigDecimal sourcePrice=n(source,"srcAmount").divide(n(source,"qty"),12,RoundingMode.HALF_UP),billPrice=n(bill,"lineAmount").divide(n(bill,"canonicalQty"),12,RoundingMode.HALF_UP);
        if(sourcePrice.subtract(billPrice).abs().compareTo(new BigDecimal("0.0001"))>0)return "账单与成本的原币数量金额依据不兼容，等待复核";
        return null;
    }
    private BigDecimal occupied(Access a,long line,Long except){return db.queryForObject("SELECT coalesce(sum(base_qty),0) FROM ap_cost_assignment_line WHERE country_id=? AND bill_line_id=?"+(except==null?"":" AND assignment_id<>?"),BigDecimal.class,except==null?new Object[]{a.requireCountry(),line}:new Object[]{a.requireCountry(),line,except});}
    /** A header is rounded once; its immutable original line order receives the currency tail. */
    private BigDecimal linePrincipal(Access a,Map<String,Object> bill){
        var lines=db.queryForList("SELECT id,amount FROM ap_bill_line WHERE country_id=? AND bill_id=? ORDER BY id",a.requireCountry(),bill.get("id"));BigDecimal total=n(bill,"baseAmount"),original=n(bill,"amount"),used=ZERO;if(total==null||original==null)throw failure("AP_COST_BASIS_INCOMPATIBLE","账单缺少冻结本金依据");if(original.signum()==0&&total.signum()!=0)throw failure("AP_COST_BASIS_INCOMPATIBLE","零原币账单与冻结本位本金不一致");List<BigDecimal> raw=new ArrayList<>();
        for(int x=0;x<lines.size();x++){BigDecimal part=original.signum()==0?ZERO:x==lines.size()-1?total.subtract(used):total.multiply(n(lines.get(x).get("amount"))).divide(original,12,RoundingMode.HALF_UP);raw.add(part);used=used.add(part);}
        var posted=AccountingAmounts.split(total,raw,ledger.baseScale(a,id(bill,"bookId")));for(int x=0;x<lines.size();x++)if(((Number)lines.get(x).get("id")).longValue()==id(bill,"billLineId"))return posted.get(x);throw ApiException.notFound();
    }
    /** Draft order never participates. Actual frozen principal is subtracted, so the final quantity takes the exact tail. */
    private BigDecimal nextPrincipal(Access a,Map<String,Object> bill,BigDecimal qty){
        var frozen=db.queryForMap("SELECT coalesce(sum(l.base_qty),0) qty,coalesce(sum(l.principal_amount),0) principal FROM ap_cost_assignment_line l JOIN ap_cost_assignment h ON h.country_id=l.country_id AND h.id=l.assignment_id WHERE l.country_id=? AND l.bill_line_id=? AND h.status='FROZEN'",a.requireCountry(),bill.get("billLineId"));BigDecimal total=linePrincipal(a,bill),through=n(frozen.get("qty")).add(qty),capacity=n(bill,"canonicalQty");if(through.compareTo(capacity)>0)throw failure("AP_COST_SOURCE_EXCEEDED","关联数量超过已确认账单行基础数量");BigDecimal prefix=through.compareTo(capacity)==0?total:AccountingAmounts.split(total,List.of(total.multiply(through).divide(capacity,12,RoundingMode.HALF_UP),total.subtract(total.multiply(through).divide(capacity,12,RoundingMode.HALF_UP))),ledger.baseScale(a,id(bill,"bookId"))).getFirst();return prefix.subtract(n(frozen.get("principal")));
    }
    private Map<String,Object> economicBasis(Map<String,Object> bill,BigDecimal qty,BigDecimal principal){var out=new LinkedHashMap<String,Object>();for(String field:List.of("bookId","partnerId","currency","baseCurrency","rate","rateId","rateDate","canonicalSourceType","canonicalSourceId","canonicalQty","lineAmount")){Object v=bill.get(field);out.put(field,v instanceof java.sql.Date?v.toString():v);}out.put("billId",bill.get("id"));out.put("billLineId",bill.get("billLineId"));out.put("billAmount",bill.get("amount"));out.put("billBaseAmount",bill.get("baseAmount"));out.put("baseQty",qty);out.put("principalAmount",principal);return out;}
    private record Evaluation(boolean ready,String reason,BigDecimal principal,List<Map<String,Object>> parts){}
    private Evaluation evaluate(Access a,Map<String,Object> source,Map<String,Object> h,boolean lockBills){
        if(h==null)return new Evaluation(false,"等待显式关联兼容的已确认应付账单行",null,List.of());var lines=assigned(a,id(h,"id"));
        if("FROZEN".equals(h.get("status"))){return new Evaluation(true,null,lines.stream().map(l->n(l,"principalAmount")).reduce(ZERO,BigDecimal::add),lines.stream().map(l->{var part=new LinkedHashMap<String,Object>();part.put("assignmentLineId",l.get("id"));part.put("billId",l.get("billId"));part.put("billLineId",l.get("billLineId"));part.put("baseQty",l.get("baseQty"));part.put("principalAmount",l.get("principalAmount"));part.put("economicBasis",json.readMap(l.get("economicBasis").toString()));return (Map<String,Object>)part;}).toList());}
        if(lines.stream().map(l->n(l,"baseQty")).reduce(ZERO,BigDecimal::add).compareTo(n(source,"qty"))!=0)return new Evaluation(false,"关联基础数量尚未完整覆盖成本数量",null,List.of());
        var parts=new ArrayList<Map<String,Object>>();BigDecimal total=ZERO;
        for(var line:lines){var bill=bill(a,id(line,"billLineId"),lockBills);String reason=incompatibility(source,bill);if(reason!=null)return new Evaluation(false,reason,null,List.of());BigDecimal principal=nextPrincipal(a,bill,n(line,"baseQty"));var part=new LinkedHashMap<String,Object>();part.put("assignmentLineId",line.get("id"));part.put("billId",bill.get("id"));part.put("billLineId",bill.get("billLineId"));part.put("baseQty",line.get("baseQty"));part.put("principalAmount",principal);part.put("economicBasis",economicBasis(bill,n(line,"baseQty"),principal));parts.add(part);total=total.add(principal);}
        return new Evaluation(true,null,total,parts);
    }
    @Override public Map<String,Object> principal(Access a,long cost){var source=source(a,cost);var h=header(a,cost);var e=evaluate(a,source,h,false);var out=new LinkedHashMap<String,Object>();out.put("ready",e.ready());out.put("reason",e.reason());out.put("principalAmount",e.principal());out.put("assignmentId",h==null?null:h.get("id"));out.put("status",h==null?"UNASSIGNED":h.get("status"));out.put("lines",e.parts());return out;}
    @Override public void freeze(Access a,long cost,long event){
        var source=source(a,cost);lock(a,id(source,"bookId"));var h=header(a,cost);var e=evaluate(a,source,h,true);if(!e.ready())throw failure("CST_PAYABLE_BASIS_REQUIRED",e.reason());if("FROZEN".equals(h.get("status"))){if(id(h,"frozenEventId")!=event)throw failure("AP_COST_BASIS_FROZEN","成本本金依据已由其他解释冻结");return;}
        db.update("UPDATE ap_cost_assignment SET status='FROZEN',frozen_event_id=?,frozen_at=clock_timestamp(),version=version+1 WHERE country_id=? AND id=?",event,a.requireCountry(),h.get("id"));for(var part:e.parts())db.update("UPDATE ap_cost_assignment_line SET principal_amount=?,economic_basis=?::jsonb WHERE country_id=? AND id=?",part.get("principalAmount"),json.write(part.get("economicBasis")),a.requireCountry(),part.get("assignmentLineId"));
    }
    public Map<String,Object> get(RequestContext c,long cost){return tx.execute(s->{var a=auth.authorize(c);a.require("cst:cost:view");costRead(a);return view(a,cost);});}
    private Map<String,Object> view(Access a,long cost){
        var source=source(a,cost);var h=header(a,cost);boolean legacy=(h==null||!"FROZEN".equals(h.get("status")))&&legacy(a,cost);boolean ap=a.has("ap:bill:view");boolean billScope=a.canBook(id(source,"bookId"));var out=new LinkedHashMap<String,Object>();for(String f:List.of("bookId","qty","srcCurrency","baseCurrency","rate","basePurchaseAmount"))out.put(f,source.get(f));out.put("costId",cost);out.put("version",h==null?0:h.get("version"));out.put("status",legacy?"LEGACY":h==null?"UNASSIGNED":h.get("status"));out.put("sourceNo","CST_INBOUND_COST-"+cost);out.put("canEdit",!legacy&&(h==null||!"FROZEN".equals(h.get("status")))&&Boolean.TRUE.equals(source.get("confirmed"))&&ap&&billScope&&a.has("cst:cost:confirm")&&FieldPolicyService.rank(a.fieldGroups().get("COST"))>=2);
        var linked=h==null?List.<Map<String,Object>>of():assigned(a,id(h,"id"));BigDecimal qty=linked.stream().map(l->n(l,"baseQty")).reduce(ZERO,BigDecimal::add);out.put("assignedQty",qty);out.put("remainingQty",n(source,"qty").subtract(qty));var e=legacy?new Evaluation(true,"旧解释结果已冻结；不会按新关联规则重算",null,List.of()):!ap||!billScope?new Evaluation(h!=null&&qty.compareTo(n(source,"qty"))==0,h==null?"等待显式关联兼容的已确认应付账单行":qty.compareTo(n(source,"qty"))==0?"依据关联状态已就绪；新解释仍须由当前授权核验并冻结":"关联基础数量尚未完整覆盖成本数量",null,List.of()):evaluate(a,source,h,false);out.put("basisStatus",legacy?"LEGACY":h!=null&&"FROZEN".equals(h.get("status"))?"FROZEN":e.ready()?"READY":"WAITING");out.put("basisReason",e.reason());
        var details=new ArrayList<Map<String,Object>>();var candidates=new ArrayList<Map<String,Object>>();
        if(ap){for(var l:linked){var b=bill(a,id(l,"billLineId"),false,false);if(!a.canRow(b))continue;docs.requireDocumentAccess(a,"AP_BILL",id(l,"billId"),false);var line=new LinkedHashMap<String,Object>();for(String f:List.of("billId","billLineId","baseQty","principalAmount"))line.put(f,l.get(f));line.put("docNo",b.get("docNo"));for(String f:List.of("currency","baseCurrency","rate"))line.put(f,b.get(f));details.add(line);}
            for(Long lineId:db.queryForList("SELECT l.id FROM ap_bill_line l JOIN ap_bill b ON b.country_id=l.country_id AND b.id=l.bill_id WHERE l.country_id=? AND b.book_id=? AND l.canonical_source_type='PUR_ORDER_LINE_BASE' AND l.canonical_source_id=? AND b.status IN('CONFIRMED','PARTIAL_PAID','PAID') ORDER BY b.id,l.id",Long.class,a.requireCountry(),source.get("bookId"),source.get("poLineId"))){var b=bill(a,lineId,false,false);if(!a.canRow(b))continue;docs.requireDocumentAccess(a,"AP_BILL",id(b,"id"),false);var r=new LinkedHashMap<String,Object>();r.put("billId",b.get("id"));r.put("billLineId",lineId);for(String f:List.of("docNo","currency","baseCurrency","rate","canonicalSourceId","lineAmount"))r.put(f,b.get(f));r.put("billAmount",b.get("amount"));r.put("billBaseAmount",b.get("baseAmount"));r.put("billQty",b.get("canonicalQty"));r.put("availableQty",n(b,"canonicalQty").subtract(occupied(a,lineId,h==null?null:id(h,"id"))));String reason=incompatibility(source,b);r.put("compatible",reason==null);r.put("basisReason",reason);r.put("principalAmount",b.get("baseAmount")==null?null:linePrincipal(a,b));candidates.add(r);}}
        out.put("lines",details);out.put("candidates",candidates);return fields.mask(a,out,"COST");
    }
    private void authorizeReturnedBills(Access a,Map<String,Object> result){for(String collection:List.of("lines","candidates"))if(result.get(collection) instanceof List<?> rows)for(Object value:rows)if(value instanceof Map<?,?> row)docs.requireDocumentAccess(a,"AP_BILL",Inputs.id(row.get("billId")),false);}
    @SuppressWarnings("unchecked") public Map<String,Object> save(RequestContext c,long cost,Map<String,Object> body,String key){return tx.execute(s->{var a=auth.authorize(c);a.require("cst:cost:confirm");a.require("ap:bill:view");costWrite(a);var source=source(a,cost);long book=id(source,"bookId");if(!a.canBook(book))throw ApiException.notFound();return idem.execute(c,"PUT","/api/v1/ap/cost-assignments/"+cost,key,body,book,()->{
            lock(a,book);var before=header(a,cost);if(legacy(a,cost)||before!=null&&"FROZEN".equals(before.get("status")))throw failure("AP_COST_BASIS_FROZEN","已有解释的成本本金依据不能修改");if(version(body)!=(before==null?0:((Number)before.get("version")).longValue()))throw Inputs.conflict();if(!Boolean.TRUE.equals(source.get("confirmed")))throw failure("CST_COST_MISSING","请先确认成本，再关联已确认账单");periods.assertOpen(a.requireCountry(),book,LocalDate.parse(source.get("confirmedBizDate").toString()));
            if(!(body.get("lines") instanceof List<?> raw)||raw.stream().anyMatch(l->!(l instanceof Map)))throw Inputs.bad("请显式填写账单行关联");var requested=(List<Map<String,Object>>)(List<?>)raw;var selected=new TreeMap<Long,BigDecimal>();BigDecimal total=ZERO;for(var l:requested){long line=Inputs.id(l.get("billLineId"));BigDecimal qty=Inputs.decimal(l.get("baseQty"),6,Inputs.PUBLIC_DECIMAL_MAX);if(qty.signum()<=0||selected.put(line,qty)!=null)throw Inputs.bad("关联基础数量须大于0，账单行不能重复");total=total.add(qty);}if(total.compareTo(n(source,"qty"))>0)throw failure("AP_COST_SOURCE_EXCEEDED","关联数量超过原成本基础数量");
            var bills=new LinkedHashMap<Long,Map<String,Object>>();for(var entry:selected.entrySet()){var b=bill(a,entry.getKey(),true);docs.requireDocumentAccess(a,"AP_BILL",id(b,"id"),false);String reason=incompatibility(source,b);if(reason!=null)throw failure("AP_COST_BASIS_INCOMPATIBLE",reason);if(occupied(a,entry.getKey(),before==null?null:id(before,"id")).add(entry.getValue()).compareTo(n(b,"canonicalQty"))>0)throw failure("AP_COST_SOURCE_EXCEEDED","账单行剩余可关联基础数量不足");bills.put(entry.getKey(),b);}
            long assignment;if(before==null)assignment=db.queryForObject("INSERT INTO ap_cost_assignment(country_id,book_id,cost_id,source_basis,created_by,version) VALUES(?,?,?,?::jsonb,?,0) RETURNING id",Long.class,a.requireCountry(),book,cost,json.write(sourceBasis(source)),a.userId());else{assignment=id(before,"id");db.update("DELETE FROM ap_cost_assignment_line WHERE country_id=? AND assignment_id=?",a.requireCountry(),assignment);db.update("UPDATE ap_cost_assignment SET version=version+1 WHERE country_id=? AND id=?",a.requireCountry(),assignment);}
            if(before==null)db.update("UPDATE ap_cost_assignment SET version=version+1 WHERE country_id=? AND id=?",a.requireCountry(),assignment);
            for(var entry:selected.entrySet()){var b=bills.get(entry.getKey());db.update("INSERT INTO ap_cost_assignment_line(country_id,book_id,assignment_id,cost_id,bill_id,bill_line_id,canonical_source_type,canonical_source_id,base_qty) VALUES(?,?,?,?,?,?,?,?,?)",a.requireCountry(),book,assignment,cost,b.get("id"),entry.getKey(),b.get("canonicalSourceType"),b.get("canonicalSourceId"),entry.getValue());}
            var result=view(a,cost);audit.append(c,"关联采购成本账单依据","CST_INBOUND_COST",cost,before,result);return result;
        },r->{source(a,cost);a.require("ap:bill:view");costWrite(a);if(!a.canBook(id(r,"bookId")))throw ApiException.notFound();authorizeReturnedBills(a,r);});});}
}
