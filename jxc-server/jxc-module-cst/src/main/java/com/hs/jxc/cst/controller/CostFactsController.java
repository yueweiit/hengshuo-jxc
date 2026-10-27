package com.hs.jxc.cst.controller;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.fin.api.PeriodApi;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.*;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/cst")
public class CostFactsController {
 private final com.hs.jxc.cst.service.CostValuationService valuation;private final JdbcTemplate jdbc;private final AuthorizationService auth;private final FieldPolicyService fields;private final PeriodApi periods;private final IdempotencyExecutor idem;private final AuditWriter audit;private final TransactionTemplate tx;private final com.hs.jxc.inv.api.InventoryApi inventory;private final com.hs.jxc.pur.api.SupplyApi purchase;private final com.hs.jxc.lgs.api.LogisticsApi logistics;
 public CostFactsController(com.hs.jxc.cst.service.CostValuationService valuation,JdbcTemplate jdbc,AuthorizationService auth,FieldPolicyService fields,PeriodApi periods,IdempotencyExecutor idem,AuditWriter audit,DocumentAccessService docs,PlatformTransactionManager tm,com.hs.jxc.inv.api.InventoryApi inventory,com.hs.jxc.pur.api.SupplyApi purchase,com.hs.jxc.lgs.api.LogisticsApi logistics){this.inventory=inventory;this.purchase=purchase;this.logistics=logistics;this.valuation=valuation;this.jdbc=jdbc;this.auth=auth;this.fields=fields;this.periods=periods;this.idem=idem;this.audit=audit;this.tx=new TransactionTemplate(tm);fields.register("COST","srcCurrency","srcUnitPrice","srcAmount","purchaseOriginalAmount","purchaseBaseQty","basePurchaseAmount","rateId","rateDate","rateVersion","sourceCostId","costSnapshotId","costStatus","methodVersion","poolQty","poolAmount","sourceUnitCost","sourceAmount","valuedAmount","sourceOriginalQty","sourceOriginalAmount","roundingAdjustment","beforeAmount","afterAmount","amountChange");for(var type:List.of("CST_INBOUND_COST","CST_COGS")){String table=type.equals("CST_COGS")?"cst_cogs":"cst_inbound_cost";docs.register(type,List.of("cst:cost:view"),List.of(),(a,id)->{var rows=jdbc.queryForList("SELECT * FROM "+table+" WHERE country_id=? AND id=?",a.requireCountry(),id);return rows.isEmpty()?null:DbRows.camel(rows.getFirst());});}}
 @GetMapping("/method") public ApiEnvelope method(@RequestParam long bookId){var c=RequestContextHolder.require();return ApiEnvelope.ok(tx.execute(s->{var a=auth.authorize(c);a.require("cst:method:config","cst:cost:view");if(!a.canBook(Inputs.id(bookId)))throw ApiException.notFound();var rows=jdbc.queryForList("SELECT * FROM cst_method_config WHERE country_id=? AND book_id=?",a.requireCountry(),bookId);return rows.isEmpty()?Map.of("bookId",bookId,"status","UNCONFIGURED"):DbRows.camel(rows.getFirst());}),c.traceId());}
 @PutMapping("/method") public ApiEnvelope set(@RequestParam(required=false) Long bookId,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(tx.execute(s->{var a=auth.authorize(c);a.require("cst:method:config");long book=bookId==null?Inputs.id(body.get("bookId")):Inputs.id(bookId);if(!a.canBook(book))throw ApiException.notFound();String method=Inputs.required(body,"method");if(!Set.of("FIFO","BATCH_SPECIFIC","MOVING_AVG").contains(method))throw Inputs.bad("成本计价方法不合法");return idem.execute(c,"PUT","/api/v1/cst/method?bookId="+book,key,body,book,()->{periods.lockExclusive(a.requireCountry(),book);if(jdbc.queryForObject("SELECT (SELECT count(*) FROM cst_inbound_cost WHERE country_id=? AND book_id=?)+(SELECT count(*) FROM cst_cogs WHERE country_id=? AND book_id=?)",Long.class,a.requireCountry(),book,a.requireCountry(),book)>0)throw new ApiException(409,"CST_METHOD_LOCKED","账套已有成本事实，不能切换计价方法");var old=jdbc.queryForList("SELECT * FROM cst_method_config WHERE country_id=? AND book_id=? FOR UPDATE",a.requireCountry(),book);if(!old.isEmpty()&&Inputs.version(body)!=((Number)old.getFirst().get("version_no")).longValue())throw Inputs.conflict();LocalDate date=body.get("effectiveFrom")==null?LocalDate.of(1900,1,1):LocalDate.parse(String.valueOf(body.get("effectiveFrom")));jdbc.update("INSERT INTO cst_method_config(country_id,book_id,method,effective_from) VALUES(?,?,?,?) ON CONFLICT(country_id,book_id) DO UPDATE SET method=excluded.method,effective_from=excluded.effective_from,version_no=cst_method_config.version_no+1",a.requireCountry(),book,method,date);var result=DbRows.camel(jdbc.queryForMap("SELECT * FROM cst_method_config WHERE country_id=? AND book_id=?",a.requireCountry(),book));audit.append(c,"配置成本计价方法","CST_METHOD",((Number)result.get("id")).longValue(),old,result);return result;},r->{if(!a.canBook(book))throw ApiException.notFound();});}),c.traceId());}
 @GetMapping({"/inbound-costs","/cogs"})
 public ApiEnvelope facts(jakarta.servlet.http.HttpServletRequest request,@RequestParam Map<String,String> q,@RequestParam(required=false) Long supplierId){
  var c=RequestContextHolder.require();
  return ApiEnvelope.ok(tx.execute(s->{
   var a=auth.authorize(c);a.require("cst:cost:view");
   boolean inbound=request.getRequestURI().endsWith("inbound-costs");
   List<Object> args=new ArrayList<>();args.add(a.requireCountry());
   String where="country_id=? AND "+scope(a,args),table=inbound?"cst_inbound_cost":"cst_cogs";
   String keyword=q.getOrDefault("keyword","").trim().toLowerCase(Locale.ROOT);
   Long supplierFilter=inbound&&supplierId!=null?Inputs.id(supplierId):null;
   List<Map<String,Object>> rows=new ArrayList<>();Map<String,Integer> counts=new HashMap<>();
   for(var raw:jdbc.queryForList("SELECT * FROM "+table+" WHERE "+where+" ORDER BY id DESC",args.toArray())){
    long id=((Number)raw.get("id")).longValue();
    var row=inbound?valuation.inbound(a,id,false):DbRows.camel(raw);
    if(inbound)sourceLabels(c,a,row);
    else{
     var complete=jdbc.queryForList("SELECT amount,unit_cost FROM cst_cogs_completion WHERE country_id=? AND cogs_id=?",a.requireCountry(),id);
     if(!complete.isEmpty()){row.put("amount",complete.getFirst().get("amount"));row.put("unitCost",complete.getFirst().get("unit_cost"));row.put("status","ESTIMATED");}
    }
    boolean match=true;
    for(String field:List.of("bookId","warehouseId","productId"))
     if(q.containsKey(field)&&!String.valueOf(row.get(field)).equals(q.get(field)))match=false;
    if(supplierFilter!=null&&!(row.get("supplierId") instanceof Number supplier&&supplier.longValue()==supplierFilter))match=false;
    if(inbound&&!keyword.isEmpty()&&!row.get("batchNo").toString().toLowerCase(Locale.ROOT).contains(keyword))match=false;
    if(q.containsKey("dateFrom")&&String.valueOf(row.get("bizDate")).compareTo(q.get("dateFrom"))<0)match=false;
    if(q.containsKey("dateTo")&&String.valueOf(row.get("bizDate")).compareTo(q.get("dateTo"))>0)match=false;
    if(!match)continue;
    counts.merge(String.valueOf(row.get("status")),1,Integer::sum);
    if(!q.containsKey("status")||String.valueOf(row.get("status")).equals(q.get("status")))rows.add(fields.mask(a,row,"COST"));
   }
   int page=q.containsKey("page")?Integer.parseInt(q.get("page")):1,size=q.containsKey("size")?Math.min(200,Integer.parseInt(q.get("size"))):20;
   if(page<1||size<1)throw Inputs.bad("分页参数不合法");
   return Map.of("records",rows.stream().skip((long)(page-1)*size).limit(size).toList(),"total",rows.size(),"page",page,"size",size,"counts",counts);
  }),c.traceId());
 }
 /** Labels come from each source owner, after the existing cost-row authorization. No price or list grant. */
 private void sourceLabels(RequestContext context,Access access,Map<String,Object> row){
  long book=((Number)row.get("bookId")).longValue(),warehouse=((Number)row.get("warehouseId")).longValue();
  var batch=inventory.batchReference(context,book,warehouse,((Number)row.get("batchId")).longValue());
  row.put("batchNo",batch.batchNo());
  if(row.get("poId") instanceof Number order){
   var source=purchase.costOrderReference(access,book,warehouse,order.longValue());
   row.put("poNo",source.get("docNo"));row.put("supplierId",source.get("supplierId"));
  }
  if("LGS_RECEIPT".equals(row.get("sourceType")))
   row.putAll(logistics.receiptCostReference(access,book,((Number)row.get("sourceLineId")).longValue()));
 }
 private String scope(Access a,List<Object> args){if(a.scope().all())return "TRUE";List<String> clauses=new ArrayList<>();if(!a.scope().warehouses().isEmpty()){args.addAll(a.scope().warehouses());clauses.add("warehouse_id IN ("+String.join(",",Collections.nCopies(a.scope().warehouses().size(),"?"))+")");}if(!a.scope().books().isEmpty()){args.addAll(a.scope().books());clauses.add("book_id IN ("+String.join(",",Collections.nCopies(a.scope().books().size(),"?"))+")");}return clauses.isEmpty()?"FALSE":"("+String.join(" OR ",clauses)+")";}
}
