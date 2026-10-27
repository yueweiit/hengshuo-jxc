package com.hs.jxc.sal;
import com.hs.jxc.common.api.*;import com.hs.jxc.common.context.*;import java.util.*;import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/sal")
public class SalesController {
 private final SalesService s;public SalesController(SalesService s){this.s=s;}private RequestContext c(){return RequestContextHolder.require();}private ApiEnvelope ok(Object d){return ApiEnvelope.ok(d,c().traceId());}
 @GetMapping("/orders")public ApiEnvelope orders(@RequestParam Map<String,String>q){return ok(s.orders(c(),q));}
 @GetMapping("/orders/{id}")public ApiEnvelope get(@PathVariable long id){return ok(s.get(c(),Inputs.id(id)));}
 @PostMapping("/orders")public ApiEnvelope create(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.create(c(),b,key));}
 @PutMapping("/orders/{id}")public ApiEnvelope update(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(s.update(c(),Inputs.id(id),b));}
 @PutMapping("/orders/{id}/allocations")public ApiEnvelope allocations(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(s.allocations(c(),Inputs.id(id),b));}
 @PostMapping("/orders/{id}/submit")public ApiEnvelope submit(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.submit(c(),Inputs.id(id),b==null?Map.of():b,key));}
 @PostMapping("/orders/{id}/withdraw")public ApiEnvelope withdraw(@PathVariable long id){return ok(s.withdraw(c(),Inputs.id(id)));}
 @PostMapping("/orders/{id}/cancel-lines")public ApiEnvelope cancel(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.cancel(c(),Inputs.id(id),b,key,false));}
 @PostMapping("/orders/{id}/close")public ApiEnvelope close(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.cancel(c(),Inputs.id(id),b,key,true));}
 @GetMapping("/orders/{id}/outbound-check")public ApiEnvelope check(@PathVariable long id,@RequestParam long warehouseId){return ok(s.check(c(),Inputs.id(id),Inputs.id(warehouseId)));}
 @PostMapping("/orders/{id}/outbound-check")public ApiEnvelope checkSelection(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(s.checkSelection(c(),Inputs.id(id),b));}
 @GetMapping("/orders/{id}/timeline")public ApiEnvelope timeline(@PathVariable long id){return ok(s.timeline(c(),Inputs.id(id)));}
 @GetMapping("/prices")public ApiEnvelope prices(@RequestParam Map<String,String>q){return ok(s.prices(c(),q));}
 @GetMapping("/prices/resolve")public ApiEnvelope resolve(@RequestParam Map<String,String>q){return ok(s.resolvePrice(c(),q));}
 @PostMapping("/prices")public ApiEnvelope price(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.savePrice(c(),null,b,key));}
 @PutMapping("/prices/{id}")public ApiEnvelope priceUpdate(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.savePrice(c(),Inputs.id(id),b,key));}
 @GetMapping("/outbounds")public ApiEnvelope outbounds(@RequestParam Map<String,String>q){return ok(s.outbounds(c(),q));}
 @PostMapping("/outbounds")public ApiEnvelope outbound(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.createOutbound(c(),b,key));}
 @PostMapping("/outbounds/{id}/confirm")public ApiEnvelope confirm(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.confirmOutbound(c(),Inputs.id(id),b==null?Map.of():b,key));}
 @PostMapping("/outbounds/{id}/sign")public ApiEnvelope sign(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.sign(c(),Inputs.id(id),b,key));}
 @GetMapping("/store-daily")public ApiEnvelope daily(@RequestParam(required=false)Long storeId,@RequestParam(required=false)String date){return ok(s.storeDaily(c(),storeId,date==null?null:java.time.LocalDate.parse(date)));}
 @GetMapping("/signs")public ApiEnvelope signs(){return ok(s.signs(c()));}
 @PostMapping("/sign-diffs/{id}/resolve")public ApiEnvelope diff(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.resolveSign(c(),Inputs.id(id),b,key));}
}
