package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.*;
import java.util.Map;
import java.util.List;
import java.math.BigDecimal;
import java.util.concurrent.*;
import com.hs.jxc.sys.jobs.*;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.FieldPolicyService;
import com.hs.jxc.common.api.ApiException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;

@Import(WorkbenchJobsIT.ProbeConfig.class)
class WorkbenchJobsIT extends SupplyFixtures {
    @Value("${local.server.port}") int port;
    final HttpClient client=HttpClient.newHttpClient();
    final ObjectMapper mapper=new ObjectMapper();
    @Autowired(required=false) JobApi jobs;
    @Autowired Probe probe;
    @Autowired(required=false) JobService jobService;
    @DynamicPropertySource static void manualWorker(DynamicPropertyRegistry r){r.add("jxc.jobs.enabled",()->false);}
    @SuppressWarnings("unchecked") Map<String,Object> request(String path,String method,Object body,String key)throws Exception {
        var b=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1"+path)).header("Authorization","Bearer supply-fixture").header("X-Country-Id","101");
        if(key!=null)b.header("Idempotency-Key",key);
        if(body==null)b.method(method,HttpRequest.BodyPublishers.noBody());else b.header("Content-Type","application/json").method(method,HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)));
        var r=client.send(b.build(),HttpResponse.BodyHandlers.ofString());var out=mapper.readValue(r.body(),Map.class);out.put("httpStatus",r.statusCode());return out;
    }
    @Test void personalWorkbenchReadsExistingFactsWithoutCreatingTasksOrNotifications()throws Exception {
        long events=owner.queryForObject("select count(*) from sys_biz_event",Long.class);
        assertThat(request("/sys/workbench/summary","GET",null,null)).containsEntry("httpStatus",200).containsEntry("code","OK");
        assertThat(request("/sys/todos","GET",null,null)).containsEntry("httpStatus",200);
        assertThat(request("/sys/notifications","GET",null,null)).containsEntry("httpStatus",200);
        assertThat(owner.queryForObject("select count(*) from sys_biz_event",Long.class)).isEqualTo(events);
        assertThat(owner.queryForObject("select count(*) from sys_todo",Integer.class)).isZero();
    }
    @Test void historicalAssignedTodoDoesNotKeepBusinessVisibilityAfterScopeRevocation()throws Exception {
        String title="Synthetic restricted statement from book 601",link="/finance/reports?bookId=601&periodId=701";
        seed("insert into sys_todo(country_id,todo_type,dedup_key,title,link,perm,assignee_id) values(101,'REPORT','restricted-book',?,?,'fin:report:view',201)",title,link);
        assertThat(request("/sys/todos","GET",null,null).toString()).contains(title,link);
        seed("delete from sys_user_data_scope where user_id=201");
        // The role still has *, but assignment must not override today's missing business scope.
        var todos=request("/sys/todos","GET",null,null);assertThat(todos).containsEntry("httpStatus",200);assertThat(todos.toString()).doesNotContain(title,link);
        assertThat(request("/sys/workbench/summary","GET",null,null).toString()).doesNotContain(link);
    }
    @SuppressWarnings("unchecked") Map<String,Object> queued(String intent)throws Exception {
        var r=request("/sys/jobs","POST",Map.of("jobType","TEST_EXPORT","bookId",601,"params",Map.of("nonce","one")),intent);
        assertThat(r).containsEntry("httpStatus",200).containsEntry("code","OK");return (Map<String,Object>)r.get("data");
    }
    @SuppressWarnings("unchecked") Map<String,Object> data(String path)throws Exception {var r=request(path,"GET",null,null);assertThat(r).containsEntry("httpStatus",200);return (Map<String,Object>)r.get("data");}
    @Test void exportIntentUsesExistingOutboxAndDownloadsOnlyAfterCommittedSuccess()throws Exception {
        probe.fail=false;String intent=key();var q=queued(intent);long job=id(q);assertThat(queued(intent).get("id")).isEqualTo(q.get("id"));
        assertThat(request("/sys/jobs/"+job+"/download","GET",null,null)).containsEntry("httpStatus",409);
        jobs.run(101,job);jobs.run(101,job);
        assertThat(data("/sys/jobs/"+job)).containsEntry("status","SUCCESS");
        assertThat(data("/sys/jobs/"+job+"/download")).containsEntry("content","12.34");
        assertThat(owner.queryForObject("select count(*) from sys_todo where dedup_key='job-probe-one'",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from sys_biz_event where source_type='SYS_REPORT_EXPORT'",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from sys_job_result",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select content->>'isolation' from sys_job_result",String.class)).isEqualTo("repeatable read");
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
    }
    @Test void failedEffectRollsBackOutputAndNotificationThenOriginalJobCanRetry()throws Exception {
        probe.fail=true;long job=id(queued(key()));jobs.run(101,job);
        assertThat(data("/sys/jobs/"+job)).containsEntry("status","FAILED").containsEntry("lastError","CONSUMER_FAILED");
        assertThat(owner.queryForObject("select count(*) from sys_job_result",Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from sys_notification",Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from sys_todo where dedup_key='job-probe-one'",Integer.class)).isZero();
        probe.fail=false;jobs.run(101,job);assertThat(data("/sys/jobs/"+job)).containsEntry("status","SUCCESS");
        assertThat(owner.queryForObject("select count(*) from sys_job_result",Integer.class)).isEqualTo(1);
    }
    @Test void concurrentWorkersCommitExactlyOneArtifactAndNotification()throws Exception {
        probe.fail=false;long job=id(queued(key()));var start=new CountDownLatch(1);var pool=Executors.newFixedThreadPool(2);
        try{var tasks=List.of(pool.submit(()->{start.await();jobs.run(101,job);return true;}),pool.submit(()->{start.await();jobs.run(101,job);return true;}));start.countDown();for(var task:tasks)task.get(20,TimeUnit.SECONDS);}finally{pool.shutdownNow();}
        assertThat(data("/sys/jobs/"+job)).containsEntry("status","SUCCESS");
        assertThat(owner.queryForObject("select count(*) from sys_job_result",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from sys_notification",Integer.class)).isEqualTo(1);
    }
    @Test void retryReauthorizesCurrentOwnerSessionAndRecordsANewExecutionIntent()throws Exception {
        probe.fail=false;long job=id(queued(key()));
        seed("update sys_session set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 second' where user_id=201");jobs.run(101,job);
        assertThat(owner.queryForObject("select count(*) from sys_job_result",Integer.class)).isZero();
        String hash=com.hs.jxc.sys.service.SessionService.digest("new-owner-session");
        seed("insert into sys_session(token_hash,user_id,expires_at) values(?,201,clock_timestamp()+interval '1 hour')",hash);
        jobService.retry(context(201,101,hash),job,key());jobs.run(101,job);jobs.run(101,job);
        assertThat(owner.queryForObject("select count(*) from sys_job_result",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from sys_notification",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select session_hash from sys_job_execution_intent where job_id=? order by id desc limit 1",String.class,job)).isEqualTo(hash);
        seed("update sys_role set permissions='[\"fin:report:view\"]' where id=202");
        assertThatThrownBy(()->jobService.retry(context(201,101,hash),job,key())).isInstanceOf(ApiException.class);
    }
    @Test void successfulCachedDownloadRechecksFieldsPermissionsAndCurrentBookScope()throws Exception {
        probe.fail=false;String intent=key();long job=id(queued(intent));jobs.run(101,job);
        seed("update sys_role set field_policies='{\"ORDER_TOTAL\":\"HIDDEN\"}' where id=202");
        assertThat(request("/sys/jobs/"+job+"/download","GET",null,null)).containsEntry("httpStatus",403);
        seed("update sys_role set permissions='[\"fin:report:view\"]' where id=202");
        assertThat(request("/sys/jobs/"+job+"/download","GET",null,null)).containsEntry("httpStatus",403);
        assertThat(request("/sys/jobs","POST",Map.of("jobType","TEST_EXPORT","bookId",601,"params",Map.of("nonce","one")),intent)).containsEntry("httpStatus",403);
        seed("update sys_role set permissions='[\"*\"]',field_policies='{\"ORDER_TOTAL\":\"WRITE\"}' where id=202");seed("delete from sys_user_data_scope where user_id=201");
        assertThat(request("/sys/jobs/"+job+"/download","GET",null,null)).containsEntry("httpStatus",404);
    }
    @Test void technicalExportsDoNotInventAnAccountingPeriodOrBecomeAccountingWork()throws Exception {
        // An export is technical work; the country current day has no accounting period in this fixture.
        probe.fail=false;seed("update fin_period set start_date='2025-10-01',end_date='2025-10-31',fiscal_year=2025 where id=701");
        long job=id(queued(key()));jobs.run(101,job);
        assertThat(data("/sys/jobs/"+job)).containsEntry("status","SUCCESS");
        assertThat(owner.queryForObject("select count(*) from sys_biz_event_consume where consumer='FIN_VOUCHER'",Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from fin_period",Integer.class)).isEqualTo(1);
    }
    @Test void disabledCountryHistoricalExportUsesOnlyTechnicalMetadata()throws Exception {
        seed("UPDATE sys_country SET status='DISABLED' WHERE id=101");
        var job=jobs.enqueue(c(),"FIN_LEDGER_EXPORT",601,Map.of("type","general","periodId",701),key());jobs.run(101,id(job));
        assertThat(data("/sys/jobs/"+id(job))).containsEntry("status","SUCCESS");assertThat(data("/sys/jobs/"+id(job)+"/download").get("content").toString()).contains("POSTED_FACTS");
        assertThat(owner.queryForObject("SELECT count(*) FROM fin_voucher",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM sys_job_result",Integer.class)).isEqualTo(1);
    }
    @Test void workerStatusIsCountryScopedAndRequiresOperationalPermission()throws Exception {
        var status=data("/sys/jobs/worker-status");assertThat(status).containsEntry("enabled",false).containsKeys("recoveryLimit","providers","runs");
        seed("UPDATE sys_role SET permissions='[\"fin:report:export\"]' WHERE id=202");assertThat(request("/sys/jobs/worker-status","GET",null,null).get("httpStatus")).isEqualTo(403);
    }
    @Test void workerStatusFlagsStaleRuntimeAndFailedEffects()throws Exception {
        seed("INSERT INTO sys_worker_runtime(country_id,kind,status,last_started_at) VALUES(101,'SYNTHETIC_STALE','RUNNING',clock_timestamp()-interval '10 minutes')");
        probe.fail=true;long job=id(queued(key()));jobs.run(101,job);
        var status=data("/sys/jobs/worker-status");assertThat(status.get("alerts").toString()).contains("WORKER_STALE","CONSUMER_FAILED","FAILED_EFFECT");
    }
    @Test void committedQueuedWorkCanRecoverWithoutTheAfterCommitExecutor()throws Exception {
        probe.fail=false;long job=id(queued(key()));
        assertThat(java.util.Arrays.stream(JobService.class.getMethods()).map(java.lang.reflect.Method::getName)).contains("recoverCountry");
        var method=JobService.class.getMethod("recoverCountry",long.class,int.class);
        method.invoke(jobService,101L,10);
        assertThat(data("/sys/jobs/"+job)).containsEntry("status","SUCCESS");
        assertThat(owner.queryForObject("select count(*) from sys_job_result",Integer.class)).isEqualTo(1);
    }
    @TestConfiguration static class ProbeConfig {
        @Bean Probe jobProbe(org.springframework.jdbc.core.JdbcTemplate db,FieldPolicyService fields){return new Probe(db,fields);}
    }
    static class Probe implements JobHandler {
        final org.springframework.jdbc.core.JdbcTemplate db;final FieldPolicyService fields;volatile boolean fail;
        Probe(org.springframework.jdbc.core.JdbcTemplate db,FieldPolicyService fields){this.db=db;this.fields=fields;}
        public String kind(){return "TEST_EXPORT";}
        public void authorize(Access a,long book,Map<String,Object> request){a.require("fin:report:export");if(!a.canBook(book))throw ApiException.notFound();}
        public Map<String,Object> execute(Access a,long book,Map<String,Object> request){db.update("insert into sys_todo(country_id,todo_type,dedup_key,title,assignee_id,status) values(?,'EXPORT','job-probe-one','Completed export',?,'DONE')",a.requireCountry(),a.userId());if(fail)throw new IllegalStateException("private internal diagnostic must not escape");return Map.of("amount",new BigDecimal("12.34"),"isolation",db.queryForObject("show transaction_isolation",String.class));}
        public Map<String,Object> download(Access a,long book,Map<String,Object> result){authorize(a,book,Map.of());var visible=fields.mask(a,result,"ORDER_TOTAL");if(!visible.containsKey("amount"))throw ApiException.forbidden();return Map.of("filename","test.csv","content",visible.get("amount").toString(),"contentType","text/csv; charset=UTF-8");}
    }
}
