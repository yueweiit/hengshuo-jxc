package com.hs.jxc.fin.ledger;
import com.hs.jxc.common.api.*;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.*;
import java.util.*;
import org.springframework.stereotype.Component;
@Component
public class LedgerJobHandler implements JobHandler {
 private final LedgerService ledger;private final com.hs.jxc.fin.service.ExportPeriodContext context;public LedgerJobHandler(LedgerService ledger,com.hs.jxc.fin.service.ExportPeriodContext context){this.ledger=ledger;this.context=context;}
 public String kind(){return "FIN_LEDGER_EXPORT";}
 public void authorize(Access a,long book,Map<String,Object> request){ledger.authorizeExport(a,book,request);}
 public Map<String,Object> captureRequest(Access a,long book,Map<String,Object> request){authorize(a,book,request);return context.capture(a,book,request,"BALANCE");}
 private Long id(Map<String,Object> r,String name){return r.get(name)==null?null:Inputs.id(r.get(name));}
 public Map<String,Object> execute(Access a,long book,Map<String,Object> request){authorize(a,book,request);context.verify(a,book,request,"BALANCE");var r=new LinkedHashMap<>(ledger.ledgerFacts(a,book,Inputs.required(request,"type"),id(request,"periodId"),id(request,"accountId"),id(request,"fundAccountId"),Inputs.text(request,"auxKey",null)));var filters=new LinkedHashMap<>(request);filters.remove("_periodContext");r.put("filters",filters);return r;}
 @SuppressWarnings("unchecked")public Map<String,Object> download(Access a,long book,Map<String,Object> result){if(Inputs.id(result.get("bookId"))!=book)throw ApiException.notFound();var filters=(Map<String,Object>)result.get("filters");authorize(a,book,filters);var visible=ledger.maskExport(a,result);var rows=(List<Map<String,Object>>)visible.getOrDefault("lines",visible.getOrDefault("rows",List.of()));var metadata=new LinkedHashMap<String,Object>();for(String key:List.of("bookId","periodId","type","currency","source","snapshotId","closeGeneration"))if(visible.get(key)!=null)metadata.put(key,visible.get(key));metadata.put("filters",filters);return CsvFiles.file("ledger-"+filters.get("type")+"-"+result.get("periodId")+".csv",metadata,rows);}
}
