package com.hs.jxc.sys.controller;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import com.hs.jxc.sys.service.DocumentNumberService;
import org.springframework.web.bind.annotation.*;
import java.util.Map;
@RestController @RequestMapping("/api/v1/sys")
public class DocumentNumberController {
 private final DocumentNumberService service;public DocumentNumberController(DocumentNumberService service){this.service=service;}
 @GetMapping("/doc-number-rules") public ApiEnvelope list(){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.rules(c),c.traceId());}
 @PutMapping("/doc-number-rules/{type}") public ApiEnvelope save(@PathVariable String type,@RequestBody Map<String,Object>b){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.save(c,type,b),c.traceId());}
 @GetMapping("/countries/{countryId}/doc-number-rules") public ApiEnvelope countryRules(@PathVariable long countryId){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.rules(new RequestContext(c.userId(),Inputs.id(countryId),c.traceId(),c.tokenHash())),c.traceId());}
 @PutMapping("/countries/{countryId}/doc-number-rules/{type}") public ApiEnvelope countryRule(@PathVariable long countryId,@PathVariable String type,@RequestBody Map<String,Object>b){var c=RequestContextHolder.require();return ApiEnvelope.ok(service.save(new RequestContext(c.userId(),Inputs.id(countryId),c.traceId(),c.tokenHash()),type,b),c.traceId());}
}
