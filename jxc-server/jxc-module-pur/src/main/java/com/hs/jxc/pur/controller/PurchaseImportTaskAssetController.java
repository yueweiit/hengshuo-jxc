package com.hs.jxc.pur.controller;
import com.hs.jxc.pur.service.*;

import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/** 独立任务凭证入口。无普通登录豁免业务功能；每次读取均回查租约和原请求者当前授权。 */
@RestController
public class PurchaseImportTaskAssetController {
    private final PurchaseImportTaskService tasks;
    public PurchaseImportTaskAssetController(PurchaseImportTaskService tasks){this.tasks=tasks;}
    @GetMapping("/internal/purchase-import/tasks/{taskId}/assets/{sourceId}")
    public ResponseEntity<byte[]> asset(@PathVariable UUID taskId,@PathVariable long sourceId,@RequestHeader(value="X-Purchase-Task",defaultValue="")String credential){return PurchaseImportController.binary(tasks.taskAsset(taskId,sourceId,credential));}
}
