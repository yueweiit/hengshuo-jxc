package com.hs.jxc.sys.imports;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContextHolder;
import java.util.Map;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/v1/sys")
public class ImportController {
 private final ImportService service;public ImportController(ImportService service){this.service=service;}
 @GetMapping("/import-types") public ApiEnvelope types(){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.types(c),c.traceId());}
 @GetMapping("/import-templates/{type}") public ApiEnvelope template(@PathVariable String type){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.template(c,type),c.traceId());}
 @GetMapping("/imports") public ApiEnvelope list(){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.list(c),c.traceId());}
 @PostMapping("/imports") public ApiEnvelope create(@RequestBody Map<String,Object> body){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.create(c,body),c.traceId());}
 @GetMapping({"/imports/{id}","/imports/{id}/errors"}) public ApiEnvelope detail(@PathVariable long id){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.detail(c,Inputs.id(id)),c.traceId());}
 @PostMapping("/imports/{id}/confirm") public ApiEnvelope confirm(@PathVariable long id,@RequestHeader(value="Idempotency-Key",required=false) String key,@RequestBody(required=false) Map<String,Object> body){if(body!=null&&!body.isEmpty())throw Inputs.bad("确认时不能修改已预校验内容，请重新预校验");var c=RequestContextHolder.require();return ApiEnvelope.ok(service.confirm(c,Inputs.id(id),key),c.traceId());}
 @PostMapping("/imports/{id}/cancel") public ApiEnvelope cancel(@PathVariable long id){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.cancel(c,Inputs.id(id)),c.traceId());}
}
