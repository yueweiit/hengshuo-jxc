package com.hs.jxc.inv.controller;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContextHolder;
import com.hs.jxc.inv.service.*;
import java.util.Map;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/inv")
public class InventoryAnalysisController {
 private final InventoryClassification analysis;private final ReplenishmentService replenish;
 public InventoryAnalysisController(InventoryClassification analysis,ReplenishmentService replenish){this.analysis=analysis;this.replenish=replenish;}
 private ApiEnvelope ok(Object data){return ApiEnvelope.ok(data,RequestContextHolder.require().traceId());}
 @GetMapping("/classify-rules") public ApiEnvelope rules(){return ok(analysis.rules(RequestContextHolder.require()));}
 @PostMapping("/classify-rules") public ApiEnvelope create(@RequestBody Map<String,Object>b){return ok(analysis.save(RequestContextHolder.require(),null,b));}
 @PutMapping("/classify-rules/{id}") public ApiEnvelope save(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(analysis.save(RequestContextHolder.require(),Inputs.id(id),b));}
 @PostMapping("/classify-rules/{id}/recalculate") public ApiEnvelope recalc(@PathVariable long id){return ok(analysis.recalculate(RequestContextHolder.require(),Inputs.id(id)));}
 @GetMapping("/classify-results") public ApiEnvelope results(@RequestParam Map<String,String> q){return ok(analysis.results(RequestContextHolder.require(),q));}
 @GetMapping("/classify-results/{id}/orders") public ApiEnvelope orders(@PathVariable long id){return ok(analysis.orders(RequestContextHolder.require(),Inputs.id(id)));}
 @GetMapping("/replenishments") public ApiEnvelope replenishments(){return ok(replenish.list(RequestContextHolder.require()));}
 @PostMapping("/replenishments") public ApiEnvelope request(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(replenish.create(RequestContextHolder.require(),b,key));}
 @PostMapping("/replenishments/suggest") public ApiEnvelope suggest(@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(replenish.suggest(RequestContextHolder.require(),key));}
 @PostMapping("/replenishments/{id}/{action:decide|link|close}") public ApiEnvelope action(@PathVariable long id,@PathVariable String action,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(replenish.action(RequestContextHolder.require(),Inputs.id(id),action,b,key));}
}
