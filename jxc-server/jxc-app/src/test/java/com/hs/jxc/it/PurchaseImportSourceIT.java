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

/** 仅替换外部解析网络；授权、租约、MinIO、迁移和全部CRUD使用真实实现。 */
class PurchaseImportSourceIT extends PurchaseImportFixture {
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
        var b=upload(UUID.randomUUID().toString());parse(b);owner.update("UPDATE pur_order_import_batch SET header=jsonb_set(header,'{prepayRatio}','\"0.000000\"') WHERE batch_id=?",id(b));var appended=imports.upload(actor,"another.xlsx",file,header(),id(b),UUID.randomUUID().toString());parse(appended);tasks.execute(101,task(appended));var saved=imports.get(actor,id(b));assertThat(rows(saved)).extracting(r->r.get("rowNo")).containsExactly(1,2);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_source",Integer.class)).isEqualTo(2);
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
        try(var app=featureContainer(image,false)){
            app.start();String base="http://"+app.getHost()+":"+app.getMappedPort(8080);var http=java.net.http.HttpClient.newHttpClient();var accepted=httpUpload(base);assertThat(accepted.statusCode()).as(accepted.body()).isEqualTo(202);var b=codec.readMap(codec.write(codec.readMap(accepted.body()).get("data")));parse(b);
            var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+"/api/v1/pur/order-imports/"+id(b))).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").GET().build();var response=http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);assertThat(response.body()).contains("53.1234567890");
            String expected=com.hs.jxc.attachment.AttachmentObjectStore.sha256(java.nio.file.Files.readAllBytes(java.nio.file.Path.of("target/jxc-app-0.1.0-SNAPSHOT.jar")));assertThat(app.execInContainer("sha256sum","/app/app.jar").getStdout()).startsWith(expected+" ");
            var saved=imports.get(actor,id(b));long rowId=((Number)rows(saved).getFirst().get("id")).longValue();var value=values();value.put("purchaseQty","12");
            var changed=java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+"/api/v1/pur/order-imports/"+id(b)+"/rows/"+rowId)).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Content-Type","application/json").PUT(java.net.http.HttpRequest.BodyPublishers.ofString(codec.write(Map.of("version",1,"values",value)))).build();var edited=http.send(changed,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(edited.statusCode()).as(edited.body()).isEqualTo(200);assertThat(edited.body()).contains("12.0000");
            owner.update("UPDATE sys_role SET permissions=permissions||'[\"md:product:view\"]'::jsonb WHERE id=801");var decision=java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+"/api/v1/pur/order-imports/"+id(b)+"/rows/"+rowId+"/decision")).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Content-Type","application/json").PUT(java.net.http.HttpRequest.BodyPublishers.ofString(codec.write(Map.of("version",2,"decision","EXISTING","productId",501,"unit","PCS")))).build();var confirmed=http.send(decision,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(confirmed.statusCode()).as(confirmed.body()).isEqualTo(200);assertThat(confirmed.body()).contains("READY");assertThat(owner.queryForObject("SELECT count(*) FROM sys_audit_log WHERE action='PUR_IMPORT_PRODUCT_DECISION'",Integer.class)).isEqualTo(1);
        }
    }
    @Test void approvedRealParserBridgePersistsSixtyRowsAndOriginalImages()throws Exception {
        String python=System.getProperty("jxc.test.purchase-python"),sample=System.getProperty("jxc.test.purchase-source");org.junit.jupiter.api.Assumptions.assumeTrue(python!=null&&sample!=null,"实际Docling调用仅使用显式指定的解释器和样本");
        try(var bridge=startBridge(python)){
            var client=bridge.client();doAnswer(call->client.parse(call.getArgument(0),call.getArgument(1),call.getArgument(2),call.getArgument(3),call.getArgument(4))).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
            byte[] bytes=java.nio.file.Files.readAllBytes(java.nio.file.Path.of(sample));var b=imports.upload(actor,"NY-051-采购导入.xlsx",bytes,header(),null,UUID.randomUUID().toString());tasks.execute(101,task(b));var taskResult=tasks.get(actor,task(b));assertThat(taskResult).as(taskResult.toString()).containsEntry("status","SUCCEEDED");
            var saved=imports.get(actor,id(b));assertThat(rows(saved)).hasSize(60);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_image",Integer.class)).isEqualTo(20);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_row_image",Integer.class)).isEqualTo(60);assertThat(owner.queryForObject("SELECT sum(purchase_qty) FROM pur_order_import",java.math.BigDecimal.class)).isEqualByComparingTo("480");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM md_product_image",Integer.class)).isZero();
        }
    }

    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"FROZEN","DISABLED"})
    void frozenOrDisabledWritesReturnExplicitHttpFailureAndRetryAfterReopening(String mode)throws Exception{var b=upload(UUID.randomUUID().toString());parse(b);long row=((Number)rows(imports.get(actor,id(b))).getFirst().get("id")).longValue();boolean frozen=mode.equals("FROZEN");if(frozen){long epoch=owner.queryForObject("SELECT epoch FROM sys_write_control",Long.class);owner.queryForObject("SELECT jxc_set_write_mode('FROZEN',?,?::uuid,'test operator','isolated import validation')::text",String.class,epoch,UUID.randomUUID().toString());}else owner.update("UPDATE sys_country SET status='DISABLED' WHERE id=101");try{var http=java.net.http.HttpClient.newHttpClient();String root="http://127.0.0.1:"+port+"/api/v1/pur/order-imports/"+id(b);var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(root+"/rows/"+row)).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Content-Type","application/json").PUT(java.net.http.HttpRequest.BodyPublishers.ofString(codec.write(Map.of("version",1,"values",values())))).build();var response=http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).as(response.body()).isEqualTo(frozen?503:409);assertThat(response.body()).contains(frozen?"SYS_WRITES_FROZEN":"SYS_COUNTRY_DISABLED");assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("version",1);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();}finally{if(frozen){long epoch=owner.queryForObject("SELECT epoch FROM sys_write_control",Long.class);owner.queryForObject("SELECT jxc_set_write_mode('OPEN',?,?::uuid,'test operator','end isolated validation')::text",String.class,epoch,UUID.randomUUID().toString());}else owner.update("UPDATE sys_country SET status='ACTIVE' WHERE id=101");}assertThat(imports.saveRow(actor,id(b),row,Map.of("version",1,"values",values()))).containsEntry("version",2);}
}
