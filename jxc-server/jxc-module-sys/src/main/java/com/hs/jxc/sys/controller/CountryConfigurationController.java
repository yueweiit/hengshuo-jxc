package com.hs.jxc.sys.controller;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import com.hs.jxc.sys.service.CountryConfigurationService;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController @RequestMapping("/api/v1/sys")
public class CountryConfigurationController {
 private final CountryConfigurationService service;public CountryConfigurationController(CountryConfigurationService service){this.service=service;}
 private RequestContext c(){return RequestContextHolder.require();}private ApiEnvelope ok(Object d){return ApiEnvelope.ok(d,c().traceId());}
 @GetMapping("/countries") public ApiEnvelope countries(){return ok(service.countries(c()));}
 @GetMapping("/countries/{id}") public ApiEnvelope country(@PathVariable long id){return ok(service.get(c(),Inputs.id(id)));}
 @PutMapping("/countries/{id}/params") public ApiEnvelope params(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(service.params(c(),Inputs.id(id),b));}
 @GetMapping("/countries/{id}/readiness") public ApiEnvelope readiness(@PathVariable long id,@RequestParam(required=false)String action){return ok(service.readiness(c(),Inputs.id(id),action));}
 @GetMapping("/countries/{id}/reviews") public ApiEnvelope reviews(@PathVariable long id){return ok(service.reviews(c(),Inputs.id(id)));}
 @PostMapping("/countries/{id}/reviews/{reviewId}/confirm") public ApiEnvelope review(@PathVariable long id,@PathVariable long reviewId,@RequestBody Map<String,Object>b){return ok(service.review(c(),Inputs.id(id),Inputs.id(reviewId),b));}
 @PostMapping("/countries/{id}/activate") public ApiEnvelope activate(@PathVariable long id){return ok(service.activate(c(),Inputs.id(id)));}
 @PostMapping("/countries/{id}/disable") public ApiEnvelope disable(@PathVariable long id){return ok(service.disable(c(),Inputs.id(id)));}
 @GetMapping("/country-templates") public ApiEnvelope templates(@RequestParam Map<String,String>q){return ok(service.templates(c(),q));}
 @GetMapping("/country-templates/{id}") public ApiEnvelope template(@PathVariable long id){return ok(service.template(c(),Inputs.id(id)));}
 @PostMapping("/country-templates") public ApiEnvelope createTemplate(@RequestBody Map<String,Object>b){return ok(service.createTemplate(c(),b));}
 @PostMapping("/country-templates/{id}/publish") public ApiEnvelope publish(@PathVariable long id){return ok(service.publish(c(),Inputs.id(id)));}
 @PostMapping("/country-clone-jobs") public ApiEnvelope cloneJob(@RequestBody Map<String,Object>b){return ok(service.createClone(c(),b));}
 @GetMapping("/country-clone-jobs/{id}") public ApiEnvelope cloneJob(@PathVariable long id){return ok(service.cloneJob(c(),Inputs.id(id)));}
 @PutMapping("/country-clone-jobs/{id}/items") public ApiEnvelope cloneItems(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(service.cloneItems(c(),Inputs.id(id),b));}
 @PostMapping("/country-clone-jobs/{id}/org") public ApiEnvelope cloneOrg(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(service.cloneOrg(c(),Inputs.id(id),b));}
 @PostMapping("/country-clone-jobs/{id}/admin") public ApiEnvelope cloneAdmin(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(service.cloneAdmin(c(),Inputs.id(id),b));}
 @GetMapping("/country-clone-jobs/{id}/preview") public ApiEnvelope preview(@PathVariable long id){return ok(service.preview(c(),Inputs.id(id)));}
 @PostMapping("/country-clone-jobs/{id}/apply") public ApiEnvelope apply(@PathVariable long id){return ok(service.apply(c(),Inputs.id(id)));}
 @GetMapping("/template-upgrades") public ApiEnvelope upgrades(@RequestParam long countryId){return ok(service.upgrades(c(),Inputs.id(countryId)));}
 @PostMapping("/template-upgrades") public ApiEnvelope previewUpgrade(@RequestBody Map<String,Object>b){return ok(service.previewUpgrade(c(),b));}
 @PostMapping("/template-upgrades/{id}/confirm") public ApiEnvelope confirmUpgrade(@PathVariable long id){return ok(service.confirmUpgrade(c(),Inputs.id(id)));}
}
