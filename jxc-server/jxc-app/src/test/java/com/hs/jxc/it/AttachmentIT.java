package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import io.minio.*;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import com.hs.jxc.sys.service.SessionService;
import com.hs.jxc.attachment.AttachmentService;
import com.hs.jxc.sys.service.AuthorizationService;
import com.hs.jxc.common.api.ApiException;
import org.springframework.beans.factory.annotation.Autowired;

class AttachmentIT extends BasePgIT {
    private static final String TOKEN="attachment-fixture-session";
    private static final byte[] CONTENT="real MinIO evidence 123".getBytes(StandardCharsets.UTF_8);
    @Value("${local.server.port}") int port;
    @Autowired AttachmentService attachments;
    @Autowired AuthorizationService authorization;
    private final HttpClient http=HttpClient.newHttpClient();
    private final JsonMapper json=JsonMapper.builder().build();
    @DynamicPropertySource static void attachmentStorage(DynamicPropertyRegistry r) {
        String endpoint=MinioTestStorage.endpoint();
        r.add("jxc.storage.endpoint",()->endpoint);
        r.add("jxc.storage.access-key",()->MinioTestStorage.ACCESS);
        r.add("jxc.storage.secret-key",()->MinioTestStorage.SECRET);
        r.add("jxc.storage.bucket",()->MinioTestStorage.BUCKET);
    }
    @BeforeEach void seedAttachmentUser() {
        resetFixtures();
        owner.update("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(81001,'ATTACH','Attachment test','USD','UTC','ACTIVE')");
        owner.update("INSERT INTO sys_authz_epoch(country_id) VALUES(81001)");
        owner.update("INSERT INTO sys_user(id,username,password_hash,display_name,status) VALUES(81101,'attachment-user','unused','Attachment tester','ENABLED')");
        owner.update("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,81101,clock_timestamp()+interval '1 hour')",SessionService.digest(TOKEN));
        owner.update("INSERT INTO sys_role(id,country_id,code,name,status,permissions,field_policies) VALUES(81201,81001,'ATTACH','Attachment role','ENABLED','[\"org:*\",\"fin:book:config\"]','{\"COST\":\"WRITE\",\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"BANK_INFO\":\"WRITE\",\"PROFIT\":\"WRITE\",\"CREDIT\":\"WRITE\"}')");
        owner.update("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(81001,81101,81201)");
        owner.update("INSERT INTO org_entity(id,country_id,code,name) VALUES(81301,81001,'A1','Allowed entity'),(81302,81001,'A2','Hidden entity')");
        owner.update("INSERT INTO org_store(id,country_id,entity_id,code,name) VALUES(81401,81001,81301,'AS1','Attachment store')");
        owner.update("INSERT INTO org_warehouse(id,country_id,entity_id,store_id,code,name,type) VALUES(81501,81001,81301,81401,'AW1','Attachment warehouse','STORE')");
        owner.update("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(81601,81001,81301,'AB1','Attachment book','USD','ACTIVE')");
        owner.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,entity_id,granted_by) VALUES(81001,81101,'ENTITY',81301,81101)");
    }
    @Test void uploadListAndProxyDownloadUseThePrivateRealObjectStore() throws Exception {
        JsonNode data=upload("ORG_ENTITY",81301,"IMPORT_FILE");
        long id=data.get("id").asLong();
        var stored=owner.queryForMap("SELECT storage_key,sha256 FROM sys_attachment WHERE id=?",id);
        try(var minio=MinioTestStorage.client()) { assertThat(minio.statObject(StatObjectArgs.builder().bucket(MinioTestStorage.BUCKET).object((String)stored.get("storage_key")).build()).size()).isEqualTo(CONTENT.length); }
        var list=get("/api/v1/sys/attachments?bizType=ORG_ENTITY&bizId=81301&category=IMPORT_FILE",true);
        assertThat(list.statusCode()).isEqualTo(200);assertThat(list.body()).contains("fixture.txt");
        String proxy=proxy(id);
        assertThat(proxy).startsWith("/api/v1/sys/attachments/"+id+"/content?");
        assertThat(get(proxy,false).statusCode()).isEqualTo(401);
        var download=getBytes(proxy,true);
        assertThat(download.statusCode()).isEqualTo(200);assertThat(download.body()).containsExactly(CONTENT);
        assertThat(download.headers().firstValue("Content-Disposition").orElse("")).startsWith("attachment;");
        assertThat(download.headers().firstValue("X-Content-Type-Options").orElse("")).isEqualTo("nosniff");
        assertThat(download.headers().firstValue("Cache-Control").orElse("")).contains("no-store");
        var anonymous=http.send(HttpRequest.newBuilder(URI.create(MinioTestStorage.endpoint()+"/"+MinioTestStorage.BUCKET+"/"+stored.get("storage_key"))).GET().build(),HttpResponse.BodyHandlers.ofString());
        assertThat(anonymous.statusCode()).isEqualTo(403);
    }
    @ParameterizedTest
    @CsvSource({"ORG_STORE,81401","ORG_WAREHOUSE,81501","FIN_BOOK,81601"})
    void eachM1TrustedSourceUsesTheSharedResolverAndLock(String type,long sourceId) throws Exception {
        long id=upload(type,sourceId,"IMPORT_FILE").get("id").asLong();
        assertThat(getBytes(proxy(id),true).body()).containsExactly(CONTENT);
    }
    @Test void uploadRechecksTheSourceVersionAfterObjectIoBeforeRegistering() throws Exception {
        try(var connection=owner.getDataSource().getConnection()) {
            connection.setAutoCommit(false);connection.createStatement().executeQuery("SELECT id FROM org_entity WHERE id=81301 FOR UPDATE");
            var waiting=CompletableFuture.supplyAsync(()->{try{return uploadResponse("ORG_ENTITY",81301,"IMPORT_FILE");}catch(Exception e){throw new CompletionException(e);}});
            await().atMost(Duration.ofSeconds(5)).until(()->owner.queryForObject("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM org_entity%'",Integer.class)>0);
            assertThat(owner.queryForObject("SELECT count(*) FROM sys_attachment",Integer.class)).isZero();
            connection.createStatement().executeUpdate("UPDATE org_entity SET version=version+1 WHERE id=81301");connection.commit();
            assertThat(waiting.get(5,TimeUnit.SECONDS).statusCode()).isEqualTo(409);
            assertThat(owner.queryForObject("SELECT count(*) FROM sys_attachment",Integer.class)).isZero();
        }
    }
    @Test void unavailableObjectStoreLeavesNoValidEvidenceAndRecoversWithoutDuplicateMetadata() throws Exception {
        var docker=org.testcontainers.DockerClientFactory.instance().client();
        String container=MinioTestStorage.MINIO.getContainerId();
        try {
            docker.pauseContainerCmd(container).exec();
            var ctx=context(81101,81001,SessionService.digest(TOKEN));
            assertThatThrownBy(()->attachments.upload(ctx,"ORG_ENTITY",81301,"IMPORT_FILE","outage.txt","text/plain",CONTENT))
                .isInstanceOf(ApiException.class).extracting("code").isEqualTo("STORAGE_UNAVAILABLE");
            assertThat(owner.queryForObject("SELECT count(*) FROM sys_attachment",Integer.class)).isZero();
            assertThat(owner.queryForObject("SELECT count(*) FROM sys_attachment_link",Integer.class)).isZero();
            assertThat(owner.queryForObject("SELECT count(*) FROM sys_audit_log WHERE action='ATTACHMENT_UPLOAD'",Integer.class)).isZero();
        } finally {
            if(Boolean.TRUE.equals(docker.inspectContainerCmd(container).exec().getState().getPaused()))
                docker.unpauseContainerCmd(container).exec();
        }
        long id=upload("ORG_ENTITY",81301,"IMPORT_FILE").get("id").asLong();
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_attachment",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_attachment_link",Integer.class)).isEqualTo(1);
        assertThat(getBytes(proxy(id),true).body()).isEqualTo(CONTENT);
    }
    @Test void revocationRejectsPreviouslyIssuedDownloadAndMetadata() throws Exception {
        long id=upload("ORG_ENTITY",81301,"IMPORT_FILE").get("id").asLong();String proxy=proxy(id);
        owner.update("DELETE FROM sys_user_data_scope WHERE user_id=81101");
        assertThat(get(proxy,true).statusCode()).isEqualTo(404);
        assertThat(get("/api/v1/sys/attachments/"+id+"/url",true).statusCode()).isEqualTo(404);
        assertThat(get("/api/v1/sys/attachments?bizType=ORG_ENTITY&bizId=81301&category=IMPORT_FILE",true).statusCode()).isEqualTo(404);
    }
    @Test void sensitiveAttachmentRequiresCurrentFieldPermissions() throws Exception {
        long id=upload("ORG_ENTITY",81301,"IMPORT_FILE").get("id").asLong();String proxy=proxy(id);
        owner.update("UPDATE sys_role SET field_policies='{}',version=version+1 WHERE id=81201");
        assertThat(get(proxy,true).statusCode()).isEqualTo(403);
    }
    @Test void missingUnknownOrInvisibleSourcesAndCategoriesNeverCreateMetadata() throws Exception {
        assertThat(uploadResponse("SAL_OUTBOUND",81301,"IMPORT_FILE").statusCode()).isEqualTo(404);
        assertThat(uploadResponse("ORG_ENTITY",81302,"IMPORT_FILE").statusCode()).isEqualTo(404);
        assertThat(uploadResponse("ORG_ENTITY",81301,"UNKNOWN_CATEGORY").statusCode()).isEqualTo(400);
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_attachment",Integer.class)).isZero();
    }
    @Test void missingObjectsTamperedBytesAndMismatchedLinkSnapshotsAreRejected() throws Exception {
        long missing=upload("ORG_ENTITY",81301,"IMPORT_FILE").get("id").asLong();String missingUrl=proxy(missing);
        String missingKey=owner.queryForObject("SELECT storage_key FROM sys_attachment WHERE id=?",String.class,missing);
        try(var minio=MinioTestStorage.client()) {minio.removeObject(RemoveObjectArgs.builder().bucket(MinioTestStorage.BUCKET).object(missingKey).build());}
        assertThat(get(missingUrl,true).statusCode()).isEqualTo(404);
        long tampered=upload("ORG_ENTITY",81301,"IMPORT_FILE").get("id").asLong();String tamperedUrl=proxy(tampered);
        String key=owner.queryForObject("SELECT storage_key FROM sys_attachment WHERE id=?",String.class,tampered);
        byte[] fake="different proof content".getBytes(StandardCharsets.UTF_8);
        try(var minio=MinioTestStorage.client()) {minio.putObject(PutObjectArgs.builder().bucket(MinioTestStorage.BUCKET).object(key).stream(new ByteArrayInputStream(fake),(long)fake.length,-1L).contentType("text/plain").build());}
        assertThat(get(tamperedUrl,true).statusCode()).isEqualTo(409);
        long mismatch=upload("ORG_ENTITY",81301,"IMPORT_FILE").get("id").asLong();String original=proxy(mismatch);
        assertThat(get(original.replace("category=IMPORT_FILE","category=SIGN_PROOF"),true).statusCode()).isEqualTo(409);
        assertThat(get(original.replaceFirst("linkVersion=[0-9]+","linkVersion=999"),true).statusCode()).isEqualTo(409);
        assertThat(get(original.replaceFirst("sha256=[a-f0-9]{64}","sha256="+"b".repeat(64)),true).statusCode()).isEqualTo(409);
    }
    @Test void unlinkKeepsObjectAndHistoryAndInvalidatesOldProxy() throws Exception {
        long id=upload("ORG_ENTITY",81301,"IMPORT_FILE").get("id").asLong();String proxy=proxy(id);
        var unlinked=post("/api/v1/sys/attachments/"+id+"/unlink");assertThat(unlinked.statusCode()).isEqualTo(200);
        assertThat(owner.queryForObject("SELECT unlinked_at IS NOT NULL FROM sys_attachment_link WHERE attachment_id=?",Boolean.class,id)).isTrue();
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_attachment WHERE id=?",Integer.class,id)).isEqualTo(1);
        assertThat(get(proxy,true).statusCode()).isEqualTo(404);
        assertThat(json.readTree(get("/api/v1/sys/attachments?bizType=ORG_ENTITY&bizId=81301&category=IMPORT_FILE",true).body()).get("data").size()).isZero();
        String key=owner.queryForObject("SELECT storage_key FROM sys_attachment WHERE id=?",String.class,id);
        try(var minio=MinioTestStorage.client()) {assertThat(minio.statObject(StatObjectArgs.builder().bucket(MinioTestStorage.BUCKET).object(key).build()).size()).isEqualTo(CONTENT.length);}
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_audit_log WHERE resource_type='ORG_ENTITY' AND resource_id=81301",Integer.class)).isEqualTo(2);
    }
    @Test void unlinkWaitsForTheSameTrustedSourceLockUsedByCommands() throws Exception {
        long id=upload("ORG_ENTITY",81301,"IMPORT_FILE").get("id").asLong();
        try(var connection=owner.getDataSource().getConnection()) {
            connection.setAutoCommit(false);connection.createStatement().executeQuery("SELECT id FROM org_entity WHERE id=81301 FOR UPDATE");
            var waiting=CompletableFuture.supplyAsync(()->{try{return post("/api/v1/sys/attachments/"+id+"/unlink");}catch(Exception e){throw new CompletionException(e);}});
            await().atMost(Duration.ofSeconds(5)).until(()->owner.queryForObject("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM org_entity%'",Integer.class)>0);
            assertThat(waiting).isNotDone();
            assertThat(owner.queryForObject("SELECT unlinked_at IS NULL FROM sys_attachment_link WHERE attachment_id=?",Boolean.class,id)).isTrue();
            connection.commit();assertThat(waiting.get(5,TimeUnit.SECONDS).statusCode()).isEqualTo(200);
        }
    }
    @Test void preparedEvidenceCanJoinCallerTransactionAndRollBackWithIt()throws Exception {
        long id=upload("ORG_ENTITY",81301,"IMPORT_FILE").get("id").asLong();
        var ctx=context(81101,81001,SessionService.digest(TOKEN));
        var spec=new AttachmentService.EvidenceSpec(id,"ORG_ENTITY",81301,"IMPORT_FILE",1,owner.queryForObject("SELECT sha256 FROM sys_attachment WHERE id=?",String.class,id));
        var prepared=new java.util.concurrent.atomic.AtomicReference<AttachmentService.PreparedEvidence>();
        assertThatCode(()->prepared.set(attachments.prepareEvidence(ctx,spec))).doesNotThrowAnyException();
        assertThatThrownBy(()->inCountry(81001,()->{
            var access=authorization.authorize(ctx);attachments.requirePreparedEvidence(ctx,access,prepared.get());
            jdbc.update("UPDATE org_entity SET name='must rollback' WHERE id=81301");
            throw new IllegalStateException("command-rollback");
        })).isInstanceOf(IllegalStateException.class).hasMessage("command-rollback");
        assertThat(owner.queryForObject("SELECT name FROM org_entity WHERE id=81301",String.class)).isEqualTo("Allowed entity");
    }
    @Test void preparedEvidenceRejectsAChangedLinkAfterObjectVerification()throws Exception {
        long id=upload("ORG_ENTITY",81301,"IMPORT_FILE").get("id").asLong();
        var ctx=context(81101,81001,SessionService.digest(TOKEN));
        var spec=new AttachmentService.EvidenceSpec(id,"ORG_ENTITY",81301,"IMPORT_FILE",1,owner.queryForObject("SELECT sha256 FROM sys_attachment WHERE id=?",String.class,id));
        var prepared=new java.util.concurrent.atomic.AtomicReference<AttachmentService.PreparedEvidence>();
        assertThatCode(()->prepared.set(attachments.prepareEvidence(ctx,spec))).doesNotThrowAnyException();
        attachments.unlink(ctx,id,"link changed after probe");
        assertThatThrownBy(()->inCountry(81001,()->attachments.requirePreparedEvidence(ctx,authorization.authorize(ctx),prepared.get())))
            .isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);
    }
    private JsonNode upload(String type,long bizId,String category)throws Exception {var r=uploadResponse(type,bizId,category);assertThat(r.statusCode()).as(r.body()).isEqualTo(200);return json.readTree(r.body()).get("data");}
    private HttpResponse<String> uploadResponse(String type,long bizId,String category)throws Exception {
        String boundary="attachment-test-boundary";
        String body="--"+boundary+"\r\nContent-Disposition: form-data; name=\"bizType\"\r\n\r\n"+type+"\r\n--"+boundary+"\r\nContent-Disposition: form-data; name=\"bizId\"\r\n\r\n"+bizId+"\r\n--"+boundary+"\r\nContent-Disposition: form-data; name=\"category\"\r\n\r\n"+category+"\r\n--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"fixture.txt\"\r\nContent-Type: text/plain\r\n\r\n"+new String(CONTENT,StandardCharsets.UTF_8)+"\r\n--"+boundary+"--\r\n";
        return http.send(request("/api/v1/sys/attachments",true).header("Content-Type","multipart/form-data; boundary="+boundary).POST(HttpRequest.BodyPublishers.ofString(body)).build(),HttpResponse.BodyHandlers.ofString());
    }
    private String proxy(long id)throws Exception {var r=get("/api/v1/sys/attachments/"+id+"/url",true);assertThat(r.statusCode()).as(r.body()).isEqualTo(200);return json.readTree(r.body()).get("data").get("url").asString();}
    private HttpRequest.Builder request(String path,boolean authenticated){var b=HttpRequest.newBuilder(URI.create("http://localhost:"+port+path)).timeout(Duration.ofSeconds(10));if(authenticated)b.header("Authorization","Bearer "+TOKEN).header("X-Country-Id","81001");return b;}
    private HttpResponse<String> get(String path,boolean auth)throws Exception{return http.send(request(path,auth).GET().build(),HttpResponse.BodyHandlers.ofString());}
    private HttpResponse<byte[]> getBytes(String path,boolean auth)throws Exception{return http.send(request(path,auth).GET().build(),HttpResponse.BodyHandlers.ofByteArray());}
    private HttpResponse<String> post(String path)throws Exception{return http.send(request(path,true).POST(HttpRequest.BodyPublishers.noBody()).build(),HttpResponse.BodyHandlers.ofString());}
}
