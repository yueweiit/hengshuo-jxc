package com.hs.jxc.sys.controller;

import com.hs.jxc.common.api.ApiEnvelope;
import com.hs.jxc.common.context.RequestContextHolder;
import com.hs.jxc.sys.service.AuditQueryService;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/sys/audit-logs")
public class AuditQueryController {
    private final AuditQueryService service;
    public AuditQueryController(AuditQueryService service) { this.service=service; }
    @GetMapping public ApiEnvelope list(@RequestParam Map<String,String> query) {
        var context=RequestContextHolder.require();
        return ApiEnvelope.ok(service.list(context,query),context.traceId());
    }
}
