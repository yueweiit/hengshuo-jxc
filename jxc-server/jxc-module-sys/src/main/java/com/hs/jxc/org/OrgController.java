package com.hs.jxc.org;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/v1/org")
public class OrgController {
    private final OrgService service;
    public OrgController(OrgService service){this.service=service;}
    private RequestContext ctx(){return RequestContextHolder.require();}
    private ApiEnvelope ok(Object data){return ApiEnvelope.ok(data,ctx().traceId());}
    @GetMapping("/{kind:entities|stores|warehouses}") public ApiEnvelope list(@PathVariable String kind,@RequestParam Map<String,String> q){return ok(service.list(ctx(),kind,q));}
    @GetMapping("/{kind:entities|stores|warehouses}/{id}") public ApiEnvelope get(@PathVariable String kind,@PathVariable long id){return ok(service.get(ctx(),kind,id));}
    @PostMapping("/{kind:entities|stores|warehouses}") public ApiEnvelope create(@PathVariable String kind,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(service.create(ctx(),kind,body,key));}
    @PutMapping("/{kind:entities|stores|warehouses}/{id}") public ApiEnvelope update(@PathVariable String kind,@PathVariable long id,@RequestBody Map<String,Object> body){return ok(service.update(ctx(),kind,id,body));}
    @PostMapping("/{kind:entities|stores|warehouses}/{id}/enable") public ApiEnvelope enable(@PathVariable String kind,@PathVariable long id){return ok(service.toggle(ctx(),kind,id,true));}
    @PostMapping("/{kind:entities|stores|warehouses}/{id}/disable") public ApiEnvelope disable(@PathVariable String kind,@PathVariable long id){return ok(service.toggle(ctx(),kind,id,false));}
}
