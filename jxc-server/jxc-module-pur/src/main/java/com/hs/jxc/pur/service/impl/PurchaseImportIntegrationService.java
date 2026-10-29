package com.hs.jxc.pur.service.impl;

import com.hs.jxc.common.api.*;
import com.hs.jxc.sys.integrations.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** 仅为现有采购任务提供字段识别与模型通信；不暴露密钥或通用聊天接口。 */
@Service
public class PurchaseImportIntegrationService {
    private final PurchaseImportTaskServiceImpl tasks;private final PurchaseImportConnections connections;private final ExternalServiceHttp http;private final JsonCodec json;private final JdbcTemplate jdbc;private final TransactionTemplate tx;
    public PurchaseImportIntegrationService(PurchaseImportTaskServiceImpl tasks,PurchaseImportConnections connections,ExternalServiceHttp http,JsonCodec json,JdbcTemplate jdbc,PlatformTransactionManager manager){this.tasks=tasks;this.connections=connections;this.http=http;this.json=json;this.jdbc=jdbc;this.tx=new TransactionTemplate(manager);}
    public Map<String,Object> fields(UUID id,String credential,Map<String,Object> document){
        var scope=tasks.scoped(id,credential,false);
        if(!"PARSE".equals(scope.task().get("kind")))throw ApiException.forbidden();
        if(!Set.of("format","fileSha256","sheet","tables","rows","sourceCells").containsAll(document.keySet())||!"SupplierDocumentV1".equals(document.get("format"))||!Objects.equals(scope.task().get("input_hash"),document.get("fileSha256"))||json.write(document).getBytes(java.nio.charset.StandardCharsets.UTF_8).length>4*1024*1024)throw Inputs.bad("采购字段识别来源无效或超过4MiB");
        var service=ExternalServiceConfig.map(connections.snapshot(scope.task()).get("n8n"));ExternalServiceConfig.requireEnabled("n8n",service);
        var reply=http.exchange(ExternalServiceConfig.text(service,"fieldsUrl"),ExternalServiceConfig.text(service,"fieldsKey"),"POST",Map.of("document",document,"taskId",id.toString(),"credential",credential),((Number)service.get("timeoutSeconds")).intValue(),4*1024*1024);
        ExternalServiceHttp.requireSuccess(reply);tasks.scoped(id,credential,false);
        if(!"ok".equals(reply.body().get("status"))||!(reply.body().get("mapping") instanceof Map<?,?>))throw new ApiException(502,"SUPPLIER_N8N_FAILED","采购字段工作流未返回完整映射，请检查工作流状态");
        return reply.body();
    }
    public Map<String,Object> model(UUID id,String credential,Map<String,Object> body){
        // 先核对任务权限，再解析模型消息；长校验后在预留调用额度时再次核对租约。
        tasks.scoped(id,credential,false);
        if(!body.keySet().equals(Set.of("purpose","prompt")))throw Inputs.bad("模型入口只接受采购识别用途及固定消息");
        String purpose=Inputs.required(body,"purpose");var prompt=validatePrompt(body.get("prompt"));
        var task=tx.execute(s->{
            var scope=tasks.scoped(id,credential,false);String kind=scope.task().get("kind").toString();
            if(!(purpose.equals("FIELDS")&&kind.equals("PARSE")||purpose.equals("REVIEW")&&Set.of("MATCH","EXPLAIN").contains(kind)))throw ApiException.forbidden();
            if(jdbc.update("UPDATE pur_order_import_task SET integration_model_calls=integration_model_calls+1 WHERE country_id=? AND id=? AND status='RUNNING' AND credential_hash=? AND integration_model_calls<2 AND lease_until>clock_timestamp()",scope.actor().countryId(),id,scope.task().get("credential_hash"))!=1)throw new ApiException(429,"INTEGRATION_TASK_MODEL_LIMIT","本次任务执行的模型调用已达到限制，请检查失败原因后重试");
            return scope.task();
        });
        var service=ExternalServiceConfig.map(connections.snapshot(task).get("deepseek"));ExternalServiceConfig.requireEnabled("deepseek",service);
        prompt.put("model",ExternalServiceConfig.text(service,"model"));prompt.put("temperature",0);
        var reply=http.exchange(ExternalServiceConfig.text(service,"url")+"/chat/completions",ExternalServiceConfig.text(service,"key"),"POST",prompt,((Number)service.get("timeoutSeconds")).intValue(),2*1024*1024);
        ExternalServiceHttp.requireSuccess(reply);tasks.scoped(id,credential,false);
        if(!(reply.body().get("choices") instanceof List<?> choices)||choices.isEmpty())throw new ApiException(502,"INTEGRATION_MODEL_INVALID_RESPONSE","模型未返回有效结果，未生成识别结论");
        return reply.body();
    }
    private Map<String,Object> validatePrompt(Object input){
        var prompt=ExternalServiceConfig.map(input);
        if(!Set.of("model","messages","temperature","response_format","max_tokens").containsAll(prompt.keySet())||!(prompt.get("messages") instanceof List<?> messages)||messages.size()!=2||json.write(prompt).getBytes(java.nio.charset.StandardCharsets.UTF_8).length>PurchaseImportReviewBatch.MAX_BYTES+4*1024*1024)throw Inputs.bad("模型请求仅接受不超过44MiB的固定采购识别消息");
        for(int i=0;i<messages.size();i++){
            var message=ExternalServiceConfig.map(messages.get(i));
            if(!message.keySet().equals(Set.of("role","content"))||!Objects.equals(message.get("role"),i==0?"system":"user"))throw Inputs.bad("采购模型消息角色或字段无效");
            Object content=message.get("content");
            if(content instanceof String text){if(text.isBlank()||text.length()>(i==0?65536:4*1024*1024))throw Inputs.bad("采购模型文字为空或超过允许大小");}
            else if(i==1&&content instanceof List<?> parts&&!parts.isEmpty()&&parts.size()<=128){
                for(Object item:parts){var part=ExternalServiceConfig.map(item);
                    if("text".equals(part.get("type"))&&part.keySet().equals(Set.of("type","text"))&&part.get("text") instanceof String)continue;
                    if("image_url".equals(part.get("type"))&&part.keySet().equals(Set.of("type","image_url"))){var image=ExternalServiceConfig.map(part.get("image_url"));if(image.keySet().equals(Set.of("url"))&&image.get("url") instanceof String url&&url.matches("data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*"))continue;}
                    throw Inputs.bad("采购模型仅接受真实内嵌图片与文字，不接受网络图片地址");
                }
            }else throw Inputs.bad("采购模型消息内容无效");
        }
        if(prompt.containsKey("response_format")&&!Objects.equals(prompt.get("response_format"),Map.of("type","json_object")))throw Inputs.bad("采购模型输出仅接受JSON格式");
        if(prompt.containsKey("max_tokens")){
            Object value=prompt.get("max_tokens");if(!(value instanceof Number))throw Inputs.bad("批量模型输出额度无效");
            try{int limit=new java.math.BigDecimal(value.toString()).intValueExact();if(limit<1||limit>32768)throw Inputs.bad("批量模型输出额度无效");}catch(ArithmeticException|NumberFormatException invalid){throw Inputs.bad("批量模型输出额度无效");}
        }
        return new LinkedHashMap<>(prompt);
    }
}
