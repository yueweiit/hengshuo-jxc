package com.hs.jxc.ar;
import com.hs.jxc.common.api.*;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.*;
import java.util.*;
import org.springframework.stereotype.Component;
/** Existing saved statements only: exports never generate or overwrite a statement. */
@Component
public class ReceivablesStatementExport implements JobHandler {
 private final ReceivablesService receivables;public ReceivablesStatementExport(ReceivablesService receivables){this.receivables=receivables;}
 public String kind(){return "AR_STATEMENT_EXPORT";}
 public void authorize(Access a,long book,Map<String,Object> request){receivables.authorizeStatementExport(a,book,request);}
 public Map<String,Object> execute(Access a,long book,Map<String,Object> request){authorize(a,book,request);return Map.of("bookId",book,"filters",request,"rows",receivables.statementExportRows(a,book,request));}
 @SuppressWarnings("unchecked") public Map<String,Object> download(Access a,long book,Map<String,Object> result){if(Inputs.id(result.get("bookId"))!=book)throw ApiException.notFound();var filters=(Map<String,Object>)result.get("filters");authorize(a,book,filters);var rows=receivables.maskStatementExport(a,book,(List<Map<String,Object>>)(List<?>)result.get("rows"));return CsvFiles.file("customer-statements.csv",Map.of("bookId",book,"filters",filters),rows);}
}
