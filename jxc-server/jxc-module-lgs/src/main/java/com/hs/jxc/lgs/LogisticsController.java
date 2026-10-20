package com.hs.jxc.lgs;
import com.hs.jxc.common.api.*;import com.hs.jxc.common.context.*;import java.util.*;import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/lgs")
public class LogisticsController {
 private final LogisticsService s;public LogisticsController(LogisticsService s){this.s=s;}private RequestContext c(){return RequestContextHolder.require();}private ApiEnvelope ok(Object d){return ApiEnvelope.ok(d,c().traceId());}
 @GetMapping("/{kind:shipments|holds|deliveries|receipts|fees|discrepancies|transships}")public ApiEnvelope list(@PathVariable String kind){return ok(s.list(c(),kind));}
 @GetMapping("/{kind:shipments|holds|deliveries|receipts|fees|discrepancies|transships}/{id}")public ApiEnvelope get(@PathVariable String kind,@PathVariable long id){return ok(s.get(c(),kind,Inputs.id(id)));}
 @PostMapping("/{kind:shipments|holds|deliveries|receipts|fees|transships}")public ApiEnvelope create(@PathVariable String kind,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.create(c(),kind,b,key));}
 @PutMapping("/{kind:shipments|holds|deliveries|receipts|fees}/{id}")public ApiEnvelope update(@PathVariable String kind,@PathVariable long id,@RequestBody Map<String,Object>b){return ok(s.update(c(),kind,Inputs.id(id),b));}
 @PostMapping("/{kind:shipments|holds|deliveries|receipts|fees|discrepancies}/{id}/{action:submit|dispatch|confirm|release|void|resolve|nodes}")public ApiEnvelope action(@PathVariable String kind,@PathVariable long id,@PathVariable String action,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.action(c(),kind,Inputs.id(id),action,b==null?Map.of():b,key));}
 @GetMapping("/shipments/{id}/quantities")public ApiEnvelope quantities(@PathVariable long id){return ok(s.quantities(c(),Inputs.id(id)));}
 @GetMapping("/shipments/{id}/related")public ApiEnvelope related(@PathVariable long id){return ok(s.related(c(),Inputs.id(id)));}
 @PostMapping("/shipments/{id}/nodes/{eventId}/correct")public ApiEnvelope correct(@PathVariable long id,@PathVariable long eventId,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.correctNode(c(),Inputs.id(id),Inputs.id(eventId),b,key));}
 @GetMapping("/in-transit")public ApiEnvelope inTransit(){return ok(s.inTransit(c()));}
}
