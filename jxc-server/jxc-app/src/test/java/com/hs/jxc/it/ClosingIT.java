package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.sys.service.SessionService;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Value;
import tools.jackson.databind.json.JsonMapper;

/** Real PostgreSQL period close facts, permissions, rollback and competing book gates. */
class ClosingIT extends BasePgIT {
    @Value("${local.server.port}") int port;
    @org.springframework.beans.factory.annotation.Autowired com.hs.jxc.fin.accounting.AccountingService accounting;
    @org.springframework.beans.factory.annotation.Autowired com.hs.jxc.sys.service.AuthorizationService authorization;
    @org.springframework.beans.factory.annotation.Autowired com.hs.jxc.sys.jobs.JobApi jobs;
    @org.springframework.test.context.DynamicPropertySource static void manualJobs(org.springframework.test.context.DynamicPropertyRegistry r){r.add("jxc.jobs.enabled",()->false);}
    final HttpClient http=HttpClient.newHttpClient();
    final JsonMapper json=JsonMapper.builder().build();
    @BeforeEach void fixtures(){
        resetFixtures();
        seed("insert into md_currency(code,name,decimals) values('MXN','Synthetic peso',2)");
        seed("insert into sys_country(id,code,name,default_currency,timezone,status) values(101,'CLOSE','Synthetic','MXN','UTC','ACTIVE')");
        seed("insert into sys_authz_epoch(country_id) values(101)");NumberFixtures.seed(101,"FIN_VOUCHER");
        seed("insert into sys_user(id,username,password_hash,display_name,status) values(201,'closer','unused','Synthetic closer','ENABLED')");
        seed("insert into sys_session(token_hash,user_id,expires_at) values(?,201,clock_timestamp()+interval '1 hour')",SessionService.digest("close-201"));
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(101,201,'COUNTRY_ALL',201)");
        seed("insert into sys_role(id,country_id,code,name,permissions,field_policies) values(203,101,'FIN','Finance','[\"fin:*\"]','{\"COST\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"BANK_INFO\":\"WRITE\",\"PROFIT\":\"WRITE\"}')");
        seed("insert into sys_user_role(country_id,user_id,role_id) values(101,201,203)");
        seed("insert into org_entity(id,country_id,code,name) values(301,101,'E','Synthetic')");
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(601,101,301,'B','Synthetic','MXN','ACTIVE')");
        seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(701,101,601,2026,10,'2026-10-01','2026-10-31','OPEN')");
    }
    @Test void missingReportConfigurationBlocksAndCannotBeWaived() throws Exception {
        var check=data(ok("POST","/fin/periods/701/close-check",Map.of("bookId",601)));
        assertThat(check).containsEntry("canClose",false);
        assertThat(check.get("checks").toString()).contains("REPORT_CONFIG","FAIL");
        assertThat(call("POST","/fin/periods/701/waive",Map.of("bookId",601,"checkCode","REPORT_CONFIG","reason","Synthetic","fingerprint","stale","closeGeneration",1)).statusCode()).isEqualTo(400);
        assertThat(call("POST","/fin/periods/701/close",Map.of("bookId",601)).body()).contains("FIN_CLOSE_BLOCKED");
        assertThat(owner.queryForObject("select status from fin_period where id=701",String.class)).isEqualTo("OPEN");
        assertThat(owner.queryForObject("select count(*) from fin_snapshot",Integer.class)).isZero();
    }
    @Test void closeIsAtomicIdempotentAndCheckNeverReopensClosedPeriod() throws Exception {
        templates();String key=UUID.randomUUID().toString();var body=Map.<String,Object>of("bookId",601);
        var closed=data(ok("POST","/fin/periods/701/close",body,key));
        assertThat(map(closed.get("period"))).containsEntry("status","CLOSED");
        assertThat(closed.get("closeGeneration")).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from fin_snapshot",Integer.class)).isEqualTo(3);
        assertThat(map(closed.get("nextPeriod"))).containsEntry("startDate","2026-11-01");
        assertThat(data(ok("POST","/fin/periods/701/close",body,key))).isEqualTo(closed);
        assertThat(data(ok("POST","/fin/periods/701/close",body))).containsEntry("duplicate",true);
        assertThat(data(ok("POST","/fin/periods/701/close-check",body))).containsEntry("canClose",false);
        assertThat(owner.queryForObject("select status from fin_period where id=701",String.class)).isEqualTo("CLOSED");
        assertThat(owner.queryForObject("select count(*) from fin_snapshot",Integer.class)).isEqualTo(3);
        seed("update sys_role set permissions='[\"fin:ledger:view\"]' where id=203");
        assertThat(call("POST","/fin/periods/701/close",body,key).statusCode()).isEqualTo(403);
    }
    private long id(Map<String,Object> row){return ((Number)row.get("id")).longValue();}
    @Test void queuedOpenPeriodExportRejectsAnInterveningCloseAndReopen() throws Exception {
        templates();var delayed=new ArrayList<Long>();
        for(String kind:List.of("FIN_LEDGER_EXPORT","FIN_REPORT_EXPORT"))delayed.add(id(jobs.enqueue(context(201,101,SessionService.digest("close-201")),kind,601,Map.of("periodId",701,"type",kind.equals("FIN_LEDGER_EXPORT")?"general":"INCOME"),UUID.randomUUID().toString())));
        ok("POST","/fin/periods/701/close",Map.of("bookId",601));ok("POST","/fin/periods/701/reopen",Map.of("bookId",601,"reason","Synthetic correction"));
        assertThat(owner.queryForObject("SELECT status FROM fin_period WHERE id=701",String.class)).isEqualTo("OPEN");
        for(long job:delayed){jobs.run(101,job);assertThat(data(ok("GET","/sys/jobs/"+job,null))).containsEntry("status","FAILED").containsEntry("lastError","JOB_CONTEXT_CHANGED");assertThat(owner.queryForObject("SELECT count(*) FROM sys_job_result WHERE job_id=?",Integer.class,job)).isZero();}
    }
    @Test void queuedFinancialExportsRejectChangedCloseGenerationWhileCompletedFilesStayFrozen() throws Exception {
        templates();ok("POST","/fin/periods/701/close",Map.of("bookId",601));
        var original=new ArrayList<Long>();var delayed=new ArrayList<Long>();
        for(String kind:List.of("FIN_LEDGER_EXPORT","FIN_REPORT_EXPORT")){
            String type=kind.equals("FIN_LEDGER_EXPORT")?"general":"INCOME";
            var params=Map.<String,Object>of("periodId",701,"type",type,"_periodContext",Map.of("status","OPEN"));
            long complete=id(jobs.enqueue(context(201,101,SessionService.digest("close-201")),kind,601,params,UUID.randomUUID().toString()));jobs.run(101,complete);original.add(complete);
            assertThat(data(ok("GET","/sys/jobs/"+complete,null))).containsEntry("status","SUCCESS");
            delayed.add(id(jobs.enqueue(context(201,101,SessionService.digest("close-201")),kind,601,params,UUID.randomUUID().toString())));
        }
        String saved=owner.queryForObject("SELECT content::text FROM sys_job_result WHERE job_id=?",String.class,original.getFirst());
        ok("POST","/fin/periods/701/reopen",Map.of("bookId",601,"reason","Synthetic correction"));ok("POST","/fin/periods/701/close",Map.of("bookId",601));
        for(long job:delayed){jobs.run(101,job);assertThat(data(ok("GET","/sys/jobs/"+job,null))).containsEntry("status","FAILED").containsEntry("lastError","JOB_CONTEXT_CHANGED");assertThat(owner.queryForObject("SELECT count(*) FROM sys_job_result WHERE job_id=?",Integer.class,job)).isZero();}
        for(long job:original)assertThat(call("GET","/sys/jobs/"+job+"/download",null).statusCode()).isEqualTo(200);
        assertThat(owner.queryForObject("SELECT content::text FROM sys_job_result WHERE job_id=?",String.class,original.getFirst())).isEqualTo(saved);
    }
    @Test void reopenRetainsGenerationsAndRejectsLaterClosedPeriods() throws Exception {
        templates();ok("POST","/fin/periods/701/close",Map.of("bookId",601));
        assertThat(call("POST","/fin/periods/701/reopen",Map.of("bookId",601)).statusCode()).isEqualTo(400);
        var impact=data(ok("GET","/fin/periods/701/reopen-impact?bookId=601",null));
        assertThat((List<?>)impact.get("dependencies")).hasSize(1);
        var reopened=data(ok("POST","/fin/periods/701/reopen",Map.of("bookId",601,"reason","Synthetic correction")));
        assertThat(map(reopened.get("period"))).containsEntry("status","OPEN");
        assertThat((List<?>)reopened.get("snapshotRefs")).hasSize(3);
        assertThat(owner.queryForObject("select count(*) from fin_snapshot",Integer.class)).isEqualTo(3);
        assertThat(data(ok("POST","/fin/periods/701/close",Map.of("bookId",601)))).containsEntry("closeGeneration",2);
        long next=owner.queryForObject("select id from fin_period where start_date='2026-11-01'",Long.class);
        ok("POST","/fin/periods/"+next+"/close",Map.of("bookId",601));
        assertThat(call("POST","/fin/periods/701/reopen",Map.of("bookId",601,"reason","Synthetic correction")).body()).contains("FIN_LATER_CLOSED");
        assertThat(owner.queryForObject("select count(*) from fin_snapshot where period_id=701",Integer.class)).isEqualTo(6);
    }
    @Test void runtimeCannotForgeClosingStateOrSnapshots() {
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("update fin_period set status='CLOSED' where id=701");return null;})).isInstanceOf(Exception.class);
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("insert into fin_snapshot(country_id,book_id,period_id,close_generation,snapshot_type,content,source_versions,source_fingerprint,created_by) values(101,601,701,1,'BALANCE','{}','{}',repeat('a',64),201)");return null;})).isInstanceOf(Exception.class);
    }
    @Test void simultaneousCloseCreatesExactlyOneGeneration() throws Exception {
        templates();var pool=Executors.newFixedThreadPool(3);var start=new CountDownLatch(1);
        try{var futures=new ArrayList<Future<HttpResponse<String>>>();for(int i=0;i<3;i++)futures.add(pool.submit(()->{start.await();return call("POST","/fin/periods/701/close",Map.of("bookId",601));}));start.countDown();for(var f:futures)assertThat(f.get(20,TimeUnit.SECONDS).statusCode()).isEqualTo(200);}
        finally{pool.shutdownNow();}
        assertThat(owner.queryForObject("select count(*) from fin_close_generation",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from fin_snapshot",Integer.class)).isEqualTo(3);
    }
    @Test void failedSnapshotInsertionRollsBackPeriodAndIdempotency() throws Exception {
        templates();seed("create function synthetic_close_failure() returns trigger language plpgsql as $$ begin if NEW.snapshot_type='REPORT' then raise exception 'Synthetic close failure';end if;return NEW;end $$");
        seed("create trigger synthetic_close_failure before insert on fin_snapshot for each row execute function synthetic_close_failure()");String key=UUID.randomUUID().toString();
        try{assertThat(call("POST","/fin/periods/701/close",Map.of("bookId",601),key).statusCode()).isEqualTo(500);assertThat(owner.queryForObject("select status from fin_period where id=701",String.class)).isEqualTo("OPEN");assertThat(owner.queryForObject("select count(*) from fin_snapshot",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from sys_idempotency where key=?",Integer.class,key)).isZero();}
        finally{seed("drop trigger synthetic_close_failure on fin_snapshot");seed("drop function synthetic_close_failure()");}
        ok("POST","/fin/periods/701/close",Map.of("bookId",601),key);
    }
    @Test void waiverBindsCurrentSourcesAndGenerationAndClosedLedgerUsesFrozenFacts() throws Exception {
        templates();var ar=data(ok("POST","/fin/accounts",Map.of("code","1101","name","Synthetic AR","category","ASSET","direction","DEBIT","reconcileType","AR")));var equity=data(ok("POST","/fin/accounts",Map.of("code","3001","name","Synthetic Equity","category","EQUITY","direction","CREDIT")));
        var zero=data(ok("POST","/fin/accounts",Map.of("code","1999","name","Synthetic zero account")));
        ok("POST","/fin/opening-balances",Map.of("accountId",ar.get("id"),"amount",10,"direction","DEBIT","cutoffDate","2026-09-30"));ok("POST","/fin/opening-balances",Map.of("accountId",equity.get("id"),"amount",10,"direction","CREDIT","cutoffDate","2026-09-30"));ok("POST","/fin/opening-balances/confirm",Map.of());
        var check=check("AR_DIFF");assertThat(check).containsEntry("result","FAIL").containsEntry("waivable",true);
        var waiver=Map.<String,Object>of("bookId",601,"checkCode","AR_DIFF","reason","Synthetic confirmed opening difference","fingerprint",check.get("fingerprint"),"closeGeneration",check.get("closeGeneration"));
        ok("POST","/fin/periods/701/waive",waiver);assertThat(check("AR_DIFF")).containsEntry("result","WAIVED");
        seed("update fin_account set name='Synthetic AR revised',version=version+1 where id=?",ar.get("id"));
        assertThat(call("POST","/fin/periods/701/waive",waiver).body()).contains("FIN_WAIVER_STALE");assertThat(check("AR_DIFF")).containsEntry("result","FAIL");
        check=check("AR_DIFF");ok("POST","/fin/periods/701/waive",Map.of("bookId",601,"checkCode","AR_DIFF","reason","Synthetic current difference","fingerprint",check.get("fingerprint"),"closeGeneration",check.get("closeGeneration")));ok("POST","/fin/periods/701/close",Map.of("bookId",601));
        seed("update fin_account set name='Changed after closing',version=version+1 where id=?",ar.get("id"));
        ok("DELETE","/fin/accounts/"+zero.get("id"),Map.of("version",zero.get("version")));var zeroDetail=data(ok("GET","/fin/ledgers/detail?bookId=601&periodId=701&accountId="+zero.get("id"),null));assertThat(map(zeroDetail.get("account"))).containsEntry("name","Synthetic zero account");
        var ledger=data(ok("GET","/fin/ledgers/balance?bookId=601&periodId=701",null));assertThat(ledger).containsEntry("source","CLOSED_SNAPSHOT");assertThat(ledger.toString()).contains("Synthetic AR revised").doesNotContain("Changed after closing");var detail=data(ok("GET","/fin/ledgers/detail?bookId=601&periodId=701&accountId="+ar.get("id"),null));assertThat(map(detail.get("account"))).containsEntry("name","Synthetic AR revised");
        var recon=data(ok("GET","/fin/reconcile?bookId=601&periodId=701&type=AR",null));assertThat(recon).containsEntry("source","CLOSED_SNAPSHOT");
        ok("POST","/fin/periods/701/reopen",Map.of("bookId",601,"reason","Synthetic correction"));assertThat(check("AR_DIFF")).containsEntry("result","FAIL").containsEntry("closeGeneration",2);
        assertThat(owner.queryForObject("select count(*) from fin_close_waiver",Integer.class)).isEqualTo(2);assertThat(owner.queryForObject("select count(*) from fin_snapshot",Integer.class)).isEqualTo(3);
    }
    @Test void checkingUnstartedPeriodDoesNotAdvertiseCloseOrChangeItsState() throws Exception {
        templates();seed("update fin_period set status='NOT_STARTED' where id=701");
        var result=data(ok("POST","/fin/periods/701/close-check",Map.of("bookId",601)));
        assertThat(result).containsEntry("canClose",false);assertThat(map(result.get("period"))).containsEntry("status","NOT_STARTED");
        assertThat(owner.queryForObject("select status from fin_period where id=701",String.class)).isEqualTo("NOT_STARTED");
    }
    @Test void reopenPermissionIsIndependentFromClosePermission() throws Exception {
        templates();seed("update sys_role set permissions='[\"fin:period:close\"]' where id=203");
        ok("POST","/fin/periods/701/close",Map.of("bookId",601));
        assertThat(call("POST","/fin/periods/701/reopen",Map.of("bookId",601,"reason","Synthetic correction")).statusCode()).isEqualTo(403);
        seed("update sys_role set permissions='[\"fin:period:reopen\"]' where id=203");
        ok("POST","/fin/periods/701/reopen",Map.of("bookId",601,"reason","Synthetic correction"));
        assertThat(call("POST","/fin/periods/701/close",Map.of("bookId",601)).statusCode()).isEqualTo(403);
    }
    @Test void controlledSqlCloseRejectsIncompleteSnapshotsAndOmittedRealBalanceRows() throws Exception {
        templates();var ar=data(ok("POST","/fin/accounts",Map.of("code","1101","name","Synthetic AR","category","ASSET","direction","DEBIT")));var equity=data(ok("POST","/fin/accounts",Map.of("code","3001","name","Synthetic Equity","category","EQUITY","direction","CREDIT")));
        ok("POST","/fin/opening-balances",Map.of("accountId",ar.get("id"),"amount",10,"direction","DEBIT","cutoffDate","2026-09-30"));ok("POST","/fin/opening-balances",Map.of("accountId",equity.get("id"),"amount",10,"direction","CREDIT","cutoffDate","2026-09-30"));ok("POST","/fin/opening-balances/confirm",Map.of());
        String report=json.writeValueAsString(Map.of("balance",Map.of("available",true),"income",Map.of("available",true),"cashflow",Map.of("available",true))),reconcile=json.writeValueAsString(Map.of("rows",List.of(Map.of("type","AR"),Map.of("type","AP"),Map.of("type","INVENTORY"),Map.of("type","CASH"))));
        assertThatThrownBy(()->inCountry(101,()->jdbc.queryForObject("select jxc_finalize_period(101,601,701,201,'{}'::jsonb,?::jsonb,?::jsonb,'{}'::jsonb,repeat('a',64),'[]'::jsonb)",Integer.class,report,reconcile))).hasStackTraceContaining("FIN_CLOSE_SNAPSHOT_INCOMPLETE");
        assertThatThrownBy(()->inCountry(101,()->jdbc.queryForObject("select jxc_finalize_period(101,601,701,201,'{\"balances\":[],\"postedLines\":[]}'::jsonb,?::jsonb,?::jsonb,'{}'::jsonb,repeat('a',64),'[]'::jsonb)",Integer.class,report,reconcile))).hasStackTraceContaining("FIN_CLOSE_BALANCE_MISMATCH");
        assertThat(owner.queryForObject("select status from fin_period where id=701",String.class)).isEqualTo("OPEN");assertThat(owner.queryForObject("select count(*) from fin_snapshot",Integer.class)).isZero();
    }
    @Test void nullAmountsCannotForgeAnImmutableBalanceSnapshotThroughControlledSql() throws Exception {
        templates();var debit=data(ok("POST","/fin/accounts",Map.of("code","1001","name","Synthetic asset")));var credit=data(ok("POST","/fin/accounts",Map.of("code","3001","name","Synthetic equity","category","EQUITY","direction","CREDIT")));
        ok("POST","/fin/opening-balances",Map.of("accountId",debit.get("id"),"amount",10,"direction","DEBIT","cutoffDate","2026-09-30"));ok("POST","/fin/opening-balances",Map.of("accountId",credit.get("id"),"amount",10,"direction","CREDIT","cutoffDate","2026-09-30"));ok("POST","/fin/opening-balances/confirm",Map.of());
        var fake=new ArrayList<Map<String,Object>>();for(long id:owner.queryForList("select id from fin_account_balance where period_id=701 order by id",Long.class)){var row=new LinkedHashMap<String,Object>();row.put("id",id);for(String field:List.of("accountId","auxKey","currency","openingDebit","openingCredit","periodDebit","periodCredit","closingDebit","closingCredit","origClosing"))row.put(field,null);fake.add(row);}
        String balance=json.writeValueAsString(Map.of("balances",fake,"postedLines",List.of())),report=json.writeValueAsString(Map.of("balance",Map.of("available",true),"income",Map.of("available",true),"cashflow",Map.of("available",true))),reconcile=json.writeValueAsString(Map.of("rows",List.of(Map.of("type","AR"),Map.of("type","AP"),Map.of("type","INVENTORY"),Map.of("type","CASH"))));
        var checks=List.of("UNPOSTED","UNBALANCED","EVENTS_OPEN","COST_PENDING","ALLOCATION_PENDING","STOCKTAKE_PENDING","RECON_DATA_MISSING","AR_DIFF","AP_DIFF","INV_DIFF","CASH_DIFF","CASHFLOW_MISSING","REPORT_CONFIG","NEXT_PERIOD").stream().map(code->Map.of("checkCode",code,"result","PASS")).toList();String checkJson=json.writeValueAsString(checks);
        assertThatThrownBy(()->inCountry(101,()->jdbc.queryForObject("select jxc_finalize_period(101,601,701,201,?::jsonb,?::jsonb,?::jsonb,'{}'::jsonb,repeat('a',64),?::jsonb)",Integer.class,balance,report,reconcile,checkJson))).hasStackTraceContaining("FIN_CLOSE_BALANCE_MISMATCH");
        assertThat(owner.queryForObject("select status from fin_period where id=701",String.class)).isEqualTo("OPEN");assertThat(owner.queryForObject("select count(*) from fin_snapshot",Integer.class)).isZero();
    }
    @Test void reportAvailabilityMustBeBooleanTrueForControlledSqlClose() throws Exception {
        templates();String report=json.writeValueAsString(Map.of("balance",Map.of("available","true"),"income",Map.of("available","true"),"cashflow",Map.of("available","true"))),reconcile=json.writeValueAsString(Map.of("rows",List.of(Map.of("type","AR"),Map.of("type","AP"),Map.of("type","INVENTORY"),Map.of("type","CASH"))));
        String checks=json.writeValueAsString(List.of("UNPOSTED","UNBALANCED","EVENTS_OPEN","COST_PENDING","ALLOCATION_PENDING","STOCKTAKE_PENDING","RECON_DATA_MISSING","AR_DIFF","AP_DIFF","INV_DIFF","CASH_DIFF","CASHFLOW_MISSING","REPORT_CONFIG","NEXT_PERIOD").stream().map(code->Map.of("checkCode",code,"result","PASS")).toList());
        assertThatThrownBy(()->inCountry(101,()->jdbc.queryForObject("select jxc_finalize_period(101,601,701,201,'{\"balances\":[],\"postedLines\":[]}'::jsonb,?::jsonb,?::jsonb,'{}'::jsonb,repeat('a',64),?::jsonb)",Integer.class,report,reconcile,checks))).hasStackTraceContaining("FIN_CLOSE_SNAPSHOT_INCOMPLETE");
        assertThat(owner.queryForObject("select status from fin_period where id=701",String.class)).isEqualTo("OPEN");
    }
    @Test void internalClosingReconciliationRetainsRawAmountsWhileHttpUsesCurrentMask() throws Exception {
        seed("update sys_role set field_policies='{}' where id=203");
        var raw=inCountry(101,()->{var a=authorization.authorize(context(201,101,SessionService.digest("close-201")));return accounting.reconcileForClose(a,601,701);});
        assertThat(raw.getFirst()).containsKeys("businessAmount","glAmount","diffAmount");
        var view=data(ok("GET","/fin/reconcile?bookId=601&periodId=701&type=AR",null));assertThat(view).doesNotContainKeys("businessAmount","glAmount","diffAmount");
    }
    @Test void sharedBusinessGateCommitsBeforeCloseRechecksAndClosedGateRejectsBusinessFact() throws Exception {
        templates();var pool=Executors.newFixedThreadPool(2);var locked=new CountDownLatch(1);var release=new CountDownLatch(1);
        try{
            var business=pool.submit(()->inCountry(101,()->{jdbc.queryForList("select id from fin_book where country_id=101 and id=601 for share");locked.countDown();await(release);jdbc.update("insert into sys_biz_event(country_id,book_id,event_type,source_type,source_id,biz_date) values(101,601,'SYNTHETIC_PENDING','SYNTHETIC',901,'2026-10-15')");return true;}));
            assertThat(locked.await(5,TimeUnit.SECONDS)).isTrue();var close=pool.submit(()->call("POST","/fin/periods/701/close",Map.of("bookId",601)));assertThatThrownBy(()->close.get(150,TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);release.countDown();assertThat(business.get(10,TimeUnit.SECONDS)).isTrue();assertThat(close.get(10,TimeUnit.SECONDS).body()).contains("FIN_CLOSE_BLOCKED","EVENTS_OPEN");
        }finally{release.countDown();pool.shutdownNow();}
        // A separate empty period demonstrates the opposite lock ordering without deleting facts.
        seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(700,101,601,2026,9,'2026-09-01','2026-09-30','OPEN')");
        ok("POST","/fin/periods/700/close",Map.of("bookId",601));
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("insert into sys_biz_event(country_id,book_id,event_type,source_type,source_id,biz_date) values(101,601,'SYNTHETIC_PENDING','SYNTHETIC',902,'2026-09-15')");return null;})).isInstanceOf(Exception.class);
        assertThat(owner.queryForObject("select count(*) from sys_biz_event where source_id=902",Integer.class)).isZero();
    }
    @Test void anotherBookIsIndependentAndReplayChecksCurrentFieldPolicy() throws Exception {
        templates();seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,301,'OTHER','Synthetic other book','MXN','ACTIVE')");seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(703,101,602,2026,10,'2026-10-01','2026-10-31','OPEN')");
        var pool=Executors.newSingleThreadExecutor();var locked=new CountDownLatch(1);var release=new CountDownLatch(1);
        try{var held=pool.submit(()->inCountry(101,()->{jdbc.queryForList("select id from fin_book where country_id=101 and id=601 for update");locked.countDown();await(release);return true;}));assertThat(locked.await(5,TimeUnit.SECONDS)).isTrue();assertThat(data(ok("POST","/fin/periods/703/close-check",Map.of("bookId",602)))).containsEntry("bookId",602);release.countDown();held.get(5,TimeUnit.SECONDS);}finally{release.countDown();pool.shutdownNow();}
        String key=UUID.randomUUID().toString();ok("POST","/fin/periods/701/close",Map.of("bookId",601),key);seed("update sys_role set field_policies='{}' where id=203");assertThat(call("POST","/fin/periods/701/close",Map.of("bookId",601),key).statusCode()).isEqualTo(403);
    }
    @SuppressWarnings("unchecked") Map<String,Object> check(String code) throws Exception {var out=data(ok("POST","/fin/periods/701/close-check",Map.of("bookId",601)));return ((List<Map<String,Object>>)out.get("checks")).stream().filter(r->code.equals(r.get("checkCode"))).findFirst().orElseThrow();}
    static void await(CountDownLatch latch){try{if(!latch.await(10,TimeUnit.SECONDS))throw new IllegalStateException("Synthetic barrier timeout");}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IllegalStateException(e);}}
    void templates() throws Exception {for(String type:List.of("BALANCE_SHEET","INCOME")){var t=data(ok("POST","/fin/report-templates",Map.of("bookId",601,"reportType",type,"name","Synthetic "+type,"rule","CATEGORY_V1")));ok("POST","/fin/report-templates/"+t.get("id")+"/review",Map.of("bookId",601,"version",t.get("version")));}}
    @SuppressWarnings("unchecked") Map<String,Object> map(Object raw){return (Map<String,Object>)raw;}
    Map<String,Object> data(HttpResponse<String> r){return map(json.readValue(r.body(),Map.class).get("data"));}
    HttpResponse<String> ok(String method,String path,Object body) throws Exception {return ok(method,path,body,UUID.randomUUID().toString());}
    HttpResponse<String> ok(String method,String path,Object body,String key) throws Exception {var r=call(method,path,body,key);assertThat(r.statusCode()).withFailMessage(r.body()).isEqualTo(200);return r;}
    HttpResponse<String> call(String method,String path,Object body) throws Exception {return call(method,path,body,UUID.randomUUID().toString());}
    HttpResponse<String> call(String method,String path,Object body,String key) throws Exception {var b=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1"+path)).header("Authorization","Bearer close-201").header("X-Country-Id","101").header("Content-Type","application/json").header("Idempotency-Key",key);b.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));return http.send(b.build(),HttpResponse.BodyHandlers.ofString());}
}
