package com.hs.jxc.fin.report;

import com.hs.jxc.common.api.ApiEnvelope;
import com.hs.jxc.common.api.Inputs;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.*;
import com.hs.jxc.sys.jobs.JobApi;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.*;
import org.springframework.beans.factory.ObjectProvider;

@RestController
@RequestMapping("/api/v1/fin")
public class ReportController {
    private final ReportService reports;private final ObjectProvider<JobApi> jobs;
    public ReportController(ReportService reports,ObjectProvider<JobApi> jobs){this.reports=reports;this.jobs=jobs;}
    private RequestContext c(){return RequestContextHolder.require();}
    private ApiEnvelope ok(Object value){return ApiEnvelope.ok(value,c().traceId());}
    @GetMapping("/reports/{type}") public ApiEnvelope report(@PathVariable String type,@RequestParam(required=false)Long bookId,@RequestParam(required=false)Long periodId){return ok(reports.report(c(),bookId,periodId,type));}
    @PostMapping("/reports/{type}/export") public ApiEnvelope export(@PathVariable String type,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){long book=Inputs.id(body.get("bookId"));var request=new LinkedHashMap<String,Object>();request.put("periodId",Inputs.id(body.get("periodId")));request.put("type",ReportRules.type(type));var service=jobs.getIfAvailable();if(service==null)throw new ApiException(503,"SYS_JOB_UNAVAILABLE","导出任务服务尚不可用");return ok(service.enqueue(c(),"FIN_REPORT_EXPORT",book,request,key));}
    @GetMapping("/report-templates") public ApiEnvelope templates(@RequestParam(required=false)Long bookId,@RequestParam(required=false)String type){return ok(reports.templates(c(),bookId,type));}
    @PostMapping("/report-templates") public ApiEnvelope create(@RequestParam(required=false)Long bookId,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(reports.save(c(),bookId,null,body,key));}
    @PutMapping("/report-templates/{id}") public ApiEnvelope update(@PathVariable long id,@RequestParam(required=false)Long bookId,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(reports.save(c(),bookId,id,body,key));}
    @PostMapping("/report-templates/{id}/review") public ApiEnvelope review(@PathVariable long id,@RequestParam(required=false)Long bookId,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(reports.review(c(),bookId,id,body,key));}
}
