package com.hs.jxc.pur.service;

import com.hs.jxc.common.api.*;
import java.net.*;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** 只有显式配置的受限桥接可接收任务清单；不自动选取演示地址。 */
@Component
public class PurchaseImportRecognitionClient {
    private final String workerUrl,workerKey,n8nUrl,n8nKey;private final JsonCodec json;
    public PurchaseImportRecognitionClient(String workerUrl,String workerKey,JsonCodec json){this(workerUrl,workerKey,"","",json);}
    @org.springframework.beans.factory.annotation.Autowired
    public PurchaseImportRecognitionClient(@Value("${jxc.purchase-import.worker-url:}")String workerUrl,@Value("${jxc.purchase-import.worker-key:}")String workerKey,@Value("${jxc.purchase-import.n8n-url:}")String n8nUrl,@Value("${jxc.purchase-import.n8n-key:}")String n8nKey,JsonCodec json){this.workerUrl=workerUrl;this.workerKey=workerKey;this.n8nUrl=n8nUrl;this.n8nKey=n8nKey;this.json=json;}
    public Map<String,Object> parse(UUID taskId,String credential,long sourceId,String sha256,String sheet){return parse(taskId,credential,sourceId,sha256,sheet,null);}
    public Map<String,Object> parse(UUID taskId,String credential,long sourceId,String sha256,String sheet,Map<String,Object> overrides){
        if(workerUrl.isBlank()||workerKey.isBlank())throw new ApiException(503,"PARSER_UNAVAILABLE","采购解析服务未配置，请联系管理员");
        var body=new LinkedHashMap<String,Object>();body.put("taskId",taskId.toString());body.put("credential",credential);body.put("sourceId",sourceId);body.put("sha256",sha256);body.put("sheet",sheet);
        if(overrides!=null)body.put("mappingOverrides",overrides);return invoke("supplier-parse",body,"document",160*1024*1024);
    }
    public Map<String,Object> embed(UUID task,String credential,long asset,String sha){return invoke("embedding",Map.of("taskId",task.toString(),"credential",credential,"assetId",asset,"sha256",sha),"feature",1024*1024);}
    public Map<String,Object> index(UUID task,String credential,Map<String,Object> input){return invoke("index",Map.of("taskId",task.toString(),"credential",credential,"input",input),"index",256*1024*1024);}
    public Map<String,Object> search(UUID task,String credential,Map<String,Object> input){var body=new LinkedHashMap<String,Object>(input);body.put("taskId",task.toString());body.put("credential",credential);return invoke("search",body,"search",8*1024*1024);}
    public Map<String,Object> recognize(UUID task,String credential,Map<String,Object> input){if(n8nUrl.isBlank()||n8nKey.isBlank())throw new ApiException(503,"N8N_UNAVAILABLE","受限识别工作流未配置");if(!URI.create(n8nUrl).getPath().endsWith("/jxc-purchase-recognition-v1"))throw new ApiException(503,"N8N_CONFIG_INVALID","请配置独立受限识别工作流地址");var body=new LinkedHashMap<String,Object>(input);body.put("taskId",task.toString());body.put("credential",credential);return post(n8nUrl,n8nKey,body,"receipt",2*1024*1024,"N8N_UNAVAILABLE");}
    private Map<String,Object> invoke(String operation,Map<String,Object> body,String field,int maximum){if(workerUrl.isBlank()||workerKey.isBlank())throw new ApiException(503,"PARSER_UNAVAILABLE","受限识别服务未配置");String endpoint=workerUrl.replaceAll("/$","")+"/internal/jxc/"+operation;return post(endpoint,workerKey,body,field,maximum,"PARSER_UNAVAILABLE");}
    private Map<String,Object> post(String endpoint,String key,Map<String,Object> body,String field,int maximum,String failureCode){
        try{URI url=URI.create(endpoint);if(!Set.of("http","https").contains(url.getScheme())||url.getUserInfo()!=null||url.getFragment()!=null||url.getQuery()!=null)throw new IllegalArgumentException();var client=HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();var request=HttpRequest.newBuilder(url).timeout(Duration.ofMinutes(10)).header("Authorization","Bearer "+key).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(json.write(body))).build();var response=client.send(request,HttpResponse.BodyHandlers.ofInputStream());byte[] data;try(var stream=response.body()){data=stream.readNBytes(maximum+1);}if(data.length>maximum)throw new ApiException(502,"PARSER_RESPONSE_LIMIT","受限服务结果超过允许大小");var result=json.readMap(new String(data,java.nio.charset.StandardCharsets.UTF_8));if(response.statusCode()!=200||!"ok".equals(result.get("status"))){if(failureCode.equals("N8N_UNAVAILABLE"))throw new ApiException(502,"N8N_UNAVAILABLE","受限工作流失败或未确认结果保存，请检查工作流状态");String code=result.get("code") instanceof String c?c:failureCode;String message=result.get("message") instanceof String m?m:"受限识别服务返回失败";throw new ApiException(502,code,message,result.get("details"));}if(!(result.get(field) instanceof Map<?,?>))throw new ApiException(502,"PARSER_INVALID_RESPONSE","受限服务未返回完整合同");return json.readMap(json.write(result.get(field)));}
        catch(ApiException error){throw error;}catch(InterruptedException error){Thread.currentThread().interrupt();throw new ApiException(503,"PARSER_INTERRUPTED","任务中断，可使用原任务恢复");}catch(Exception error){throw new ApiException(503,failureCode,"受限识别服务连接、超时或响应解析失败");}
    }
}
