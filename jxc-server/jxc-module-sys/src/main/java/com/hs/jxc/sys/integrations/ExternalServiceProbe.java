package com.hs.jxc.sys.integrations;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import java.time.Instant;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** 获取配置及记录各用短事务，网络检查不占用授权或数据库锁。 */
@Service
public class ExternalServiceProbe {
    private final ExternalServiceConfig config;private final ExternalServiceHttp http;private final JdbcTemplate jdbc;private final JsonCodec json;private final TransactionTemplate tx;
    public ExternalServiceProbe(ExternalServiceConfig config,ExternalServiceHttp http,JdbcTemplate jdbc,JsonCodec json,PlatformTransactionManager manager){this.config=config;this.http=http;this.jdbc=jdbc;this.json=json;this.tx=new TransactionTemplate(manager);}
    public Map<String,Object> test(RequestContext ctx,String name,Map<String,Object> body){
        ExternalServiceConfig.requireService(name);if(!body.keySet().equals(Set.of("version")))throw Inputs.bad("连接检查只接受已保存的配置版本");int version=ExternalServiceConfig.version(body);
        var service=tx.execute(s->{config.authorize(ctx,false);if(version!=config.currentVersion())throw Inputs.conflict();return ExternalServiceConfig.map(config.snapshot(version).get(name));});
        String status="ok",message;
        try{
            ExternalServiceConfig.requireConfigured(name,service);
            int timeout=Math.min(30,((Number)service.get("timeoutSeconds")).intValue());
            if(name.equals("n8n")){
                for(String purpose:List.of("fields","recognition")){
                    var reply=http.exchange(ExternalServiceConfig.text(service,purpose+"Url"),ExternalServiceConfig.text(service,purpose+"Key"),"POST",Map.of("format","JxcConnectionProbeV1"),timeout,65536);ExternalServiceHttp.requireSuccess(reply);
                    if(!"ok".equals(reply.body().get("status"))||!"JxcConnectionProbeV1".equals(reply.body().get("format"))||!purpose.equals(reply.body().get("purpose")))throw new ApiException(502,"INTEGRATION_PROBE_PROTOCOL","工作流未返回对应连接检查协议，请更新并发布本次工作流版本");
                }
                message="两个采购工作流的连接协议检查通过，未执行采购识别或调用模型";
            }else if(name.equals("deepseek")){
                var reply=http.exchange(ExternalServiceConfig.text(service,"url")+"/models",ExternalServiceConfig.text(service,"key"),"GET",null,timeout,2*1024*1024);ExternalServiceHttp.requireSuccess(reply);
                if(!(reply.body().get("data") instanceof List<?> models)||models.stream().noneMatch(m->m instanceof Map<?,?> model&&Objects.equals(model.get("id"),service.get("model"))))throw new ApiException(502,"INTEGRATION_MODEL_UNAVAILABLE","服务未列出配置的模型，请核对模型名称或账户权限");
                message="模型目录读取成功，已找到配置模型；未提交采购内容，实际图文效果仍需业务验证";
            }else{
                var reply=http.exchange(ExternalServiceConfig.text(service,"url")+"/internal/jxc/connection-test",ExternalServiceConfig.text(service,"key"),"POST",Map.of("format","JxcConnectionProbeV1"),timeout,65536);ExternalServiceHttp.requireSuccess(reply);
                if(!"ok".equals(reply.body().get("status"))||!"docling".equals(reply.body().get("purpose")))throw new ApiException(502,"INTEGRATION_PROBE_PROTOCOL","解析服务未返回连接检查协议，请核对服务版本");
                message="解析桥接连接协议检查通过，未执行Docling转换或图片识别";
            }
        }catch(ApiException error){status="error";message=error.getMessage();}
        var result=Map.<String,Object>of("status",status,"message",message,"checkedAt",Instant.now().toString());
        tx.execute(s->{config.authorize(ctx,true);if(version!=config.currentVersion())throw Inputs.conflict();jdbc.update("INSERT INTO sys_external_service_probe(version,service,result) VALUES(?,?,?::jsonb) ON CONFLICT(version,service) DO UPDATE SET result=excluded.result",version,name,json.write(result));return null;});
        return result;
    }
}
