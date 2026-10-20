package com.hs.jxc.ap;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import org.springframework.web.bind.annotation.*;
import java.util.*;
@RestController
@RequestMapping("/api/v1/ap")
public class PayablesController {
 private final PayablesService service;private final org.springframework.beans.factory.ObjectProvider<com.hs.jxc.sys.jobs.JobApi> jobs;public PayablesController(PayablesService service,org.springframework.beans.factory.ObjectProvider<com.hs.jxc.sys.jobs.JobApi> jobs){this.service=service;this.jobs=jobs;}
 private static Map<String,Object>safe(Map<String,Object>b){return b==null?Map.of():b;}
 private RequestContext c(){return RequestContextHolder.require();}private ApiEnvelope ok(Object value){return ApiEnvelope.ok(value,c().traceId());}
 @GetMapping("/{kind:bills|payments|prepayments|settlements|adjustments}") public ApiEnvelope list(@PathVariable String kind,@RequestParam Map<String,String> q){return ok(service.list(c(),kind,q));}
 @GetMapping("/{kind:bills|payments|prepayments|settlements|credit-notes|adjustments}/{id}") public ApiEnvelope get(@PathVariable String kind,@PathVariable long id){return ok(service.get(c(),kind,id));}
 @GetMapping("/credit-notes")public ApiEnvelope credits(){return ok(service.creditNotes(c()));}
 @GetMapping("/bill-sources")public ApiEnvelope sources(){return ok(service.billSources(c()));}
 @GetMapping("/partners/{id}/timeline")public ApiEnvelope timeline(@PathVariable long id){return ok(service.timeline(c(),id));}
 @GetMapping("/statements")public ApiEnvelope statements(@RequestParam Map<String,String>q){return ok(service.statements(c(),q));}
 @PostMapping({"/bills","/bills/from-sources"}) public ApiEnvelope bill(@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.createBill(c(),safe(b),key));}
 @PostMapping("/bills/{id}/confirm")public ApiEnvelope confirmBill(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.confirmBill(c(),id,safe(b),key));}
 @PostMapping("/bills/{id}/void")public ApiEnvelope voidBill(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.voidBill(c(),id,safe(b),key));}
 @PostMapping("/{kind:payments|prepayments}")public ApiEnvelope funding(@PathVariable String kind,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.createFunding(c(),kind,safe(b),key));}
 @PostMapping("/{kind:payments|prepayments}/{id}/confirm")public ApiEnvelope confirmFunding(@PathVariable String kind,@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.confirmFunding(c(),kind,id,safe(b),key));}
 @PostMapping("/settlements")public ApiEnvelope settle(@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.settle(c(),safe(b),key));}
 @PostMapping("/settlements/{id}/reverse")public ApiEnvelope reverse(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.reverse(c(),id,safe(b),key));}
 @PostMapping("/adjustments")public ApiEnvelope adjust(@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.adjustment(c(),safe(b),key));}
 @PostMapping("/adjustments/{id}/confirm")public ApiEnvelope confirmAdjustment(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.confirmAdjustment(c(),id,safe(b),key));}
 @GetMapping("/partners/{id}/balances")public ApiEnvelope balance(@PathVariable long id){return ok(service.balances(c(),id));}
 @PostMapping("/statements")public ApiEnvelope statement(@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.statement(c(),safe(b),key));}
 @PostMapping("/statements/{id}/export")public ApiEnvelope exportStatement(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){var handler=jobs.getIfAvailable();if(handler==null)throw new ApiException(503,"SYS_JOB_UNAVAILABLE","导出任务服务尚不可用");return ok(handler.enqueue(c(),"AP_STATEMENT_EXPORT",Inputs.id(b.get("bookId")),Map.of("statementId",id),key));}
 @GetMapping("/payables")public ApiEnvelope due(@RequestParam Map<String,String>q){return ok(service.payables(c(),q));}
}
