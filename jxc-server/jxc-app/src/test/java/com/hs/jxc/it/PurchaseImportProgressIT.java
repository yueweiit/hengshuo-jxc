package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import java.util.*;
import java.net.URI;
import java.net.http.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class PurchaseImportProgressIT extends PurchaseImportFixture {
    Map<String,Object> twoRows(){var doc=document();var first=list(doc.get("rows")).getFirst();var second=new LinkedHashMap<>(first);second.put("sourceRow",3);doc.put("rows",List.of(first,second));return doc;}
    @SuppressWarnings("unchecked") List<Map<String,Object>> list(Object value){return (List<Map<String,Object>>)value;}
    HttpResponse<String> report(UUID task,String token,long source,String phase,int processed,Integer total)throws Exception {
        return report("http://127.0.0.1:"+port,task,token,source,phase,processed,total);
    }
    HttpResponse<String> report(String base,UUID task,String token,long source,String phase,int processed,Integer total)throws Exception {
        var body=new LinkedHashMap<String,Object>();body.put("sourceId",source);body.put("phase",phase);body.put("processedRows",processed);body.put("totalRows",total);
        var request=HttpRequest.newBuilder(URI.create(base+"/internal/purchase-import/tasks/"+task+"/progress")).header("X-Purchase-Task",token).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(codec.write(body))).build();
        return HttpClient.newHttpClient().send(request,HttpResponse.BodyHandlers.ofString());
    }
    @SuppressWarnings("unchecked") Map<String,Object> progress(UUID task){return (Map<String,Object>)tasks.get(actor,task).get("progress");}
    @Test void bridgeReportsRealRowsBeforeTheDocumentIsSaved()throws Exception {
        var b=upload(UUID.randomUUID().toString());UUID task=task(b);
        doAnswer(call->{var response=report(task,call.getArgument(1),call.getArgument(2),"PARSING",1,2);assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
            assertThat(progress(task)).containsEntry("processedRows",1).containsEntry("totalRows",2).containsEntry("phase","PARSING");
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import",Integer.class)).isZero();return twoRows();
        }).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task);assertThat(tasks.get(actor,task)).containsEntry("status","SUCCEEDED");assertThat(rows(imports.get(actor,id(b)))).hasSize(2);
    }
    @Test void progressRemainsReadableDuringTheBusinessTransactionAndSurvivesRollback()throws Exception {
        var b=upload(UUID.randomUUID().toString());UUID task=task(b);
        owner.execute("CREATE FUNCTION test_progress_reject_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_row=3 THEN PERFORM pg_sleep(3); RAISE EXCEPTION 'fixture second row rejected'; END IF; RETURN NEW; END $$");
        owner.execute("CREATE TRIGGER test_progress_second BEFORE INSERT ON pur_order_import FOR EACH ROW EXECUTE FUNCTION test_progress_reject_second()");
        doReturn(twoRows()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        var pool=Executors.newSingleThreadExecutor();
        try {
            var running=pool.submit(()->tasks.execute(101,task));long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);Map<String,Object> current=null;
            while(System.nanoTime()<deadline){current=progress(task);if(current!=null&&"SAVING".equals(current.get("phase"))&&Integer.valueOf(1).equals(current.get("processedRows")))break;Thread.sleep(50);}
            assertThat(current).containsEntry("phase","SAVING").containsEntry("processedRows",1);assertThat(running.isDone()).isFalse();
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import",Integer.class)).isZero();running.get(10,TimeUnit.SECONDS);
            assertThat(tasks.get(actor,task)).containsEntry("status","FAILED");assertThat(progress(task)).containsEntry("phase","SAVING").containsEntry("processedRows",1);
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import",Integer.class)).isZero();
        } finally {pool.shutdownNow();owner.execute("DROP TRIGGER IF EXISTS test_progress_second ON pur_order_import");owner.execute("DROP FUNCTION IF EXISTS test_progress_reject_second()");}
    }
    @Test void progressRejectsInvalidCountsWrongScopeAndPhaseRegression()throws Exception {
        var b=upload(UUID.randomUUID().toString());UUID task=task(b);
        doAnswer(call->{String token=call.getArgument(1);long source=call.getArgument(2);
            assertThat(report(task,"invalid",source,"PARSING",0,2).statusCode()).isIn(401,403);
            assertThat(report(task,token,source+1,"PARSING",0,2).statusCode()).isEqualTo(403);
            assertThat(report(task,token,source,"PARSING",3,2).statusCode()).isEqualTo(400);
            assertThat(report(task,token,source,"PARSING",-1,2).statusCode()).isEqualTo(400);
            assertThat(report(task,token,source,"PARSING",1,2).statusCode()).isEqualTo(200);
            assertThat(report(task,token,source,"READING",0,null).statusCode()).isEqualTo(409);
            assertThat(report(task,token,source,"DONE",2,2).statusCode()).isEqualTo(400);return twoRows();
        }).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task);
        assertThat(tasks.get(actor,task)).containsEntry("status","SUCCEEDED");
    }
    @Test void isolatedPythonBridgeUsesTheScopedProgressEndpointBeforeReturningRows()throws Exception {
        String python=System.getProperty("jxc.test.progress-python");org.junit.jupiter.api.Assumptions.assumeTrue(python!=null,"显式指定隔离桥接测试解释器");
        try(var bridge=startBridge(python,"workbench.tests.jxc_progress_fixture:app")){
            var b=upload(UUID.randomUUID().toString());UUID task=task(b);
            doAnswer(call->bridge.client().parse(call.getArgument(0),call.getArgument(1),call.getArgument(2),call.getArgument(3),call.getArgument(4))).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
            tasks.execute(101,task);assertThat(tasks.get(actor,task)).containsEntry("status","SUCCEEDED");assertThat(rows(imports.get(actor,id(b)))).hasSize(2);
            assertThat(progress(task)).containsEntry("sourceTotalRows",2).containsEntry("phase","LINKING");
            assertThat(owner.queryForObject("SELECT parser_version FROM pur_order_import_source",String.class)).isEqualTo("progress-contract-fixture");
        }
    }
    @Test void retryClearsCountsAndRejectsThePreviousAttemptCredential()throws Exception {
        var b=upload(UUID.randomUUID().toString());UUID task=task(b);String[] previous={null};
        doAnswer(call->{previous[0]=call.getArgument(1);assertThat(report(task,previous[0],call.getArgument(2),"PARSING",1,2).statusCode()).isEqualTo(200);throw com.hs.jxc.common.api.Inputs.bad("fixture parse failure");}).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task);assertThat(progress(task)).containsEntry("processedRows",1);
        tasks.retry(actor,task,UUID.randomUUID().toString(),null);assertThat(progress(task)).isNull();
        doAnswer(call->{assertThat(report(task,previous[0],call.getArgument(2),"PARSING",2,2).statusCode()).isEqualTo(403);assertThat(report(task,call.getArgument(1),call.getArgument(2),"PARSING",0,2).statusCode()).isEqualTo(200);assertThat(progress(task)).containsEntry("attemptCount",2).containsEntry("processedRows",0);return twoRows();}).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task);assertThat(tasks.get(actor,task)).containsEntry("status","SUCCEEDED");
    }
    @Test void validTaskCredentialStillRequiresTheRequestersCurrentAuthorization()throws Exception {
        var b=upload(UUID.randomUUID().toString());UUID task=task(b);
        doAnswer(call->{owner.update("UPDATE sys_session SET revoked_at=clock_timestamp() WHERE token_hash=?",tokenHash);assertThat(report(task,call.getArgument(1),call.getArgument(2),"PARSING",0,2).statusCode()).isIn(401,403);return twoRows();}).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task);assertThat(owner.queryForObject("SELECT status FROM pur_order_import_task WHERE id=?",String.class,task)).isEqualTo("NEEDS_REAUTH");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import",Integer.class)).isZero();
    }
    @Test void isolatedDockerApplicationAcceptsOnlyScopedProgressAndExposesTheActualTaskSnapshot()throws Exception {
        String image=System.getProperty("jxc.test.purchase-image");org.junit.jupiter.api.Assumptions.assumeTrue(image!=null,"仅显式构建本地特性镜像后运行");
        try(var app=featureContainer(image,false)){
            app.start();String base="http://"+app.getHost()+":"+app.getMappedPort(8080);var b=upload(UUID.randomUUID().toString());UUID task=task(b);
            doAnswer(call->{long source=call.getArgument(2);assertThat(report(base,task,"invalid",source,"PARSING",1,2).statusCode()).isIn(401,403);assertThat(report(base,task,call.getArgument(1),source,"PARSING",1,2).statusCode()).isEqualTo(200);
                var read=HttpRequest.newBuilder(URI.create(base+"/api/v1/pur/order-imports/tasks/"+task)).header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").GET().build();var response=HttpClient.newHttpClient().send(read,HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);assertThat(response.body()).contains("\"processedRows\":1","\"totalRows\":2","\"status\":\"RUNNING\"");return twoRows();
            }).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
            tasks.execute(101,task);assertThat(tasks.get(actor,task)).containsEntry("status","SUCCEEDED");
            String expected=com.hs.jxc.attachment.AttachmentObjectStore.sha256(java.nio.file.Files.readAllBytes(java.nio.file.Path.of("target/jxc-app-0.1.0-SNAPSHOT.jar")));assertThat(app.execInContainer("sha256sum","/app/app.jar").getStdout()).startsWith(expected+" ");
        }
    }
}
