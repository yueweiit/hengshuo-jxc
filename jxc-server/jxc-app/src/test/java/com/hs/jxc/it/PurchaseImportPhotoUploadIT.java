package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import java.util.*;
import java.io.*;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import com.hs.jxc.attachment.AttachmentObjectStore;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.pur.service.impl.PurchaseImportProductServiceImpl;
import com.hs.jxc.pur.service.impl.PurchaseImportPhotoServiceImpl;

/** 实际HTTP、数据库、MinIO验证；只使用隔离夹具，不连接运行业务库。 */
class PurchaseImportPhotoUploadIT extends PurchaseImportFixture {
    @MockitoSpyBean AttachmentObjectStore objectStore;
    @Autowired PurchaseImportProductServiceImpl review;
    @Autowired PurchaseImportPhotoServiceImpl photos;
    HttpClient photoClient=HttpClient.newHttpClient();
    byte[] png() throws IOException {
        var out=new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(2,2,BufferedImage.TYPE_INT_RGB),"png",out);
        return out.toByteArray();
    }
    HttpResponse<String> uploadPhoto(UUID batch,long row,int version,byte[] bytes,String mime,String name,Map<String,Object> values,String key)throws Exception {
        return uploadPhoto("http://127.0.0.1:"+port,batch,row,version,bytes,mime,name,values,key);
    }
    HttpResponse<String> uploadPhoto(String base,UUID batch,long row,int version,byte[] bytes,String mime,String name,Map<String,Object> values,String key)throws Exception {
        String boundary="Photo"+UUID.randomUUID();var body=new ByteArrayOutputStream();
        for(var part:Map.of("version",String.valueOf(version),"values",codec.write(values)).entrySet()) body.write(("--"+boundary+"\r\nContent-Disposition: form-data; name=\""+part.getKey()+"\"\r\n\r\n"+part.getValue()+"\r\n").getBytes(StandardCharsets.UTF_8));
        body.write(("--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\""+name+"\"\r\nContent-Type: "+mime+"\r\n\r\n").getBytes(StandardCharsets.UTF_8));body.write(bytes);body.write(("\r\n--"+boundary+"--\r\n").getBytes(StandardCharsets.UTF_8));
        var request=HttpRequest.newBuilder(URI.create(base+"/api/v1/pur/order-imports?batchId="+batch+"&imageRowId="+row))
            .header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Idempotency-Key",key)
            .header("Content-Type","multipart/form-data; boundary="+boundary).POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray())).build();
        return photoClient.send(request,HttpResponse.BodyHandlers.ofString());
    }
    @SuppressWarnings("unchecked") Map<String,Object> data(HttpResponse<String> response){return (Map<String,Object>)codec.readMap(response.body()).get("data");}
    @SuppressWarnings("unchecked") List<Map<String,Object>> images(Map<String,Object> row){return (List<Map<String,Object>>)row.get("images");}
    @Test void uploadPersistsPhotoAndWholeRowWithManualProvenanceAndIdempotentRetry()throws Exception {
        var b=upload(UUID.randomUUID().toString());parse(b);var before=rows(imports.get(actor,id(b))).getFirst();long rowId=((Number)before.get("id")).longValue();
        var edited=values();edited.put("productSpec","M");byte[] bytes=png();String key=UUID.randomUUID().toString();
        var response=uploadPhoto(id(b),rowId,1,bytes,"image/png","photo.png",edited,key);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        var saved=rows(data(response)).getFirst();assertThat(saved).containsEntry("version",2).containsEntry("productSpec","M").containsEntry("purchaseUnitPrice","53.1234567890");
        var image=images(saved).getFirst();assertThat(image).containsEntry("status","CONFIRMED").containsEntry("origin","MANUAL_UPLOAD");
        assertThat(imports.content(actor,id(b),((Number)image.get("id")).longValue(),true).bytes()).containsExactly(bytes);
        var retry=uploadPhoto(id(b),rowId,1,bytes,"image/png","photo.png",edited,key);assertThat(retry.statusCode()).as(retry.body()).isEqualTo(200);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_image",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_source",Integer.class)).isEqualTo(2);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_task",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM md_product_image",Integer.class)).isZero();
        assertThat(((Number)images(rows(imports.get(actor,id(b))).getFirst()).getFirst().get("id")).longValue()).isEqualTo(((Number)image.get("id")).longValue());
    }
    @Test void replacementOnlyRejectsTheCurrentRowsOldImageAndPreservesTheSource()throws Exception {
        var b=upload(UUID.randomUUID().toString());var doc=photoDocument();var second=new LinkedHashMap<>(listRows(doc).getFirst());second.put("sourceRow",3);doc.put("rows",List.of(listRows(doc).getFirst(),second));
        var assoc=new LinkedHashMap<>(list(doc.get("associations")).getFirst());var other=new LinkedHashMap<>(assoc);other.put("sourceRow",3);doc.put("associations",List.of(assoc,other));
        doReturn(doc).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));var before=rows(imports.get(actor,id(b)));long rowId=((Number)before.getFirst().get("id")).longValue(),old=((Number)images(before.getFirst()).getFirst().get("id")).longValue();
        var response=uploadPhoto(id(b),rowId,1,png(),"image/png","photo.png",values(),UUID.randomUUID().toString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        var after=rows(imports.get(actor,id(b)));assertThat(images(after.getFirst())).anySatisfy(image->assertThat(image).containsEntry("id",old).containsEntry("status","REJECTED"));
        assertThat(images(after.get(1))).singleElement().satisfies(image->assertThat(image).containsEntry("id",old).containsEntry("status","UNCONFIRMED"));
        long source=((Number)before.getFirst().get("sourceId")).longValue();assertThat(imports.content(actor,id(b),source,false).bytes()).containsExactly(file);
    }
    @Test void staleVersionAndFalseImagesDoNotChangeRowOrImageRelations()throws Exception {
        var b=upload(UUID.randomUUID().toString());parse(b);long rowId=((Number)rows(imports.get(actor,id(b))).getFirst().get("id")).longValue();
        for(var bad:List.of(new byte[0],"not-an-image".getBytes(StandardCharsets.UTF_8),new byte[10*1024*1024+1])){
            var response=uploadPhoto(id(b),rowId,1,bad,"image/png","photo.png",values(),UUID.randomUUID().toString());assertThat(response.statusCode()).as(response.body()).isIn(400,413);
        }
        var mismatch=uploadPhoto(id(b),rowId,1,png(),"image/jpeg","photo.jpg",values(),UUID.randomUUID().toString());assertThat(mismatch.statusCode()).as(mismatch.body()).isEqualTo(400);
        var stale=uploadPhoto(id(b),rowId,2,png(),"image/png","photo.png",values(),UUID.randomUUID().toString());assertThat(stale.statusCode()).as(stale.body()).isEqualTo(409);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_image",Integer.class)).isZero();assertThat(rows(imports.get(actor,id(b))).getFirst()).containsEntry("version",1);
    }
    @Test void storageFailureKeepsThePreviousPhotoAndAllRowValues()throws Exception {
        var b=upload(UUID.randomUUID().toString());doReturn(photoDocument()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));
        var before=rows(imports.get(actor,id(b))).getFirst();long rowId=((Number)before.get("id")).longValue();var edited=values();edited.put("productSpec","M");
        doThrow(new ApiException(503,"STORAGE_UNAVAILABLE","附件存储暂时不可用")).when(objectStore).put(anyString(),any(byte[].class),eq("image/png"));
        var response=uploadPhoto(id(b),rowId,1,png(),"image/png","photo.png",edited,UUID.randomUUID().toString());assertThat(response.statusCode()).as(response.body()).isEqualTo(503);
        var after=rows(imports.get(actor,id(b))).getFirst();assertThat(after).containsEntry("version",1).containsEntry("productSpec","S");assertThat(images(after)).isEqualTo(images(before));
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_source",Integer.class)).isEqualTo(1);
    }
    @Test void missingPermissionWrongBatchAndCreatedRowCannotUpload()throws Exception {
        var b=upload(UUID.randomUUID().toString());parse(b);long rowId=((Number)rows(imports.get(actor,id(b))).getFirst().get("id")).longValue();byte[] image=png();
        var wrong=uploadPhoto(UUID.randomUUID(),rowId,1,image,"image/png","photo.png",values(),UUID.randomUUID().toString());assertThat(wrong.statusCode()).isEqualTo(404);
        owner.update("UPDATE pur_order_import SET target_order_line_id=999 WHERE id=?",rowId);
        var locked=uploadPhoto(id(b),rowId,1,image,"image/png","photo.png",values(),UUID.randomUUID().toString());assertThat(locked.statusCode()).as(locked.body()).isEqualTo(409);
        owner.update("UPDATE pur_order_import SET target_order_line_id=NULL WHERE id=?",rowId);owner.update("UPDATE sys_role SET permissions='[]' WHERE id=801");
        var denied=uploadPhoto(id(b),rowId,1,image,"image/png","photo.png",values(),UUID.randomUUID().toString());assertThat(denied.statusCode()).as(denied.body()).isEqualTo(403);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_image",Integer.class)).isZero();
    }
    @Test void replacingPublishedProductPhotoRequiresTheExistingProductPhotoWorkflow()throws Exception {
        var b=upload(UUID.randomUUID().toString());doReturn(photoDocument()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));
        var before=rows(imports.get(actor,id(b))).getFirst();long rowId=((Number)before.get("id")).longValue(),image=((Number)images(before).getFirst().get("id")).longValue();
        owner.update("UPDATE sys_role SET permissions=permissions||'[\"md:product:view\",\"md:product:edit\"]'::jsonb WHERE id=801");
        imports.associate(actor,id(b),rowId,image,Map.of("version",1,"association","CONFIRMED"));review.decide(actor,id(b),rowId,Map.of("version",2,"decision","EXISTING","productId",501,"unit","PCS"));
        var published=photos.publish(actor,id(b),rowId,Map.of("version",3,"imageIds",List.of(image),"confirmOwnership",true),UUID.randomUUID().toString());int version=((Number)rows(published).getFirst().get("version")).intValue();
        var response=uploadPhoto(id(b),rowId,version,png(),"image/png","photo.png",values(),UUID.randomUUID().toString());assertThat(response.statusCode()).as(response.body()).isEqualTo(409);
        assertThat(images(rows(imports.get(actor,id(b))).getFirst())).singleElement().satisfies(current->assertThat(current.get("productImageId")).isNotNull());
        assertThat(owner.queryForObject("SELECT count(*) FROM md_product_image",Integer.class)).isEqualTo(1);
    }
    @Test void isolatedDockerGatewayAcceptsPhotoAboveTwoMiBAndServesTheVerifiedPage()throws Exception {
        String appImage=System.getProperty("jxc.test.purchase-image"),webImage=System.getProperty("jxc.test.purchase-web-image"),certs=System.getProperty("jxc.test.photo-certs"),dist=System.getProperty("jxc.test.photo-dist");
        org.junit.jupiter.api.Assumptions.assumeTrue(appImage!=null&&webImage!=null&&certs!=null&&dist!=null,"仅在显式构建本地镜像和临时测试证书后运行");
        var certificate=java.security.cert.CertificateFactory.getInstance("X.509");var trust=java.security.KeyStore.getInstance(java.security.KeyStore.getDefaultType());trust.load(null,null);
        try(var input=java.nio.file.Files.newInputStream(java.nio.file.Path.of(certs,"certificate.pem"))){trust.setCertificateEntry("local-test",certificate.generateCertificate(input));}
        var manager=javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm());manager.init(trust);var ssl=javax.net.ssl.SSLContext.getInstance("TLS");ssl.init(null,manager.getTrustManagers(),null);photoClient=HttpClient.newBuilder().sslContext(ssl).build();
        var b=upload(UUID.randomUUID().toString());parse(b);long rowId=((Number)rows(imports.get(actor,id(b))).getFirst().get("id")).longValue();
        try(var gateway=featureGateway(appImage,webImage,certs,false)){
            var app=gateway.app();String base=gateway.base();
                var picture=new BufferedImage(1024,1024,BufferedImage.TYPE_INT_RGB);var random=new Random(123);
                for(int y=0;y<1024;y++)for(int x=0;x<1024;x++)picture.setRGB(x,y,random.nextInt());
                var out=new ByteArrayOutputStream();ImageIO.write(picture,"png",out);byte[] bytes=out.toByteArray();assertThat(bytes.length).isGreaterThan(2*1024*1024);
                var response=uploadPhoto(base,id(b),rowId,1,bytes,"image/png","large-photo.png",values(),UUID.randomUUID().toString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
                long image=((Number)images(rows(data(response)).getFirst()).getFirst().get("id")).longValue();
                var read=HttpRequest.newBuilder(URI.create(base+"/api/v1/pur/order-imports/"+id(b)+"/images/"+image+"/content")).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").GET().build();
                var content=photoClient.send(read,HttpResponse.BodyHandlers.ofByteArray());assertThat(content.statusCode()).isEqualTo(200);assertThat(content.body()).containsExactly(bytes);
                var page=photoClient.send(HttpRequest.newBuilder(URI.create(base+"/purchase/orders/import")).GET().build(),HttpResponse.BodyHandlers.ofString());assertThat(page.statusCode()).isEqualTo(200);assertThat(page.body()).contains("<div id=\"app\"");
                var root=java.nio.file.Path.of(dist);int checked=0;
                try(var files=java.nio.file.Files.walk(root)){
                    for(var path:files.filter(java.nio.file.Files::isRegularFile).toList()){
                        String relative=root.relativize(path).toString().replace('\\','/');
                        var asset=photoClient.send(HttpRequest.newBuilder(URI.create(base+"/"+relative)).GET().build(),HttpResponse.BodyHandlers.ofByteArray());
                        assertThat(asset.statusCode()).as(relative).isEqualTo(200);assertThat(AttachmentObjectStore.sha256(asset.body())).as(relative).isEqualTo(AttachmentObjectStore.sha256(java.nio.file.Files.readAllBytes(path)));checked++;
                    }
                }
                assertThat(checked).isGreaterThan(10);System.out.println("PHOTO_GATEWAY_VERIFIED bytes="+bytes.length+" staticFiles="+checked);
                String expected=AttachmentObjectStore.sha256(java.nio.file.Files.readAllBytes(java.nio.file.Path.of("target/jxc-app-0.1.0-SNAPSHOT.jar")));assertThat(app.execInContainer("sha256sum","/app/app.jar").getStdout()).startsWith(expected+" ");
        }
    }
    @SuppressWarnings("unchecked") List<Map<String,Object>> list(Object value){return (List<Map<String,Object>>)value;}
    List<Map<String,Object>> listRows(Map<String,Object> doc){return list(doc.get("rows"));}
}
