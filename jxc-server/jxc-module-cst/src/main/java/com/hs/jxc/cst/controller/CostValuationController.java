package com.hs.jxc.cst.controller;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import com.hs.jxc.cst.service.CostValuationService;
import java.util.*;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/cst")
public class CostValuationController {
 private final CostValuationService service;
 public CostValuationController(CostValuationService service){this.service=service;}
 private ApiEnvelope result(java.util.function.Function<RequestContext,Object>f){var c=RequestContextHolder.require();return ApiEnvelope.ok(f.apply(c),c.traceId());}
 @PostMapping("/inbound-costs/{id}/confirm") public ApiEnvelope confirm(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return result(c->service.confirm(c,Inputs.id(id),b==null?Map.of():b,key));}
 @PostMapping("/inbound-costs/batch-confirm")public ApiEnvelope batch(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return result(c->service.batchConfirm(c,b,key));}
 @PostMapping("/allocations")public ApiEnvelope allocation(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return result(c->service.createAllocation(c,b,key));}
 @PostMapping("/allocations/{id}/{action:confirm|reverse}")public ApiEnvelope allocationAction(@PathVariable long id,@PathVariable String action,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return result(c->service.allocationAction(c,Inputs.id(id),action,b==null?Map.of():b,key));}
 @PostMapping("/adjustments")public ApiEnvelope adjustment(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return result(c->service.createAdjustment(c,b,key));}
 @PostMapping("/adjustments/{id}/confirm")public ApiEnvelope adjustmentConfirm(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return result(c->service.confirmAdjustment(c,Inputs.id(id),b==null?Map.of():b,key));}
 @PostMapping("/expenses")public ApiEnvelope expense(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return result(c->service.createExpense(c,b,key));}
 @GetMapping({"/allocations","/adjustments","/expenses"})public ApiEnvelope lists(jakarta.servlet.http.HttpServletRequest request,@RequestParam Map<String,String>q){String kind=request.getRequestURI().substring(request.getRequestURI().lastIndexOf('/')+1);return result(c->service.listFacts(c,kind,q));}
 @GetMapping("/batches/{id}/cost-trace")public ApiEnvelope trace(@PathVariable long id,@RequestParam Map<String,String>q){return result(c->service.trace(c,Inputs.id(id),q));}
}
