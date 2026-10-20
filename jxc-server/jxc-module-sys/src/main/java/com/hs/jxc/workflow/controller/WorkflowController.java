package com.hs.jxc.workflow.controller;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import com.hs.jxc.workflow.service.WorkflowService;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/wf")
public class WorkflowController {
    private final WorkflowService service;
    public WorkflowController(WorkflowService service){this.service=service;}
    private RequestContext ctx(){return RequestContextHolder.require();}
    private ApiEnvelope ok(Object data){return ApiEnvelope.ok(data,ctx().traceId());}
    @GetMapping("/rules")public ApiEnvelope rules(@RequestParam Map<String,String> q){return ok(service.rules(ctx(),q));}
    @GetMapping("/rules/{id}")public ApiEnvelope rule(@PathVariable long id){return ok(service.getRule(ctx(),Inputs.id(id)));}
    @GetMapping("/rules/{id}/versions")public ApiEnvelope versions(@PathVariable long id){return ok(service.versions(ctx(),Inputs.id(id)));}
    @PostMapping("/rules")public ApiEnvelope create(@RequestBody Map<String,Object>b){return ok(service.createRule(ctx(),b));}
    @PutMapping("/rules/{id}")public ApiEnvelope update(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(service.updateRule(ctx(),Inputs.id(id),b));}
    @PostMapping("/rules/{id}/enable")public ApiEnvelope enable(@PathVariable long id){return ok(service.toggleRule(ctx(),Inputs.id(id),true));}
    @PostMapping("/rules/{id}/disable")public ApiEnvelope disable(@PathVariable long id){return ok(service.toggleRule(ctx(),Inputs.id(id),false));}
    @GetMapping("/doc-types")public ApiEnvelope docTypes(){return ok(service.docTypes(ctx()));}
    @PutMapping("/doc-types/{docType}")public ApiEnvelope configure(@PathVariable String docType,@RequestBody Map<String,Object>b){return ok(service.configure(ctx(),docType,b));}
    @GetMapping("/tasks/mine")public ApiEnvelope tasks(@RequestParam Map<String,String> q){return ok(service.tasks(ctx(),q));}
    public record Comment(String comment){}
    @PostMapping("/tasks/{id}/approve")public ApiEnvelope approve(@PathVariable long id,@RequestBody(required=false)Comment b){return ok(service.approve(ctx(),Inputs.id(id),b==null?null:b.comment()));}
    @PostMapping("/tasks/{id}/reject")public ApiEnvelope reject(@PathVariable long id,@RequestBody Comment b){return ok(service.reject(ctx(),Inputs.id(id),b.comment()));}
    @GetMapping("/instances")public ApiEnvelope instances(@RequestParam String docType,@RequestParam long docId){return ok(service.instances(ctx(),docType,Inputs.id(docId)));}
    @PostMapping("/instances/{id}/withdraw")public ApiEnvelope withdraw(@PathVariable long id){return ok(service.withdraw(ctx(),Inputs.id(id)));}
}
