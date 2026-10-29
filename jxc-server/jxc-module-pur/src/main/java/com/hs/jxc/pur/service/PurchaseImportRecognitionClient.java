package com.hs.jxc.pur.service;

import com.hs.jxc.common.api.*;
import com.hs.jxc.pur.service.impl.PurchaseImportConnections;
import com.hs.jxc.sys.integrations.*;
import java.net.URI;
import java.util.*;
import org.springframework.stereotype.Component;

/** 原任务与协议保持不变；连接来自任务绑定版本，测试构造器保留显式旧连接。 */
@Component
public class PurchaseImportRecognitionClient {
    private final String workerUrl,workerKey,n8nUrl,n8nKey;
    private final JsonCodec json;private final PurchaseImportConnections connections;private final ExternalServiceHttp transport;
    public PurchaseImportRecognitionClient(String workerUrl,String workerKey,JsonCodec json){this(workerUrl,workerKey,"","",json);}
    public PurchaseImportRecognitionClient(String workerUrl,String workerKey,String n8nUrl,String n8nKey,JsonCodec json){this(workerUrl,workerKey,n8nUrl,n8nKey,json,null,new ExternalServiceHttp(json));}
    @org.springframework.beans.factory.annotation.Autowired
    public PurchaseImportRecognitionClient(PurchaseImportConnections connections,ExternalServiceHttp transport,JsonCodec json){this("","","","",json,connections,transport);}
    private PurchaseImportRecognitionClient(String workerUrl,String workerKey,String n8nUrl,String n8nKey,JsonCodec json,PurchaseImportConnections connections,ExternalServiceHttp transport){this.workerUrl=workerUrl;this.workerKey=workerKey;this.n8nUrl=n8nUrl;this.n8nKey=n8nKey;this.json=json;this.connections=connections;this.transport=transport;}
    private Map<String,Object> settings(UUID task,String credential){
        if(connections!=null)return connections.forTask(task,credential);
        return Map.of("docling",Map.of("url",workerUrl,"key",workerKey,"source","STARTUP","enabled",!workerUrl.isBlank()&&!workerKey.isBlank(),"timeoutSeconds",600),"n8n",Map.of("recognitionUrl",n8nUrl,"recognitionKey",n8nKey,"source","STARTUP","enabled",!n8nUrl.isBlank()&&!n8nKey.isBlank(),"timeoutSeconds",600));
    }
    private Map<String,Object> enabled(Map<String,Object> all,String name,String code){
        var service=ExternalServiceConfig.map(all.get(name));
        if(!Boolean.TRUE.equals(service.get("enabled"))){if("PAGE".equals(service.get("source")))throw new ApiException(503,"INTEGRATION_DISABLED",name+"连接已停用，请检查外部服务配置");throw new ApiException(503,code,"受限识别服务未配置，请联系管理员");}
        return service;
    }
    public Map<String,Object> parse(UUID taskId,String credential,long sourceId,String sha256,String sheet){return parse(taskId,credential,sourceId,sha256,sheet,null);}
    public Map<String,Object> parse(UUID taskId,String credential,long sourceId,String sha256,String sheet,Map<String,Object> overrides){
        var all=settings(taskId,credential);var worker=enabled(all,"docling","PARSER_UNAVAILABLE");
        var body=new LinkedHashMap<String,Object>();body.put("taskId",taskId.toString());body.put("credential",credential);body.put("sourceId",sourceId);body.put("sha256",sha256);body.put("sheet",sheet);body.put("reportProgress",true);
        if("PAGE".equals(ExternalServiceConfig.map(all.get("n8n")).get("source"))){enabled(all,"n8n","N8N_UNAVAILABLE");body.put("managedServices",true);}
        if(overrides!=null)body.put("mappingOverrides",overrides);
        return invoke(worker,"supplier-parse",body,"document",160*1024*1024);
    }
    public Map<String,Object> embed(UUID task,String credential,long asset,String sha){return invoke(enabled(settings(task,credential),"docling","PARSER_UNAVAILABLE"),"embedding",Map.of("taskId",task.toString(),"credential",credential,"assetId",asset,"sha256",sha),"feature",1024*1024);}
    public Map<String,Object> index(UUID task,String credential,Map<String,Object> input){return invoke(enabled(settings(task,credential),"docling","PARSER_UNAVAILABLE"),"index",Map.of("taskId",task.toString(),"credential",credential,"input",input),"index",256*1024*1024);}
    public Map<String,Object> search(UUID task,String credential,Map<String,Object> input){var body=new LinkedHashMap<String,Object>(input);body.put("taskId",task.toString());body.put("credential",credential);return invoke(enabled(settings(task,credential),"docling","PARSER_UNAVAILABLE"),"search",body,"search",8*1024*1024);}
    public Map<String,Object> recognize(UUID task,String credential,Map<String,Object> input){
        var service=enabled(settings(task,credential),"n8n","N8N_UNAVAILABLE");String endpoint=ExternalServiceConfig.text(service,"recognitionUrl");
        if(!URI.create(endpoint).getPath().endsWith("/jxc-purchase-recognition-v1"))throw new ApiException(503,"N8N_CONFIG_INVALID","请配置独立受限识别工作流地址");
        var body=new LinkedHashMap<String,Object>(input);body.put("taskId",task.toString());body.put("credential",credential);
        return post(endpoint,ExternalServiceConfig.text(service,"recognitionKey"),body,"receipt",2*1024*1024,"N8N_UNAVAILABLE",((Number)service.get("timeoutSeconds")).intValue());
    }
    private Map<String,Object> invoke(Map<String,Object> worker,String operation,Map<String,Object> body,String field,int maximum){
        String endpoint=ExternalServiceConfig.text(worker,"url").replaceAll("/$","")+"/internal/jxc/"+operation;
        return post(endpoint,ExternalServiceConfig.text(worker,"key"),body,field,maximum,"PARSER_UNAVAILABLE",((Number)worker.get("timeoutSeconds")).intValue());
    }
    public Map<String,Object> reviewBatch(UUID task,String credential,Map<String,Object> input){
        if(!"MatchReviewBatchV1".equals(input.get("format"))||!input.keySet().equals(Set.of("format","rows","images")))throw Inputs.bad("批量核对只接受已固定的行依据与图片");
        var service=enabled(settings(task,credential),"n8n","N8N_UNAVAILABLE");String endpoint=ExternalServiceConfig.text(service,"recognitionUrl");
        if(!URI.create(endpoint).getPath().endsWith("/jxc-purchase-recognition-v1"))throw new ApiException(503,"N8N_CONFIG_INVALID","请配置独立受限识别工作流地址");
        var body=new LinkedHashMap<>(input);if("PAGE".equals(service.get("source"))){body.put("taskId",task.toString());body.put("credential",credential);}
        return post(endpoint,ExternalServiceConfig.text(service,"recognitionKey"),body,"result",16*1024*1024,"N8N_UNAVAILABLE",((Number)service.get("timeoutSeconds")).intValue());
    }
    private Map<String,Object> post(String endpoint,String key,Map<String,Object> body,String field,int maximum,String failureCode,int timeout){
        var response=transport.exchange(endpoint,key,"POST",body,timeout,maximum);var result=response.body();
        if(response.status()!=200||!"ok".equals(result.get("status"))){
            if(failureCode.equals("N8N_UNAVAILABLE"))throw new ApiException(502,"N8N_UNAVAILABLE","受限工作流失败或未确认结果保存，请检查工作流状态");
            String code=result.get("code") instanceof String c?c:failureCode;String message=result.get("message") instanceof String m?m:"受限识别服务返回失败";
            throw new ApiException(502,code,message,result.get("details"));
        }
        if(!(result.get(field) instanceof Map<?,?>))throw new ApiException(502,"PARSER_INVALID_RESPONSE","受限服务未返回完整合同");
        return json.readMap(json.write(result.get(field)));
    }
}
