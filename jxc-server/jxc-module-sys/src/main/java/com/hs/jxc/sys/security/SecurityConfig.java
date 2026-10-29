package com.hs.jxc.sys.security;

import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.sys.service.SessionService;
import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@Profile("!bootstrap")
public class SecurityConfig {
    @Bean org.springframework.security.core.userdetails.UserDetailsService disablePasswordFallback(){return username->{throw new org.springframework.security.core.userdetails.UsernameNotFoundException("Only bearer sessions are supported");};}
    @Bean SecurityFilterChain applicationSecurity(HttpSecurity http,SessionService sessions,JsonCodec json)throws Exception {
        return http.httpBasic(c->c.disable()).formLogin(c->c.disable()).csrf(c->c.disable()).sessionManagement(s->s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(a->a.requestMatchers("/actuator/health","/actuator/health/**","/api/v1/health","/api/v1/auth/login","/error").permitAll()
                .requestMatchers(org.springframework.http.HttpMethod.GET,"/internal/purchase-import/tasks/*/assets/*").permitAll().requestMatchers(org.springframework.http.HttpMethod.POST,"/internal/purchase-import/tasks/*/catalog-search","/internal/purchase-import/tasks/*/result","/internal/purchase-import/tasks/*/progress").permitAll().anyRequest().authenticated())
            .exceptionHandling(e->e.authenticationEntryPoint((req,res,ex)->SessionAuthenticationFilter.write(res,json,401,"AUTH_REQUIRED","请先登录",java.util.UUID.randomUUID().toString()))
                .accessDeniedHandler((req,res,ex)->SessionAuthenticationFilter.write(res,json,403,"SYS_FORBIDDEN","没有此操作的权限",java.util.UUID.randomUUID().toString())))
            .addFilterBefore(new SessionAuthenticationFilter(sessions,json),UsernamePasswordAuthenticationFilter.class).build();
    }
}
