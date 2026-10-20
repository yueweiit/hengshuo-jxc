package com.hs.jxc.sys.controller;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import com.hs.jxc.sys.service.DocumentGovernanceService;
import java.util.*;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/sys")
public class DocumentGovernanceController {
 private final DocumentGovernanceService service;public DocumentGovernanceController(DocumentGovernanceService service){this.service=service;}
 private RequestContext c(){return RequestContextHolder.require();}private ApiEnvelope ok(Object value){return ApiEnvelope.ok(value,c().traceId());}
 @GetMapping("/doc-watchers") public ApiEnvelope watchers(@RequestParam Map<String,String>q){return ok(service.watchers(c(),q));}
 @GetMapping("/doc-watchers/{id}") public ApiEnvelope watcher(@PathVariable long id){return ok(service.watcher(c(),Inputs.id(id)));}
 @PostMapping("/doc-watchers") public ApiEnvelope create(@RequestBody Map<String,Object>b){return ok(service.saveWatcher(c(),null,b));}
 @PutMapping("/doc-watchers/{id}") public ApiEnvelope update(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(service.saveWatcher(c(),Inputs.id(id),b));}
 @PostMapping("/doc-watchers/{id}/enable") public ApiEnvelope enable(@PathVariable long id){return ok(service.toggleWatcher(c(),Inputs.id(id),true));}
 @PostMapping("/doc-watchers/{id}/disable") public ApiEnvelope disable(@PathVariable long id){return ok(service.toggleWatcher(c(),Inputs.id(id),false));}
 @GetMapping("/delegations") public ApiEnvelope delegations(@RequestParam Map<String,String>q){return ok(service.delegations(c(),q));}
 @PostMapping("/delegations") public ApiEnvelope delegate(@RequestBody Map<String,Object>b){return ok(service.delegate(c(),b));}
 @PostMapping("/delegations/{id}/revoke") public ApiEnvelope revoke(@PathVariable long id){return ok(service.revoke(c(),Inputs.id(id)));}
 @DeleteMapping("/delegations/{id}") public ApiEnvelope remove(@PathVariable long id){return ok(service.revoke(c(),Inputs.id(id)));}
}
