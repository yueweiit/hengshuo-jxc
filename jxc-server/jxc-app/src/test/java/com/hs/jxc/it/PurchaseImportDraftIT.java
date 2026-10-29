package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.pur.service.impl.*;
import com.hs.jxc.pur.service.PurchaseImportRecognitionClient;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

class PurchaseImportDraftIT extends PurchaseImportFixture {
    @Autowired PurchaseImportProductServiceImpl review;
    @Autowired PurchaseImportDraftServiceImpl drafts;
    @DynamicPropertySource static void draftConfig(DynamicPropertyRegistry r){r.add("jxc.purchase-import.draft-creation.enabled",()->true);}
    @BeforeEach void permissions(){owner.update("UPDATE sys_role SET permissions=permissions||'[\"md:product:view\"]'::jsonb WHERE id=801");}
    @Override Map<String,Object> header(){var h=super.header();h.put("termDays",0);return h;}
    Map<String,Object> prepared(){var b=upload(UUID.randomUUID().toString());parse(b);var saved=imports.get(actor,id(b));long row=((Number)rows(saved).getFirst().get("id")).longValue();review.decide(actor,id(b),row,Map.of("version",1,"decision","EXISTING","productId",501,"unit","PCS"));return imports.get(actor,id(b));}
    Map<String,Object> preview(Map<String,Object>b){return drafts.previews(actor,id(b),Map.of("batchVersion",imports.get(actor,id(b)).get("version")));}
    Map<String,Object> readyGroup(Map<String,Object>b){var initial=groups(preview(b)).getFirst();var h=header();h.put("taxRate","0.13");h.put("priceTaxBasis","EXCLUSIVE");drafts.saveGroup(actor,id(b),((Number)initial.get("id")).longValue(),Map.of("groupVersion",initial.get("version"),"header",h));return groups(preview(b)).getFirst();}
    long groupId(Map<String,Object>g){return ((Number)g.get("id")).longValue();}
    Map<String,Object> confirmation(Map<String,Object>g){return Map.of("groupVersion",g.get("version"),"previewToken",g.get("previewToken"),"confirm",true);}
    @Test void previewRequiresTaxAndCompleteConfirmationWithoutAllocatingBusinessState(){
        var b=prepared();var group=groups(preview(b)).getFirst();assertThat(group.get("createStatus")).isEqualTo("DRAFT");assertThat(group.get("errors")).asString().contains("税率","价税");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM md_product_unit_used",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class)).isZero();
    }
    @Test void previewUsesTenDecimalSourceThenShowsFourDecimalNativePriceAndTax(){
        var b=prepared();var g=readyGroup(b);assertThat(g.get("createStatus")).isEqualTo("READY");var p=(Map<?,?>)g.get("preview");assertThat(p.get("totalAmount")).asString().isEqualTo("531.2350");assertThat(p.get("taxAmount")).asString().isEqualTo("69.0606");assertThat(p.get("lines")).asString().contains("53.1235","53.1234567890");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    @Test void unresolvedSecondRowBlocksTheWholeSourceOrder(){
        var b=prepared();var second=imports.upload(actor,"second.xlsx",file,header(),id(b),UUID.randomUUID().toString());parse(second);var group=readyGroup(b);assertThat(group.get("createStatus")).isEqualTo("DRAFT");assertThat(group.get("errors")).asString().contains("未确认");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    @Test void confirmedDraftIsCreatedOnceAndReadBackWithExactSourceMappings(){
        var b=prepared();var g=readyGroup(b);String key=UUID.randomUUID().toString();var first=drafts.create(actor,id(b),groupId(g),confirmation(g),key);var again=drafts.create(actor,id(b),groupId(g),confirmation(g),key);assertThat(first).containsEntry("createStatus","CREATED").containsEntry("verifyStatus","VERIFIED");assertThat(again.get("orderId")).isEqualTo(first.get("orderId"));assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("SELECT status FROM pur_order",String.class)).isEqualTo("DRAFT");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import WHERE target_order_line_id IS NOT NULL",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("SELECT count(*) FROM pur_domestic_receipt",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM ap_bill",Integer.class)).isZero();
        long row=((Number)rows(imports.get(actor,id(b))).getFirst().get("id")).longValue();assertThatThrownBy(()->imports.deleteRow(actor,id(b),row,2)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);
    }
    @Test void sourceOrMasterChangeInvalidatesTheStoredPreview(){
        var b=prepared();var g=readyGroup(b);owner.update("UPDATE md_product SET name='Changed',version=version+1 WHERE id=501");assertThatThrownBy(()->drafts.create(actor,id(b),groupId(g),confirmation(g),UUID.randomUUID().toString())).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    @Test void competingCreateCommandsCannotCreateTwoDrafts()throws Exception {
        var b=prepared();var g=readyGroup(b);assertThat(compete(()->drafts.create(actor,id(b),groupId(g),confirmation(g),UUID.randomUUID().toString()),()->drafts.create(actor,id(b),groupId(g),confirmation(g),UUID.randomUUID().toString()))).isEqualTo(1);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isEqualTo(1);
    }
    @Test void readBackFailureKeepsTheCreatedOrderAndCanBeVerifiedLater(){
        var b=prepared();owner.update("UPDATE sys_role SET permissions='[\"pur:order:create\",\"md:product:view\"]' WHERE id=801");var g=readyGroup(b);var result=drafts.create(actor,id(b),groupId(g),confirmation(g),UUID.randomUUID().toString());assertThat(result).containsEntry("createStatus","CREATED").containsEntry("verifyStatus","READ_FAILED");assertThat(result.get("orderId")).isNotNull();owner.update("UPDATE sys_role SET permissions=permissions||'[\"pur:order:view\"]'::jsonb WHERE id=801");assertThat(drafts.creation(actor,id(b),groupId(g))).containsEntry("verifyStatus","VERIFIED");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isEqualTo(1);
    }
    @Test void failedNativeTransactionLeavesNoHalfOrderAndOriginalRequestCanRecover(){
        var b=prepared();var g=readyGroup(b);String key=UUID.randomUUID().toString();
        owner.execute("CREATE FUNCTION reject_import_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture line rejected'; END $$");
        owner.execute("CREATE TRIGGER reject_import_line BEFORE INSERT ON pur_order_line FOR EACH ROW EXECUTE FUNCTION reject_import_line()");
        try{assertThatThrownBy(()->drafts.create(actor,id(b),groupId(g),confirmation(g),key)).isInstanceOf(RuntimeException.class);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM md_product_unit_used",Integer.class)).isZero();var pending=drafts.creation(actor,id(b),groupId(g));assertThat(pending).containsEntry("createStatus","UNKNOWN").containsKey("createIntent");var row=rows(imports.get(actor,id(b))).getFirst();assertThatThrownBy(()->imports.saveRow(actor,id(b),((Number)row.get("id")).longValue(),Map.of("version",row.get("version"),"values",values()))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);}
        finally{owner.execute("DROP TRIGGER reject_import_line ON pur_order_line");owner.execute("DROP FUNCTION reject_import_line()");}
        assertThat(drafts.create(actor,id(b),groupId(g),confirmation(g),key)).containsEntry("createStatus","CREATED").containsEntry("verifyStatus","VERIFIED");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isEqualTo(1);
    }
    @Test void laterNativeHeaderChangeIsReportedAsDifferentWithoutCreatingAgain(){
        var b=prepared();var g=readyGroup(b);var created=drafts.create(actor,id(b),groupId(g),confirmation(g),UUID.randomUUID().toString());owner.update("UPDATE pur_order SET term_days=30 WHERE id=?",created.get("orderId"));assertThat(drafts.creation(actor,id(b),groupId(g))).containsEntry("createStatus","CREATED").containsEntry("verifyStatus","DIFFERENT").containsEntry("orderId",created.get("orderId"));assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isEqualTo(1);
    }
    @Test void explicitSplitRetainsSourceNumberAndMapsDuplicateProductLinesBySequence(){
        var b=prepared();var second=imports.upload(actor,"second.xlsx",file,header(),id(b),UUID.randomUUID().toString());parse(second);var saved=imports.get(actor,id(b));var last=rows(saved).getLast();review.decide(actor,id(b),((Number)last.get("id")).longValue(),Map.of("version",last.get("version"),"decision","EXISTING","productId",501,"unit","PCS"));var g=readyGroup(b);var split=drafts.saveGroup(actor,id(b),groupId(g),Map.of("groupVersion",g.get("version"),"header",g.get("header"),"splitRowIds",List.of(last.get("id"))));assertThat(groups(split)).hasSize(2);for(var group:groups(preview(b))){assertThat(group.get("sourceOrderNo")).isEqualTo("PO-1");assertThat(drafts.create(actor,id(b),groupId(group),confirmation(group),UUID.randomUUID().toString())).containsEntry("verifyStatus","VERIFIED");}assertThat(owner.queryForObject("SELECT count(DISTINCT target_order_line_id) FROM pur_order_import",Integer.class)).isEqualTo(2);
    }

    @Test void isolatedFeatureDockerCreatesAndReadsTheOriginalDraftOverHttp()throws Exception{
        String image=System.getProperty("jxc.test.purchase-image");Assumptions.assumeTrue(image!=null,"显式构建特性镜像后执行");var b=prepared();var g=readyGroup(b);String key=UUID.randomUUID().toString();
        try(var app=featureContainer(image,true)){app.start();String base="http://"+app.getHost()+":"+app.getMappedPort(8080)+"/api/v1/pur/order-imports/"+id(b)+"/groups/"+groupId(g);var http=java.net.http.HttpClient.newHttpClient();var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+"/drafts")).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Content-Type","application/json").header("Idempotency-Key",key).POST(java.net.http.HttpRequest.BodyPublishers.ofString(codec.write(confirmation(g)))).build();var result=http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(result.statusCode()).as(result.body()).isEqualTo(200);assertThat(result.body()).contains("CREATED","VERIFIED","DRAFT");assertThat(http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(200);var read=java.net.http.HttpRequest.newBuilder(java.net.URI.create(base+"/creation")).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").GET().build();assertThat(http.send(read,java.net.http.HttpResponse.BodyHandlers.ofString()).body()).contains("VERIFIED");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isEqualTo(1);String expected=com.hs.jxc.attachment.AttachmentObjectStore.sha256(java.nio.file.Files.readAllBytes(java.nio.file.Path.of("target/jxc-app-0.1.0-SNAPSHOT.jar")));assertThat(app.execInContainer("sha256sum","/app/app.jar").getStdout()).startsWith(expected+" ");}
    }

    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(ints={1,2})
    void realBrowserSaveCreatesTheNativeDraftAndRepeatedSaveOnlyReadsIt(int expectedOrders)throws Exception {
        String script=System.getProperty("jxc.test.purchase-save-ui"),appImage=System.getProperty("jxc.test.purchase-image"),webImage=System.getProperty("jxc.test.purchase-web-image"),certs=System.getProperty("jxc.test.photo-certs");
        Assumptions.assumeTrue(script!=null&&appImage!=null&&webImage!=null&&certs!=null,"显式提供页面脚本与本地镜像后运行隔离真实保存验收");
        owner.update("UPDATE sys_role SET permissions='[\"*\"]'::jsonb WHERE id=801");
        var batch=prepared();
        if(expectedOrders==2){var second=imports.upload(actor,"second.xlsx",file,header(),id(batch),UUID.randomUUID().toString());parse(second);var last=rows(imports.get(actor,id(batch))).getLast();review.decide(actor,id(batch),((Number)last.get("id")).longValue(),Map.of("version",last.get("version"),"decision","EXISTING","productId",501,"unit","PCS"));}
        var ready=readyGroup(batch);
        if(expectedOrders==2){var last=rows(imports.get(actor,id(batch))).getLast();drafts.saveGroup(actor,id(batch),groupId(ready),Map.of("groupVersion",ready.get("version"),"header",ready.get("header"),"splitRowIds",List.of(last.get("id"))));}
        try(var gateway=featureGateway(appImage,webImage,certs,true)){
            var log=java.nio.file.Path.of("target/purchase-import-save-browser.log").toAbsolutePath();
            var process=new ProcessBuilder("node",script,gateway.base(),id(batch).toString(),java.nio.file.Path.of("target/purchase-import-save-browser-"+expectedOrders+".png").toAbsolutePath().toString(),String.valueOf(expectedOrders)).redirectErrorStream(true).redirectOutput(log.toFile()).start();
            try{assertThat(process.waitFor(100,java.util.concurrent.TimeUnit.SECONDS)).as("浏览器保存超时，日志 %s",log).isTrue();assertThat(process.exitValue()).as(java.nio.file.Files.readString(log)).isZero();}
            finally{if(process.isAlive()){process.destroyForcibly();process.waitFor();}}
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isEqualTo(expectedOrders);
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order WHERE status='DRAFT'",Integer.class)).isEqualTo(expectedOrders);
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_line",Integer.class)).isEqualTo(expectedOrders);
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import WHERE target_order_line_id IS NOT NULL",Integer.class)).isEqualTo(expectedOrders);
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_group WHERE fee_todos->0->>'reviewStatus'='CONFIRMED' AND (fee_todos->0->>'amount')::numeric=29.10",Integer.class)).isEqualTo(expectedOrders);
            assertThat(owner.queryForObject("SELECT count(*) FROM lgs_fee",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM cst_inbound_cost",Integer.class)).isZero();
            System.out.println(java.nio.file.Files.readString(log));
        }
    }


    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"UNIT","SCOPE","PERIOD"})
    void changedUnitScopeOrPeriodRejectsTheOriginalPreviewWithoutBusinessWrites(String change){var b=prepared();if(change.equals("UNIT")){owner.update("INSERT INTO md_product_unit(product_id,unit,factor_to_base) VALUES(501,'BOX',10)");var row=rows(imports.get(actor,id(b))).getFirst();review.decide(actor,id(b),((Number)row.get("id")).longValue(),Map.of("version",row.get("version"),"decision","EXISTING","productId",501,"unit","BOX"));}var g=readyGroup(b);switch(change){case "UNIT"->owner.update("UPDATE md_product_unit SET factor_to_base=12,version=version+1 WHERE product_id=501 AND unit='BOX'");case "SCOPE"->owner.update("DELETE FROM sys_user_data_scope WHERE user_id=201");case "PERIOD"->owner.update("UPDATE fin_period SET status='CLOSED' WHERE id=701");default->throw new AssertionError(change);}assertThatThrownBy(()->drafts.create(actor,id(b),groupId(g),confirmation(g),UUID.randomUUID().toString())).isInstanceOf(ApiException.class);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM md_product_unit_used",Integer.class)).isZero();}
}
