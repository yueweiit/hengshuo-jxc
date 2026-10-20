package com.hs.jxc.md;
import com.hs.jxc.common.api.*;import com.hs.jxc.common.context.*;import java.util.Map;import org.springframework.web.bind.annotation.*;
/** List GET remains owned by the existing MasterLookupController. */
@RestController @RequestMapping("/api/v1/md/fund-accounts")
public class FundAccountController {
 private final FundAccountService service;public FundAccountController(FundAccountService service){this.service=service;}private RequestContext c(){return RequestContextHolder.require();}private ApiEnvelope ok(Object d){return ApiEnvelope.ok(d,c().traceId());}
 @GetMapping("/{id}") public ApiEnvelope get(@PathVariable long id){return ok(service.get(c(),Inputs.id(id)));}
 @PostMapping("") public ApiEnvelope create(@RequestBody Map<String,Object>body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.save(c(),null,body,key));}
 @PutMapping("/{id}") public ApiEnvelope update(@PathVariable long id,@RequestBody Map<String,Object>body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.save(c(),Inputs.id(id),body,key));}
 @PostMapping("/{id}/{action:enable|disable}") public ApiEnvelope toggle(@PathVariable long id,@PathVariable String action,@RequestBody Map<String,Object>body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.toggle(c(),Inputs.id(id),action.equals("enable"),body,key));}
}
