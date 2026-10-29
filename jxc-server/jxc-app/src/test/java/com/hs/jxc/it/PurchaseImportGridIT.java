package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import org.junit.jupiter.api.Test;

/** RevoGrid只编辑采购暂存；真实HTTP/数据库，不触碰现有运行批次。 */
class PurchaseImportGridIT extends PurchaseImportFixture {
    final HttpClient client=HttpClient.newHttpClient();
    Map<String,Object> item(Long id,Integer version,String clientId,String name) {
        var r=new LinkedHashMap<String,Object>();r.put("id",id);r.put("version",version);r.put("clientId",clientId);r.put("values",values());
        var names=new LinkedHashMap<String,Object>();names.put("suppliedProductName",name);names.put("suppliedProductCode",null);names.put("supplierProductCode",null);r.put("matchInputs",names);return r;
    }
    Map<String,Object> request(Map<String,Object>b,List<Map<String,Object>> rows) {
        var body=new LinkedHashMap<String,Object>();body.put("batchId",b==null?null:b.get("batchId"));body.put("batchVersion",b==null?null:b.get("version"));body.put("header",Map.of());body.put("rows",rows);return body;
    }
    HttpResponse<String> post(Map<String,Object> body,String key)throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1/pur/order-imports/grid"))
            .header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Content-Type","application/json").header("Idempotency-Key",key)
            .POST(HttpRequest.BodyPublishers.ofString(codec.write(body))).build(),HttpResponse.BodyHandlers.ofString());
    }
    @SuppressWarnings("unchecked") Map<String,Object> data(HttpResponse<String>r){return (Map<String,Object>)codec.readMap(r.body()).get("data");}
    @Test void emptyGridCreatesStagingWithUnknownsAndReplaysWithoutDuplicateRows()throws Exception {
        var first=item(null,null,"-1","商品甲");((Map<String,Object>)first.get("values")).put("purchaseQty",null);
        var body=request(null,List.of(first,item(null,null,"-2","商品乙")));String key=UUID.randomUUID().toString();
        var response=post(body,key);assertThat(response.statusCode()).as(response.body()).isEqualTo(200);var saved=data(response);
        assertThat(rows(saved)).hasSize(2);assertThat(rows(saved).getFirst().get("purchaseQty")).isNull();
        assertThat(rows(saved).getFirst().get("suppliedProductName")).isEqualTo("商品甲");
        assertThat(((Map<?,?>)saved.get("header")).get("bookId")).isNull();
        assertThat(post(body,key).body()).contains(saved.get("batchId").toString());
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import",Integer.class)).isEqualTo(2);
        assertThat(owner.queryForObject("SELECT original_values->>'format' FROM pur_order_import ORDER BY row_no LIMIT 1",String.class)).isEqualTo("ManualGridV1");
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    Map<String,Object> parsedPhoto(){var b=upload(UUID.randomUUID().toString());doReturn(photoDocument()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));return imports.get(actor,id(b));}
    @Test void updateAndAppendKeepImageSourceAndOriginalCells()throws Exception {
        var b=parsedPhoto();var old=rows(b).getFirst();long rid=((Number)old.get("id")).longValue();
        String original=owner.queryForObject("SELECT original_values::text FROM pur_order_import WHERE id=?",String.class,rid);
        var edited=item(rid,((Number)old.get("version")).intValue(),"17","改名");
        var response=post(request(b,List.of(edited,item(null,null,"-1","追加商品"))),UUID.randomUUID().toString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);var saved=rows(data(response));assertThat(saved).hasSize(2);
        assertThat(codec.write(saved.getFirst().get("images"))).isEqualTo(codec.write(old.get("images")));
        assertThat(saved.getFirst().get("sourceId").toString()).isEqualTo(old.get("sourceId").toString());
        assertThat(owner.queryForObject("SELECT original_values::text FROM pur_order_import WHERE id=?",String.class,rid)).isEqualTo(original);
        assertThat(saved.getFirst().get("purchaseUnitPrice")).isEqualTo("53.1234567890");
    }
    @Test void invalidSecondRowRollsBackFirstRowAndNewBatch()throws Exception {
        var invalid=item(null,null,"-2","错误行");((Map<String,Object>)invalid.get("values")).put("purchaseQty","abc");
        var response=post(request(null,List.of(item(null,null,"-1","有效行"),invalid)),UUID.randomUUID().toString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(400);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import",Integer.class)).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_batch",Integer.class)).isZero();
    }
    @Test void staleBatchOrRowVersionRejectsAllChanges()throws Exception {
        var b=parsedPhoto();var r=rows(b).getFirst();long rid=((Number)r.get("id")).longValue();
        var badRow=item(rid,99,"17","不应保存");
        assertThat(post(request(b,List.of(item(null,null,"-1","先插入"),badRow)),UUID.randomUUID().toString()).statusCode()).isEqualTo(409);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import",Integer.class)).isEqualTo(1);
        var body=request(b,List.of(item(rid,((Number)r.get("version")).intValue(),"17","过期批次")));body.put("batchVersion",99);
        assertThat(post(body,UUID.randomUUID().toString()).statusCode()).isEqualTo(409);
    }
    @Test void pastedPhotoCannotReplaceImageEvidence()throws Exception {
        var b=parsedPhoto();var r=rows(b).getFirst();var edit=item(((Number)r.get("id")).longValue(),((Number)r.get("version")).intValue(),"17","名称");
        ((Map<String,Object>)edit.get("values")).put("photo","任意图片网址");
        assertThat(post(request(b,List.of(edit)),UUID.randomUUID().toString()).statusCode()).isEqualTo(400);
        assertThat(rows(imports.get(actor,id(b))).getFirst().get("images")).isEqualTo(r.get("images"));
    }
    @Test void replayRechecksFieldPermission()throws Exception {
        var body=request(null,List.of(item(null,null,"-1","商品")));String key=UUID.randomUUID().toString();
        assertThat(post(body,key).statusCode()).isEqualTo(200);
        owner.update("UPDATE sys_role SET field_policies='{\"COST\":\"READ\",\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\"}' WHERE id=801");
        assertThat(post(body,key).statusCode()).isEqualTo(403);
    }
    @Test void createdRowsCannotBeEditedOrPartiallyAppended()throws Exception {
        var b=parsedPhoto();var r=rows(b).getFirst();long rowId=((Number)r.get("id")).longValue();
        owner.update("UPDATE pur_order_import SET target_order_line_id=999 WHERE id=?",rowId);
        var body=request(b,List.of(item(null,null,"-1","不能插入"),item(rowId,((Number)r.get("version")).intValue(),"17","不能覆盖")));
        assertThat(post(body,UUID.randomUUID().toString()).statusCode()).isEqualTo(409);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import",Integer.class)).isEqualTo(1);
    }
    @Test void wholeRowPhotoAndNameSaveShareTheSameAtomicRequest()throws Exception {
        var b=parsedPhoto();var r=rows(b).getFirst();long rowId=((Number)r.get("id")).longValue();
        var image=Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=");
        var input=item(rowId,((Number)r.get("version")).intValue(),"17","照片和名称");
        var saved=imports.uploadPhoto(actor,id(b),rowId,"photo.png","image/png",image,input,UUID.randomUUID().toString());
        assertThat(rows(saved).getFirst().get("suppliedProductName")).isEqualTo("照片和名称");
        assertThat(rows(saved).getFirst().get("images").toString()).contains("MANUAL_UPLOAD");
    }
    @Test void clearingManualBatchRedactsGridReplaySnapshot()throws Exception {
        var body=request(null,List.of(item(null,null,"-1","不能恢复的草稿")));String key=UUID.randomUUID().toString();
        var saved=data(post(body,key));
        var clearing=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1/pur/order-imports/"+saved.get("batchId")))
            .header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("If-Match",saved.get("version").toString()).header("Idempotency-Key",UUID.randomUUID().toString()).DELETE().build(),HttpResponse.BodyHandlers.ofString());
        assertThat(clearing.statusCode()).as(clearing.body()).isEqualTo(200);
        assertThat(owner.queryForObject("SELECT response->>'cleared' FROM sys_idempotency WHERE key=?",String.class,key)).isEqualTo("true");
        assertThat(post(body,key).statusCode()).isEqualTo(404);
    }
}
