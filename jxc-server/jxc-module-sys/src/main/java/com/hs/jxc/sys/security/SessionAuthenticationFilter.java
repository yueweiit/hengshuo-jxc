package com.hs.jxc.sys.security;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import com.hs.jxc.sys.service.SessionService;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.IOException;
import java.util.*;

public class SessionAuthenticationFilter extends OncePerRequestFilter {
    private final SessionService sessions;private final JsonCodec json;
    public SessionAuthenticationFilter(SessionService sessions,JsonCodec json){this.sessions=sessions;this.json=json;}
    @Override protected void doFilterInternal(HttpServletRequest req,HttpServletResponse res,FilterChain chain)throws ServletException,IOException {
        String trace=UUID.randomUUID().toString();res.setHeader("X-Trace-Id",trace);
        try {
            String bearer=req.getHeader("Authorization");
            if(bearer!=null&&!Set.of("/api/v1/auth/login","/actuator/health","/api/v1/health").contains(req.getRequestURI())) {
                if(!bearer.startsWith("Bearer ")||bearer.length()>520||bearer.substring(7).isBlank())throw new ApiException(401,"AUTH_REQUIRED","请提供有效登录令牌");
                String token=bearer.substring(7);long user=sessions.identify(token);
                Long country=null;String value=req.getHeader("X-Country-Id");
                if(value!=null&&!value.isBlank())try{country=Long.valueOf(value);if(country<=0||country>9007199254740991L)throw new NumberFormatException();}catch(NumberFormatException e){throw new ApiException(400,"SYS_BAD_REQUEST","国家ID不合法");}
                RequestContextHolder.set(new RequestContext(user,country,trace,SessionService.digest(token)));
                SecurityContextHolder.getContext().setAuthentication(UsernamePasswordAuthenticationToken.authenticated(user,null,List.of()));
            }
            chain.doFilter(req,res);
        }catch(ApiException e){write(res,json,e.getStatus(),e.getCode(),e.getMessage(),trace);}
        finally{RequestContextHolder.clear();SecurityContextHolder.clearContext();}
    }
    static void write(HttpServletResponse res,JsonCodec json,int status,String code,String message,String trace)throws IOException {
        res.setStatus(status);res.setContentType("application/json;charset=UTF-8");res.getWriter().write(json.write(ApiEnvelope.error(code,message,null,trace)));
    }
}
