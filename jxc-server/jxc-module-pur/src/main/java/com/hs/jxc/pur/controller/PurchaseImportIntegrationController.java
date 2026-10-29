package com.hs.jxc.pur.controller;
import com.hs.jxc.pur.service.impl.PurchaseImportIntegrationService;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController @RequestMapping("/internal/purchase-import/tasks/{taskId}")
public class PurchaseImportIntegrationController {
    private final PurchaseImportIntegrationService service;
    public PurchaseImportIntegrationController(PurchaseImportIntegrationService service){this.service=service;}
    @PostMapping("/fields") public Map<String,Object> fields(@PathVariable UUID taskId,@RequestHeader(value="X-Purchase-Task",defaultValue="")String credential,@RequestBody Map<String,Object> body){return service.fields(taskId,credential,body);}
    @PostMapping("/model") public Map<String,Object> model(@PathVariable UUID taskId,@RequestHeader(value="X-Purchase-Task",defaultValue="")String credential,@RequestBody Map<String,Object> body){return service.model(taskId,credential,body);}
}
