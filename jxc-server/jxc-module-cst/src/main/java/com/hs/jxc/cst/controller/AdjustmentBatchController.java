package com.hs.jxc.cst.controller;

import com.hs.jxc.common.api.ApiEnvelope;
import com.hs.jxc.common.context.RequestContextHolder;
import com.hs.jxc.cst.service.AdjustmentBatchQuery;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

/** Read-only selection for the existing cost adjustment command. */
@RestController
@RequestMapping("/api/v1/cst/adjustment-batches")
public class AdjustmentBatchController {
    private final AdjustmentBatchQuery query;
    public AdjustmentBatchController(AdjustmentBatchQuery query) { this.query = query; }

    @GetMapping
    public ApiEnvelope list(@RequestParam Map<String, String> filters) {
        var context = RequestContextHolder.require();
        return ApiEnvelope.ok(query.list(context, filters), context.traceId());
    }
}
