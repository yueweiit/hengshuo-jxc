package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.hs.jxc.attachment.AttachmentObjectStore;
import com.hs.jxc.common.api.ApiException;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

/** 当前批次清空：真实HTTP、隔离PostgreSQL和MinIO，不操作本地业务批次。 */
class PurchaseImportClearIT extends PurchaseImportFixture {
    @MockitoSpyBean AttachmentObjectStore store;
    @Autowired com.hs.jxc.attachment.AttachmentAssetService assetService;
    @Autowired com.hs.jxc.pur.service.impl.PurchaseImportClearService clearing;
    @Autowired com.hs.jxc.pur.service.impl.PurchaseImportTaskWorker worker;
    HttpClient client=HttpClient.newHttpClient();
    Map<String,Object> parsed(){var b=upload(UUID.randomUUID().toString());doReturn(photoDocument()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));return imports.get(actor,id(b));}
    HttpResponse<String> clear(String base,UUID batch,long version,String key)throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create(base+"/api/v1/pur/order-imports/"+batch)).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("If-Match",String.valueOf(version)).header("Idempotency-Key",key).DELETE().build(),HttpResponse.BodyHandlers.ofString());
    }
    HttpResponse<String> clear(Map<String,Object>b,String key)throws Exception{return clear("http://127.0.0.1:"+port,id(b),((Number)b.get("version")).longValue(),key);}
    @SuppressWarnings("unchecked") Map<String,Object> data(HttpResponse<String> r){return (Map<String,Object>)codec.readMap(r.body()).get("data");}
    List<Map<String,Object>> assets(UUID batch){return owner.queryForList("SELECT DISTINCT a.id,a.storage_key FROM sys_attachment a WHERE a.id IN (SELECT attachment_id FROM pur_order_import_source WHERE batch_id=? UNION SELECT i.attachment_id FROM pur_order_import_image i JOIN pur_order_import_source s ON s.id=i.source_id WHERE s.batch_id=?)",batch,batch);}
    @Test void deletesOnlyCurrentStagingAndExclusiveObjectsAndReplaysOriginalKey()throws Exception {
        var b=parsed();var other=parsed();var files=assets(id(b));String key=UUID.randomUUID().toString();
        UUID taskId=owner.queryForObject("SELECT id FROM pur_order_import_task WHERE batch_id=?",UUID.class,id(b));long rowId=((Number)rows(b).getFirst().get("id")).longValue();
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_task_progress WHERE task_id=?",Integer.class,taskId)).isEqualTo(1);
        owner.update("INSERT INTO pur_order_import_candidate(country_id,row_id,run_id,product_id,evidence) VALUES(101,?,?,501,'{}')",rowId,taskId);
        owner.update("INSERT INTO pur_order_import_group(country_id,batch_id,group_key,source_order_no,effective_header,create_key) VALUES(101,?,'PO-1','PO-1',?::jsonb,?)",id(b),codec.write(header()),UUID.randomUUID());
        var response=clear(b,key);assertThat(response.statusCode()).as(response.body()).isEqualTo(200);assertThat(data(response)).containsEntry("cleared",true).containsEntry("cleanupPending",false);
        for(var a:files){assertThat(owner.queryForObject("SELECT object_status FROM sys_attachment WHERE id=?",String.class,a.get("id"))).isEqualTo("DELETED");assertThatThrownBy(()->store.read(a.get("storage_key").toString(),100*1024*1024)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);}
        for(String table:List.of("pur_order_import","pur_order_import_group","pur_order_import_source","pur_order_import_task","pur_order_import_batch"))assertThat(owner.queryForObject("SELECT count(*) FROM "+table+" WHERE batch_id=?",Integer.class,id(b))).as(table).isZero();
        for(String table:List.of("pur_order_import_candidate","pur_order_import_row_image"))assertThat(owner.queryForObject("SELECT count(*) FROM "+table+" WHERE row_id=?",Integer.class,rowId)).as(table).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_image",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_task_progress WHERE task_id=?",Integer.class,taskId)).isZero();
        assertThat(rows(imports.get(actor,id(other)))).hasSize(1);assertThat(clear(b,key).statusCode()).isEqualTo(200);assertThat(clear(b,UUID.randomUUID().toString()).statusCode()).isEqualTo(404);
        assertThat(owner.queryForObject("SELECT response->>'cleared' FROM sys_idempotency WHERE country_id=101 AND endpoint='/api/v1/pur/order-imports' AND response->>'batchId'=?",String.class,id(b).toString())).isEqualTo("true");
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    @Test void sharedAttachmentReferenceRetainsItsObject()throws Exception {
        var b=parsed();var other=parsed();long sourceAsset=((Number)assets(id(b)).getFirst().get("id")).longValue();
        owner.update("UPDATE pur_order_import_source SET attachment_id=? WHERE batch_id=?",sourceAsset,id(other));
        var response=clear(b,UUID.randomUUID().toString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        assertThat(owner.queryForObject("SELECT object_status FROM sys_attachment WHERE id=?",String.class,sourceAsset)).isEqualTo("AVAILABLE");
        String key=owner.queryForObject("SELECT storage_key FROM sys_attachment WHERE id=?",String.class,sourceAsset);assertThat(store.read(key,100*1024*1024)).isNotEmpty();
    }
    @Test void publishedProductAndFeatureReferencesArePreserved()throws Exception {
        var b=parsed();long asset=owner.queryForObject("SELECT attachment_id FROM pur_order_import_image",Long.class);
        owner.update("INSERT INTO md_product_image(country_id,product_id,attachment_id,created_by) VALUES(101,501,?,201)",asset);owner.update("INSERT INTO image_feature(country_id,attachment_id,model_name,model_version,preprocess_version,created_by) VALUES(101,?,'test','test','test',201)",asset);
        var response=clear(b,UUID.randomUUID().toString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        assertThat(owner.queryForObject("SELECT object_status FROM sys_attachment WHERE id=?",String.class,asset)).isEqualTo("AVAILABLE");assertThat(owner.queryForObject("SELECT count(*) FROM md_product_image",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("SELECT count(*) FROM image_feature",Integer.class)).isEqualTo(1);
        assertThat(store.read(owner.queryForObject("SELECT storage_key FROM sys_attachment WHERE id=?",String.class,asset),10*1024*1024)).isNotEmpty();
    }
    @Test void bookAndFieldScopeApplyBeforeDeleteAndOnCachedReceipt()throws Exception {
        var b=parsed();owner.update("UPDATE sys_role SET field_policies='{\"COST\":\"READ\",\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\"}' WHERE id=801");assertThat(clear(b,UUID.randomUUID().toString()).statusCode()).isEqualTo(403);
        owner.update("UPDATE sys_role SET field_policies='{\"COST\":\"WRITE\",\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\"}' WHERE id=801");
        String key=UUID.randomUUID().toString();assertThat(clear(b,key).statusCode()).isEqualTo(200);owner.update("UPDATE sys_user_data_scope SET effective_to=clock_timestamp()-interval '1 hour' WHERE country_id=101 AND user_id=201");assertThat(clear(b,key).statusCode()).isEqualTo(404);
    }
    @Test void recoveryOnlyConsumesClearReceiptsAndRespectsTransactionGuard()throws Exception {
        var unrelated=parsed();long isolated=((Number)assets(id(unrelated)).getFirst().get("id")).longValue();owner.update("UPDATE sys_attachment SET object_status='QUARANTINED' WHERE id=?",isolated);
        var b=parsed();doThrow(new ApiException(503,"STORAGE_UNAVAILABLE","测试存储失败")).when(store).delete(anyString());assertThat(clear(b,UUID.randomUUID().toString()).statusCode()).isEqualTo(503);
        var queued=upload(UUID.randomUUID().toString());assertThatThrownBy(()->worker.recover(101,20)).isInstanceOf(ApiException.class);assertThat(owner.queryForObject("SELECT status FROM pur_order_import_task WHERE id=?",String.class,task(queued))).isEqualTo("SUCCEEDED");
        doCallRealMethod().when(store).delete(anyString());assertThat(clearing.recover(101,20)).isEqualTo(1);assertThat(clearing.recover(101,20)).isZero();
        assertThat(owner.queryForObject("SELECT object_status FROM sys_attachment WHERE id=?",String.class,isolated)).isEqualTo("QUARANTINED");assertThat(store.read(owner.queryForObject("SELECT storage_key FROM sys_attachment WHERE id=?",String.class,isolated),100*1024*1024)).isNotEmpty();
        assertThatThrownBy(()->inCountry(101,()->{store.delete("never-deleted");return null;})).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(()->assetService.retireUnreferenced(101,List.of(isolated))).isInstanceOf(IllegalStateException.class);
    }
    @Test void independentlyQuarantinedCurrentAssetBlocksDeletionWithFullRollback()throws Exception {
        var b=parsed();long asset=((Number)assets(id(b)).getFirst().get("id")).longValue();owner.update("UPDATE sys_attachment SET object_status='QUARANTINED' WHERE id=?",asset);
        var response=clear(b,UUID.randomUUID().toString());assertThat(response.statusCode()).as(response.body()).isEqualTo(409);assertThat(codec.readMap(response.body())).containsEntry("code","PUR_IMPORT_ASSET_HELD");assertThat(rows(imports.get(actor,id(b)))).hasSize(1);assertThat(assets(id(b))).hasSize(2);
    }
    @Test void writeFreezeAndDisabledCountryPreventDatabaseAndObjectDeletion()throws Exception {
        var b=parsed();var files=assets(id(b));
        owner.update("UPDATE sys_write_control SET mode='FROZEN'");
        try{var response=clear(b,UUID.randomUUID().toString());assertThat(response.statusCode()).as(response.body()).isEqualTo(503);assertThat(codec.readMap(response.body())).containsEntry("code","SYS_WRITES_FROZEN");}finally{owner.update("UPDATE sys_write_control SET mode='OPEN'");}
        owner.update("UPDATE sys_country SET status='DISABLED' WHERE id=101");
        try{var response=clear(b,UUID.randomUUID().toString());assertThat(response.statusCode()).as(response.body()).isEqualTo(409);assertThat(codec.readMap(response.body())).containsEntry("code","SYS_COUNTRY_DISABLED");}finally{owner.update("UPDATE sys_country SET status='ACTIVE' WHERE id=101");}
        assertThat(rows(imports.get(actor,id(b)))).hasSize(1);
        doThrow(new ApiException(503,"STORAGE_UNAVAILABLE","测试存储失败")).when(store).delete(anyString());assertThat(clear(b,UUID.randomUUID().toString()).statusCode()).isEqualTo(503);doCallRealMethod().when(store).delete(anyString());
        owner.update("UPDATE sys_write_control SET mode='FROZEN'");
        try{assertThatThrownBy(()->clearing.recover(101,20)).hasMessageContaining("SYS_WRITES_FROZEN");for(var f:files)assertThat(store.read(f.get("storage_key").toString(),100*1024*1024)).isNotEmpty();}finally{owner.update("UPDATE sys_write_control SET mode='OPEN'");}
        assertThat(clearing.recover(101,20)).isEqualTo(1);
    }
    @Test void staleCreatedAndUnresolvedBatchesRemainIntact()throws Exception {
        var b=parsed();assertThat(clear("http://127.0.0.1:"+port,id(b),999,UUID.randomUUID().toString()).statusCode()).isEqualTo(409);
        owner.update("INSERT INTO pur_order_import_group(country_id,batch_id,group_key,source_order_no,effective_header,create_key) VALUES(101,?,'PO-1','PO-1',?::jsonb,?)",id(b),codec.write(header()),UUID.randomUUID());
        for(String state:List.of("CREATED","CREATING","UNKNOWN")){
            owner.update("UPDATE pur_order_import_group SET create_status=? WHERE batch_id=?",state,id(b));
            assertThat(clear(b,UUID.randomUUID().toString()).statusCode()).as(state).isEqualTo(409);
        }
        owner.update("UPDATE pur_order_import_group SET create_status='DRAFT' WHERE batch_id=?",id(b));owner.update("UPDATE pur_order_import SET target_order_line_id=999 WHERE batch_id=?",id(b));
        assertThat(clear(b,UUID.randomUUID().toString()).statusCode()).isEqualTo(409);assertThat(rows(imports.get(actor,id(b)))).hasSize(1);
    }
    @Test void queuedAndRunningTasksBlockCleanup()throws Exception {
        var b=upload(UUID.randomUUID().toString());assertThat(clear(b,UUID.randomUUID().toString()).statusCode()).isEqualTo(409);
        owner.update("UPDATE pur_order_import_task SET status='RUNNING' WHERE batch_id=?",id(b));assertThat(clear(b,UUID.randomUUID().toString()).statusCode()).isEqualTo(409);
        assertThat(assets(id(b))).hasSize(1);
    }
    @Test void currentPermissionsAndOwnershipAreRequiredIncludingReplay()throws Exception {
        var b=parsed();owner.update("INSERT INTO sys_user(id,username,password_hash,display_name) VALUES(202,'other','hash','Other')");owner.update("UPDATE pur_order_import_batch SET created_by=202 WHERE batch_id=?",id(b));assertThat(clear(b,UUID.randomUUID().toString()).statusCode()).isEqualTo(404);
        owner.update("UPDATE pur_order_import_batch SET created_by=201 WHERE batch_id=?",id(b));String key=UUID.randomUUID().toString();assertThat(clear(b,key).statusCode()).isEqualTo(200);
        owner.update("UPDATE sys_role SET permissions='[]' WHERE id=801");assertThat(clear(b,key).statusCode()).isEqualTo(403);
    }
    @Test void databaseFailureRollsBackBeforeObjectDeletion()throws Exception {
        var b=parsed();var files=assets(id(b));
        owner.execute("CREATE FUNCTION test_clear_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'clear test failure'; END $$");owner.execute("CREATE TRIGGER test_clear_fail BEFORE DELETE ON pur_order_import_batch FOR EACH ROW EXECUTE FUNCTION test_clear_fail()");
        try{assertThat(clear(b,UUID.randomUUID().toString()).statusCode()).isEqualTo(500);assertThat(rows(imports.get(actor,id(b)))).hasSize(1);for(var f:files)assertThat(store.read(f.get("storage_key").toString(),100*1024*1024)).isNotEmpty();}finally{owner.execute("DROP TRIGGER test_clear_fail ON pur_order_import_batch");owner.execute("DROP FUNCTION test_clear_fail()");}
    }
    @Test void statusRecoversCommittedDeletionAndRetryCompletesFileCleanup()throws Exception {
        var b=parsed();String key=UUID.randomUUID().toString();doThrow(new ApiException(503,"STORAGE_UNAVAILABLE","测试存储失败")).when(store).delete(anyString());
        var failed=clear(b,key);assertThat(failed.statusCode()).as(failed.body()).isEqualTo(503);assertThat(data(failed)).containsEntry("cleared",true).containsEntry("cleanupPending",true);
        var status=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1/pur/order-imports/"+id(b)+"/clear-status")).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").GET().build(),HttpResponse.BodyHandlers.ofString());
        assertThat(status.statusCode()).as(status.body()).isEqualTo(200);assertThat(data(status)).containsEntry("requestKey",key).containsEntry("cleanupPending",true);
        doCallRealMethod().when(store).delete(anyString());var retried=clear(b,key);assertThat(retried.statusCode()).as(retried.body()).isEqualTo(200);assertThat(data(retried)).containsEntry("cleanupPending",false);
    }
    @Test void isolatedDockerUsesVerifiedApplicationForClear()throws Exception {
        String image=System.getProperty("jxc.test.purchase-image"),web=System.getProperty("jxc.test.purchase-web-image"),certs=System.getProperty("jxc.test.photo-certs"),dist=System.getProperty("jxc.test.photo-dist");
        org.junit.jupiter.api.Assumptions.assumeTrue(image!=null&&web!=null&&certs!=null&&dist!=null,"显式提供本地镜像、测试证书和已验证dist才运行");
        var trust=java.security.KeyStore.getInstance(java.security.KeyStore.getDefaultType());trust.load(null,null);try(var input=java.nio.file.Files.newInputStream(java.nio.file.Path.of(certs,"certificate.pem"))){trust.setCertificateEntry("local-test",java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(input));}
        var manager=javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm());manager.init(trust);var ssl=javax.net.ssl.SSLContext.getInstance("TLS");ssl.init(null,manager.getTrustManagers(),null);client=HttpClient.newBuilder().sslContext(ssl).build();
        var b=parsed();try(var gateway=featureGateway(image,web,certs,false)){
            var r=clear(gateway.base(),id(b),((Number)b.get("version")).longValue(),UUID.randomUUID().toString());assertThat(r.statusCode()).as(r.body()).isEqualTo(200);assertThat(data(r)).containsEntry("cleanupPending",false);
            var page=client.send(HttpRequest.newBuilder(URI.create(gateway.base()+"/purchase/orders/import")).GET().build(),HttpResponse.BodyHandlers.ofString());assertThat(page.statusCode()).isEqualTo(200);assertThat(page.body()).contains("<div id=\"app\"");
            var root=java.nio.file.Path.of(dist);int checked=0;try(var paths=java.nio.file.Files.walk(root)){for(var path:paths.filter(java.nio.file.Files::isRegularFile).toList()){String relative=root.relativize(path).toString().replace('\\','/');var asset=client.send(HttpRequest.newBuilder(URI.create(gateway.base()+"/"+relative)).GET().build(),HttpResponse.BodyHandlers.ofByteArray());assertThat(asset.statusCode()).as(relative).isEqualTo(200);assertThat(AttachmentObjectStore.sha256(asset.body())).as(relative).isEqualTo(AttachmentObjectStore.sha256(java.nio.file.Files.readAllBytes(path)));checked++;}}
            assertThat(checked).isGreaterThan(10);String expected=AttachmentObjectStore.sha256(java.nio.file.Files.readAllBytes(java.nio.file.Path.of("target/jxc-app-0.1.0-SNAPSHOT.jar")));assertThat(gateway.app().execInContainer("sha256sum","/app/app.jar").getStdout()).startsWith(expected+" ");System.out.println("PUR_IMPORT_CLEAR_GATEWAY_VERIFIED staticFiles="+checked);
        }
    }
}
