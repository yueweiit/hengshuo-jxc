package com.hs.jxc.fin.report;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.*;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.fin.api.*;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.*;
import java.math.BigDecimal;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.*;
import org.springframework.transaction.support.*;

@Service
public class ReportService implements ReportApi {
    private final JdbcTemplate db;private final JsonCodec json;private final AuthorizationService auth;private final FieldPolicyService fields;private final BookResolver books;private final BookGate gates;private final IdempotencyExecutor idem;private final AuditWriter audit;private final ReportFacts facts;private final SnapshotApi snapshots;private final TransactionTemplate tx,readTx;
    public ReportService(JdbcTemplate db,JsonCodec json,AuthorizationService auth,FieldPolicyService fields,BookResolver books,BookGate gates,IdempotencyExecutor idem,AuditWriter audit,ReportFacts facts,SnapshotApi snapshots,PlatformTransactionManager manager){
        this.db=db;this.json=json;this.auth=auth;this.fields=fields;this.books=books;this.gates=gates;this.idem=idem;this.audit=audit;this.facts=facts;this.snapshots=snapshots;tx=new TransactionTemplate(manager);readTx=new TransactionTemplate(manager);readTx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        fields.register("COST","difference","openingNet","closingNet");
    }
    private static long number(Map<String,Object> row,String key){return ((Number)row.get(key)).longValue();}
    /** The shared CREDIT "available" amount name must not hide this nonfinancial configuration flag. */
    public Map<String,Object> mask(Access a,Map<String,Object> row){var result=fields.mask(a,row,"COST");if(row.get("available") instanceof Boolean value)result.put("available",value);return result;}
    private void activeTransaction(){if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Report API requires the authorized caller transaction");}
    private long resolve(Access a,Long selected,Long period){
        if(period!=null){var rows=db.queryForList("SELECT book_id FROM fin_period WHERE country_id=? AND id=?",a.requireCountry(),period);if(rows.isEmpty())throw ApiException.notFound();long actual=((Number)rows.getFirst().get("book_id")).longValue();if(selected!=null&&selected!=actual)throw ApiException.notFound();selected=actual;}
        return books.resolve(a,selected,null);
    }
    private Map<String,Object> period(Access a,long book,Long period){
        var rows=period==null?db.queryForList("SELECT * FROM fin_period WHERE country_id=? AND book_id=? AND ?::date BETWEEN start_date AND end_date",a.requireCountry(),book,LocalDate.now(ZoneId.of(db.queryForObject("SELECT timezone FROM sys_country WHERE id=?",String.class,a.requireCountry()))).toString()):db.queryForList("SELECT * FROM fin_period WHERE country_id=? AND book_id=? AND id=?",a.requireCountry(),book,period);
        if(rows.isEmpty())throw new ApiException(400,"FIN_PERIOD_NOT_FOUND","请选择会计期间");return DbRows.camel(rows.getFirst());
    }
    public Map<String,Object> report(RequestContext c,Long selected,Long periodId,String requested){return readTx.execute(status->{
        var a=auth.authorize(c);a.require("fin:report:view");long book=resolve(a,selected,periodId);var p=period(a,book,periodId);return mask(a,read(a,book,p,ReportRules.type(requested)));
    });}
    @SuppressWarnings("unchecked") private Map<String,Object> read(Access a,long book,Map<String,Object> p,String type){
        if(!"CLOSED".equals(p.get("status")))return calculate(a,book,p,type,facts.balances(a,book,p));
        var saved=snapshots.latest(a,book,number(p,"id"),"REPORT");if(saved==null)throw new ApiException(409,"FIN_REPORT_SNAPSHOT_MISSING","已结账期间缺少冻结报表，请检查结账快照");
        Object content=saved.get("content");if(!(content instanceof Map<?,?> bundle)||!(bundle.get(snapshotKey(type)) instanceof Map<?,?> report))throw new ApiException(409,"FIN_REPORT_SNAPSHOT_MISSING","冻结报表内容不完整");
        var out=new LinkedHashMap<>((Map<String,Object>)report);out.put("source","SNAPSHOT");out.put("snapshotId",saved.get("id"));out.put("closeGeneration",saved.get("closeGeneration"));out.put("sourceFingerprint",saved.get("sourceFingerprint"));out.put("sourceVersions",saved.get("sourceVersions"));return out;
    }
    private String snapshotKey(String type){return switch(type){case "BALANCE_SHEET"->"balance";case "INCOME"->"income";default->"cashflow";};}
    @Override public Map<String,Object> snapshot(Access a,long book,long periodId){
        activeTransaction();books.resolve(a,book,null);var p=period(a,book,periodId);var balances=facts.balances(a,book,p);var out=new LinkedHashMap<String,Object>();for(String type:List.of("BALANCE_SHEET","INCOME","CASHFLOW"))out.put(snapshotKey(type),calculate(a,book,p,type,balances));return out;
    }
    public void authorizeExport(Access a,long book,Map<String,Object> request){activeTransaction();a.require("fin:report:export");long period=Inputs.id(request.get("periodId"));ReportRules.type(Inputs.required(request,"type"));resolve(a,book,period);period(a,book,period);}
    /** Export workers already own the authorized effect transaction; no separate connection or gate. */
    public Map<String,Object> exportSnapshot(Access a,long book,Map<String,Object> request){authorizeExport(a,book,request);var p=period(a,book,Inputs.id(request.get("periodId")));var result=read(a,book,p,ReportRules.type(Inputs.required(request,"type")));if(!Boolean.TRUE.equals(result.get("available")))throw new ApiException(400,"FIN_REPORT_CONFIGURATION_MISSING","报表配置缺项，不能生成导出文件");return result;}
    private Map<String,Object> calculate(Access a,long book,Map<String,Object> p,String type,List<Map<String,Object>> balances){
        var out=new LinkedHashMap<String,Object>();out.put("type",type);out.put("bookId",book);out.put("periodId",p.get("id"));out.put("periodName",p.get("fiscalYear")+"-"+String.format("%02d",((Number)p.get("periodNo")).intValue()));out.put("currency",books.baseCurrency(a,book));out.put("source","LIVE");out.put("trial",ReportFacts.trial(balances));
        int openingCount=db.queryForObject("SELECT count(*) FROM fin_opening_balance WHERE country_id=? AND book_id=? AND status='CONFIRMED' AND cutoff_date<?::date",Integer.class,a.requireCountry(),book,p.get("startDate"));out.put("openingState",openingCount==0?"NOT_PROVIDED":"CONFIRMED");
        var missing=new ArrayList<String>();var lines=new ArrayList<Map<String,Object>>();
        if(type.equals("CASHFLOW")){
            lines.addAll(facts.cashflows(a,book,number(p,"id")));int absent=facts.missingCashflow(a,book,number(p,"id"));if(absent>0)missing.add("FIN_CASHFLOW_ITEM_MISSING");for(var line:lines)line.put("accounts",accountRefs(balances,new LinkedHashSet<>(idList(line.get("accountIds")))));
            out.put("note","按现金银行已记账分录的现金流项目汇总，不以销售额代替现金流入");
        }else{
            var rows=db.queryForList("SELECT id FROM fin_report_template WHERE country_id=? AND book_id=? AND report_type=? AND status='ACTIVE'",a.requireCountry(),book,type);
            if(rows.isEmpty())missing.add("FIN_REPORT_TEMPLATE_MISSING");else{
                var template=template(a,book,((Number)rows.getFirst().get("id")).longValue(),false);out.put("templateId",template.get("id"));out.put("templateVersionNo",template.get("versionNo"));out.put("rule",template.get("rule"));
                if("CATEGORY_V1".equals(template.get("rule")))category(type,balances,lines);else mapped(balances,ReportRules.maps(template.get("lines")),lines);
                var covered=new HashSet<Long>();for(var line:lines)covered.addAll(idList(line.get("accountIds")));
                for(var balance:balances)if(ReportFacts.decimal(balance,type.equals("INCOME")?"periodDebit":"closingNet").signum()!=0||type.equals("INCOME")&&ReportFacts.decimal(balance,"periodCredit").signum()!=0){if((!type.equals("INCOME")||Set.of("INCOME","COST","EXPENSE","PROFIT_LOSS").contains(balance.get("category")))&&!covered.contains(number(balance,"accountId")))missing.add("FIN_REPORT_UNMAPPED_ACCOUNT:"+balance.get("code")+":"+balance.get("category"));}
            }
            if(type.equals("BALANCE_SHEET")&&!lines.isEmpty()){
                BigDecimal difference=lineAmount(lines,"ASSET").subtract(lineAmount(lines,"LIABILITY")).subtract(lineAmount(lines,"EQUITY")).subtract(lineAmount(lines,"RETAINED_PROFIT"));out.put("difference",difference);out.put("balanced",difference.signum()==0&&Boolean.TRUE.equals(((Map<?,?>)out.get("trial")).get("balanced")));
            }
        }
        out.put("lines",lines);out.put("missingConfigurations",missing.stream().distinct().toList());out.put("available",missing.isEmpty());return out;
    }
    private static BigDecimal lineAmount(List<Map<String,Object>> lines,String code){return lines.stream().filter(l->code.equals(l.get("code"))).map(l->ReportFacts.decimal(l,"amount")).findFirst().orElse(BigDecimal.ZERO);}
    private List<Long> idList(Object raw){if(!(raw instanceof Collection<?> values))return List.of();return values.stream().map(Inputs::id).toList();}
    private List<Map<String,Object>> accountRefs(List<Map<String,Object>> facts,Set<Long> ids){var unique=new LinkedHashMap<Long,Map<String,Object>>();for(var row:facts)if(ids.contains(number(row,"accountId")))unique.putIfAbsent(number(row,"accountId"),Map.of("accountId",row.get("accountId"),"code",row.get("code"),"name",row.get("name")));return new ArrayList<>(unique.values());}
    private Map<String,Object> amountLine(String code,String name,List<Map<String,Object>> selected,String field,int sign){var row=new LinkedHashMap<String,Object>();row.put("code",code);row.put("name",name);row.put("amount",ReportFacts.sum(selected,field).multiply(BigDecimal.valueOf(sign)));var ids=new LinkedHashSet<Long>();for(var fact:selected)ids.add(number(fact,"accountId"));row.put("accountIds",new ArrayList<>(ids));row.put("accounts",accountRefs(selected,ids));return row;}
    private void category(String type,List<Map<String,Object>> balances,List<Map<String,Object>> lines){
        if(type.equals("BALANCE_SHEET")){
            for(String category:List.of("ASSET","LIABILITY","EQUITY"))lines.add(amountLine(category,switch(category){case "ASSET"->"资产合计";case "LIABILITY"->"负债合计";default->"权益科目余额";},balances.stream().filter(r->category.equals(r.get("category"))).toList(),"closingNet",category.equals("ASSET")?1:-1));
            lines.add(amountLine("RETAINED_PROFIT","未结转损益",balances.stream().filter(r->Set.of("INCOME","COST","EXPENSE").contains(r.get("category"))).toList(),"closingNet",-1));
        }else{
            for(String category:List.of("INCOME","COST","EXPENSE")){var selected=balances.stream().filter(r->category.equals(r.get("category"))).map(r->{var copy=new LinkedHashMap<>(r);copy.put("periodNet",ReportFacts.decimal(r,"periodDebit").subtract(ReportFacts.decimal(r,"periodCredit")));return (Map<String,Object>)copy;}).toList();lines.add(amountLine(category.equals("INCOME")?"REVENUE":category.equals("COST")?"COGS":"EXPENSE",category.equals("INCOME")?"营业收入":category.equals("COST")?"营业成本":"期间费用",selected,"periodNet",category.equals("INCOME")?-1:1));}
            var profit=amountLine("PROFIT","利润",balances.stream().filter(r->Set.of("INCOME","COST","EXPENSE").contains(r.get("category"))).toList(),"periodCredit",1);profit.put("amount",lineAmount(lines,"REVENUE").subtract(lineAmount(lines,"COGS")).subtract(lineAmount(lines,"EXPENSE")));lines.add(profit);
        }
    }
    private void mapped(List<Map<String,Object>> balances,List<Map<String,Object>> definitions,List<Map<String,Object>> out){
        for(var definition:definitions){String formula=definition.get("formula").toString();int sign=((Number)definition.get("sign")).intValue();Map<String,Object> line;
            if(formula.equals("LINE_SUM")){BigDecimal value=BigDecimal.ZERO;var ids=new LinkedHashSet<Long>();for(var term:ReportRules.maps(definition.get("terms"))){var previous=out.stream().filter(l->l.get("code").equals(term.get("code"))).findFirst().orElseThrow(ReportRules::expression);value=value.add(ReportFacts.decimal(previous,"amount").multiply(BigDecimal.valueOf(((Number)term.get("sign")).intValue())));ids.addAll(idList(previous.get("accountIds")));}line=new LinkedHashMap<>();line.put("code",definition.get("code"));line.put("name",definition.get("name"));line.put("amount",value.multiply(BigDecimal.valueOf(sign)));line.put("accountIds",new ArrayList<>(ids));line.put("accounts",accountRefs(balances,ids));}
            else{var ids=new HashSet<>(idList(definition.get("accountIds")));var selected=balances.stream().filter(b->definition.get("category")!=null?definition.get("category").equals(b.get("category")):ids.contains(number(b,"accountId"))).map(b->{var copy=new LinkedHashMap<>(b);copy.put("periodNet",ReportFacts.decimal(b,"periodDebit").subtract(ReportFacts.decimal(b,"periodCredit")));return (Map<String,Object>)copy;}).toList();line=amountLine(definition.get("code").toString(),definition.get("name").toString(),selected,formula.equals("CLOSING_NET")?"closingNet":"periodNet",sign);}
            out.add(line);
        }
    }
    public Map<String,Object> templates(RequestContext c,Long selected,String type){return tx.execute(s->{var a=auth.authorize(c);a.require("fin:report:view","fin:mapping:edit","fin:mapping:review");long book=books.resolve(a,selected,null);if(type!=null)ReportRules.type(type);var rows=db.queryForList("SELECT id FROM fin_report_template WHERE country_id=? AND book_id=?"+(type==null?"":" AND report_type=?")+" ORDER BY report_type,version_no DESC",type==null?new Object[]{a.requireCountry(),book}:new Object[]{a.requireCountry(),book,type.toUpperCase(Locale.ROOT)}).stream().map(row->template(a,book,((Number)row.get("id")).longValue(),false)).toList();return Map.of("records",rows,"total",rows.size(),"bookId",book);});}
    private Map<String,Object> template(Access a,long book,long id,boolean lock){var rows=db.queryForList("SELECT * FROM fin_report_template WHERE country_id=? AND book_id=? AND id=?"+(lock?" FOR UPDATE":""),a.requireCountry(),book,id);if(rows.isEmpty())throw ApiException.notFound();var row=DbRows.camel(rows.getFirst());row.put("rule",row.remove("ruleCode"));var lines=db.queryForList("SELECT * FROM fin_report_template_line WHERE country_id=? AND book_id=? AND template_id=? ORDER BY seq",a.requireCountry(),book,id).stream().map(DbRows::camel).toList();for(var line:lines){line.put("terms",json.read(line.get("terms").toString(),List.class));line.put("accountIds",db.queryForList("SELECT account_id FROM fin_report_line_account WHERE country_id=? AND book_id=? AND line_id=? ORDER BY account_id",Long.class,a.requireCountry(),book,line.get("id")));}row.put("lines",lines);return row;}
    private long commandBook(Access a,Long selected,Map<String,Object> body){Long explicit=body.get("bookId")==null?selected:Inputs.id(body.get("bookId"));if(selected!=null&&!selected.equals(explicit))throw ApiException.notFound();long book=books.resolve(a,explicit,null);gates.lock(a.requireCountry(),book,true);return book;}
    private void cas(Map<String,Object> body,Map<String,Object> row){if(Inputs.version(body)!=number(row,"version"))throw Inputs.conflict();}
    public Map<String,Object> save(RequestContext c,Long selected,Long id,Map<String,Object> body,String key){return tx.execute(s->{
        var a=auth.authorize(c);a.require("fin:mapping:edit");long book=commandBook(a,selected,body);String method=id==null?"POST":"PUT",path="/api/v1/fin/report-templates"+(id==null?"":"/"+id);
        return idem.execute(c,method,path,key,body,book,()->{
            Map<String,Object> old=id==null?null:template(a,book,id,true);if(old!=null){if(!"NEED_REVIEW".equals(old.get("status")))throw new ApiException(400,"FIN_REPORT_TEMPLATE_LOCKED","已复核报表模板须新增版本");cas(body,old);}
            var input=new LinkedHashMap<String,Object>();if(old!=null)input.putAll(old);input.putAll(body);String type=ReportRules.type(Inputs.required(input,"reportType"));if(type.equals("CASHFLOW"))throw Inputs.bad("现金流量表直接使用现金流项目事实");if(old!=null&&!type.equals(old.get("reportType")))throw Inputs.bad("版本内不能更换报表类型");String name=Inputs.required(input,"name"),rule=Inputs.required(input,"rule");if(name.length()>200)throw Inputs.bad("模板名称过长");var lines=ReportRules.validate(rule,input.get("lines"));
            for(var line:lines)for(long account:idList(line.get("accountIds")))if(db.queryForList("SELECT id FROM fin_account WHERE country_id=? AND book_id=? AND id=?",a.requireCountry(),book,account).isEmpty())throw ApiException.notFound();
            long result;if(old==null){int version=db.queryForObject("SELECT COALESCE(max(version_no),0)+1 FROM fin_report_template WHERE country_id=? AND book_id=? AND report_type=?",Integer.class,a.requireCountry(),book,type);result=db.queryForObject("INSERT INTO fin_report_template(country_id,book_id,report_type,name,rule_code,version_no,created_by) VALUES(?,?,?,?,?,?,?) RETURNING id",Long.class,a.requireCountry(),book,type,name,rule,version,a.userId());}
            else{result=id;db.update("UPDATE fin_report_template SET name=?,rule_code=?,version=version+1 WHERE country_id=? AND book_id=? AND id=?",name,rule,a.requireCountry(),book,result);db.update("DELETE FROM fin_report_line_account WHERE country_id=? AND book_id=? AND line_id IN(SELECT id FROM fin_report_template_line WHERE country_id=? AND book_id=? AND template_id=?)",a.requireCountry(),book,a.requireCountry(),book,result);db.update("DELETE FROM fin_report_template_line WHERE country_id=? AND book_id=? AND template_id=?",a.requireCountry(),book,result);}
            int seq=0;for(var line:lines){long lid=db.queryForObject("INSERT INTO fin_report_template_line(country_id,book_id,template_id,seq,code,name,formula,category,sign,terms) VALUES(?,?,?,?,?,?,?,?,?,?::jsonb) RETURNING id",Long.class,a.requireCountry(),book,result,++seq,line.get("code"),line.get("name"),line.get("formula"),line.get("category"),line.get("sign"),json.write(line.get("terms")));for(long account:idList(line.get("accountIds")))db.update("INSERT INTO fin_report_line_account(country_id,book_id,line_id,account_id) VALUES(?,?,?,?)",a.requireCountry(),book,lid,account);}
            var output=template(a,book,result,false);audit.append(c,"保存财务报表模板","fin-report-template",result,old,output);return output;
        },result->template(a,book,number(result,"id"),false));
    });}
    public Map<String,Object> review(RequestContext c,Long selected,long id,Map<String,Object> body,String key){return tx.execute(s->{
        var a=auth.authorize(c);a.require("fin:mapping:review");long book=commandBook(a,selected,body);return idem.execute(c,"POST","/api/v1/fin/report-templates/"+id+"/review",key,body,book,()->{
            var old=template(a,book,id,true);cas(body,old);if(!"NEED_REVIEW".equals(old.get("status")))throw new ApiException(400,"FIN_REPORT_TEMPLATE_LOCKED","只有待复核版本可生效");var lines=ReportRules.validate(old.get("rule").toString(),old.get("lines"));
            if("ACCOUNT_MAP_V1".equals(old.get("rule"))){var codes=new HashSet<String>();for(var line:lines)codes.add(line.get("code").toString());if(!codes.containsAll("BALANCE_SHEET".equals(old.get("reportType"))?Set.of("ASSET","LIABILITY","EQUITY","RETAINED_PROFIT"):Set.of("PROFIT")))throw Inputs.bad("报表缺少资产负债平衡行或利润合计行");}
            db.update("UPDATE fin_report_template SET status='RETIRED',version=version+1 WHERE country_id=? AND book_id=? AND report_type=? AND status='ACTIVE'",a.requireCountry(),book,old.get("reportType"));db.update("UPDATE fin_report_template SET status='ACTIVE',reviewed_by=?,reviewed_at=clock_timestamp(),version=version+1 WHERE country_id=? AND book_id=? AND id=?",a.userId(),a.requireCountry(),book,id);var result=template(a,book,id,false);audit.append(c,"复核财务报表模板","fin-report-template",id,old,result);return result;
        },result->template(a,book,number(result,"id"),false));
    });}
}
