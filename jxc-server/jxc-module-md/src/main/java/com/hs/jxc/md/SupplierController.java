package com.hs.jxc.md;
import com.hs.jxc.common.api.*;import com.hs.jxc.common.context.*;import java.util.*;import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/md")
public class SupplierController {
 private final SupplierService service; public SupplierController(SupplierService s){service=s;} private RequestContext ctx(){return RequestContextHolder.require();}private ApiEnvelope ok(Object d){return ApiEnvelope.ok(d,ctx().traceId());}
 @GetMapping("/{kind:suppliers|logistics-providers|partners|expense-items}") public ApiEnvelope list(@PathVariable String kind){return ok(service.list(ctx(),kind));}
 @GetMapping("/{kind:suppliers|logistics-providers|partners|expense-items}/{id}") public ApiEnvelope get(@PathVariable String kind,@PathVariable long id){return ok(service.get(ctx(),kind,id));}
 @PostMapping("/{kind:suppliers|logistics-providers|partners|expense-items}") public ApiEnvelope create(@PathVariable String kind,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.save(ctx(),kind,null,b,key));}
 @PutMapping("/{kind:suppliers|logistics-providers|partners|expense-items}/{id}") public ApiEnvelope update(@PathVariable String kind,@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.save(ctx(),kind,id,b,key));}
 @PostMapping("/{kind:suppliers|logistics-providers|partners|expense-items}/{id}/enable") public ApiEnvelope enable(@PathVariable String kind,@PathVariable long id){return ok(service.toggle(ctx(),kind,id,true));}
 @PostMapping("/{kind:suppliers|logistics-providers|partners|expense-items}/{id}/disable") public ApiEnvelope disable(@PathVariable String kind,@PathVariable long id){return ok(service.toggle(ctx(),kind,id,false));}
 @GetMapping("/partners/{id}/banks")public ApiEnvelope banks(@PathVariable long id){return ok(service.banks(ctx(),id));}
}
