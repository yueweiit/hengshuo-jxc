package com.hs.jxc.ar;
import com.hs.jxc.common.api.*;import com.hs.jxc.common.context.*;import java.util.*;import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/ar")
public class ReceivablesController {
 @org.springframework.beans.factory.annotation.Autowired private com.hs.jxc.sys.jobs.JobApi jobs;
 @PostMapping("/statements/export") public ApiEnvelope export(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.exportStatements(c(),b,key,jobs));}

 private final ReceivablesService s;public ReceivablesController(ReceivablesService s){this.s=s;}private RequestContext c(){return RequestContextHolder.require();}private ApiEnvelope ok(Object data){return ApiEnvelope.ok(data,c().traceId());}
 @GetMapping("/{kind:receipts|receivables|credit-notes|writeoffs|statements|credit-rules}")public ApiEnvelope list(@PathVariable String kind,@RequestParam Map<String,String>q){return ok(s.list(c(),kind,q));}
 @PostMapping("/receipts")public ApiEnvelope receipt(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.createReceipt(c(),b,key));}
 @GetMapping("/receipts/order-context/{id}")public ApiEnvelope receiptOrderContext(@PathVariable long id){return ok(s.receiptOrderContext(c(),Inputs.id(id)));}
 @PostMapping("/receipts/{id}/{action:confirm|reject|void}")public ApiEnvelope receiptAction(@PathVariable long id,@PathVariable String action,@RequestBody(required=false)Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.receiptAction(c(),Inputs.id(id),action,b==null?Map.of():b,key));}
 @PostMapping("/writeoffs")public ApiEnvelope writeoff(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.writeoff(c(),b,key));}
 @PostMapping("/writeoffs/{id}/reverse")public ApiEnvelope reverse(@PathVariable long id,@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.reverse(c(),Inputs.id(id),b,key));}
 @PostMapping("/credit-rules")public ApiEnvelope createRule(@RequestBody Map<String,Object>b){return ok(s.saveRule(c(),null,b));}
 @PutMapping("/credit-rules/{id}")public ApiEnvelope editRule(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(s.saveRule(c(),Inputs.id(id),b));}
 @PostMapping("/credit-rules/{id}/preview-impact")public ApiEnvelope preview(@PathVariable long id){return ok(s.previewRule(c(),Inputs.id(id)));}
 @GetMapping("/customers/{id}/{view:credit|balances|timeline}")public ApiEnvelope customer(@PathVariable long id,@PathVariable String view,@RequestParam Map<String,String>q){return ok(s.customerView(c(),Inputs.id(id),view,q));}
 @PostMapping("/statements")public ApiEnvelope statement(@RequestBody Map<String,Object>b,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(s.statement(c(),b,key));}
 @GetMapping("/store-receipts")public ApiEnvelope store(@RequestParam Map<String,String>q){return ok(s.storeReceipts(c(),q));}
}
