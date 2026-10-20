package com.hs.jxc.md;
import com.hs.jxc.common.api.*;import com.hs.jxc.common.context.RequestContextHolder;
import java.util.Map;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/md")
public class CustomerMasterController {
 private final CustomerMasterService service;public CustomerMasterController(CustomerMasterService service){this.service=service;}
 @GetMapping({"/customers","/customer-groups","/customer-levels"}) public ApiEnvelope list(jakarta.servlet.http.HttpServletRequest request,@RequestParam Map<String,String> q){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.list(c,kind(request),q),c.traceId());}
 @GetMapping("/{kind:customers|customer-groups|customer-levels}/{id}") public ApiEnvelope get(@PathVariable String kind,@PathVariable long id){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.get(c,kind,Inputs.id(id)),c.traceId());}
 @PostMapping({"/customers","/customer-groups","/customer-levels"}) public ApiEnvelope create(jakarta.servlet.http.HttpServletRequest request,@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.save(c,kind(request),null,b,key),c.traceId());}
 @PutMapping("/{kind:customers|customer-groups|customer-levels}/{id}") public ApiEnvelope update(@PathVariable String kind,@PathVariable long id,@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.save(c,kind,Inputs.id(id),b,key),c.traceId());}
 @PostMapping("/{kind:customers|customer-groups|customer-levels}/{id}/{action:enable|disable}") public ApiEnvelope toggle(@PathVariable String kind,@PathVariable long id,@PathVariable String action,@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.toggle(c,kind,Inputs.id(id),action.equals("enable"),b,key),c.traceId());}
 @GetMapping("/customers/{customer}/banks") public ApiEnvelope banks(@PathVariable long customer){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.banks(c,Inputs.id(customer)),c.traceId());}
 @PostMapping("/customers/{customer}/banks") public ApiEnvelope bankCreate(@PathVariable long customer,@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.saveBank(c,Inputs.id(customer),null,b,key),c.traceId());}
 @PutMapping("/customers/{customer}/banks/{id}") public ApiEnvelope bankUpdate(@PathVariable long customer,@PathVariable long id,@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false) String key){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.saveBank(c,Inputs.id(customer),Inputs.id(id),b,key),c.traceId());}
 private static String kind(jakarta.servlet.http.HttpServletRequest r){return r.getRequestURI().substring(r.getRequestURI().lastIndexOf('/')+1);}
}
