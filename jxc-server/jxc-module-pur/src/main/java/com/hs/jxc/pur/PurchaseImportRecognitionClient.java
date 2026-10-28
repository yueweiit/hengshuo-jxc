package com.hs.jxc.pur;

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
    private final String workerUrl,workerKey;private final JsonCodec json;
    public PurchaseImportRecognitionClient(@Value("${jxc.purchase-import.worker-url:}")String workerUrl,@Value("${jxc.purchase-import.worker-key:}")String workerKey,JsonCodec json){this.workerUrl=workerUrl;this.workerKey=workerKey;this.json=json;}
    public Map<String,Object> parse(UUID taskId,String credential,long sourceId,String sha256,String sheet){
        if(workerUrl.isBlank()||workerKey.isBlank())throw new ApiException(503,"PARSER_UNAVAILABLE","采购解析服务未配置，请联系管理员");
        var body=new LinkedHashMap<String,Object>();body.put("taskId",taskId.toString());body.put("credential",credential);body.put("sourceId",sourceId);body.put("sha256",sha256);body.put("sheet",sheet);
        return invoke("parse",body,"document",160*1024*1024);
    }
    public Map<String,Object> embed(UUID task,String credential,long asset,String sha){return invoke("embedding",Map.of("taskId",task.toString(),"credential",credential,"assetId",asset,"sha256",sha),"feature",1024*1024);}
    public Map<String,Object> index(UUID task,String credential,Map<String,Object> input){return invoke("index",Map.of("taskId",task.toString(),"credential",credential,"input",input),"index",256*1024*1024);}
    private Map<String,Object> invoke(String operation,Map<String,Object> body,String field,int maximum){
        if(workerUrl.isBlank()||workerKey.isBlank())throw new ApiException(503,"PARSER_UNAVAILABLE","受限识别服务未配置");
        try{URI url=URI.create(workerUrl);if(!Set.of("http","https").contains(url.getScheme())||url.getUserInfo()!=null||url.getFragment()!=null)throw new IllegalArgumentException();var client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
            var request=HttpRequest.newBuilder(url.resolve(url.getPath().replaceAll("/$","")+"/internal/jxc/"+operation)).timeout(Duration.ofMinutes(10)).header("Authorization","Bearer "+workerKey).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(json.write(body))).build();
            var response=client.send(request,HttpResponse.BodyHandlers.ofInputStream());byte[] data;try(var stream=response.body()){data=stream.readNBytes(maximum+1);}if(data.length>maximum)throw new ApiException(502,"PARSER_RESPONSE_LIMIT","解析结果超过允许大小");var result=json.readMap(new String(data,java.nio.charset.StandardCharsets.UTF_8));
            if(response.statusCode()!=200||!"ok".equals(result.get("status"))){String code=result.get("code") instanceof String c?c:"PARSER_FAILED";String message=result.get("message") instanceof String m?m:"解析服务返回失败";throw new ApiException(502,code,message,result.get("details"));}if(!(result.get(field) instanceof Map<?,?>))throw new ApiException(502,"PARSER_INVALID_RESPONSE","解析服务未返回来源合同");return json.readMap(json.write(result.get(field)));
        }catch(ApiException e){throw e;}catch(InterruptedException e){Thread.currentThread().interrupt();throw new ApiException(503,"PARSER_INTERRUPTED","解析任务中断，可使用原任务重试");}catch(Exception e){throw new ApiException(503,"PARSER_UNAVAILABLE","采购解析服务连接、超时或响应解析失败");}
    }
}
