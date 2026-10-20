package com.hs.jxc.cst.profit;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.cst.api.ProfitSourceProvider;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.lgs.api.LogisticsApi;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.*;
import java.math.*;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** A read of dated facts, not a persisted projection. No command, replay, cost rebuild or GL write. */
@Service
public class ProfitService {
    public static final String DISCLAIMER="按系统内已登记数据计算，未包含线下营销费用，不能称为全成本净利润。";
    private final JdbcTemplate db;private final AuthorizationService auth;private final FieldPolicyService fields;
    private final BookResolver books;private final LogisticsApi logistics;private final List<ProfitSourceProvider> providers;private final JsonCodec json;private final TransactionTemplate tx;
    public ProfitService(JdbcTemplate db,AuthorizationService auth,FieldPolicyService fields,BookResolver books,LogisticsApi logistics,List<ProfitSourceProvider> providers,JsonCodec json,PlatformTransactionManager tm){
        this.db=db;this.auth=auth;this.fields=fields;this.books=books;this.logistics=logistics;this.providers=providers;this.json=json;
        tx=new TransactionTemplate(tm);tx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        // Authorization holds FOR SHARE epoch gates. A PostgreSQL READ ONLY transaction forbids those gates.
        fields.register("ORDER_TOTAL","netSalesAmount","originalSalesAmount","grossProfit","contributionProfit");
        fields.register("COST","directExpense","periodExpense","costVersions","grossProfit","contributionProfit");
        fields.register("PROFIT","grossProfit","contributionProfit");
    }
    public Map<String,Object> query(RequestContext c,Map<String,String> q){return tx.execute(s->{var a=auth.authorize(c);requireProfit(a);return fields.mask(a,snapshot(a,q),"ORDER_TOTAL");});}
    private void requireProfit(Access a){a.require("cst:profit:view");if(FieldPolicyService.rank(a.fieldGroups().get("PROFIT"))<1)throw ApiException.forbidden();}
    public Map<String,Object> history(RequestContext c){return tx.execute(s->{var a=auth.authorize(c);requireAnalysis(a);return Map.of("records",List.of(),"total",0,"providerStatus","NOT_CONFIGURED");});}
    public Object analysis(RequestContext c,Map<String,Object> body){return tx.execute(s->{var a=auth.authorize(c);requireAnalysis(a);Map<String,String> q=new LinkedHashMap<>();for(String key:List.of("bookId","periodId","from","to"))if(body.get(key)!=null)q.put(key,body.get(key).toString());var facts=fields.mask(a,snapshot(a,q),"ORDER_TOTAL");throw new ApiException(503,"AI_PROVIDER_NOT_CONFIGURED","AI供应商尚未配置，未生成分析或模型历史",Map.of("providerStatus","NOT_CONFIGURED","disclaimer",DISCLAIMER,"sourceHash",facts.get("sourceHash")));});}
    private void requireAnalysis(Access a){a.require("ai:analysis:use");requireProfit(a);}
    private record Segment(LocalDate from,LocalDate to,Instant knownAt,Map<String,Object> period){}
    private Map<String,Object> snapshot(Access a,Map<String,String> q){
        long book=books.resolve(a,q.get("bookId")==null?null:queryId(q.get("bookId")),null);
        var country=DbRows.camel(db.queryForMap("SELECT code,timezone FROM sys_country WHERE id=?",a.requireCountry()));
        String currency=books.baseCurrency(a,book);int scale=db.queryForObject("SELECT decimals FROM md_currency WHERE code=?",Integer.class,currency);
        LocalDate today=LocalDate.now(ZoneId.of(country.get("timezone").toString()));Long periodId=q.get("periodId")==null?null:queryId(q.get("periodId"));
        Map<String,Object> selected=null;
        if(periodId!=null){var found=db.queryForList("SELECT * FROM fin_period WHERE country_id=? AND book_id=? AND id=?",a.requireCountry(),book,periodId);if(found.isEmpty())throw ApiException.notFound();selected=DbRows.camel(found.getFirst());}
        LocalDate from=day(q.get("from"),selected==null?today.withDayOfMonth(1):day(selected.get("startDate"))),to=day(q.get("to"),selected==null?today:day(selected.get("endDate")));
        if(to.isBefore(from)||to.toEpochDay()-from.toEpochDay()>3660)throw Inputs.bad("利润查询日期范围不合法或超过十年");
        if(selected!=null&&(from.isBefore(day(selected.get("startDate")))||to.isAfter(day(selected.get("endDate")))))throw Inputs.bad("查询日期不在所选期间内");
        Instant now=Instant.now();List<Segment> segments=new ArrayList<>();
        for(var raw:db.queryForList("SELECT * FROM fin_period WHERE country_id=? AND book_id=? AND start_date<=? AND end_date>=? ORDER BY start_date",a.requireCountry(),book,to,from)){
            var p=DbRows.camel(raw);LocalDate start=from.isAfter(day(p.get("startDate")))?from:day(p.get("startDate")),end=to.isBefore(day(p.get("endDate")))?to:day(p.get("endDate"));
            Instant cutoff="CLOSED".equals(p.get("status"))&&p.get("closedAt")!=null?Instant.parse(p.get("closedAt").toString()):now;
            segments.add(new Segment(start,end,cutoff,p));
        }
        long covered=segments.stream().mapToLong(s->s.to().toEpochDay()-s.from().toEpochDay()+1).sum();if(covered!=to.toEpochDay()-from.toEpochDay()+1)throw new ApiException(400,"FIN_PERIOD_NOT_FOUND","利润查询范围缺少会计期间");
        Map<Long,Row> rows=new TreeMap<>();List<Map<String,Object>> allSources=new ArrayList<>();
        for(var segment:segments){
            var facts=providers.stream().flatMap(provider->provider.profitFacts(a,book,segment.from(),segment.to(),segment.knownAt()).stream()).toList();
            Set<Long> origins=new HashSet<>();for(var fact:facts)if(fact.originalSalesAmount()!=null&&fact.originalOutboundLineId()!=null)origins.add(fact.originalOutboundLineId());var taxBases=new HashMap<Long,Boolean>();for(var provider:providers)taxBases.putAll(provider.outboundTaxBases(a,book,origins,segment.knownAt()));
            for(var fact:facts){
                var row=rows.computeIfAbsent(fact.productId(),Row::new);row.qty=row.qty.add(fact.netQty());
                var source=source(fact.sourceType(),fact.sourceId(),fact.sourceLineId(),fact.sourceNo(),fact.bizDate());
                if(fact.originalSalesAmount()!=null){boolean fxMissing=!currency.equals(fact.currency()),taxMissing=fact.taxRate()!=null&&fact.taxRate().signum()!=0||fact.originalOutboundLineId()!=null&&!Boolean.TRUE.equals(taxBases.get(fact.originalOutboundLineId()));row.salesMissing|=fxMissing||taxMissing;row.sales=row.sales.add(fact.originalSalesAmount());source.put("originalSalesAmount",fact.originalSalesAmount());source.put("currency",fact.currency());source.put("rateMissing",fxMissing);source.put("taxBasisMissing",taxMissing);if(fact.originalOutboundLineId()!=null)source.put("originalOutboundLineId",fact.originalOutboundLineId());source.put("netSalesAmount",fxMissing||taxMissing?null:fact.originalSalesAmount());}
                if(fact.costSourceType()!=null){var cost=cost(a,book,fact,segment);row.costMissing|=cost.amount()==null;row.estimated|=cost.estimated();if(cost.amount()!=null)row.cogs=row.cogs.add(cost.amount());row.versions.addAll(cost.versions());source.put("cogsAmount",cost.amount());source.put("costVersions",cost.versions());source.put("costMissing",cost.amount()==null);}
                row.sources.add(source);allSources.add(source);
            }
            adjustments(a,book,segment,rows,allSources);expenses(a,book,segment,rows,allSources);
        }
        List<Map<String,Object>> result=rows.values().stream().map(r->render(r,scale)).toList();
        var versions=new LinkedHashMap<String,Object>();versions.put("algorithm","profit-facts-v1");versions.put("countryId",a.requireCountry());versions.put("bookId",book);versions.put("from",from);versions.put("to",to);versions.put("periods",segments.stream().map(s->Map.of("periodId",s.period().get("id"),"periodVersion",s.period().get("version"),"status",s.period().get("status"),"closeGeneration",s.period().get("closeGeneration"))).toList());versions.put("sources",allSources);
        var out=new LinkedHashMap<String,Object>();out.put("bookId",book);out.put("countryId",a.requireCountry());out.put("countryCode",country.get("code"));out.put("timezone",country.get("timezone"));out.put("baseCurrency",currency);out.put("currency",currency);out.put("currencyDecimals",scale);out.put("periodId",periodId);out.put("from",from);out.put("to",to);out.put("periodStatus",segments.stream().map(s->s.period().get("status").toString()).distinct().count()==1?segments.getFirst().period().get("status"):"MIXED");out.put("fresh",true);out.put("sourceVersion","profit-facts-v1");out.put("sourceHash",Digests.sha256(json.write(IdempotencyExecutor.canonical(versions))));out.put("rows",result);out.put("grossProfit",total(result,"grossProfit"));out.put("contributionProfit",total(result,"contributionProfit"));out.put("disclaimer",DISCLAIMER);out.put("reconcileHint","财务利润表来自已记账凭证；本页读取业务事实，未记账业务、未分到商品的期间费用、暂估成本及税口径会造成差异。");out.put("differences",List.of("未记账业务及财务报表科目映射范围","未分到商品的期间费用使用productId=0单列","含暂估成本或费用；缺成本、实际冻结汇率或确认税口径时金额为空","非零税率但缺少独立确认含税/未税事实时，保留原始成交额并标数据不足","关闭期间按关闭时间与业务日期截止事实读取，后续成本补齐和反向结算不改写旧期间"));return out;
    }
    private record Cost(BigDecimal amount,boolean estimated,List<Map<String,Object>> versions){}
    private Cost cost(Access a,long book,ProfitSourceProvider.Fact fact,Segment s){
        var costs=db.queryForList("SELECT c.id,c.amount,c.status,c.method,c.method_version,x.amount completed_amount,x.biz_date completion_date FROM cst_cogs c LEFT JOIN cst_cogs_completion x ON x.country_id=c.country_id AND x.cogs_id=c.id AND x.biz_date<=? AND x.created_at<=? WHERE c.country_id=? AND c.book_id=? AND c.source_type=? AND c.source_line_id=? AND c.created_at<=?",s.to(),Timestamp.from(s.knownAt()),a.requireCountry(),book,fact.costSourceType(),fact.costSourceLineId(),Timestamp.from(s.knownAt()));
        if(!costs.isEmpty()){var c=costs.getFirst();BigDecimal amount=(BigDecimal)(c.get("amount")==null?c.get("completed_amount"):c.get("amount"));var version=new LinkedHashMap<String,Object>();version.put("cogsId",c.get("id"));version.put("method",c.get("method"));version.put("methodVersion",c.get("method_version"));version.put("completionDate",c.get("completion_date"));version.put("cogsAmount",amount);return new Cost(amount,!"CONFIRMED".equals(c.get("status"))||c.get("amount")==null,List.of(version));}
        if(fact.inboundBatchId()!=null){var inbound=db.queryForList("SELECT i.id,i.base_purchase_amount,i.status,x.base_purchase_amount confirmed_amount FROM cst_inbound_cost i LEFT JOIN cst_cost_confirmation x ON x.country_id=i.country_id AND x.cost_id=i.id AND x.biz_date<=? AND x.confirmed_at<=? WHERE i.country_id=? AND i.book_id=? AND i.batch_id=? AND i.created_at<=?",s.to(),Timestamp.from(s.knownAt()),a.requireCountry(),book,fact.inboundBatchId(),Timestamp.from(s.knownAt()));if(!inbound.isEmpty()){var i=inbound.getFirst();BigDecimal amount=(BigDecimal)(i.get("base_purchase_amount")==null?i.get("confirmed_amount"):i.get("base_purchase_amount"));return new Cost(amount==null?null:amount.negate(),!"CONFIRMED".equals(i.get("status")),List.of(Map.of("inboundCostId",i.get("id"))));}}
        return new Cost(null,false,List.of());
    }
    private void adjustments(Access a,long book,Segment s,Map<Long,Row> rows,List<Map<String,Object>> all){
        for(var raw:db.queryForList("SELECT * FROM cst_cost_adjustment WHERE country_id=? AND book_id=? AND status='CONFIRMED' AND biz_date BETWEEN ? AND ? AND confirmed_at<=? AND (source_type<>'RETURN_COST' OR target='COGS') ORDER BY id",a.requireCountry(),book,s.from(),s.to(),Timestamp.from(s.knownAt()))){var arow=DbRows.camel(raw);if(!a.canRow(arow))continue;BigDecimal sold=(BigDecimal)arow.get("soldAmount");if(sold==null||sold.signum()==0)continue;var row=rows.computeIfAbsent(n(arow,"productId"),Row::new);row.cogs=row.cogs.add(sold);var source=source("CST_ADJUSTMENT",n(arow,"id"),n(arow,"id"),arow.get("docNo").toString(),day(arow.get("bizDate")));source.put("cogsAmount",sold);source.put("costSourceType",arow.get("sourceType"));if("FEE_ALLOCATION".equals(arow.get("sourceType"))){var fees=db.queryForList("SELECT fee_id FROM cst_fee_allocation WHERE country_id=? AND book_id=? AND id=?",Long.class,a.requireCountry(),book,arow.get("sourceId"));if(fees.isEmpty())row.costMissing=true;else{boolean estimated="ESTIMATE".equals(logistics.costFee(a,fees.getFirst(),false).estimateFlag());row.estimated|=estimated;source.put("estimated",estimated);}}row.sources.add(source);all.add(source);}
    }
    private void expenses(Access a,long book,Segment s,Map<Long,Row> rows,List<Map<String,Object>> all){
        for(var raw:db.queryForList("SELECT * FROM cst_expense_record WHERE country_id=? AND book_id=? AND status='CONFIRMED' AND biz_date BETWEEN ? AND ? AND created_at<=? ORDER BY id",a.requireCountry(),book,s.from(),s.to(),Timestamp.from(s.knownAt()))){var exp=DbRows.camel(raw);if(!a.canRow(exp))continue;var lines=db.queryForList("SELECT * FROM cst_expense_alloc_line WHERE country_id=? AND expense_id=? ORDER BY id",a.requireCountry(),exp.get("id"));boolean direct="DIRECT_SELLING".equals(exp.get("treatment"));if(lines.isEmpty()){if(!direct)addExpense(rows,all,exp,0,(BigDecimal)exp.get("baseAmount"),false);}else for(var line:lines)addExpense(rows,all,exp,((Number)line.get("product_id")).longValue(),(BigDecimal)line.get("base_amount"),direct);}
    }
    private void addExpense(Map<Long,Row> rows,List<Map<String,Object>> all,Map<String,Object> exp,long product,BigDecimal amount,boolean direct){var row=rows.computeIfAbsent(product,Row::new);if(direct)row.direct=row.direct.add(amount);else row.period=row.period.add(amount);var source=source("CST_EXPENSE",n(exp,"id"),n(exp,"id"),exp.get("docNo").toString(),day(exp.get("bizDate")));source.put(direct?"directExpense":"periodExpense",amount);row.sources.add(source);all.add(source);}
    private static final class Row {final long product;BigDecimal qty=BigDecimal.ZERO,sales=BigDecimal.ZERO,cogs=BigDecimal.ZERO,direct=BigDecimal.ZERO,period=BigDecimal.ZERO;boolean salesMissing,costMissing,estimated;List<Map<String,Object>> sources=new ArrayList<>(),versions=new ArrayList<>();Row(long product){this.product=product;}}
    private Map<String,Object> render(Row row,int scale){
        var out=new LinkedHashMap<String,Object>();out.put("productId",row.product);if(row.product==0){out.put("productCode","—");out.put("productName","未分到商品的期间费用");}else{var product=db.queryForMap("SELECT product_code,name FROM md_product WHERE id=?",row.product);out.put("productCode",product.get("product_code"));out.put("productName",product.get("name"));}
        out.put("netSalesQty",row.qty.setScale(4,RoundingMode.HALF_UP));var raw=new LinkedHashMap<String,Object>();raw.put("netSalesAmount",row.salesMissing?null:row.sales);raw.put("cogsAmount",row.costMissing?null:row.cogs);raw.put("directExpense",row.direct);raw.put("periodExpense",row.period);BigDecimal gross=row.salesMissing||row.costMissing?null:row.sales.subtract(row.cogs);raw.put("grossProfit",gross);raw.put("contributionProfit",gross==null?null:gross.subtract(row.direct).subtract(row.period));raw.forEach((key,value)->out.put(key,value==null?null:((BigDecimal)value).setScale(scale,RoundingMode.HALF_UP)));out.put("originalAmounts",raw);out.put("completeness",row.costMissing||row.salesMissing?"INSUFFICIENT":row.estimated?"ESTIMATED":"COMPLETE");out.put("costVersions",row.versions);out.put("sources",row.sources);return out;
    }
    private BigDecimal total(List<Map<String,Object>> rows,String key){if(rows.stream().anyMatch(r->r.get(key)==null))return null;return rows.stream().map(r->(BigDecimal)r.get(key)).reduce(BigDecimal.ZERO,BigDecimal::add);}
    private Map<String,Object> source(String type,long id,long line,String no,LocalDate date){var s=new LinkedHashMap<String,Object>();s.put("sourceType",type);s.put("sourceId",id);s.put("sourceLineId",line);s.put("sourceNo",no);s.put("bizDate",date);return s;}
    private LocalDate day(Object value){return LocalDate.parse(value.toString());}
    private LocalDate day(String value,LocalDate fallback){try{return value==null?fallback:LocalDate.parse(value);}catch(Exception ex){throw Inputs.bad("日期不合法");}}
    private long queryId(String value){try{return Inputs.id(new BigDecimal(value));}catch(NumberFormatException ex){throw Inputs.bad("ID必须是安全整数");}}
    private long n(Map<String,Object> r,String key){return ((Number)r.get(key)).longValue();}
}
