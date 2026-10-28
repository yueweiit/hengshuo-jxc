package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.pur.*;
import com.hs.jxc.sys.service.SessionService;
import java.util.*;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/** 仅替换外部解析网络；授权、租约、MinIO、迁移和全部CRUD使用真实实现。 */
class PurchaseImportSourceIT extends BasePgIT {
    @Autowired PurchaseImportService imports;
    @Autowired PurchaseImportTaskService tasks;
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
    @BeforeEach void fixture() {
        InventoryIT.seedBase();
        owner.update("INSERT INTO sys_authz_epoch(country_id) VALUES(101)");
        owner.update("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,201,clock_timestamp()+interval '1 hour')",tokenHash);
        owner.update("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(801,101,'IMPORT','Import','[\"pur:order:*\"]','{\"COST\":\"WRITE\",\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\"}')");
        owner.update("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(101,201,801)");
        owner.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) VALUES(101,201,'BOOK',601,201)");
        owner.update("INSERT INTO md_currency(code,name) VALUES('USD','美元')");
        owner.update("INSERT INTO md_supplier(id,country_id,code,name,settle_currency) VALUES(901,101,'S','Supplier','USD')");
    }
    Map<String,Object> header(){var h=new LinkedHashMap<String,Object>();h.put("bookId",601);h.put("supplierId",901);h.put("currency","USD");h.put("orderDate","2026-10-28");h.put("expectedDate",null);h.put("paymentTerms","");h.put("prepayRatio","0");h.put("termDays",null);return h;}
    Map<String,Object> values(){var v=new LinkedHashMap<String,Object>();for(String k:List.of("sourceOrderNo","photo","productSpec","purchaseQty","saleUnitPrice","saleTotal","purchaseUnitPrice","freight","landedUnitCost","usdUnitCost","usdTotal"))v.put(k,null);v.put("sourceOrderNo","PO-1");v.put("productSpec","S");v.put("purchaseQty","10");v.put("purchaseUnitPrice","53.1234567890");return v;}
    @SuppressWarnings("unchecked") List<Map<String,Object>> rows(Map<String,Object> b){return (List<Map<String,Object>>)b.get("rows");}
    UUID id(Map<String,Object>b){return UUID.fromString(b.get("batchId").toString());}
    UUID task(Map<String,Object>b){return UUID.fromString(b.get("taskId").toString());}
    Map<String,Object> upload(String key){return imports.upload(actor,"采购.xlsx",file,header(),null,key);}
    Map<String,Object> document(){
        var source=Map.of("fileSha256",com.hs.jxc.attachment.AttachmentObjectStore.sha256(file),"parserVersion","fixture-v1");
        return new LinkedHashMap<>(Map.of("format","SourceDocumentV1","source",source,"sheets",List.of(Map.of("name","采购","role","PURCHASE")),"rows",List.of(Map.of("sourceSheet","采购","sourceRow",2,"originalValues",Map.of("G","53.1234567890"),"rawNumericTexts",Map.of("G","53.1234567890"),"formulas",Map.of(),"cachedValues",Map.of(),"normalizedValues",values())),"images",List.of(),"associations",List.of(),"warnings",List.of(),"errors",List.of()));
    }
    void parse(Map<String,Object>b){
        doReturn(document()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task(b));
    }
    @Test void uploadIsDurableAndOnlySuccessfulParsingProducesRowsWithoutBusinessWrites(){
        var b=upload(UUID.randomUUID().toString());assertThat(rows(b)).isEmpty();assertThat(b.get("status")).isEqualTo("PARSING");parse(b);
        var saved=imports.get(actor,id(b));assertThat(rows(saved)).hasSize(1);assertThat(rows(saved).getFirst()).containsEntry("purchaseUnitPrice","53.1234567890").containsEntry("sourceRow",2);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM md_product",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT count(*) FROM md_product_image",Integer.class)).isZero();
    }
    @Test void sameIntentDoesNotAppendAgainAndDifferentContentUnderSameKeyConflicts(){
        String key=UUID.randomUUID().toString();var a=upload(key);var b=upload(key);assertThat(b.get("batchId")).isEqualTo(a.get("batchId"));
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_source",Integer.class)).isEqualTo(1);
        assertThatThrownBy(()->imports.upload(actor,"采购.xlsx","other".getBytes(StandardCharsets.UTF_8),header(),null,key)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SYS_IDEMPOTENCY_CONFLICT");
    }
    @Test void editKeepsOriginalsRejectsStaleVersionAndLastDeleteKeepsBatch(){
        var b=upload(UUID.randomUUID().toString());parse(b);var saved=imports.get(actor,id(b));var row=rows(saved).getFirst();long rowId=((Number)row.get("id")).longValue();var v=values();v.put("purchaseQty","12");
        var updated=imports.saveRow(actor,id(b),rowId,Map.of("version",1,"values",v));assertThat(updated).containsEntry("purchaseQty","12.0000");
        assertThatThrownBy(()->imports.saveRow(actor,id(b),rowId,Map.of("version",1,"values",v))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);
        assertThat(owner.queryForObject("SELECT original_values->>'G' FROM pur_order_import WHERE id=?",String.class,rowId)).isEqualTo("53.1234567890");
        imports.deleteRow(actor,id(b),rowId,2);assertThat(rows(imports.get(actor,id(b)))).isEmpty();
    }
    @Test void failedParserLeavesExplicitFailedTaskAndRetryReusesSource(){
        var b=upload(UUID.randomUUID().toString());when(parser.parse(any(),anyString(),anyLong(),anyString(),isNull())).thenThrow(new ApiException(503,"PARSER_UNAVAILABLE","解析服务不可用"));tasks.execute(101,task(b));
        assertThat(tasks.get(actor,task(b))).containsEntry("status","FAILED").containsEntry("errorCode","PARSER_UNAVAILABLE");
        tasks.retry(actor,task(b),UUID.randomUUID().toString(),null);parse(b);assertThat(rows(imports.get(actor,id(b)))).hasSize(1);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_source",Integer.class)).isEqualTo(1);
    }
    @Test void revokedSessionCannotFinishOrReadAssets(){
        var b=upload(UUID.randomUUID().toString());owner.update("UPDATE sys_session SET revoked_at=clock_timestamp() WHERE token_hash=?",tokenHash);tasks.execute(101,task(b));
        assertThat(owner.queryForObject("SELECT status FROM pur_order_import_task WHERE id=?",String.class,task(b))).isEqualTo("NEEDS_REAUTH");
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import",Integer.class)).isZero();
    }
    @Test void headerVersionAndFieldPoliciesAreEnforced(){
        var b=upload(UUID.randomUUID().toString());parse(b);var saved=imports.get(actor,id(b));var h=header();h.put("paymentTerms","30天");var versions=rows(saved).stream().map(r->Map.of("id",r.get("id"),"version",r.get("version"))).toList();
        imports.saveHeader(actor,id(b),Map.of("header",h,"versions",versions,"batchVersion",saved.get("version")));
        assertThatThrownBy(()->imports.saveHeader(actor,id(b),Map.of("header",h,"versions",versions,"batchVersion",saved.get("version")))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);
        owner.update("UPDATE sys_role SET field_policies='{}',version=version+1 WHERE id=801");assertThatThrownBy(()->imports.get(actor,id(b))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(403);
    }
    @Test void samePhotoCanBelongToTwoSpecificationRowsWithoutPublishingEither() {
        var b=upload(UUID.randomUUID().toString());var doc=document();var first=new LinkedHashMap<>(listRows(doc).getFirst());var second=new LinkedHashMap<>(first);second.put("sourceRow",3);var v=values();v.put("productSpec","M");second.put("normalizedValues",v);doc.put("rows",List.of(first,second));
        byte[] png=Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=");String hash=com.hs.jxc.attachment.AttachmentObjectStore.sha256(png);
        doc.put("images",List.of(Map.of("imageId",hash,"sha256",hash,"mimeType","image/png","bytes",png.length,"width",1,"height",1,"mediaPart","xl/media/image1.png","contentBase64",Base64.getEncoder().encodeToString(png))));
        doc.put("associations",List.of(Map.of("imageId",hash,"sourceSheet","采购","sourceRow",2,"anchor",Map.of("from",2),"status","UNCONFIRMED"),Map.of("imageId",hash,"sourceSheet","采购","sourceRow",3,"anchor",Map.of("from",3),"status","UNCONFIRMED")));
        doReturn(doc).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));
        var saved=imports.get(actor,id(b));assertThat(rows(saved)).hasSize(2);long image=owner.queryForObject("SELECT id FROM pur_order_import_image",Long.class);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_row_image",Integer.class)).isEqualTo(2);
        long rowId=((Number)rows(saved).getFirst().get("id")).longValue();var confirmed=imports.associate(actor,id(b),rowId,image,Map.of("version",1,"association","CONFIRMED"));assertThat(confirmed).containsEntry("version",2).containsEntry("batchVersion",3);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_row_image WHERE association_status='UNCONFIRMED'",Integer.class)).isEqualTo(1);
        assertThat(imports.content(actor,id(b),image,true).bytes()).containsExactly(png);assertThat(owner.queryForObject("SELECT count(*) FROM md_product_image",Integer.class)).isZero();
    }
    @SuppressWarnings("unchecked") List<Map<String,Object>> listRows(Map<String,Object>d){return (List<Map<String,Object>>)d.get("rows");}
    @Test void scopedTaskCredentialCanReadOnlyItsOwnSourceAndIsRevokedAfterCompletion() {
        var b=upload(UUID.randomUUID().toString());var credential=new java.util.concurrent.atomic.AtomicReference<String>();
        doAnswer(call->{String cap=call.getArgument(1);long source=call.getArgument(2);credential.set(cap);assertThat(tasks.taskAsset(task(b),source,cap).bytes()).containsExactly(file);assertThatThrownBy(()->tasks.taskAsset(task(b),source+1,cap)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(403);return document();}).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task(b));long source=owner.queryForObject("SELECT source_id FROM pur_order_import_task WHERE id=?",Long.class,task(b));
        assertThat(rows(imports.get(actor,id(b)))).hasSize(1);assertThatThrownBy(()->tasks.taskAsset(task(b),source,credential.get())).isInstanceOf(ApiException.class).extracting("status").isEqualTo(403);
    }
    @Test void wrongSourceHashAndLateResultsDoNotChangeExistingManualRows(){
        var b=upload(UUID.randomUUID().toString());var doc=document();doc.put("source",Map.of("fileSha256","0".repeat(64),"parserVersion","wrong"));doReturn(doc).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));assertThat(rows(imports.get(actor,id(b)))).isEmpty();assertThat(tasks.get(actor,task(b)).get("status")).isEqualTo("FAILED");
        tasks.retry(actor,task(b),UUID.randomUUID().toString(),null);imports.saveHeader(actor,id(b),Map.of("header",header(),"versions",List.of(),"batchVersion",1));tasks.execute(101,task(b));assertThat(tasks.get(actor,task(b)).get("status")).isEqualTo("STALE");assertThat(rows(imports.get(actor,id(b)))).isEmpty();
    }
    @Test void sourceLargerThanOrdinaryAttachmentLimitIsPrivateReadableAndBookScopeProtected(){
        byte[] large=new byte[2*1024*1024];Arrays.fill(large,(byte)'x');var b=imports.upload(actor,"large.xlsx",large,header(),null,UUID.randomUUID().toString());long source=owner.queryForObject("SELECT source_id FROM pur_order_import_task WHERE id=?",Long.class,task(b));assertThat(imports.content(actor,id(b),source,false).bytes()).containsExactly(large);
        owner.update("DELETE FROM sys_user_data_scope WHERE user_id=201");assertThatThrownBy(()->imports.get(actor,id(b))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);assertThatThrownBy(()->imports.content(actor,id(b),source,false)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);
    }
    @Test void appendingUsesCurrentHeaderAndAllocatesStableRowsWithoutDuplicateParsing(){
        var b=upload(UUID.randomUUID().toString());parse(b);var appended=imports.upload(actor,"another.xlsx",file,header(),id(b),UUID.randomUUID().toString());parse(appended);tasks.execute(101,task(appended));var saved=imports.get(actor,id(b));assertThat(rows(saved)).extracting(r->r.get("rowNo")).containsExactly(1,2);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_source",Integer.class)).isEqualTo(2);
    }
    java.net.http.HttpResponse<String> httpUpload(String base)throws Exception {
        String boundary="purchase-source-boundary";String body="--"+boundary+"\r\nContent-Disposition: form-data; name=\"header\"\r\n\r\n"+codec.write(header())+"\r\n--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"purchase.xlsx\"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\nPK-test-source\r\n--"+boundary+"--\r\n";
        var http=java.net.http.HttpClient.newHttpClient();
        var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+"/api/v1/pur/order-imports")).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Idempotency-Key",UUID.randomUUID().toString()).header("Content-Type","multipart/form-data; boundary="+boundary).POST(java.net.http.HttpRequest.BodyPublishers.ofString(body)).build();
        return http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString());
    }
    @Test void realHttpUploadIsAcceptedAsTaskAndOtherInternalRoutesRemainProtected()throws Exception {
        String base="http://localhost:"+port;var http=java.net.http.HttpClient.newHttpClient();var response=httpUpload(base);assertThat(response.statusCode()).as(response.body()).isEqualTo(202);assertThat(codec.readMap(response.body()).get("code")).isEqualTo("OK");
        String asset="/internal/purchase-import/tasks/"+UUID.randomUUID()+"/assets/1";
        assertThat(http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+asset)).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
        assertThat(http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+asset)).POST(java.net.http.HttpRequest.BodyPublishers.noBody()).build(),java.net.http.HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
    }
    @Test void approvedRealWorkbookFitsSourceAssetPolicyWithoutChangingOriginal()throws Exception {
        String sample=System.getProperty("jxc.test.purchase-source");org.junit.jupiter.api.Assumptions.assumeTrue(sample!=null,"真实样本须显式传入，不能在其他环境静默替换为演示数据");
        byte[] bytes=java.nio.file.Files.readAllBytes(java.nio.file.Path.of(sample));assertThat(bytes.length).isEqualTo(54501763);String hash=com.hs.jxc.attachment.AttachmentObjectStore.sha256(bytes);assertThat(hash).isEqualTo("736d04418821c5c9304c65522e262ea2da6c20fdd1b8c27190de549fe2bf0f86");
        var b=imports.upload(actor,"NY-051-采购导入.xlsx",bytes,header(),null,UUID.randomUUID().toString());long source=owner.queryForObject("SELECT source_id FROM pur_order_import_task WHERE id=?",Long.class,task(b));assertThat(com.hs.jxc.attachment.AttachmentObjectStore.sha256(imports.content(actor,id(b),source,false).bytes())).isEqualTo(hash);assertThat(rows(b)).isEmpty();assertThat(com.hs.jxc.attachment.AttachmentObjectStore.sha256(java.nio.file.Files.readAllBytes(java.nio.file.Path.of(sample)))).isEqualTo(hash);
    }
    @Test void abandonedLeaseIsReclaimedWithoutAddingRowsTwice(){
        var b=upload(UUID.randomUUID().toString());owner.update("UPDATE pur_order_import_task SET status='RUNNING',lease_owner=?,lease_until=clock_timestamp()-interval '1 second' WHERE id=?",UUID.randomUUID(),task(b));doReturn(document()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());assertThat(tasks.recover(101,20)).isEqualTo(1);assertThat(tasks.recover(101,20)).isZero();assertThat(rows(imports.get(actor,id(b)))).hasSize(1);
    }
    @Test void isolatedFeatureDockerServesTheSameUploadAndReadContract()throws Exception {
        String image=System.getProperty("jxc.test.purchase-image");org.junit.jupiter.api.Assumptions.assumeTrue(image!=null,"仅在显式构建本地特性镜像后执行");
        try(var app=new org.testcontainers.containers.GenericContainer<>(org.testcontainers.utility.DockerImageName.parse(image))
                .withEnv("JXC_DB_URL","jdbc:postgresql://host.docker.internal:"+PgDatabase.PG.getMappedPort(5432)+"/"+PgDatabase.PG.getDatabaseName()).withEnv("JXC_DB_USER","jxc_app").withEnv("JXC_DB_PASSWORD",PgDatabase.PASSWORD).withEnv("JXC_BIND_ADDRESS","0.0.0.0").withEnv("JXC_STORAGE_ENDPOINT","http://host.docker.internal:"+MinioTestStorage.MINIO.getMappedPort(9000)).withEnv("JXC_STORAGE_ACCESS_KEY",MinioTestStorage.ACCESS).withEnv("JXC_STORAGE_SECRET_KEY",MinioTestStorage.SECRET).withEnv("JXC_STORAGE_BUCKET",MinioTestStorage.BUCKET).withEnv("JXC_PURCHASE_IMPORT_WORKER_ENABLED","true")
                .withExposedPorts(8080).withCreateContainerCmdModifier(c->c.withEntrypoint("java")).withCommand("-Xmx384m","-Dfile.encoding=UTF-8","-jar","/app/app.jar","--spring.flyway.enabled=false","--jxc.jobs.enabled=false").waitingFor(org.testcontainers.containers.wait.strategy.Wait.forHttp("/actuator/health").forPort(8080).withStartupTimeout(java.time.Duration.ofSeconds(90)))){
            app.start();String base="http://"+app.getHost()+":"+app.getMappedPort(8080);var http=java.net.http.HttpClient.newHttpClient();var accepted=httpUpload(base);assertThat(accepted.statusCode()).as(accepted.body()).isEqualTo(202);var b=codec.readMap(codec.write(codec.readMap(accepted.body()).get("data")));parse(b);
            var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+"/api/v1/pur/order-imports/"+id(b))).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").GET().build();var response=http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);assertThat(response.body()).contains("53.1234567890");
            String expected=com.hs.jxc.attachment.AttachmentObjectStore.sha256(java.nio.file.Files.readAllBytes(java.nio.file.Path.of("target/jxc-app-0.1.0-SNAPSHOT.jar")));assertThat(app.execInContainer("sha256sum","/app/app.jar").getStdout()).startsWith(expected+" ");
            var saved=imports.get(actor,id(b));long rowId=((Number)rows(saved).getFirst().get("id")).longValue();var value=values();value.put("purchaseQty","12");
            var changed=java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+"/api/v1/pur/order-imports/"+id(b)+"/rows/"+rowId)).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Content-Type","application/json").PUT(java.net.http.HttpRequest.BodyPublishers.ofString(codec.write(Map.of("version",1,"values",value)))).build();var edited=http.send(changed,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(edited.statusCode()).as(edited.body()).isEqualTo(200);assertThat(edited.body()).contains("12.0000");
        }
    }
    @Test void approvedRealParserBridgePersistsSixtyRowsAndOriginalImages()throws Exception {
        String python=System.getProperty("jxc.test.purchase-python"),sample=System.getProperty("jxc.test.purchase-source");org.junit.jupiter.api.Assumptions.assumeTrue(python!=null&&sample!=null,"实际Docling调用仅使用显式指定的解释器和样本");
        int bridgePort;try(var socket=new java.net.ServerSocket(0)){bridgePort=socket.getLocalPort();}
        var log=java.nio.file.Path.of("target/purchase-import-real-bridge.log").toAbsolutePath();var process=new ProcessBuilder(python,"-m","uvicorn","workbench.jxc_bridge:app","--host","127.0.0.1","--port",String.valueOf(bridgePort),"--no-access-log").directory(java.nio.file.Path.of("C:/project/docling-demo").toFile()).redirectErrorStream(true).redirectOutput(log.toFile());String workerKey=UUID.randomUUID().toString();process.environment().put("JXC_ASSET_BASE_URL","http://127.0.0.1:"+port);process.environment().put("JXC_BRIDGE_WORKER_KEY",workerKey);process.environment().put("PYTHONIOENCODING","utf-8");var bridge=process.start();
        try{
            var http=java.net.http.HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(1)).build();boolean ready=false;for(int n=0;n<80;n++){try{ready=http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+bridgePort+"/")).timeout(java.time.Duration.ofSeconds(1)).GET().build(),java.net.http.HttpResponse.BodyHandlers.discarding()).statusCode()==404;if(ready)break;}catch(java.io.IOException error){if(!bridge.isAlive())throw new AssertionError("桥接进程退出，请检查"+log);}Thread.sleep(250);}assertThat(ready).isTrue();
            var client=new PurchaseImportRecognitionClient("http://127.0.0.1:"+bridgePort,workerKey,codec);doAnswer(call->client.parse(call.getArgument(0),call.getArgument(1),call.getArgument(2),call.getArgument(3),call.getArgument(4))).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
            byte[] bytes=java.nio.file.Files.readAllBytes(java.nio.file.Path.of(sample));var b=imports.upload(actor,"NY-051-采购导入.xlsx",bytes,header(),null,UUID.randomUUID().toString());tasks.execute(101,task(b));var taskResult=tasks.get(actor,task(b));assertThat(taskResult).as(taskResult.toString()).containsEntry("status","SUCCEEDED");
            var saved=imports.get(actor,id(b));assertThat(rows(saved)).hasSize(60);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_image",Integer.class)).isEqualTo(20);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_row_image",Integer.class)).isEqualTo(60);assertThat(owner.queryForObject("SELECT sum(purchase_qty) FROM pur_order_import",java.math.BigDecimal.class)).isEqualByComparingTo("480");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM md_product_image",Integer.class)).isZero();
        }finally{bridge.destroy();if(!bridge.waitFor(5,java.util.concurrent.TimeUnit.SECONDS))bridge.destroyForcibly().waitFor();}
    }
}
