package com.hs.jxc.pur;
import com.hs.jxc.common.api.ApiEnvelope;
import java.util.*;
import org.springframework.web.bind.annotation.*;
/** 只接收短期任务凭证；不提供任意查询、商品或采购写入工具。 */
@RestController
@RequestMapping("/internal/purchase-import/tasks/{taskId}")
public class PurchaseImportMatchToolController {
 private final PurchaseImportMatchService matches;public PurchaseImportMatchToolController(PurchaseImportMatchService matches){this.matches=matches;}
 @PostMapping("/catalog-search") public ApiEnvelope catalog(@PathVariable UUID taskId,@RequestHeader(value="X-Purchase-Task",defaultValue="")String token,@RequestBody Map<String,Object> body){return ApiEnvelope.ok(matches.catalogSearch(taskId,token,body),UUID.randomUUID().toString());}
 @PostMapping("/result") public ApiEnvelope result(@PathVariable UUID taskId,@RequestHeader(value="X-Purchase-Task",defaultValue="")String token,@RequestBody Map<String,Object> body){return ApiEnvelope.ok(matches.result(taskId,token,body),UUID.randomUUID().toString());}
}
