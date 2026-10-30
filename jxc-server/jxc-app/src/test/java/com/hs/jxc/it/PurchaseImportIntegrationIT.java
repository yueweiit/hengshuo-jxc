package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import com.hs.jxc.sys.integrations.ExternalServiceConfig;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties="jxc.integrations.master-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
class PurchaseImportIntegrationIT extends PurchaseImportFixture {
    @Autowired ExternalServiceConfig config;
    @Autowired com.hs.jxc.pur.service.impl.PurchaseImportConnections connections;
    @Autowired com.hs.jxc.sys.integrations.ExternalServiceHttp transport;
    @Test void taskPinsConfigurationAndRestrictedModelUsesOldSecretAfterAdminChangesSettings()throws Exception{
        owner.update("UPDATE sys_user SET is_platform_admin=true WHERE id=201");
        var received=new AtomicReference<Map<String,Object>>();var authorization=new AtomicReference<String>();
        var server=com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/chat/completions",exchange->{authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));received.set(codec.readMap(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8)));byte[] out=codec.write(Map.of("choices",List.of(Map.of("message",Map.of("content","{}"))))).getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(200,out.length);exchange.getResponseBody().write(out);exchange.close();});server.start();
        try{
            String root="http://127.0.0.1:"+server.getAddress().getPort();config.save(actor,"deepseek",model(0,root,"first-key","first-model"));
            var batch=upload(UUID.randomUUID().toString());
            doAnswer(invocation->{
                String credential=invocation.getArgument(1);
                assertThat(owner.queryForObject("SELECT service_config_version FROM pur_order_import_task WHERE id=?",Integer.class,task(batch))).isEqualTo(1);
                config.save(actor,"deepseek",model(1,root,"new-key","new-model"));
                var prompt=Map.of("model","untrusted-model","messages",List.of(Map.of("role","system","content","仅识别采购字段"),Map.of("role","user","content","合成表格")));
                var reply=internal(task(batch),credential,Map.of("purpose","FIELDS","prompt",prompt),200);
                assertThat(reply).containsKey("choices");
                internal(task(batch),credential,Map.of("purpose","REVIEW","prompt",prompt),403);
                internal(task(batch),"101:invalid",Map.of("purpose","FIELDS","prompt",prompt),403);
                var unsafe=Map.of("messages",List.of(Map.of("role","system","content","固定用途"),Map.of("role","user","content",List.of(Map.of("type","image_url","image_url",Map.of("url","http://example.com/private.png"))))));
                internal(task(batch),credential,Map.of("purpose","FIELDS","prompt",unsafe),400);
                internal(task(batch),credential,Map.of("purpose","FIELDS","prompt",prompt),200);
                internal(task(batch),credential,Map.of("purpose","FIELDS","prompt",prompt),429);
                return document();
            }).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
            tasks.execute(101,task(batch));
            assertThat(tasks.get(actor,task(batch))).containsEntry("status","SUCCEEDED");
            assertThat(authorization.get()).isEqualTo("Bearer first-key");assertThat(received.get()).containsEntry("model","first-model");
            assertThat(codec.write(received.get())).doesNotContain("first-key","new-key","credential");
            internal(task(batch),"101:invalid",Map.of("purpose","FIELDS","prompt",Map.of()),403);
            var next=upload(UUID.randomUUID().toString());parse(next);
            assertThat(owner.queryForObject("SELECT service_config_version FROM pur_order_import_task WHERE id=?",Integer.class,task(next))).isEqualTo(2);
        }finally{server.stop(0);}
    }
    @Test void explicitlyRetryingAFailedTaskUsesCorrectedConfiguration() {
        owner.update("UPDATE sys_user SET is_platform_admin=true WHERE id=201");
        config.save(actor,"deepseek",model(0,"http://127.0.0.1:1","old-key","old-model"));
        var batch=upload(UUID.randomUUID().toString());
        doThrow(new com.hs.jxc.common.api.ApiException(503,"PARSER_UNAVAILABLE","合成连接失败")).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task(batch));
        assertThat(tasks.get(actor,task(batch))).containsEntry("status","FAILED");
        config.save(actor,"deepseek",model(1,"http://127.0.0.1:1","fixed-key","fixed-model"));
        tasks.retry(actor,task(batch),UUID.randomUUID().toString(),null);parse(batch);
        assertThat(tasks.get(actor,task(batch))).containsEntry("status","SUCCEEDED");
        assertThat(owner.queryForObject("SELECT service_config_version FROM pur_order_import_task WHERE id=?",Integer.class,task(batch))).isEqualTo(2);
    }
    @Test void savedWorkerAndFieldWorkflowAreUsedThroughTheOriginalParseTask()throws Exception{
        owner.update("UPDATE sys_user SET is_platform_admin=true WHERE id=201");
        var called=new java.util.concurrent.CopyOnWriteArrayList<String>();
        var serverFailure=new AtomicReference<Throwable>();
        var pool=java.util.concurrent.Executors.newCachedThreadPool();
        var server=com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);server.setExecutor(pool);
        server.createContext("/",exchange->{
            try{
                var input=codec.readMap(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));Map<String,Object> output;
                switch(exchange.getRequestURI().getPath()){
                    case "/internal/jxc/supplier-parse" -> {
                        assertThat(exchange.getRequestHeaders().getFirst("Authorization")).isEqualTo("Bearer worker-key");assertThat(input).containsEntry("managedServices",true);called.add("worker");
                        var source=new LinkedHashMap<String,Object>(Map.of("format","SupplierDocumentV1","fileSha256",input.get("sha256"),"rows",List.of(Map.of("source_sheet","采购","source_row",2,"row_kind","detail","cells",Map.of("A","PO-1"))),"tables",List.of(),"sourceCells",List.of()));source.put("sheet",null);
                        internal(UUID.fromString(input.get("taskId").toString()),input.get("credential").toString(),"fields",source,200);output=Map.of("status","ok","document",document());
                    }
                    case "/webhook/jxc-purchase-fields-v1" -> {
                        assertThat(exchange.getRequestHeaders().getFirst("Authorization")).isEqualTo("Bearer fields-key");assertThat(input).containsKeys("document","taskId","credential");called.add("n8n");
                        var prompt=Map.of("messages",List.of(Map.of("role","system","content","仅处理采购映射"),Map.of("role","user","content",codec.write(input.get("document")))));
                        internal(UUID.fromString(input.get("taskId").toString()),input.get("credential").toString(),Map.of("purpose","FIELDS","prompt",prompt),200);
                        output=Map.of("status","ok","mapping",Map.of("format","SupplierMappingV1"));
                    }
                    case "/chat/completions" -> {assertThat(exchange.getRequestHeaders().getFirst("Authorization")).isEqualTo("Bearer provider-key");assertThat(input).containsEntry("model","configured-model");called.add("model");output=Map.of("choices",List.of(Map.of("message",Map.of("content","{}"))));}
                    default -> throw new AssertionError("Unexpected route");
                }
                byte[] out=codec.write(output).getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(200,out.length);exchange.getResponseBody().write(out);
            }catch(Exception|AssertionError failure){serverFailure.set(failure);byte[] out="{}".getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(500,out.length);exchange.getResponseBody().write(out);}
            finally{exchange.close();}
        });server.start();
        try{
            String root="http://127.0.0.1:"+server.getAddress().getPort();
            config.save(actor,"deepseek",model(0,root,"provider-key","configured-model"));
            config.save(actor,"n8n",Map.of("version",1,"enabled",true,"fieldsUrl",root+"/webhook/jxc-purchase-fields-v1","fieldsKey","fields-key","recognitionUrl",root+"/webhook/jxc-purchase-recognition-v1","recognitionKey","recognition-key","timeoutSeconds",15));
            config.save(actor,"docling",Map.of("version",2,"enabled",true,"url",root,"key","worker-key","timeoutSeconds",15));
            var real=new com.hs.jxc.pur.service.PurchaseImportRecognitionClient(connections,transport,codec);
            doAnswer(call->real.parse(call.getArgument(0),call.getArgument(1),call.getArgument(2),call.getArgument(3),call.getArgument(4))).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
            var batch=upload(UUID.randomUUID().toString());tasks.execute(101,task(batch));
            assertThat(serverFailure.get()).isNull();assertThat(tasks.get(actor,task(batch))).containsEntry("status","SUCCEEDED");assertThat(called).containsExactly("worker","n8n","model");
            assertThat(owner.queryForObject("SELECT service_config_version FROM pur_order_import_task WHERE id=?",Integer.class,task(batch))).isEqualTo(3);
        }finally{server.stop(0);pool.shutdownNow();}
    }
    Map<String,Object> model(int version,String url,String key,String name){return Map.of("version",version,"enabled",true,"url",url,"key",key,"model",name,"timeoutSeconds",10);}
    Map<String,Object> internal(UUID task,String credential,Object input,int expected)throws Exception{
        return internal(task,credential,"model",input,expected);
    }
    Map<String,Object> internal(UUID task,String credential,String operation,Object input,int expected)throws Exception{
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/internal/purchase-import/tasks/"+task+"/"+operation)).timeout(java.time.Duration.ofSeconds(20)).header("Content-Type","application/json").header("X-Purchase-Task",credential).POST(HttpRequest.BodyPublishers.ofString(codec.write(input))).build();
        var response=HttpClient.newHttpClient().send(request,HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).as(response.body()).isEqualTo(expected);return codec.readMap(response.body());
    }
}
