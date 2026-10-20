package com.hs.jxc.cst.profit;

import com.hs.jxc.common.api.ApiEnvelope;
import com.hs.jxc.common.context.RequestContextHolder;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
public class ProfitController {
    private final ProfitService profits;
    public ProfitController(ProfitService profits){this.profits=profits;}
    @GetMapping("/cst/profit") public ApiEnvelope profit(@RequestParam Map<String,String> params){var c=RequestContextHolder.require();return ApiEnvelope.ok(profits.query(c,params),c.traceId());}
    @GetMapping("/ai/history") public ApiEnvelope history(){var c=RequestContextHolder.require();return ApiEnvelope.ok(profits.history(c),c.traceId());}
    @PostMapping("/ai/analysis") public ApiEnvelope analysis(@RequestBody Map<String,Object> body){var c=RequestContextHolder.require();return ApiEnvelope.ok(profits.analysis(c,body),c.traceId());}
    @GetMapping("/ai/analysis/{id}") public ApiEnvelope missingHistory(@PathVariable long id){var c=RequestContextHolder.require();profits.history(c);throw com.hs.jxc.common.api.ApiException.notFound();}
}
