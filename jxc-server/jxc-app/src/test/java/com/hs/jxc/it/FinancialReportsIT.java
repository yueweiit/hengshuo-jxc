package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.sys.service.SessionService;
import com.hs.jxc.sys.jobs.JobApi;
import java.net.URI;
import java.net.http.*;
import java.math.BigDecimal;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.json.JsonMapper;

/** Reports use the same synthetic ledger lifecycle and real PostgreSQL boundaries as LedgerIT. */
class FinancialReportsIT extends BasePgIT {
    @Value("${local.server.port}") int port;
    @Autowired ObjectProvider<JobApi> jobs;
    @DynamicPropertySource static void manualExportWorker(DynamicPropertyRegistry r){r.add("jxc.jobs.enabled",()->false);}
    final HttpClient http=HttpClient.newHttpClient();final JsonMapper json=JsonMapper.builder().build();
    @BeforeEach void fixtures(){
        resetFixtures();
        seed("insert into md_currency(code,name,decimals) values('MXN','Synthetic peso',2)");
        seed("insert into sys_country(id,code,name,default_currency,timezone,status) values(101,'REPORT','Synthetic','MXN','UTC','ACTIVE')");seed("insert into sys_authz_epoch(country_id) values(101)");NumberFixtures.seed(101,"FIN_VOUCHER");
        seed("insert into sys_user(id,username,password_hash,display_name,status) values(201,'preparer','unused','Preparer','ENABLED'),(202,'auditor','unused','Auditor','ENABLED')");
        for(int user:List.of(201,202)){seed("insert into sys_session(token_hash,user_id,expires_at) values(?,?,clock_timestamp()+interval '1 hour')",SessionService.digest("reports-"+user),user);seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(101,?,'COUNTRY_ALL',201)",user);}
        seed("insert into sys_role(id,country_id,code,name,permissions,field_policies) values(203,101,'FIN','Finance','[\"fin:*\"]','{\"COST\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"BANK_INFO\":\"WRITE\",\"PROFIT\":\"WRITE\"}')");seed("insert into sys_user_role(country_id,user_id,role_id) values(101,201,203),(101,202,203)");
        seed("insert into org_entity(id,country_id,code,name) values(301,101,'E','Synthetic')");seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(601,101,301,'B','Synthetic','MXN','ACTIVE')");
        seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(701,101,601,2026,10,'2026-10-01','2026-10-31','OPEN'),(702,101,601,2026,11,'2026-11-01','2026-11-30','OPEN')");
    }
    @Test void missingTemplatesAreExplicitAndReadsNeverInventConfigurationOrOpenings()throws Exception{
        var report=report("BALANCE_SHEET",701);assertThat(report).containsEntry("available",false).containsEntry("source","LIVE");assertThat(report.get("missingConfigurations").toString()).contains("FIN_REPORT_TEMPLATE_MISSING");
        assertThat(owner.queryForObject("select count(*) from fin_opening_balance",Integer.class)).isZero();assertThat(owner.queryForObject("select count(*) from fin_report_template",Integer.class)).isZero();
        assertThat(report("CASHFLOW",701)).containsEntry("available",true);
    }
    @Test void reportsUsePostedOriginalFactsConfirmedOpeningEquityAndCashBankFlows()throws Exception{
        long asset=account("1101","ASSET","DEBIT"),equity=account("3001","EQUITY","CREDIT"),income=account("6001","INCOME","CREDIT"),cost=account("5001","COST","DEBIT");
        opening(asset,"DEBIT",50);opening(equity,"CREDIT",50);ok(201,"POST","/fin/opening-balances/confirm",Map.of());templates();
        var sale=post(asset,income,100,"2026-10-15");post(cost,asset,40,"2026-10-15");
        create(asset,income,999,"2026-10-15");
        long cash=id(data(ok(201,"POST","/fin/accounts",Map.of("code","1001","name","Cash","category","ASSET","isCash",true))));
        long flow=id(data(ok(201,"POST","/fin/cashflow-items",Map.of("code","CF","name","Actual collection","category","OPERATING","direction","IN"))));
        postLines(List.of(Map.of("accountId",cash,"debit",12,"cashflowItemId",flow),Map.of("accountId",asset,"credit",12)),"2026-10-16");
        assertThat(amount(report("INCOME",701),"PROFIT")).isEqualByComparingTo("60");var bs=report("BALANCE_SHEET",701);assertThat(amount(bs,"ASSET")).isEqualByComparingTo("110");assertThat(amount(bs,"EQUITY")).isEqualByComparingTo("50");assertThat(bs).containsEntry("balanced",true);
        assertThat(amount(report("CASHFLOW",701),"CF")).isEqualByComparingTo("12");
        var reversal=data(ok(201,"POST","/fin/vouchers/"+id(sale)+"/reverse",Map.of("version",sale.get("version"),"voucherDate","2026-11-10","reason","Synthetic correction")));reversal=action(202,reversal,"audit");action(201,reversal,"post");
        assertThat(amount(report("INCOME",701),"REVENUE")).isEqualByComparingTo("100");assertThat(amount(report("INCOME",702),"REVENUE")).isEqualByComparingTo("-100");
        // A damaged projection must neither change report facts nor be silently rebuilt by GET.
        owner.execute("ALTER TABLE fin_account_balance DISABLE TRIGGER USER");try{seed("delete from fin_account_balance where country_id=101");}finally{owner.execute("ALTER TABLE fin_account_balance ENABLE TRIGGER USER");}
        assertThat(amount(report("INCOME",701),"PROFIT")).isEqualByComparingTo("60");assertThat(owner.queryForObject("select count(*) from fin_account_balance",Integer.class)).isZero();
    }
    @Test void templateFormulaIsControlledVersionsRequireReviewAndForeignAccountsRollback()throws Exception{
        long account=account("1001","ASSET","DEBIT");
        var draft=data(ok(201,"POST","/fin/report-templates",Map.of("bookId",601,"reportType","BALANCE_SHEET","name","Synthetic","rule","CATEGORY_V1")));
        assertThat(report("BALANCE_SHEET",701)).containsEntry("available",false);
        assertThat(call(201,"PUT","/fin/report-templates/"+id(draft),Map.of("bookId",601,"version",999,"reportType","BALANCE_SHEET","name","Stale","rule","CATEGORY_V1")).statusCode()).isEqualTo(409);
        ok(202,"POST","/fin/report-templates/"+id(draft)+"/review",Map.of("bookId",601,"version",draft.get("version")));
        assertThat(call(201,"PUT","/fin/report-templates/"+id(draft),Map.of("bookId",601,"version",draft.get("version"),"reportType","BALANCE_SHEET","name","Mutate","rule","CATEGORY_V1")).statusCode()).isEqualTo(400);
        var invalid=Map.<String,Object>of("bookId",601,"reportType","INCOME","name","Invalid","rule","ACCOUNT_MAP_V1","lines",List.of(Map.of("code","X","name","X","formula","Runtime.exec('x')","accountIds",List.of(account))));
        assertThat(call(201,"POST","/fin/report-templates",invalid).body()).contains("FIN_REPORT_EXPRESSION_INVALID");
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,301,'B2','Foreign book','MXN','ACTIVE')");seed("insert into fin_account(id,country_id,book_id,code,name,category,direction) values(801,101,602,'X','Foreign','ASSET','DEBIT')");
        var foreign=Map.<String,Object>of("bookId",601,"reportType","INCOME","name","Foreign","rule","ACCOUNT_MAP_V1","lines",List.of(Map.of("code","X","name","X","formula","PERIOD_NET","accountIds",List.of(801))));
        assertThat(call(201,"POST","/fin/report-templates",foreign).statusCode()).isEqualTo(404);assertThat(owner.queryForObject("select count(*) from fin_report_template",Integer.class)).isEqualTo(1);
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("update fin_report_template set name='Forged' where id=?",id(draft));return null;})).hasStackTraceContaining("JXC_REVIEWED_REPORT_IMMUTABLE");
        assertThat(inCountry(999,()->jdbc.queryForObject("select count(*) from fin_report_template",Integer.class))).isZero();
    }
    @Test void approvedAccountMapUsesOnlyControlledFactsAndOrderedLineSums()throws Exception{
        long asset=account("1101","ASSET","DEBIT"),income=account("6001","INCOME","CREDIT");post(asset,income,35,"2026-10-15");
        var tpl=data(ok(201,"POST","/fin/report-templates",Map.of("bookId",601,"reportType","INCOME","name","Explicit account map","rule","ACCOUNT_MAP_V1","lines",List.of(Map.of("code","REVENUE","name","Revenue","formula","PERIOD_NET","sign",-1,"accountIds",List.of(income)),Map.of("code","PROFIT","name","Profit","formula","LINE_SUM","terms",List.of(Map.of("code","REVENUE","sign",1)))))));
        ok(202,"POST","/fin/report-templates/"+id(tpl)+"/review",Map.of("bookId",601,"version",tpl.get("version")));
        var report=report("INCOME",701);assertThat(amount(report,"PROFIT")).isEqualByComparingTo("35");assertThat(report.get("lines").toString()).contains("accountIds","6001");
    }
    @Test void unrepresentedProfitLossCategoryProducesAnActualBalanceWarning()throws Exception{
        long asset=account("1101","ASSET","DEBIT"),profitLoss=account("3101","PROFIT_LOSS","CREDIT");templates();post(asset,profitLoss,10,"2026-10-15");
        var report=report("BALANCE_SHEET",701);assertThat(report).containsEntry("balanced",false);assertThat(new BigDecimal(report.get("difference").toString())).isEqualByComparingTo("10");
        assertThat(report.get("missingConfigurations").toString()).contains("PROFIT_LOSS");
    }
    @Test void currentPermissionsAndFieldPolicyApplyToEveryRead()throws Exception{
        long asset=account("1101","ASSET","DEBIT"),income=account("6001","INCOME","CREDIT");templates();post(asset,income,35,"2026-10-15");
        assertThat(amount(report("INCOME",701),"PROFIT")).isEqualByComparingTo("35");seed("update sys_role set field_policies='{}' where id=203");
        var hidden=report("INCOME",701);assertThat(hidden.get("lines").toString()).doesNotContain("amount=");assertThat(hidden).doesNotContainKey("difference");
        seed("update sys_role set permissions='[\"fin:ledger:view\"]' where id=203");assertThat(call(201,"GET","/fin/reports/INCOME?bookId=601&periodId=701",null).statusCode()).isEqualTo(403);
        seed("update sys_role set permissions='[\"fin:report:view\"]' where id=203");seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,301,'OTHER','Other book','MXN','ACTIVE')");seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,201,'BOOK',602,201)");assertThat(call(201,"GET","/fin/reports/INCOME?bookId=601&periodId=701",null).statusCode()).isEqualTo(404);
        var permissions=new org.assertj.core.api.SoftAssertions();
        seed("update sys_role set permissions='[\"fin:voucher:audit\"]' where id=203");seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,201,'BOOK',601,201)");permissions.assertThat(call(201,"GET","/fin/books",null).statusCode()).as("audit-only user can resolve the currently scoped book").isEqualTo(200);
        seed("update sys_role set permissions='[\"*\"]' where id=203");permissions.assertThat(ok(201,"GET","/sys/permissions/tree",null).body()).as("permission catalog supports assigning real report exports").contains("fin:report:export");permissions.assertAll();
    }
    @Test void concurrentExplicitTemplateCommandsAreIdempotentAndOneActiveVersionWins()throws Exception{
        String key=UUID.randomUUID().toString();var body=Map.<String,Object>of("bookId",601,"reportType","INCOME","name","Synthetic","rule","CATEGORY_V1");var pool=Executors.newFixedThreadPool(2);var start=new CountDownLatch(1);
        try{var a=pool.submit(()->{start.await();return call(201,"POST","/fin/report-templates",body,key);});var b=pool.submit(()->{start.await();return call(201,"POST","/fin/report-templates",body,key);});start.countDown();assertThat(id(data(a.get(20,TimeUnit.SECONDS)))).isEqualTo(id(data(b.get(20,TimeUnit.SECONDS))));}finally{pool.shutdownNow();}
        assertThat(owner.queryForObject("select count(*) from fin_report_template",Integer.class)).isEqualTo(1);
    }
    @Test void liveReportKeepsOneSnapshotAcrossConcurrentPostingAndTemplateActivation()throws Exception{
        long asset=account("1101","ASSET","DEBIT"),income=account("6001","INCOME","CREDIT");templates();post(asset,income,35,"2026-10-15");long old=owner.queryForObject("select id from fin_report_template where report_type='INCOME' and status='ACTIVE'",Long.class);
        var pool=Executors.newSingleThreadExecutor();try(var blocker=owner.getDataSource().getConnection()){
            blocker.setAutoCommit(false);try(var statement=blocker.createStatement()){statement.execute("LOCK TABLE fin_report_template IN ACCESS EXCLUSIVE MODE");}
            var pending=pool.submit(()->report("INCOME",701));long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(owner.queryForObject("select count(*) from pg_stat_activity where usename='jxc_app' and query like 'SELECT id FROM fin_report_template%' and wait_event_type='Lock'",Integer.class)==0&&System.nanoTime()<deadline)Thread.sleep(10);
            assertThat(owner.queryForObject("select count(*) from pg_stat_activity where usename='jxc_app' and query like 'SELECT id FROM fin_report_template%' and wait_event_type='Lock'",Integer.class)).isPositive();
            post(asset,income,10,"2026-10-16");try(var statement=blocker.createStatement()){statement.executeUpdate("update fin_report_template set status='RETIRED',version=version+1 where report_type='INCOME' and status='ACTIVE'");statement.executeUpdate("insert into fin_report_template(id,country_id,book_id,report_type,name,rule_code,version_no,status,created_by,reviewed_by,reviewed_at) values(900,101,601,'INCOME','Next version','CATEGORY_V1',2,'ACTIVE',201,202,clock_timestamp())");}blocker.commit();
            var during=pending.get(10,TimeUnit.SECONDS);assertThat(((Number)during.get("templateId")).longValue()).isEqualTo(old);assertThat(amount(during,"PROFIT")).isEqualByComparingTo("35");assertThat(amount(report("INCOME",701),"PROFIT")).isEqualByComparingTo("45");
        }finally{pool.shutdownNow();}
    }
    @Test void closedReportsUseFrozenGenerationAndMaskWithCurrentPolicy()throws Exception{
        long asset=account("1101","ASSET","DEBIT"),income=account("6001","INCOME","CREDIT");templates();post(asset,income,35,"2026-10-15");
        var frozen=Map.of("balance",report("BALANCE_SHEET",701),"income",report("INCOME",701),"cashflow",report("CASHFLOW",701));
        seed("insert into fin_close_generation(country_id,book_id,period_id,close_generation,source_fingerprint,checks,created_by) values(101,601,701,1,?,'[]',201)","a".repeat(64));
        seed("insert into fin_snapshot(country_id,book_id,period_id,close_generation,snapshot_type,content,source_versions,source_fingerprint,created_by) values(101,601,701,1,'REPORT',?::jsonb,'{}',?,201)",json.writeValueAsString(frozen),"a".repeat(64));
        seed("update fin_period set status='CLOSED',close_generation=1 where id=701");seed("update fin_report_template set status='RETIRED',version=version+1 where report_type='INCOME'");
        var saved=report("INCOME",701);assertThat(saved).containsEntry("source","SNAPSHOT").containsEntry("closeGeneration",1);assertThat(amount(saved,"PROFIT")).isEqualByComparingTo("35");
        seed("update sys_role set field_policies='{}' where id=203");assertThat(report("INCOME",701).get("lines").toString()).doesNotContain("amount=");
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("update fin_snapshot set content='{}' where country_id=101");return null;})).isInstanceOf(Exception.class);
    }
    @Test void reportExportUsesTheExistingAsynchronousContractAndCurrentAuthority()throws Exception{
        templates();long asset=account("1101","ASSET","DEBIT"),income=account("6001","INCOME","CREDIT");post(asset,income,35,"2026-10-15");
        var tpl=data(ok(201,"POST","/fin/report-templates",Map.of("bookId",601,"reportType","INCOME","name","Explicit export","rule","ACCOUNT_MAP_V1","lines",List.of(Map.of("code","PROFIT","name","=SUM(1,2)","formula","PERIOD_NET","sign",-1,"category","INCOME")))));ok(202,"POST","/fin/report-templates/"+id(tpl)+"/review",Map.of("bookId",601,"version",tpl.get("version")));
        var response=data(ok(201,"POST","/fin/reports/INCOME/export",Map.of("bookId",601,"periodId",701)));assertThat(response).containsEntry("status","QUEUED").containsKey("jobId");long job=((Number)response.get("jobId")).longValue();jobs.getObject().run(101,job);
        var download=data(ok(201,"GET","/sys/jobs/"+job+"/download",null));assertThat(download.get("content").toString()).contains("35","'=SUM(1,2)");
        seed("update sys_role set field_policies='{}' where id=203");assertThat(data(ok(201,"GET","/sys/jobs/"+job+"/download",null)).get("content").toString()).doesNotContain("35");
        seed("update sys_role set permissions='[\"fin:report:view\"]' where id=203");assertThat(call(201,"POST","/fin/reports/INCOME/export",Map.of("bookId",601,"periodId",701)).statusCode()).isEqualTo(403);
        assertThat(call(201,"GET","/sys/jobs/"+job+"/download",null).statusCode()).isEqualTo(403);
    }
    Map<String,Object> report(String type,long period)throws Exception{return data(ok(201,"GET","/fin/reports/"+type+"?bookId=601&periodId="+period,null));}
    void templates()throws Exception{for(String type:List.of("BALANCE_SHEET","INCOME")){var t=data(ok(201,"POST","/fin/report-templates",Map.of("bookId",601,"reportType",type,"name","Synthetic "+type,"rule","CATEGORY_V1")));ok(202,"POST","/fin/report-templates/"+id(t)+"/review",Map.of("bookId",601,"version",t.get("version")));}}
    void opening(long account,String direction,int amount)throws Exception{ok(201,"POST","/fin/opening-balances",Map.of("bookId",601,"accountId",account,"amount",amount,"direction",direction,"cutoffDate","2026-09-30"));}
    long account(String code,String category,String direction)throws Exception{return id(data(ok(201,"POST","/fin/accounts",Map.of("code",code,"name",code,"category",category,"direction",direction))));}
    Map<String,Object> create(long d,long c,int n,String date)throws Exception{return data(ok(201,"POST","/fin/vouchers",Map.of("voucherDate",date,"lines",List.of(Map.of("accountId",d,"debit",n),Map.of("accountId",c,"credit",n)))));}
    Map<String,Object> post(long d,long c,int n,String date)throws Exception{var v=create(d,c,n,date);v=action(201,v,"submit");v=action(202,v,"audit");return action(201,v,"post");}
    Map<String,Object> postLines(List<Map<String,Object>> lines,String date)throws Exception{var v=data(ok(201,"POST","/fin/vouchers",Map.of("voucherDate",date,"lines",lines)));v=action(201,v,"submit");v=action(202,v,"audit");return action(201,v,"post");}
    Map<String,Object> action(int user,Map<String,Object> row,String action)throws Exception{return data(ok(user,"POST","/fin/vouchers/"+id(row)+"/"+action,Map.of("version",row.get("version"))));}
    @SuppressWarnings("unchecked") BigDecimal amount(Map<String,Object> r,String code){return new BigDecimal(((List<Map<String,Object>>)r.get("lines")).stream().filter(l->code.equals(l.get("code"))).findFirst().orElseThrow().get("amount").toString());}
    long id(Map<String,Object> row){return ((Number)row.get("id")).longValue();}
    @SuppressWarnings("unchecked") Map<String,Object> data(HttpResponse<String> r){assertThat(r.statusCode()).withFailMessage(r.body()).isEqualTo(200);return (Map<String,Object>)json.readValue(r.body(),Map.class).get("data");}
    HttpResponse<String> ok(int user,String method,String path,Map<String,Object> body)throws Exception{var r=call(user,method,path,body);assertThat(r.statusCode()).withFailMessage(r.body()).isEqualTo(200);return r;}
    HttpResponse<String> call(int user,String method,String path,Map<String,Object> body)throws Exception{return call(user,method,path,body,UUID.randomUUID().toString());}
    HttpResponse<String> call(int user,String method,String path,Map<String,Object> body,String key)throws Exception{var b=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1"+path)).header("Authorization","Bearer reports-"+user).header("X-Country-Id","101").header("Content-Type","application/json");if(!method.equals("GET"))b.header("Idempotency-Key",key);b.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));return http.send(b.build(),HttpResponse.BodyHandlers.ofString());}
}
