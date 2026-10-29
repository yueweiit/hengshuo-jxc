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

/** 实际HTTP、数据库、MinIO验证；只使用隔离夹具，不连接运行业务库。 */
class PurchaseImportPhotoUploadIT extends PurchaseImportFixture {
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
        var request=HttpRequest.newBuilder(URI.create(base+"/api/v1/pur/order-imports/"+batch+"/rows/"+row+"/image"))
            .header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Idempotency-Key",key)
            .header("Content-Type","multipart/form-data; boundary="+boundary).POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray())).build();
        return HttpClient.newHttpClient().send(request,HttpResponse.BodyHandlers.ofString());
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
    @SuppressWarnings("unchecked") List<Map<String,Object>> list(Object value){return (List<Map<String,Object>>)value;}
    List<Map<String,Object>> listRows(Map<String,Object> doc){return list(doc.get("rows"));}
}
