package com.hs.jxc.sys.integrations;

import com.hs.jxc.common.api.*;
import java.net.*;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.stereotype.Component;

/** 识别连接与连接检查共用传输；不跟随跳转，不反射远端错误正文。 */
@Component
public class ExternalServiceHttp {
    public record Reply(int status,Map<String,Object> body) {}
    private final JsonCodec json;
    private final HttpClient http=HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
    public ExternalServiceHttp(JsonCodec json){this.json=json;}
    public static URI address(String value){
        try {
            var uri=URI.create(value);
            if(!Set.of("http","https").contains(uri.getScheme())||uri.getHost()==null||uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null||uri.getPort()==0||uri.getPort()>65535)throw new IllegalArgumentException();
            String host=uri.getHost().toLowerCase(Locale.ROOT);
            if(host.equals("0.0.0.0")||host.startsWith("169.254.")||host.equals("metadata.google.internal")||host.equals("[::]")||host.startsWith("[fe80:"))throw new IllegalArgumentException();
            return uri;
        }catch(RuntimeException invalid){throw Inputs.bad("服务地址必须为有效HTTP/HTTPS地址，不能包含账号、查询参数、片段或云元数据地址");}
    }
    public Reply exchange(String endpoint,String key,String method,Object input,int timeoutSeconds,int maximum){
        URI uri=address(endpoint);
        try {
            for(var resolved:InetAddress.getAllByName(uri.getHost()))if(resolved.isAnyLocalAddress()||resolved.isLinkLocalAddress()||resolved.isMulticastAddress())throw Inputs.bad("服务地址不能指向本地未指定地址、组播或云元数据网络");
            var request=HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(timeoutSeconds)).header("Content-Type","application/json");
            if(!key.isBlank())request.header("Authorization","Bearer "+key);
            request.method(method,input==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.write(input),StandardCharsets.UTF_8));
            var response=response(request.build(),timeoutSeconds,maximum);
            byte[] bytes=response.body();
            Map<String,Object> body;
            try{body=json.readMap(new String(bytes,StandardCharsets.UTF_8));}
            catch(RuntimeException invalid){if(response.statusCode()!=200)return new Reply(response.statusCode(),Map.of());throw new ApiException(502,"INTEGRATION_INVALID_RESPONSE","外部服务未返回有效JSON对象");}
            return new Reply(response.statusCode(),body);
        }catch(ApiException error){throw error;}
        catch(HttpTimeoutException error){throw new ApiException(504,"INTEGRATION_TIMEOUT","外部服务请求超时，请检查服务后重试");}
        catch(InterruptedException error){Thread.currentThread().interrupt();throw new ApiException(503,"PARSER_INTERRUPTED","任务中断，可使用原任务恢复");}
        catch(Exception error){throw new ApiException(503,"INTEGRATION_CONNECTION_FAILED","外部服务连接失败，请检查地址、网络和服务状态");}
    }
    private HttpResponse<byte[]> response(HttpRequest request,int timeout,int maximum)throws Exception{
        // Java21的请求超时只到响应头；显式限制完整响应等待，并取消仍在读取的请求。
        var pending=http.sendAsync(request,info->limitedBody(maximum));
        try{return pending.get(timeout,TimeUnit.SECONDS);}
        catch(TimeoutException expired){pending.cancel(true);throw new HttpTimeoutException("response deadline exceeded");}
        catch(InterruptedException interrupted){pending.cancel(true);throw interrupted;}
        catch(ExecutionException failed){
            Throwable cause=failed.getCause();
            while(cause.getCause()!=null&&!(cause instanceof ApiException)&&!(cause instanceof HttpTimeoutException))cause=cause.getCause();
            if(cause instanceof ApiException api)throw api;
            if(cause instanceof HttpTimeoutException expired)throw expired;
            throw new java.io.IOException(cause);
        }
    }
    private static HttpResponse.BodySubscriber<byte[]> limitedBody(int maximum){
        var target=HttpResponse.BodySubscribers.ofByteArray();
        return new HttpResponse.BodySubscriber<>(){
            private Flow.Subscription subscription;private long received;
            public CompletionStage<byte[]> getBody(){return target.getBody();}
            public void onSubscribe(Flow.Subscription value){subscription=value;target.onSubscribe(value);}
            public void onNext(List<ByteBuffer> buffers){
                for(var buffer:buffers)received+=buffer.remaining();
                if(received>maximum){subscription.cancel();target.onError(new ApiException(502,"INTEGRATION_RESPONSE_LIMIT","外部服务响应超过允许大小"));return;}
                target.onNext(buffers);
            }
            public void onError(Throwable error){target.onError(error);}
            public void onComplete(){target.onComplete();}
        };
    }
    public static void requireSuccess(Reply response){
        int status=response.status();
        if(status==200)return;
        if(status==401||status==403)throw new ApiException(502,"INTEGRATION_AUTH_FAILED","外部服务访问密钥验证失败");
        if(status==404)throw new ApiException(502,"INTEGRATION_ENDPOINT_NOT_FOUND","外部服务接口不存在，请核对地址或已发布工作流版本");
        if(status==429)throw new ApiException(503,"INTEGRATION_RATE_LIMITED","外部服务请求限额不足，请稍后重试");
        throw new ApiException(502,"INTEGRATION_REMOTE_FAILED","外部服务返回HTTP "+status+"，请检查服务状态");
    }
}
