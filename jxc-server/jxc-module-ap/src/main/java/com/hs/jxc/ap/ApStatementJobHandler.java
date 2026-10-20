package com.hs.jxc.ap;
import com.hs.jxc.common.api.*;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.*;
import java.util.*;
import org.springframework.stereotype.Component;
@Component
public class ApStatementJobHandler implements JobHandler {
 private final PayablesService ap;public ApStatementJobHandler(PayablesService ap){this.ap=ap;}
 public String kind(){return "AP_STATEMENT_EXPORT";}
 public void authorize(Access a,long book,Map<String,Object> request){a.require("ap:statement:view");a.require("ap:statement:export");ap.statementSnapshot(a,book,Inputs.id(request.get("statementId")));}
 public Map<String,Object> execute(Access a,long book,Map<String,Object> request){authorize(a,book,request);return ap.statementSnapshot(a,book,Inputs.id(request.get("statementId")));}
 @SuppressWarnings("unchecked")public Map<String,Object> download(Access a,long book,Map<String,Object> result){if(Inputs.id(result.get("bookId"))!=book)throw ApiException.notFound();authorize(a,book,Map.of("statementId",result.get("id")));var visible=ap.maskStatement(a,result);var metadata=new LinkedHashMap<String,Object>(visible);var rows=(List<Map<String,Object>>)metadata.remove("detailSnapshot");return CsvFiles.file("ap-statement-"+result.get("id")+".csv",metadata,rows==null?List.of():rows);}
}
