package com.hs.jxc.fin.report;

import com.hs.jxc.common.api.Inputs;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.JobHandler;
import static com.hs.jxc.sys.jobs.CsvFiles.cell;
import java.util.*;
import org.springframework.stereotype.Component;

/** Uses the shared SYS outbox job; report facts and download authorization remain module owned. */
@Component
public class FinancialReportJobHandler implements JobHandler {
    private final ReportService reports;
    private final com.hs.jxc.fin.service.ExportPeriodContext context;
    public FinancialReportJobHandler(ReportService reports,com.hs.jxc.fin.service.ExportPeriodContext context){this.reports=reports;this.context=context;}
    @Override public String kind(){return "FIN_REPORT_EXPORT";}
    @Override public void authorize(Access a,long book,Map<String,Object> request){reports.authorizeExport(a,book,request);}
    @Override public Map<String,Object> captureRequest(Access a,long book,Map<String,Object> request){authorize(a,book,request);return context.capture(a,book,request,"REPORT");}
    @Override public Map<String,Object> execute(Access a,long book,Map<String,Object> request){context.verify(a,book,request,"REPORT");return reports.exportSnapshot(a,book,request);}
    @Override public Map<String,Object> download(Access a,long book,Map<String,Object> result){
        if(Inputs.id(result.get("bookId"))!=book)throw com.hs.jxc.common.api.ApiException.notFound();
        authorize(a,book,Map.of("periodId",result.get("periodId"),"type",result.get("type")));
        var visible=reports.mask(a,result);var lines=ReportRules.maps(visible.get("lines"));boolean amounts=lines.stream().anyMatch(line->line.containsKey("amount"));
        var csv=new StringBuilder("\uFEFF");csv.append("报表类型,账套,期间,币种,来源,结账代次,来源指纹\r\n").append(cell(visible.get("type"))).append(',').append(cell(book)).append(',').append(cell(visible.get("periodName"))).append(',').append(cell(visible.get("currency"))).append(',').append(cell(visible.get("source"))).append(',').append(cell(visible.get("closeGeneration"))).append(',').append(cell(visible.get("sourceFingerprint"))).append("\r\n项目代码,项目名称");if(amounts)csv.append(",金额");csv.append("\r\n");
        for(var line:lines){csv.append(cell(line.get("code"))).append(',').append(cell(line.get("name")));if(amounts)csv.append(',').append(cell(line.get("amount")));csv.append("\r\n");}
        String filename="financial-report-"+ReportRules.type(visible.get("type").toString())+"-"+Inputs.id(visible.get("periodId"))+".csv";
        return Map.of("filename",filename,"content",csv.toString(),"contentType","text/csv; charset=UTF-8");
    }
}
