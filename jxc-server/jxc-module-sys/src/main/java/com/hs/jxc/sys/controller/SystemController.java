package com.hs.jxc.sys.controller;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import com.hs.jxc.sys.service.*;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/v1/sys")
public class SystemController {
    private final SystemManagementService service;
    public SystemController(SystemManagementService service){this.service=service;}
    private RequestContext ctx(){return RequestContextHolder.require();}
    private ApiEnvelope ok(Object data){return ApiEnvelope.ok(data,ctx().traceId());}
    @GetMapping("/user-options") public ApiEnvelope userOptions(){return ok(service.userOptions(ctx()));}
    @GetMapping("/business-user-options") public ApiEnvelope businessUserOptions(@RequestParam String purpose){return ok(service.businessUserOptions(ctx(),purpose));}
    @GetMapping("/users") public ApiEnvelope users(@RequestParam Map<String,String> query){return ok(service.users(ctx(),query));}
    @GetMapping("/users/{id}") public ApiEnvelope user(@PathVariable long id){return ok(service.user(ctx(),Inputs.id(id)));}
    @PostMapping("/users") public ApiEnvelope createUser(@RequestBody Map<String,Object> b){return ok(service.createUser(ctx(),b));}
    @PutMapping("/users/{id}") public ApiEnvelope updateUser(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(service.updateUser(ctx(),Inputs.id(id),b));}
    @PostMapping("/users/{id}/enable") public ApiEnvelope enableUser(@PathVariable long id){return ok(service.toggleUser(ctx(),Inputs.id(id),true));}
    @PostMapping("/users/{id}/disable") public ApiEnvelope disableUser(@PathVariable long id){return ok(service.toggleUser(ctx(),Inputs.id(id),false));}
    @PostMapping("/users/{id}/reset-password") public ApiEnvelope resetPassword(@PathVariable long id){return ok(service.resetPassword(ctx(),Inputs.id(id)));}
    @GetMapping("/users/{id}/grants") public ApiEnvelope grants(@PathVariable long id,@RequestParam(required=false)Long countryId){return ok(service.grants(ctx(),Inputs.id(id),countryId==null?null:Inputs.id(countryId)));}
    public record Grants(List<Object> roleIds,List<Map<String,Object>> dataScopes,Object version){}
    @PutMapping("/users/{id}/grants") public ApiEnvelope setGrants(@PathVariable long id,@RequestParam(required=false)Long countryId,@RequestBody Grants body){return ok(service.setGrants(ctx(),Inputs.id(id),countryId==null?null:Inputs.id(countryId),body.roleIds()==null?List.of():body.roleIds().stream().map(Inputs::id).toList(),body.dataScopes()==null?List.of():body.dataScopes(),Inputs.version(Collections.singletonMap("version",body.version()))));}
    public record RoleIds(List<Object> roleIds,Object version){}
    @PutMapping("/users/{id}/roles") public ApiEnvelope userRoles(@PathVariable long id,@RequestParam(required=false)Long countryId,@RequestBody RoleIds body){return ok(service.setRoles(ctx(),Inputs.id(id),countryId==null?null:Inputs.id(countryId),body.roleIds()==null?List.of():body.roleIds().stream().map(Inputs::id).toList(),Inputs.version(Collections.singletonMap("version",body.version()))));}
    public record Scopes(List<Map<String,Object>> dataScopes,Object version){}
    @PutMapping("/users/{id}/data-scopes") public ApiEnvelope userScopes(@PathVariable long id,@RequestParam(required=false)Long countryId,@RequestBody Scopes body){return ok(service.setScopes(ctx(),Inputs.id(id),countryId==null?null:Inputs.id(countryId),body.dataScopes()==null?List.of():body.dataScopes(),Inputs.version(Collections.singletonMap("version",body.version()))));}
    @GetMapping("/roles") public ApiEnvelope roles(@RequestParam Map<String,String> query){return ok(service.roles(ctx(),query));}
    @GetMapping("/roles/{id}") public ApiEnvelope role(@PathVariable long id){return ok(service.getRole(ctx(),Inputs.id(id)));}
    @PostMapping("/roles") public ApiEnvelope createRole(@RequestBody Map<String,Object>b){return ok(service.createRole(ctx(),b));}
    @PutMapping("/roles/{id}") public ApiEnvelope updateRole(@PathVariable long id,@RequestBody Map<String,Object>b){return ok(service.updateRole(ctx(),Inputs.id(id),b));}
    @PostMapping("/roles/{id}/enable") public ApiEnvelope enableRole(@PathVariable long id){return ok(service.toggleRole(ctx(),Inputs.id(id),true));}
    @PostMapping("/roles/{id}/disable") public ApiEnvelope disableRole(@PathVariable long id){return ok(service.toggleRole(ctx(),Inputs.id(id),false));}
    public record Permissions(List<String> permissions,Object version){}
    @PutMapping("/roles/{id}/permissions") public ApiEnvelope permissions(@PathVariable long id,@RequestBody Permissions b){return ok(service.setRolePermissions(ctx(),Inputs.id(id),b.permissions()==null?List.of():b.permissions(),Inputs.version(Collections.singletonMap("version",b.version()))));}
    public record Fields(Map<String,String> fieldPolicies,Object version){}
    @PutMapping("/roles/{id}/field-policies") public ApiEnvelope fields(@PathVariable long id,@RequestBody Fields b){return ok(service.setRoleFields(ctx(),Inputs.id(id),b.fieldPolicies()==null?Map.of():b.fieldPolicies(),Inputs.version(Collections.singletonMap("version",b.version()))));}
    @GetMapping("/permissions/tree") public ApiEnvelope permissionTree(){return ok(service.catalog(ctx()));}
}
