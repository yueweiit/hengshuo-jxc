package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

import com.hs.jxc.common.api.ApiException;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import com.hs.jxc.pur.service.impl.PurchaseImportDraftServiceImpl;

/** 文件接入与业务保存分开；原文件、原图、任务和国家/创建者隔离仍使用真实实现。 */
class PurchaseImportStagingIT extends PurchaseImportFixture {
    @Autowired PurchaseImportDraftServiceImpl drafts;

    @Test void realSupplierMappingStagesAllReliableRowsBeforeBusinessConfirmation() throws Exception {
        String source=System.getProperty("jxc.test.partial-source"),document=System.getProperty("jxc.test.partial-document");
        org.junit.jupiter.api.Assumptions.assumeTrue(source!=null&&document!=null,"真实来源验证需要指定原文件和已留存模型映射的解析结果");
        byte[] bytes=java.nio.file.Files.readAllBytes(java.nio.file.Path.of(source));
        assertThat(com.hs.jxc.attachment.AttachmentObjectStore.sha256(bytes)).isEqualTo("b3c7c78b3aa07852e37045d47e136dd5387cbe6075234c064313b05c3b3fd626");
        var doc=new com.hs.jxc.common.api.JsonCodec().readMap(java.nio.file.Files.readString(java.nio.file.Path.of(document),java.nio.charset.StandardCharsets.UTF_8));
        var b=imports.upload(actor,"NY-051.xlsx",bytes,Map.of(),null,UUID.randomUUID().toString());
        doReturn(doc).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));
        var saved=imports.get(actor,id(b));assertThat(rows(saved)).hasSize(60);assertThat(rows(saved)).allSatisfy(r->assertThat(r).containsEntry("sourceOrderNo",null).containsEntry("productSpec",null));
        assertThat(owner.queryForObject("SELECT sum(purchase_qty) FROM pur_order_import",java.math.BigDecimal.class)).isEqualByComparingTo("480");
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_image",Integer.class)).isEqualTo(20);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_row_image",Integer.class)).isEqualTo(63);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
        var preview=drafts.previews(actor,id(b),Map.of("batchVersion",saved.get("version")));assertThat(groups(preview)).isEmpty();
        var sourceDto=((List<Map<String,Object>>)saved.get("sources")).getFirst();var meaning=new LinkedHashMap<String,Object>();meaning.put("subjectId","Sheet1:title:A1");meaning.put("meaning","ORDER_NUMBER");meaning.put("previousMeaning",null);
        var changes=rows(saved).stream().map(r->Map.of("rowId",r.get("id"),"version",r.get("version"),"values",Map.of("sourceOrderNo","NY-051"))).toList();
        var confirmed=imports.confirmReview(actor,id(b),Map.of("sourceId",sourceDto.get("id"),"fileSha256",sourceDto.get("fileSha256"),"batchVersion",saved.get("version"),"changes",changes,"confirm",true,"interpretation",meaning),UUID.randomUUID().toString());
        assertThat(rows(confirmed)).allSatisfy(r->assertThat(r).containsEntry("sourceOrderNo","NY-051").containsEntry("productSpec",null));assertThat(confirmed.get("header")).isEqualTo(saved.get("header"));
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }

    @Test void incompleteSourcePersistsAndUnknownOrderDoesNotCreateAGroup() {
        var b=unconfigured();var doc=document();var v=(Map<String,Object>)rows(doc).getFirst().get("normalizedValues");
        v.put("sourceOrderNo",null);v.put("productSpec",null);v.put("purchaseQty",null);
        doReturn(doc).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));
        var saved=imports.get(actor,id(b));assertThat(rows(saved)).hasSize(1);
        assertThat(rows(saved).getFirst()).containsEntry("purchaseQty",null).containsEntry("sourceOrderNo",null);
        var preview=drafts.previews(actor,id(b),Map.of("batchVersion",saved.get("version")));
        assertThat(groups(preview)).isEmpty();assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }

    Map<String,Object> unconfigured() {
        return imports.upload(actor,"采购.xlsx",file,Map.of(),null,UUID.randomUUID().toString());
    }
    Map<String,Object> parsed() {
        var b=unconfigured();doReturn(photoDocument()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task(b));return imports.get(actor,id(b));
    }

    @Test void sourceAndImagesPersistWithoutBusinessHeaderOrFormalPurchase() {
        var b=parsed();assertThat(rows(b)).hasSize(1);
        assertThat(((Map<?,?>)b.get("header")).containsKey("bookId")).isTrue();
        assertThat(((Map<?,?>)b.get("header")).get("bookId")).isNull();
        assertThat(((Map<?,?>)b.get("header")).get("prepayRatio")).isNull();
        assertThat(owner.queryForMap("SELECT book_id,supplier_id,currency,order_date FROM pur_order_import"))
            .containsEntry("book_id",null).containsEntry("supplier_id",null).containsEntry("currency",null).containsEntry("order_date",null);
        assertThat(rows(b).getFirst()).containsEntry("purchaseUnitPrice","53.1234567890");
        var source=((List<Map<String,Object>>)b.get("sources")).getFirst();
        assertThat(imports.content(actor,id(b),((Number)source.get("id")).longValue(),false).bytes()).isEqualTo(file);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_image",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM md_product",Integer.class)).isEqualTo(1);
    }

    @Test void retryAndSourceEditsWorkBeforeHeaderIsSaved() {
        var b=unconfigured();doThrow(new ApiException(503,"PARSER_UNAVAILABLE","解析不可用")).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task(b));assertThat(tasks.get(actor,task(b))).containsEntry("status","FAILED");
        tasks.retry(actor,task(b),UUID.randomUUID().toString(),null);parse(b);
        var row=rows(imports.get(actor,id(b))).getFirst();var v=values();v.put("purchaseQty","11");
        var saved=imports.saveRow(actor,id(b),((Number)row.get("id")).longValue(),Map.of("version",row.get("version"),"values",v));
        assertThat(saved).containsEntry("purchaseQty","11.0000");
        assertThat(imports.get(actor,id(b)).get("status")).isEqualTo("REVIEW");
    }

    @Test void missingHeaderBlocksBusinessSaveButNotPreviewOrSourceReadback() {
        var b=parsed();var versions=rows(b).stream().map(r->Map.of("id",r.get("id"),"version",r.get("version"))).toList();
        assertThatThrownBy(()->imports.saveHeader(actor,id(b),Map.of("header",Map.of(),"versions",versions,"batchVersion",b.get("version"))))
            .isInstanceOf(ApiException.class);
        var preview=drafts.previews(actor,id(b),Map.of("batchVersion",b.get("version")));
        assertThat(groups(preview)).hasSize(1);assertThat(groups(preview).getFirst()).containsEntry("createStatus","DRAFT").containsEntry("previewToken",null);
        assertThat(groups(preview).getFirst().get("errors")).asList().isNotEmpty();
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }

    @Test void explicitBusinessSaveValidatesAndAppliesHeaderAfterImport() {
        var b=parsed();var versions=rows(b).stream().map(r->Map.of("id",r.get("id"),"version",r.get("version"))).toList();
        var saved=imports.saveHeader(actor,id(b),Map.of("header",header(),"versions",versions,"batchVersion",b.get("version")));
        assertThat(((Number)((Map<?,?>)saved.get("header")).get("bookId")).longValue()).isEqualTo(601);
        assertThat(owner.queryForObject("SELECT book_id FROM pur_order_import",Long.class)).isEqualTo(601L);
        owner.update("DELETE FROM sys_user_data_scope WHERE user_id=201");
        assertThatThrownBy(()->imports.get(actor,id(b))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);
    }

    @Test void unassignedBatchRemainsPrivateToCreatorAndCountry() {
        var b=parsed();var ctx=new com.hs.jxc.common.context.RequestContext(202,101L,"other-user",com.hs.jxc.sys.service.SessionService.digest("other-user"));
        owner.update("INSERT INTO sys_user(id,username,password_hash,display_name,status) VALUES(202,'other-staging','unused','Other','ENABLED')");
        owner.update("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,202,clock_timestamp()+interval '1 hour')",ctx.tokenHash());
        owner.update("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(101,202,801)");
        assertThatThrownBy(()->imports.get(ctx,id(b))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);
        assertThatThrownBy(()->imports.get(new com.hs.jxc.common.context.RequestContext(201,102L,"other-country",tokenHash),id(b)))
            .isInstanceOf(ApiException.class);
    }

    @Test void isolatedDockerAcceptsLargeMultipartWithoutHeaderAndKeepsOriginalBytes() throws Exception {
        String image=System.getProperty("jxc.test.purchase-image"),sample=System.getProperty("jxc.test.purchase-source");
        org.junit.jupiter.api.Assumptions.assumeTrue(image!=null&&sample!=null,"大文件HTTP验证仅使用显式指定的特性镜像和样本");
        byte[] bytes=java.nio.file.Files.readAllBytes(java.nio.file.Path.of(sample));
        assertThat(bytes.length).isEqualTo(54501763);
        assertThat(com.hs.jxc.attachment.AttachmentObjectStore.sha256(bytes)).isEqualTo("736d04418821c5c9304c65522e262ea2da6c20fdd1b8c27190de549fe2bf0f86");
        try(var app=featureContainer(image,false)) {
            app.start();String base="http://"+app.getHost()+":"+app.getMappedPort(8080),boundary="stage-"+UUID.randomUUID();
            var body=java.net.http.HttpRequest.BodyPublishers.concat(
                java.net.http.HttpRequest.BodyPublishers.ofString("--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"NY-051.xlsx\"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n"),
                java.net.http.HttpRequest.BodyPublishers.ofByteArray(bytes),
                java.net.http.HttpRequest.BodyPublishers.ofString("\r\n--"+boundary+"--\r\n"));
            var http=java.net.http.HttpClient.newHttpClient();
            var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+"/api/v1/pur/order-imports"))
                .header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101")
                .header("Idempotency-Key",UUID.randomUUID().toString()).header("Content-Type","multipart/form-data; boundary="+boundary).POST(body).build();
            var response=http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).as(response.body()).isEqualTo(202);
            var b=codec.readMap(codec.write(codec.readMap(response.body()).get("data")));
            long source=owner.queryForObject("SELECT source_id FROM pur_order_import_task WHERE id=?",Long.class,task(b));
            assertThat(imports.content(actor,id(b),source,false).bytes()).isEqualTo(bytes);
            var read=http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+"/api/v1/pur/order-imports/"+id(b)))
                .header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());
            assertThat(read.statusCode()).as(read.body()).isEqualTo(200);
            assertThat(read.body()).contains("\"bookId\":null");
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
            String jarSha=com.hs.jxc.attachment.AttachmentObjectStore.sha256(java.nio.file.Files.readAllBytes(java.nio.file.Path.of("target/jxc-app-0.1.0-SNAPSHOT.jar")));
            assertThat(app.execInContainer("sha256sum","/app/app.jar").getStdout()).startsWith(jarSha+" ");
        }
    }

    @Test void realBridgeParsesUnassignedWorkbookWithoutBusinessWrites() throws Exception {
        String python=System.getProperty("jxc.test.purchase-python"),sample=System.getProperty("jxc.test.purchase-source");
        org.junit.jupiter.api.Assumptions.assumeTrue(python!=null&&sample!=null,"真实解析仅使用显式指定的解释器和样本");
        try(var bridge=startBridge(python)) {
            var client=bridge.client();doAnswer(call->client.parse(call.getArgument(0),call.getArgument(1),call.getArgument(2),call.getArgument(3),call.getArgument(4)))
                .when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
            var b=imports.upload(actor,"NY-051-采购导入.xlsx",java.nio.file.Files.readAllBytes(java.nio.file.Path.of(sample)),Map.of(),null,UUID.randomUUID().toString());
            tasks.execute(101,task(b));var result=tasks.get(actor,task(b));assertThat(result).as(result.toString()).containsEntry("status","SUCCEEDED");
            assertThat(rows(imports.get(actor,id(b)))).hasSize(60);
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_image",Integer.class)).isEqualTo(20);
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_row_image",Integer.class)).isEqualTo(60);
            assertThat(owner.queryForObject("SELECT sum(purchase_qty) FROM pur_order_import",java.math.BigDecimal.class)).isEqualByComparingTo("480");
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
            assertThat(owner.queryForObject("SELECT count(*) FROM md_product_image",Integer.class)).isZero();
        }
    }
}
