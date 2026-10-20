package com.hs.jxc.ap;
import com.hs.jxc.common.api.*;import com.hs.jxc.common.context.*;import java.util.*;import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/ap/recognition-rules")
public class PayableRecognitionController {
 private final PayableRecognitionService rules;public PayableRecognitionController(PayableRecognitionService rules){this.rules=rules;}
 @GetMapping("/{type}")public ApiEnvelope get(@PathVariable String type){var c=RequestContextHolder.require();return ApiEnvelope.ok(rules.get(c,type),c.traceId());}
 @PutMapping("/{type}")public ApiEnvelope save(@PathVariable String type,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(rules.save(c,type,b,key),c.traceId());}
}
