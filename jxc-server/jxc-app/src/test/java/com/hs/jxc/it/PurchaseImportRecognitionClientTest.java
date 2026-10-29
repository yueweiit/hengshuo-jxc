package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.*;
import com.hs.jxc.pur.service.PurchaseImportRecognitionClient;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.junit.jupiter.api.Test;

class PurchaseImportRecognitionClientTest {
    @Test void responseLimitStillRejectsOversizedContentWithItsSpecificReason()throws Exception{
        var server=com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/large",exchange->{byte[] data=("{\"data\":\""+"a".repeat(10000)+"\"}").getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(200,data.length);exchange.getResponseBody().write(data);exchange.close();});server.start();
        try{var transport=new com.hs.jxc.sys.integrations.ExternalServiceHttp(new JsonCodec());
            assertThatThrownBy(()->transport.exchange("http://127.0.0.1:"+server.getAddress().getPort()+"/large","","GET",null,5,1024)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("INTEGRATION_RESPONSE_LIMIT");
        }finally{server.stop(0);}
    }
    @Test void configuredTimeoutAlsoCoversAResponseThatStopsAfterHeaders()throws Exception{
        var server=com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/slow",exchange->{exchange.sendResponseHeaders(200,0);exchange.getResponseBody().flush();try{Thread.sleep(1600);exchange.getResponseBody().write("{\"status\":\"ok\"}".getBytes(StandardCharsets.UTF_8));}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}finally{exchange.close();}});server.start();
        try{var transport=new com.hs.jxc.sys.integrations.ExternalServiceHttp(new JsonCodec());
            assertThatThrownBy(()->transport.exchange("http://127.0.0.1:"+server.getAddress().getPort()+"/slow","","GET",null,1,1024)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("INTEGRATION_TIMEOUT");
        }finally{server.stop(0);}
    }
    @Test void managedBatchUsesPinnedConnectionAndKeepsRelayCredentialOutsideRowsAndImages()throws Exception{
        var server=com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);var captured=new java.util.concurrent.atomic.AtomicReference<Map<String,Object>>();var auth=new java.util.concurrent.atomic.AtomicReference<String>();var json=new JsonCodec();
        server.createContext("/webhook/jxc-purchase-recognition-v1",exchange->{auth.set(exchange.getRequestHeaders().getFirst("Authorization"));captured.set(json.readMap(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8)));byte[] out="{\"status\":\"ok\",\"result\":{\"format\":\"MatchReviewBatchResultV1\",\"items\":[]}}".getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(200,out.length);exchange.getResponseBody().write(out);exchange.close();});server.start();
        try{
            var connections=org.mockito.Mockito.mock(com.hs.jxc.pur.service.impl.PurchaseImportConnections.class);UUID task=UUID.randomUUID();String token="101:task-token";
            org.mockito.Mockito.when(connections.forTask(task,token)).thenReturn(Map.of("n8n",Map.of("enabled",true,"source","PAGE","timeoutSeconds",10,"recognitionUrl","http://127.0.0.1:"+server.getAddress().getPort()+"/webhook/jxc-purchase-recognition-v1","recognitionKey","pinned-workflow-key")));
            var client=new PurchaseImportRecognitionClient(connections,new com.hs.jxc.sys.integrations.ExternalServiceHttp(json),json);
            client.reviewBatch(task,token,Map.of("format","MatchReviewBatchV1","rows",List.of(Map.of("runId",task.toString())),"images",List.of()));
            assertThat(auth.get()).isEqualTo("Bearer pinned-workflow-key");assertThat(captured.get()).containsEntry("taskId",task.toString()).containsEntry("credential",token);
            assertThat(json.write(captured.get().get("rows"))).doesNotContain(token,"pinned-workflow-key");assertThat(json.write(captured.get().get("images"))).doesNotContain(token,"pinned-workflow-key");
        }finally{server.stop(0);}
    }
    @Test void batchReviewUsesTheRestrictedEndpointAndReturnsStructuredRowResults()throws Exception{
        var server=com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);var request=new java.util.concurrent.atomic.AtomicReference<String>();
        server.createContext("/webhook/jxc-purchase-recognition-v1",exchange->{request.set(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));byte[] body="{\"status\":\"ok\",\"result\":{\"format\":\"MatchReviewBatchResultV1\",\"items\":[{\"rowId\":1},{\"rowId\":2}]}}".getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(200,body.length);exchange.getResponseBody().write(body);exchange.close();});server.start();
        try{var client=new PurchaseImportRecognitionClient("","","http://127.0.0.1:"+server.getAddress().getPort()+"/webhook/jxc-purchase-recognition-v1","test-key",new JsonCodec());var result=client.reviewBatch(UUID.randomUUID(),"101:test-task",Map.of("format","MatchReviewBatchV1","rows",List.of(Map.of("rowId",1),Map.of("rowId",2)),"images",List.of()));assertThat((List<?>)result.get("items")).hasSize(2);assertThat(request.get()).contains("MatchReviewBatchV1").doesNotContain("credential","test-key");}
        finally{server.stop(0);}
    }
    @Test void restrictedWorkflowDoesNotAttemptAnH2cUpgrade()throws Exception {
        var server=com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        var upgrade=new java.util.concurrent.atomic.AtomicReference<String>();
        var settings=new java.util.concurrent.atomic.AtomicReference<String>();
        server.createContext("/webhook/jxc-purchase-recognition-v1",exchange->{
            upgrade.set(exchange.getRequestHeaders().getFirst("Upgrade"));
            settings.set(exchange.getRequestHeaders().getFirst("HTTP2-Settings"));
            exchange.getRequestBody().readAllBytes();byte[] response="{\"status\":\"ok\",\"receipt\":{\"saved\":true}}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200,response.length);exchange.getResponseBody().write(response);exchange.close();
        });server.start();
        try {
            var client=new PurchaseImportRecognitionClient("","","http://127.0.0.1:"+server.getAddress().getPort()+"/webhook/jxc-purchase-recognition-v1","test-key",new JsonCodec());
            assertThat(client.recognize(UUID.randomUUID(),"101:test-task",Map.of("format","MatchTaskV1"))).containsEntry("saved",true);
            assertThat(upgrade.get()).as("n8n webhook must receive an ordinary HTTP/1.1 request").isNull();
            assertThat(settings.get()).isNull();
        } finally {server.stop(0);}
    }
    @Test void oldModelProxyCannotReceiveARestrictedTaskCredential(){
        var client=new PurchaseImportRecognitionClient("","","http://127.0.0.1:1/webhook/purchase-assistant/completions","test-key",new JsonCodec());
        assertThatThrownBy(()->client.recognize(UUID.randomUUID(),"101:test-task",Map.of("format","MatchTaskV1"))).isInstanceOf(ApiException.class).extracting("code").isEqualTo("N8N_CONFIG_INVALID");
    }
    @Test void workflowFailuresDoNotReflectArbitraryHeadersOrErrorDetails()throws Exception{
        var server=com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        var body=new java.util.concurrent.atomic.AtomicReference<String>();
        server.createContext("/webhook/jxc-purchase-recognition-v1",exchange->{body.set(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));assertThat(exchange.getRequestHeaders().getFirst("Authorization")).isEqualTo("Bearer test-key");byte[] response="{\"status\":\"error\",\"message\":\"secret-marker\",\"details\":{\"Authorization\":\"secret-marker\"}}".getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(500,response.length);exchange.getResponseBody().write(response);exchange.close();});server.start();
        try{var client=new PurchaseImportRecognitionClient("","","http://127.0.0.1:"+server.getAddress().getPort()+"/webhook/jxc-purchase-recognition-v1","test-key",new JsonCodec());assertThatThrownBy(()->client.recognize(UUID.randomUUID(),"101:test-task",Map.of("format","MatchTaskV1"))).isInstanceOf(ApiException.class).hasMessageNotContaining("secret-marker").satisfies(error->assertThat(((ApiException)error).getData()).isNull());assertThat(body.get()).contains("MatchTaskV1").doesNotContain("test-key","XLSX","base64");}
        finally{server.stop(0);}
    }
}
