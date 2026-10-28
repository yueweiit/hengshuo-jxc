package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.pur.service.impl.*;
import com.hs.jxc.pur.service.PurchaseImportRecognitionClient;
import com.hs.jxc.sys.service.SessionService;
import java.util.*;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/** 采购导入各模块共用隔离数据库、MinIO及来源夹具；不包含测试用例。 */
abstract class PurchaseImportFixture extends BasePgIT {
    @Autowired PurchaseImportServiceImpl imports;
    @Autowired PurchaseImportTaskServiceImpl tasks;
    @Autowired com.hs.jxc.common.api.JsonCodec codec;
    @org.springframework.beans.factory.annotation.Value("${local.server.port}") int port;
    @MockitoBean PurchaseImportRecognitionClient parser;
    final String tokenHash=SessionService.digest("purchase-import-source-test");
    final RequestContext actor=new RequestContext(201,101L,"source-test",tokenHash);
    final byte[] file="PK-test-source".getBytes(StandardCharsets.UTF_8);
    @DynamicPropertySource static void storage(DynamicPropertyRegistry r) {
        r.add("jxc.purchase-import.worker-enabled",()->true);
        r.add("jxc.storage.endpoint",MinioTestStorage::endpoint);
        r.add("jxc.storage.access-key",()->MinioTestStorage.ACCESS);
        r.add("jxc.storage.secret-key",()->MinioTestStorage.SECRET);
        r.add("jxc.storage.bucket",()->MinioTestStorage.BUCKET);
    }
    // 隔离容器曾出现毫秒级时钟回拨；初始授权明确提前生效，时效边界由专门用例覆盖。
    @BeforeEach void fixture() {
        InventoryIT.seedBase();
        owner.update("INSERT INTO sys_authz_epoch(country_id) VALUES(101)");
        owner.update("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,201,clock_timestamp()+interval '1 hour')",tokenHash);
        owner.update("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(801,101,'IMPORT','Import','[\"pur:order:*\"]','{\"COST\":\"WRITE\",\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\"}')");
        owner.update("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(101,201,801)");
        owner.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by,effective_from) VALUES(101,201,'BOOK',601,201,clock_timestamp()-interval '1 day')");
        owner.update("INSERT INTO md_currency(code,name) VALUES('USD','美元')");
        owner.update("INSERT INTO md_supplier(id,country_id,code,name,settle_currency) VALUES(901,101,'S','Supplier','USD')");
    }
    Map<String,Object> header(){var h=new LinkedHashMap<String,Object>();h.put("bookId",601);h.put("supplierId",901);h.put("currency","USD");h.put("orderDate","2026-10-28");h.put("expectedDate",null);h.put("paymentTerms","");h.put("prepayRatio","0");h.put("termDays",null);return h;}
    Map<String,Object> values(){var v=new LinkedHashMap<String,Object>();for(String k:List.of("sourceOrderNo","photo","productSpec","purchaseQty","saleUnitPrice","saleTotal","purchaseUnitPrice","freight","landedUnitCost","usdUnitCost","usdTotal"))v.put(k,null);v.put("sourceOrderNo","PO-1");v.put("productSpec","S");v.put("purchaseQty","10");v.put("purchaseUnitPrice","53.1234567890");return v;}
    @SuppressWarnings("unchecked") List<Map<String,Object>> rows(Map<String,Object> b){return (List<Map<String,Object>>)b.get("rows");}
    @SuppressWarnings("unchecked") List<Map<String,Object>> groups(Map<String,Object>b){return (List<Map<String,Object>>)b.get("groups");}
    UUID id(Map<String,Object>b){return UUID.fromString(b.get("batchId").toString());}
    UUID task(Map<String,Object>b){return UUID.fromString(b.get("taskId").toString());}
    Map<String,Object> upload(String key){return imports.upload(actor,"采购.xlsx",file,header(),null,key);}
    Map<String,Object> document(){
        var source=Map.of("fileSha256",com.hs.jxc.attachment.AttachmentObjectStore.sha256(file),"parserVersion","fixture-v1");
        return new LinkedHashMap<>(Map.of("format","SourceDocumentV1","source",source,"sheets",List.of(Map.of("name","采购","role","PURCHASE")),"rows",List.of(Map.of("sourceSheet","采购","sourceRow",2,"originalValues",Map.of("G","53.1234567890"),"rawNumericTexts",Map.of("G","53.1234567890"),"formulas",Map.of(),"cachedValues",Map.of(),"normalizedValues",values())),"images",List.of(),"associations",List.of(),"warnings",List.of(),"errors",List.of()));
    }
    Map<String,Object> photoDocument(){var doc=document();byte[] png=Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=");String hash=com.hs.jxc.attachment.AttachmentObjectStore.sha256(png);doc.put("images",List.of(Map.of("imageId",hash,"sha256",hash,"mimeType","image/png","bytes",png.length,"width",1,"height",1,"mediaPart","xl/media/image1.png","contentBase64",Base64.getEncoder().encodeToString(png))));doc.put("associations",List.of(Map.of("imageId",hash,"sourceSheet","采购","sourceRow",2,"anchor",Map.of("from",2),"status","UNCONFIRMED")));return doc;}
    void parse(Map<String,Object>b){
        doReturn(document()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task(b));
    }
    Map<String,Object> vector(){byte[] bytes=new byte[384*4];java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN).putFloat(1);return Map.of("modelName",com.hs.jxc.md.api.ProductImageApi.MODEL,"modelVersion",com.hs.jxc.md.api.ProductImageApi.MODEL_VERSION,"preprocessVersion",com.hs.jxc.md.api.ProductImageApi.PREPROCESS,"dimension",384,"data",Base64.getEncoder().encodeToString(bytes));}
    Map<String,Object> indexResult(Map<String,Object> input){byte[] bytes="faiss-protocol-fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);var result=new LinkedHashMap<String,Object>();for(String field:List.of("countryId","generation","modelName","modelVersion","preprocessVersion","dimension","featureIds"))result.put(field,input.get(field));result.put("indexBase64",Base64.getEncoder().encodeToString(bytes));result.put("indexSha256",com.hs.jxc.attachment.AttachmentObjectStore.sha256(bytes));return result;}
    org.testcontainers.containers.GenericContainer<?> featureContainer(String image,boolean drafts){return new org.testcontainers.containers.GenericContainer<>(org.testcontainers.utility.DockerImageName.parse(image))
        .withEnv("JXC_DB_URL","jdbc:postgresql://host.docker.internal:"+PgDatabase.PG.getMappedPort(5432)+"/"+PgDatabase.PG.getDatabaseName()).withEnv("JXC_DB_USER","jxc_app").withEnv("JXC_DB_PASSWORD",PgDatabase.PASSWORD).withEnv("JXC_BIND_ADDRESS","0.0.0.0").withEnv("JXC_STORAGE_ENDPOINT","http://host.docker.internal:"+MinioTestStorage.MINIO.getMappedPort(9000)).withEnv("JXC_STORAGE_ACCESS_KEY",MinioTestStorage.ACCESS).withEnv("JXC_STORAGE_SECRET_KEY",MinioTestStorage.SECRET).withEnv("JXC_STORAGE_BUCKET",MinioTestStorage.BUCKET).withEnv("JXC_PURCHASE_IMPORT_WORKER_ENABLED","true").withEnv("JXC_PURCHASE_IMPORT_DRAFT_CREATION_ENABLED",String.valueOf(drafts))
        .withExposedPorts(8080).withCreateContainerCmdModifier(c->c.withEntrypoint("java")).withCommand("-Xmx384m","-Dfile.encoding=UTF-8","-jar","/app/app.jar","--spring.flyway.enabled=false","--jxc.jobs.enabled=false").waitingFor(org.testcontainers.containers.wait.strategy.Wait.forHttp("/actuator/health").forPort(8080).withStartupTimeout(java.time.Duration.ofSeconds(90)));}

    record Bridge(java.lang.Process process,PurchaseImportRecognitionClient client) implements AutoCloseable {public void close()throws Exception{process.destroy();if(!process.waitFor(5,java.util.concurrent.TimeUnit.SECONDS))process.destroyForcibly().waitFor();}}
    Bridge startBridge(String python)throws Exception {return startBridge(python,"workbench.jxc_bridge:app");}
    Bridge startBridge(String python,String module)throws Exception {
        int bridgePort;try(var socket=new java.net.ServerSocket(0)){bridgePort=socket.getLocalPort();}var log=java.nio.file.Path.of("target/purchase-import-real-bridge-"+UUID.randomUUID()+".log").toAbsolutePath();var process=new ProcessBuilder(python,"-m","uvicorn",module,"--host","127.0.0.1","--port",String.valueOf(bridgePort),"--no-access-log").directory(java.nio.file.Path.of("C:/project/docling-demo").toFile()).redirectErrorStream(true).redirectOutput(log.toFile());String key=UUID.randomUUID().toString();process.environment().put("JXC_ASSET_BASE_URL","http://127.0.0.1:"+port);process.environment().put("JXC_BRIDGE_WORKER_KEY",key);process.environment().put("PYTHONIOENCODING","utf-8");var running=process.start();
        try{var http=java.net.http.HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(1)).build();for(int n=0;n<80;n++){try{if(http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+bridgePort+"/")).timeout(java.time.Duration.ofSeconds(1)).GET().build(),java.net.http.HttpResponse.BodyHandlers.discarding()).statusCode()==404)return new Bridge(running,new PurchaseImportRecognitionClient("http://127.0.0.1:"+bridgePort,key,codec));}catch(java.io.IOException unavailable){if(!running.isAlive())throw new AssertionError("桥接进程退出，请检查"+log);}Thread.sleep(250);}throw new AssertionError("桥接进程未就绪，请检查"+log);}catch(Throwable error){running.destroyForcibly().waitFor();throw error;}
    }

}
