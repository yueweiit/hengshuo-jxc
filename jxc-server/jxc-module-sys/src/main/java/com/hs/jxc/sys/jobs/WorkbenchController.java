package com.hs.jxc.sys.jobs;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/v1/sys")
public class WorkbenchController {
    private final JobService jobs;private final WorkbenchService workbench;private final WorkerRuntime runtime;
    public WorkbenchController(JobService jobs,WorkbenchService workbench,WorkerRuntime runtime){this.jobs=jobs;this.workbench=workbench;this.runtime=runtime;}
    private RequestContext c(){return RequestContextHolder.require();}
    private ApiEnvelope ok(Object data){return ApiEnvelope.ok(data,c().traceId());}
    @GetMapping("/workbench/summary") public ApiEnvelope summary(){return ok(workbench.summary(c()));}
    @GetMapping("/todos") public ApiEnvelope todos(@RequestParam Map<String,String> q){return ok(workbench.todos(c(),q));}
    @GetMapping("/notifications") public ApiEnvelope notices(@RequestParam Map<String,String> q){return ok(jobs.notifications(c(),q));}
    @PostMapping("/notifications/{id}/read") public ApiEnvelope read(@PathVariable long id){return ok(jobs.readNotifications(c(),Inputs.id(id)));}
    @PostMapping("/notifications/read-all") public ApiEnvelope readAll(){return ok(jobs.readNotifications(c(),null));}
    @GetMapping("/jobs/worker-status")public ApiEnvelope workerStatus(){return ok(runtime.status(c()));}
    @GetMapping("/jobs") public ApiEnvelope jobs(@RequestParam Map<String,String> q){return ok(jobs.list(c(),q));}
    @PostMapping("/jobs") @SuppressWarnings("unchecked") public ApiEnvelope create(@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){if(!(b.getOrDefault("params",Map.of()) instanceof Map<?,?>))throw Inputs.bad("params必须是对象");return ok(jobs.enqueue(c(),Inputs.required(b,"jobType"),Inputs.id(b.get("bookId")),(Map<String,Object>)b.getOrDefault("params",Map.of()),key));}
    @GetMapping("/jobs/{id}") public ApiEnvelope job(@PathVariable long id){return ok(jobs.detail(c(),Inputs.id(id)));}
    @GetMapping("/jobs/{id}/download") public ApiEnvelope download(@PathVariable long id){return ok(jobs.download(c(),Inputs.id(id)));}
    @PostMapping("/jobs/{id}/retry") public ApiEnvelope retry(@PathVariable long id,@RequestHeader(value="Idempotency-Key",required=false) String key){return ok(jobs.retry(c(),Inputs.id(id),key));}
}
