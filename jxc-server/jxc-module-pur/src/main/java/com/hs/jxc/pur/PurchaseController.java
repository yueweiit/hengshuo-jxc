package com.hs.jxc.pur;
import com.hs.jxc.common.api.*;import com.hs.jxc.common.context.*;import java.util.*;import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/pur")
public class PurchaseController {
 private final PurchaseService s;private final PurchaseOrderImportTemplate importTemplate;public PurchaseController(PurchaseService s,PurchaseOrderImportTemplate importTemplate){this.s=s;this.importTemplate=importTemplate;}private RequestContext c(){return RequestContextHolder.require();}private ApiEnvelope ok(Object d){return ApiEnvelope.ok(d,c().traceId());}
 @GetMapping("/orders/import-template")public ApiEnvelope importTemplate(){return ok(importTemplate.download(c()));}
 @GetMapping("/{kind:orders|domestic-receipts|export-nodes}")public ApiEnvelope list(@PathVariable String kind,@RequestParam Map<String,String>query){return ok(s.list(c(),kind,query));}
 @GetMapping("/{kind:orders|domestic-receipts|export-nodes}/{id}")public ApiEnvelope get(@PathVariable String kind,@PathVariable long id){return ok(s.get(c(),kind,Inputs.id(id)));}
 @PostMapping("/{kind:orders|domestic-receipts|export-nodes}")public ApiEnvelope create(@PathVariable String kind,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.create(c(),kind,b,key));}
 @PutMapping("/{kind:orders|domestic-receipts|export-nodes}/{id}")public ApiEnvelope update(@PathVariable String kind,@PathVariable long id,@RequestBody Map<String,Object>b){return ok(s.update(c(),kind,Inputs.id(id),b));}
 @PostMapping("/{kind:orders|domestic-receipts|export-nodes}/{id}/{action:submit|confirm|void|cancel-lines|close}")public ApiEnvelope action(@PathVariable String kind,@PathVariable long id,@PathVariable String action,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.action(c(),kind,Inputs.id(id),action,b==null?Map.of():b,key));}
 @PostMapping("/domestic-receipts/lines/{id}/convert")public ApiEnvelope convert(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.convert(c(),Inputs.id(id),b,key));}
 @GetMapping("/orders/{id}/progress")public ApiEnvelope progress(@PathVariable long id){return ok(s.progress(c(),Inputs.id(id)));}
 @GetMapping("/export-nodes/sources")public ApiEnvelope exportSources(){return ok(s.sources(c(),true));}
 @GetMapping("/shippable-sources")public ApiEnvelope sources(@RequestParam(required=false)Long excludeShipmentId){return ok(s.sources(c(),false,excludeShipmentId));}
}
