package com.hs.jxc.ap;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContextHolder;
import java.util.Map;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/ap/cost-assignments")
public class CostPayableBasisController {
    private final CostPayableBasisService service;
    public CostPayableBasisController(CostPayableBasisService service){this.service=service;}
    @GetMapping("/{costId}") public ApiEnvelope get(@PathVariable long costId){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.get(c,Inputs.id(costId)),c.traceId());}
    @PutMapping("/{costId}") public ApiEnvelope save(@PathVariable long costId,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.save(c,Inputs.id(costId),body,key),c.traceId());}
}
