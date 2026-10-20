package com.hs.jxc.rtn;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import org.springframework.web.bind.annotation.*;
import java.util.*;
@RestController
@RequestMapping("/api/v1/rtn")
public class ReturnsController {
 private final ReturnsService service;public ReturnsController(ReturnsService service){this.service=service;}
 private static Map<String,Object>safe(Map<String,Object>b){return b==null?Map.of():b;}
 private RequestContext c(){return RequestContextHolder.require();}private ApiEnvelope ok(Object v){return ApiEnvelope.ok(v,c().traceId());}
 @GetMapping("/{kind:sales|refunds|purchase|claims}")public ApiEnvelope list(@PathVariable String kind,@RequestParam Map<String,String>q){return ok(service.list(c(),kind,q));}
 @GetMapping("/{kind:sales|refunds|purchase|claims}/{id}")public ApiEnvelope get(@PathVariable String kind,@PathVariable long id){return ok(service.get(c(),kind,id));}
 @GetMapping("/sales/returnable")public ApiEnvelope returnable(@RequestParam long outboundId){return ok(service.returnable(c(),outboundId));}
 @GetMapping("/purchase/returnable")public ApiEnvelope purchaseSources(@RequestParam long poId,@RequestParam(defaultValue="DOMESTIC")String stage){return ok(service.purchaseReturnable(c(),poId,stage));}
 @PostMapping("/sales")public ApiEnvelope sales(@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.createSales(c(),safe(b),key));}
 @PostMapping("/sales/{id}/submit")public ApiEnvelope submit(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.submitSales(c(),id,safe(b),key));}
 @PostMapping("/sales/{id}/receive")public ApiEnvelope receive(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.receive(c(),id,safe(b),key));}
 @PostMapping("/sales/{id}/inspect")public ApiEnvelope inspect(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.inspect(c(),id,safe(b),key));}
 @PostMapping("/sales/{id}/settle")public ApiEnvelope settle(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.settleSales(c(),id,safe(b),key));}
 @PostMapping("/sales/{id}/settle/reverse")public ApiEnvelope reverse(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.reverseSales(c(),id,safe(b),key));}
 @PostMapping("/sales/{id}/cancel")public ApiEnvelope cancel(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.cancelSales(c(),id,safe(b),key));}
 @PostMapping("/refunds")public ApiEnvelope refund(@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.createRefund(c(),safe(b),key));}
 @PostMapping("/refunds/{id}/pay")public ApiEnvelope pay(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.payRefund(c(),id,safe(b),key));}
 @PostMapping("/refunds/{id}/cancel")public ApiEnvelope cancelRefund(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.cancelRefund(c(),id,safe(b),key));}
 @PostMapping("/purchase")public ApiEnvelope purchase(@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.createPurchase(c(),safe(b),key));}
 @PostMapping("/purchase/{id}/ship")public ApiEnvelope ship(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.shipPurchase(c(),id,safe(b),key));}
 @PostMapping("/claims")public ApiEnvelope claim(@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.createClaim(c(),safe(b),key));}
 @PostMapping("/claims/{id}/resolve")public ApiEnvelope resolve(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.resolveClaim(c(),id,safe(b),key));}
}
