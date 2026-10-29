package com.hs.jxc.sys.integrations;
import com.hs.jxc.common.api.ApiEnvelope;
import com.hs.jxc.common.context.RequestContextHolder;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController @RequestMapping("/api/v1/sys/external-services")
public class ExternalServiceController {
    private final ExternalServiceConfig config;private final ExternalServiceProbe probe;
    public ExternalServiceController(ExternalServiceConfig config,ExternalServiceProbe probe){this.config=config;this.probe=probe;}
    @GetMapping public ApiEnvelope get(){var ctx=RequestContextHolder.require();return ApiEnvelope.ok(config.get(ctx),ctx.traceId());}
    @PutMapping("/{service}") public ApiEnvelope save(@PathVariable String service,@RequestBody Map<String,Object> body){var ctx=RequestContextHolder.require();return ApiEnvelope.ok(config.save(ctx,service,body),ctx.traceId());}
    @PostMapping("/{service}/test") public ApiEnvelope test(@PathVariable String service,@RequestBody Map<String,Object> body){var ctx=RequestContextHolder.require();return ApiEnvelope.ok(probe.test(ctx,service,body),ctx.traceId());}
}
