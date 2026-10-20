package com.hs.jxc.fin.closing;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/fin/periods")
public class ClosingController {
    private final ClosingService closing;
    public ClosingController(ClosingService closing){this.closing=closing;}
    private RequestContext c(){return RequestContextHolder.require();}
    private ApiEnvelope ok(Object value){return ApiEnvelope.ok(value,c().traceId());}
    @PostMapping("/{id}/close-check") public ApiEnvelope check(@PathVariable long id,@RequestBody(required=false)Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(closing.check(c(),id,b==null?Map.of():b,key));}
    @PostMapping("/{id}/waive") public ApiEnvelope waive(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(closing.waive(c(),id,b,key));}
    @PostMapping("/{id}/close") public ApiEnvelope close(@PathVariable long id,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(closing.close(c(),id,b==null?Map.of():b,key));}
    @GetMapping("/{id}/reopen-impact") public ApiEnvelope impact(@PathVariable long id,@RequestParam(required=false)Long bookId){return ok(closing.impact(c(),id,bookId));}
    @PostMapping("/{id}/reopen") public ApiEnvelope reopen(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(closing.reopen(c(),id,b,key));}
}
