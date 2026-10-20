package com.hs.jxc.inv.controller;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContextHolder;
import com.hs.jxc.inv.service.InventoryDocuments;
import java.util.Map;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/inv")
public class InventoryController {
 private final InventoryDocuments service;public InventoryController(InventoryDocuments service){this.service=service;}
 @GetMapping({"/stocks","/txns","/reservations","/freezes","/transfers","/stocktakes","/limits","/alerts"}) public ApiEnvelope query(jakarta.servlet.http.HttpServletRequest request,@RequestParam Map<String,String> q){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.query(c,request.getRequestURI().substring(request.getRequestURI().lastIndexOf('/')+1),q),c.traceId());}
 @PutMapping("/limits") public ApiEnvelope limits(@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.saveLimits(c,b,key),c.traceId());}
 @GetMapping("/stocks/{warehouseId}/{productId}/batches") public ApiEnvelope batches(@PathVariable long warehouseId,@PathVariable long productId){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.batches(c,Inputs.id(warehouseId),Inputs.id(productId)),c.traceId());}
 @GetMapping("/transfers/{id}") public ApiEnvelope transfer(@PathVariable long id){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.detail(c,"transfer",Inputs.id(id)),c.traceId());}
 @GetMapping("/stocktakes/{id}") public ApiEnvelope stocktake(@PathVariable long id){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.detail(c,"stocktake",Inputs.id(id)),c.traceId());}
 @PostMapping("/transfers") public ApiEnvelope createTransfer(@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.create(c,"transfer",b,key),c.traceId());}
 @PutMapping("/transfers/{id}") public ApiEnvelope updateTransfer(@PathVariable long id,@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.action(c,"transfer",Inputs.id(id),"edit",b,key),c.traceId());}
 @PostMapping("/stocktakes") public ApiEnvelope createStocktake(@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.create(c,"stocktake",b,key),c.traceId());}
 @PostMapping("/transfers/{id}/{action:submit|ship|receive|close|void}") public ApiEnvelope transferAction(@PathVariable long id,@PathVariable String action,@RequestBody(required=false) Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.action(c,"transfer",Inputs.id(id),action,b==null?Map.of():b,key),c.traceId());}
 @PostMapping("/stocktakes/{id}/{action:start|submit|post|cancel}") public ApiEnvelope stocktakeAction(@PathVariable long id,@PathVariable String action,@RequestBody(required=false) Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.action(c,"stocktake",Inputs.id(id),action,b==null?Map.of():b,key),c.traceId());}
 @PutMapping("/stocktakes/{id}/lines") public ApiEnvelope count(@PathVariable long id,@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.action(c,"stocktake",Inputs.id(id),"lines",b,key),c.traceId());}
 @PostMapping("/freezes") public ApiEnvelope freeze(@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.freeze(c,null,b,key).get("records"),c.traceId());}
 @PostMapping("/freezes/{id}/release") public ApiEnvelope unfreeze(@PathVariable long id,@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.freeze(c,Inputs.id(id),b,key),c.traceId());}
}
