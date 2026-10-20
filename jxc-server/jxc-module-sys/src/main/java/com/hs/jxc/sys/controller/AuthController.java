package com.hs.jxc.sys.controller;

import com.hs.jxc.common.api.ApiEnvelope;
import com.hs.jxc.common.context.RequestContextHolder;
import com.hs.jxc.sys.service.SessionService;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {
    private final SessionService sessions;
    public AuthController(SessionService sessions){this.sessions=sessions;}
    public record Credentials(String username,String password){}
    @PostMapping("/login") public ApiEnvelope login(@RequestBody Credentials body){return ApiEnvelope.ok(sessions.login(body.username(),body.password()),java.util.UUID.randomUUID().toString());}
    @GetMapping("/me") public ApiEnvelope me(@RequestParam(required=false)Long countryId){var ctx=RequestContextHolder.require();return ApiEnvelope.ok(sessions.me(ctx,countryId==null?null:com.hs.jxc.common.api.Inputs.id(countryId)),ctx.traceId());}
    @PostMapping("/logout") public ApiEnvelope logout(){var ctx=RequestContextHolder.require();sessions.logout(ctx);return ApiEnvelope.ok(null,ctx.traceId());}
}
