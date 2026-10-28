package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.*;
import com.hs.jxc.pur.service.PurchaseImportRecognitionClient;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.junit.jupiter.api.Test;

class PurchaseImportRecognitionClientTest {
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
