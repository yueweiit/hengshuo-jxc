package com.hs.jxc.fin.accounting;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/fin")
public class AccountingController {
    private final AccountingService accounting;
    public AccountingController(AccountingService accounting){this.accounting=accounting;}
    private RequestContext c(){return RequestContextHolder.require();}
    private ApiEnvelope ok(Object value){return ApiEnvelope.ok(value,c().traceId());}
    private Map<String,Object> query(Map<String,String> raw){var q=new LinkedHashMap<String,Object>();raw.forEach((k,v)->{if(!v.isBlank())q.put(k,Set.of("bookId","periodId","eventId","page","size").contains(k)?Long.valueOf(v):v);});return q;}
    @GetMapping("/mapping-templates") public ApiEnvelope mappings(@RequestParam Map<String,String> q){return ok(accounting.mappings(c(),query(q)));}
    @GetMapping("/mapping-templates/{id}") public ApiEnvelope mapping(@PathVariable long id){return ok(accounting.mapping(c(),id));}
    @PostMapping("/mapping-templates") public ApiEnvelope create(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(accounting.saveMapping(c(),null,b,key));}
    @PutMapping("/mapping-templates/{id}") public ApiEnvelope update(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(accounting.saveMapping(c(),id,b,key));}
    @DeleteMapping("/mapping-templates/{id}") public ApiEnvelope delete(@PathVariable long id,@RequestParam long version,@RequestParam(required=false)Long bookId,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(accounting.deleteMapping(c(),id,bookId,Map.of("version",version),key));}
    @PostMapping("/mapping-templates/{id}/review") public ApiEnvelope review(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(accounting.review(c(),id,b,key));}
    @PostMapping("/mapping-templates/{id}/simulate") public ApiEnvelope simulate(@PathVariable long id,@RequestParam(required=false)Long eventId){return ok(accounting.simulate(c(),id,eventId));}
    @GetMapping("/events") public ApiEnvelope events(@RequestParam Map<String,String>q){return ok(accounting.events(c(),query(q)));}
    @PostMapping("/events/{id}/generate") public ApiEnvelope generate(@PathVariable long id,@RequestBody(required=false)Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){
        var input=body==null?Map.<String,Object>of():body; // Legacy callers intentionally send no body.
        if(!Set.of("bookId").containsAll(input.keySet()))throw Inputs.bad("凭证生成仅接受bookId，金额及映射取自原业务事件");
        Long selected=input.containsKey("bookId")?Inputs.id(input.get("bookId")):null;
        return ok(accounting.generate(c(),id,selected,key));
    }
    @GetMapping("/reconcile") public ApiEnvelope reconcile(@RequestParam Map<String,String>q){return ok(accounting.reconcile(c(),query(q)));}
}
