package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.sys.service.SessionService;
import com.hs.jxc.fin.ledger.LedgerService;
import org.springframework.beans.factory.annotation.Autowired;
import java.net.URI;
import java.net.http.*;
import java.math.BigDecimal;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Value;
import tools.jackson.databind.json.JsonMapper;

/** Synthetic PostgreSQL ledger acceptance: no production configuration or posting. */
class LedgerIT extends BasePgIT {
    @Value("${local.server.port}") int port;
    @Autowired LedgerService ledger;
    @Autowired com.hs.jxc.sys.jobs.JobApi exportJobs;
    final HttpClient http=HttpClient.newHttpClient();
    final JsonMapper json=JsonMapper.builder().build();
    @BeforeEach void fixtures(){
        resetFixtures();
        seed("insert into md_currency(code,name,decimals) values('MXN','Synthetic peso',2),('USD','Synthetic dollar',2)");
        seed("insert into sys_country(id,code,name,default_currency,timezone,status) values(101,'LEDGER','Synthetic','MXN','UTC','ACTIVE')");
        seed("insert into sys_authz_epoch(country_id) values(101)");NumberFixtures.seed(101,"FIN_VOUCHER");
        seed("insert into sys_user(id,username,password_hash,display_name,status) values(201,'preparer','unused','Preparer','ENABLED'),(202,'auditor','unused','Auditor','ENABLED')");
        for(int user:List.of(201,202)){
            seed("insert into sys_session(token_hash,user_id,expires_at) values(?,?,clock_timestamp()+interval '1 hour')",SessionService.digest("ledger-"+user),user);
            seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(101,?,'COUNTRY_ALL',201)",user);
        }
        seed("insert into sys_role(id,country_id,code,name,permissions,field_policies) values(203,101,'FIN','Finance','[\"fin:*\"]','{\"COST\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"BANK_INFO\":\"WRITE\",\"PROFIT\":\"WRITE\"}')");
        seed("insert into sys_user_role(country_id,user_id,role_id) values(101,201,203),(101,202,203)");
        seed("insert into org_entity(id,country_id,code,name) values(301,101,'E','Synthetic')");
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(601,101,301,'B','Synthetic','MXN','ACTIVE')");
        seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(701,101,601,2026,10,'2026-10-01','2026-10-31','OPEN'),(702,101,601,2026,11,'2026-11-01','2026-11-30','OPEN')");
    }
    @Test void voucherCreationRequiresTheConfiguredCountryNumberRule() throws Exception {long d=account("1001","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");seed("DELETE FROM sys_doc_number_rule WHERE country_id=101 AND doc_type='FIN_VOUCHER'");assertThat(call(201,"POST","/fin/vouchers",Map.of("voucherDate","2026-10-15","lines",lines(d,c,10))).body()).contains("SYS_CONFIG_MISSING");assertThat(owner.queryForObject("SELECT count(*) FROM fin_voucher",Integer.class)).isZero();}
    @Test void manualLifecycleIsSeparatedAndLatePostingCarriesForwardAndReversalKeepsOriginal() throws Exception {
        long debit=account("1001","ASSET","DEBIT"),credit=account("3001","EQUITY","CREDIT");
        assertThat(com.hs.jxc.sys.service.PermissionCatalog.tree().toString()).contains("fin:voucher:edit","fin:voucher:unaudit");
        seed("update sys_role set permissions='[\"fin:voucher:create\",\"fin:voucher:edit\",\"fin:voucher:audit\",\"fin:voucher:unaudit\",\"fin:voucher:post\",\"fin:voucher:reverse\",\"fin:ledger:view\"]' where id=203");
        var v=create(debit,credit,100,"2026-10-15"); long id=id(v);
        v=data(ok(201,"PUT","/fin/vouchers/"+id,v));
        assertThat(call(201,"POST","/fin/vouchers/"+id+"/post",Map.of("version",v.get("version"))).statusCode()).isEqualTo(400);
        v=action(201,id,"submit",v);
        assertThat(call(201,"POST","/fin/vouchers/"+id+"/audit",Map.of("version",v.get("version"))).body()).contains("FIN_AUDITOR_CONFLICT");
        v=action(202,id,"audit",v);v=data(ok(201,"POST","/fin/vouchers/"+id+"/unaudit",Map.of("version",v.get("version"),"reason","Synthetic review correction")));v=action(202,id,"audit",v);v=ledger.action(context(201,101,SessionService.digest("ledger-201")),601L,id,"post",Map.of("version",v.get("version")),UUID.randomUUID().toString());
        assertThat(v).containsEntry("status","POSTED");
        var next=data(call(201,"GET","/fin/trial-balance?periodId=702",null));assertThat(next).containsEntry("balanced",true);
        assertThat(new BigDecimal(next.get("debit").toString())).isEqualByComparingTo("100");
        var reverse=data(ok(201,"POST","/fin/vouchers/"+id+"/reverse",Map.of("version",v.get("version"),"voucherDate","2026-11-10","reason","Synthetic correction")));
        assertThat(reverse).containsEntry("status","PENDING_AUDIT");
        assertThat(call(201,"POST","/fin/vouchers/"+id+"/reverse",Map.of("version",v.get("version"),"voucherDate","2026-11-10","reason","again")).statusCode()).isEqualTo(409);
        reverse=action(202,id(reverse),"audit",reverse);reverse=action(201,id(reverse),"post",reverse);
        assertThat(data(ok(201,"GET","/fin/vouchers/"+id,null))).containsEntry("status","REVERSED");
        var original=data(ok(201,"GET","/fin/ledgers/detail?accountId="+debit+"&periodId=701",null));
        assertThat((List<?>)original.get("lines")).hasSize(1);
        var trial=data(ok(201,"GET","/fin/trial-balance?periodId=702",null));assertThat(new BigDecimal(trial.get("debit").toString())).isZero();
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("update fin_voucher_line set debit=999 where voucher_id=?",id);return null;})).isInstanceOf(Exception.class);
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("update fin_voucher set voucher_date='2026-10-16' where id=?",id);return null;})).isInstanceOf(Exception.class);
    }
    @Test void ledgerExportUsesTheSameFiltersAndRequiresItsDedicatedPermission() throws Exception {
        long d=account("1001","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");var v=create(d,c,25,"2026-10-15");v=action(201,id(v),"submit",v);v=action(202,id(v),"audit",v);action(201,id(v),"post",v);
        seed("UPDATE sys_role SET permissions='[\"fin:ledger:view\"]' WHERE id=203");
        var body=Map.<String,Object>of("bookId",601,"periodId",701,"accountId",d);
        assertThat(call(201,"POST","/fin/ledgers/detail/export",body).statusCode()).isEqualTo(403);
        seed("UPDATE sys_role SET permissions='[\"fin:ledger:view\",\"fin:ledger:export\"]' WHERE id=203");
        var job=data(ok(201,"POST","/fin/ledgers/detail/export",body));exportJobs.run(101,id(job));
        var file=data(ok(201,"GET","/sys/jobs/"+id(job)+"/download",null));assertThat(file.get("content").toString()).contains("25.00").contains("POSTED_FACTS");
        seed("UPDATE sys_role SET permissions='[\"fin:ledger:view\"]' WHERE id=203");assertThat(call(201,"GET","/sys/jobs/"+id(job)+"/download",null).statusCode()).isEqualTo(403);
    }
    @Test void openingNeverTurnsMissingOrNullAmountIntoExplicitZero() throws Exception {
        long debit=account("1001","ASSET","DEBIT");
        var missing=Map.<String,Object>of("accountId",debit,"cutoffDate","2026-09-30");
        assertThat(call(201,"POST","/fin/opening-balances",missing).statusCode()).isEqualTo(400);
        var nil=new LinkedHashMap<String,Object>(missing);nil.put("amount",null);
        assertThat(call(201,"POST","/fin/opening-balances",nil).statusCode()).isEqualTo(400);
        var explicit=new LinkedHashMap<String,Object>(missing);explicit.put("baseAmount",0);
        assertThat(data(ok(201,"POST","/fin/opening-balances",explicit))).containsEntry("status","DRAFT");
        assertThat(owner.queryForObject("select base_amount from fin_opening_balance",BigDecimal.class)).isZero();
    }
    @Test void openingRequiresExplicitBalancedConfirmationAndNeverConfirmsOnGet() throws Exception {
        long debit=account("1001","ASSET","DEBIT"),credit=account("3001","EQUITY","CREDIT");
        seed("update sys_role set permissions='[\"fin:opening:edit\"]' where id=203");
        ok(201,"GET","/fin/accounts",null);
        ok(201,"POST","/fin/opening-balances",Map.of("accountId",debit,"amount",50,"direction","DEBIT","cutoffDate","2026-09-30"));
        assertThat(call(201,"POST","/fin/opening-balances/confirm",Map.of()).body()).contains("FIN_UNBALANCED");
        ok(201,"GET","/fin/opening-balances",null);
        assertThat(owner.queryForObject("select count(*) from fin_opening_balance where status='CONFIRMED'",Integer.class)).isZero();
        ok(201,"POST","/fin/opening-balances",Map.of("accountId",credit,"amount",50,"direction","CREDIT","cutoffDate","2026-09-30"));
        ok(201,"POST","/fin/opening-balances/confirm",Map.of());ok(201,"POST","/fin/opening-balances/confirm",Map.of());
        seed("update sys_role set permissions='[\"fin:ledger:view\"]' where id=203");
        assertThat(new BigDecimal(data(ok(201,"GET","/fin/trial-balance?periodId=702",null)).get("debit").toString())).isEqualByComparingTo("50");
    }
    @Test void staleVersionAndUnbalancedOrForeignLinesRollbackWithoutFacts() throws Exception {
        long debit=account("1001","ASSET","DEBIT"),credit=account("3001","EQUITY","CREDIT");
        var v=create(debit,credit,10,"2026-10-15");var changed=new LinkedHashMap<>(v);changed.put("voucherDate","2026-10-16");
        ok(201,"PUT","/fin/vouchers/"+id(v),changed);
        assertThat(call(201,"POST","/fin/vouchers/"+id(v)+"/submit",Map.of("version",v.get("version"))).statusCode()).isEqualTo(409);
        assertThat(call(201,"POST","/fin/vouchers",Map.of("voucherDate","2026-10-15","lines",List.of(Map.of("accountId",debit,"debit",10),Map.of("accountId",credit,"credit",9)))).body()).contains("FIN_UNBALANCED");
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isEqualTo(1);
        seed("update fin_period set status='CLOSED' where id=701");
        assertThat(call(201,"POST","/fin/vouchers",Map.of("voucherDate","2026-10-15","lines",lines(debit,credit,10))).body()).contains("FIN_PERIOD_CLOSED");
    }
    @Test void concurrentIdempotentCreateAndAtomicPostOnlyApplyOnce() throws Exception {
        long debit=account("1001","ASSET","DEBIT"),credit=account("3001","EQUITY","CREDIT");
        String key=UUID.randomUUID().toString();var body=Map.<String,Object>of("voucherDate","2026-10-15","lines",lines(debit,credit,70));
        var pool=Executors.newFixedThreadPool(4);var start=new CountDownLatch(1);
        try{
            var fs=new ArrayList<Future<HttpResponse<String>>>();for(int i=0;i<4;i++)fs.add(pool.submit(()->{start.await();return call(201,"POST","/fin/vouchers",body,key);}));start.countDown();
            Set<Long> ids=new HashSet<>();for(var f:fs){var r=f.get(20,TimeUnit.SECONDS);assertThat(r.statusCode()).withFailMessage(r.body()).isEqualTo(200);ids.add(id(data(r)));}assertThat(ids).hasSize(1);
            var v=data(ok(201,"GET","/fin/vouchers/"+ids.iterator().next(),null));v=action(201,id(v),"submit",v);v=action(202,id(v),"audit",v);
            final var ready=v;var p1=pool.submit(()->call(201,"POST","/fin/vouchers/"+id(ready)+"/post",Map.of("version",ready.get("version"))));var p2=pool.submit(()->call(201,"POST","/fin/vouchers/"+id(ready)+"/post",Map.of("version",ready.get("version"))));
            assertThat(List.of(p1.get().statusCode(),p2.get().statusCode())).containsExactlyInAnyOrder(200,409);
            var trial=data(ok(201,"GET","/fin/trial-balance?periodId=701",null));assertThat(new BigDecimal(trial.get("debit").toString())).isEqualByComparingTo("70");
        }finally{pool.shutdownNow();}
    }
    @Test void repeatedAccountLinesAndIndependentConcurrentVouchersNeverLoseOrDoubleBalances() throws Exception {
        long d=account("1001","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");
        var v=data(ok(201,"POST","/fin/vouchers",Map.of("voucherDate","2026-10-15","lines",List.of(Map.of("accountId",d,"debit",20),Map.of("accountId",d,"debit",30),Map.of("accountId",c,"credit",50)))));
        v=action(201,id(v),"submit",v);v=action(202,id(v),"audit",v);action(201,id(v),"post",v);
        assertThat(new BigDecimal(data(ok(201,"GET","/fin/trial-balance?periodId=701",null)).get("debit").toString())).isEqualByComparingTo("50");
        var one=create(d,c,10,"2026-10-16");var two=create(d,c,15,"2026-11-16");
        one=action(201,id(one),"submit",one);one=action(202,id(one),"audit",one);two=action(201,id(two),"submit",two);two=action(202,id(two),"audit",two);
        final var a=one;final var b=two;var pool=Executors.newFixedThreadPool(2);var start=new CountDownLatch(1);
        try{var f1=pool.submit(()->{start.await();return action(201,id(a),"post",a);});var f2=pool.submit(()->{start.await();return action(201,id(b),"post",b);});start.countDown();f1.get(20,TimeUnit.SECONDS);f2.get(20,TimeUnit.SECONDS);}finally{pool.shutdownNow();}
        assertThat(new BigDecimal(data(ok(201,"GET","/fin/trial-balance?periodId=702",null)).get("debit").toString())).isEqualByComparingTo("75");
        assertThat(owner.queryForObject("select count(*) from fin_account_balance",Integer.class)).isEqualTo(4);
    }
    @Test void auxiliaryForeignCurrencyCashflowAndFieldPolicyAreServerValidated() throws Exception {
        long d=account("1001","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");
        var foreign=Map.<String,Object>of("voucherDate","2026-10-15","lines",List.of(Map.of("accountId",d,"debit",20,"currency","USD","origAmount",1,"rate",20),Map.of("accountId",c,"credit",20)));
        assertThat(call(201,"POST","/fin/vouchers",foreign).statusCode()).isEqualTo(400);
        var cash=data(ok(201,"POST","/fin/accounts",Map.of("code","1002","name","Synthetic cash","isCash",true)));
        assertThat(call(201,"POST","/fin/vouchers",Map.of("voucherDate","2026-10-15","lines",lines(id(cash),c,10))).body()).contains("FIN_CASHFLOW_REQUIRED");
        var aux=data(ok(201,"POST","/fin/accounts",Map.of("code","1101","name","Synthetic customer","auxTypes",List.of("CUSTOMER"))));
        assertThat(call(201,"POST","/fin/vouchers",Map.of("voucherDate","2026-10-15","lines",lines(id(aux),c,10))).body()).contains("FIN_AUX_REQUIRED");
        seed("update sys_role set field_policies='{}' where id=203");
        assertThat(call(201,"POST","/fin/vouchers",Map.of("voucherDate","2026-10-15","lines",lines(d,c,10))).statusCode()).isEqualTo(403);
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
    }
    @Test void batchAuditRollsBackEveryVoucherIfAnyPreparerConflicts() throws Exception {
        long d=account("1001","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");
        var one=create(d,c,10,"2026-10-15");var two=create(d,c,20,"2026-10-15");one=action(201,id(one),"submit",one);two=action(201,id(two),"submit",two);
        var body=Map.<String,Object>of("ids",List.of(id(one),id(two)),"versions",Map.of(String.valueOf(id(one)),one.get("version"),String.valueOf(id(two)),two.get("version")));
        assertThat(call(201,"POST","/fin/vouchers/batch-audit",body).statusCode()).isEqualTo(400);
        assertThat(owner.queryForObject("select count(*) from fin_voucher where status='AUDITED'",Integer.class)).isZero();
        ok(202,"POST","/fin/vouchers/batch-audit",body);
        assertThat(owner.queryForObject("select count(*) from fin_voucher where status='AUDITED'",Integer.class)).isEqualTo(2);
    }
    @Test void runtimeCannotForgeTheBalanceProjectionOrPostedSources() throws Exception {
        long d=account("1001","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");var v=create(d,c,25,"2026-10-15");v=action(201,id(v),"submit",v);v=action(202,id(v),"audit",v);action(201,id(v),"post",v);
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("update fin_account_balance set period_debit=period_debit+1,closing_debit=closing_debit+1 where country_id=101 and period_id=701 and account_id=?",d);return null;})).isInstanceOf(Exception.class);
        assertThat(new BigDecimal(data(ok(201,"GET","/fin/trial-balance?periodId=701",null)).get("debit").toString())).isEqualByComparingTo("25");
        var account=data(ok(201,"GET","/fin/accounts/"+d,null));var reclassify=new LinkedHashMap<String,Object>(account);reclassify.put("reconcileType","AP");assertThat(call(201,"PUT","/fin/accounts/"+d,reclassify).statusCode()).isEqualTo(400);
    }
    @Test void manualVoucherReplayAndReadRecheckTheCurrentSourcePermissions() throws Exception {
        long d=account("1001","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");
        seed("insert into md_customer(id,country_id,code,name) values(801,101,'C','Synthetic source customer')");
        seed("insert into sal_order(id,country_id,book_id,entity_id,customer_id,doc_no,order_date,currency,payment_type,entered_by) values(901,101,601,301,801,'SYNTHETIC-SOURCE','2026-10-15','MXN','CREDIT',201)");
        seed("update sys_role set permissions='[\"fin:voucher:create\",\"fin:voucher:edit\",\"fin:ledger:view\",\"sal:order:view\"]' where id=203");
        var body=Map.<String,Object>of("voucherDate","2026-10-15","lines",List.of(Map.of("accountId",d,"debit",10,"sourceDocType","SAL_ORDER","sourceDocId",901),Map.of("accountId",c,"credit",10)));String key=UUID.randomUUID().toString();var voucher=data(call(201,"POST","/fin/vouchers",body,key));long id=id(voucher);
        assertThat(call(201,"POST","/fin/vouchers",body,key).statusCode()).isEqualTo(200);
        seed("update sys_role set permissions='[\"fin:voucher:create\",\"fin:voucher:edit\",\"fin:ledger:view\"]' where id=203");
        seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,201,'BOOK',601,201)");
        org.junit.jupiter.api.Assertions.assertAll(
            ()->assertThat(call(201,"POST","/fin/vouchers",body,key).statusCode()).isEqualTo(403),
            ()->assertThat(call(201,"POST","/fin/vouchers",body,UUID.randomUUID().toString()).statusCode()).isEqualTo(403),
            ()->assertThat(call(201,"GET","/fin/vouchers/"+id,null).statusCode()).isEqualTo(403),
            ()->assertThat(call(201,"POST","/fin/vouchers/"+id+"/submit",Map.of("version",voucher.get("version"))).statusCode()).isEqualTo(403)
        );
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select status from fin_voucher where id=?",String.class,id)).isEqualTo("DRAFT");
        ok(201,"DELETE","/fin/vouchers/"+id,Map.of("version",voucher.get("version")));
    }
    @ParameterizedTest @ValueSource(strings={"UNBALANCED","MIXED_CUTOFF","NO_START_PERIOD","MISSING_CONFIRMATION","MISSING_BALANCES","MISSING_FUTURE","STALE_BALANCES","OVERLAP_POSTED"})
    void runtimeCannotConfirmOpeningWithoutItsCompleteAccountingFacts(String risk) throws Exception {
        long d=account("1001","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");
        if(risk.equals("OVERLAP_POSTED")){seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(700,101,601,2026,9,'2026-09-01','2026-09-30','OPEN')");var v=create(d,c,10,"2026-09-15");v=action(201,id(v),"submit",v);v=action(202,id(v),"audit",v);action(201,id(v),"post",v);}
        String cutoff=risk.equals("NO_START_PERIOD")?"2026-09-29":"2026-09-30";
        ok(201,"POST","/fin/opening-balances",Map.of("accountId",d,"amount",50,"direction","DEBIT","cutoffDate",cutoff));
        ok(201,"POST","/fin/opening-balances",Map.of("accountId",c,"amount",risk.equals("UNBALANCED")?49:50,"direction","CREDIT","cutoffDate",risk.equals("MIXED_CUTOFF")?"2026-10-31":cutoff));
        if(risk.equals("STALE_BALANCES"))inCountry(101,()->{jdbc.update("insert into fin_account_balance(country_id,book_id,period_id,account_id,currency) select o.country_id,o.book_id,p.id,o.account_id,o.currency from fin_opening_balance o join fin_period p on p.country_id=o.country_id and p.book_id=o.book_id where o.country_id=101");return null;});
        String expected=switch(risk){case "UNBALANCED"->"FIN_UNBALANCED";case "MIXED_CUTOFF"->"FIN_OPENING_CUTOFF_MISMATCH";case "NO_START_PERIOD"->"FIN_OPENING_PERIOD";case "MISSING_CONFIRMATION"->"FIN_OPENING_CONFIRMATION_REQUIRED";case "STALE_BALANCES"->"FIN_BALANCE_FACT_MISMATCH";case "OVERLAP_POSTED"->"FIN_OPENING_CUTOFF";default->"FIN_BALANCE_PROJECTION_MISSING";};
        assertThatThrownBy(()->inCountry(101,()->{
            jdbc.update("update fin_opening_balance set status='CONFIRMED'"+(risk.equals("MISSING_CONFIRMATION")?"":",confirmed_by=201,confirmed_at=clock_timestamp()")+" where country_id=101");
            if(risk.equals("MISSING_FUTURE"))jdbc.update("insert into fin_account_balance(country_id,book_id,period_id,account_id,currency,opening_debit,opening_credit,closing_debit,closing_credit,orig_closing) select country_id,book_id,701,account_id,currency,case when direction='DEBIT' then base_amount else 0 end,case when direction='CREDIT' then base_amount else 0 end,case when direction='DEBIT' then base_amount else 0 end,case when direction='CREDIT' then base_amount else 0 end,case when direction='DEBIT' then orig_amount else -orig_amount end from fin_opening_balance where country_id=101");
            return null;
        })).hasStackTraceContaining(expected);
        assertThat(owner.queryForObject("select count(*) from fin_opening_balance where status='CONFIRMED'",Integer.class)).isZero();
    }
    @Test void explicitFirstMonthCreatesOnlyTheRequestedInitialFiscalRangeAndCarriesOpeningForward() throws Exception {
        seed("DELETE FROM fin_period WHERE country_id=101");
        var result=data(ok(201,"POST","/fin/periods?bookId=601",Map.of("fiscalYear",2026,"firstMonth",10)));
        assertThat(((Number)result.get("created")).intValue()).isEqualTo(3);
        assertThat(owner.queryForObject("SELECT min(start_date) FROM fin_period WHERE country_id=101",java.time.LocalDate.class)).isEqualTo(java.time.LocalDate.of(2026,10,1));
        assertThat(owner.queryForList("SELECT period_no FROM fin_period WHERE country_id=101 ORDER BY period_no",Integer.class)).containsExactly(10,11,12);
        long d=account("1405","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");
        ok(201,"POST","/fin/opening-balances",Map.of("accountId",d,"amount",100,"direction","DEBIT","cutoffDate","2026-09-30"));
        ok(201,"POST","/fin/opening-balances",Map.of("accountId",c,"amount",100,"direction","CREDIT","cutoffDate","2026-09-30"));
        ok(201,"POST","/fin/opening-balances/confirm",Map.of());
        long last=owner.queryForObject("SELECT id FROM fin_period WHERE country_id=101 AND period_no=12",Long.class);
        assertThat(new BigDecimal(data(ok(201,"GET","/fin/trial-balance?periodId="+last,null)).get("debit").toString())).isEqualByComparingTo("100");
        assertThat(data(ok(201,"POST","/fin/periods?bookId=601",Map.of("fiscalYear",2026,"firstMonth",10)))).containsEntry("created",0);
    }
    @ParameterizedTest @ValueSource(ints={0,13})
    void initialFiscalMonthMustBeWithinTheCalendar(int month) throws Exception {
        int before=owner.queryForObject("SELECT count(*) FROM fin_period WHERE country_id=101",Integer.class);
        assertThat(call(201,"POST","/fin/periods?bookId=601",Map.of("fiscalYear",2026,"firstMonth",month)).statusCode()).isEqualTo(400);
        assertThat(owner.queryForObject("SELECT count(*) FROM fin_period WHERE country_id=101",Integer.class)).isEqualTo(before);
    }
    @Test void explicitlyCreatingFuturePeriodsInitializesOpeningFromExistingFacts() throws Exception {
        long d=account("1001","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");var v=create(d,c,25,"2026-10-15");v=action(201,id(v),"submit",v);v=action(202,id(v),"audit",v);action(201,id(v),"post",v);
        ok(201,"POST","/fin/periods?bookId=601",Map.of("fiscalYear",2027));long period=owner.queryForObject("select id from fin_period where country_id=101 and fiscal_year=2027 and period_no=1",Long.class);
        var trial=data(ok(201,"GET","/fin/trial-balance?periodId="+period,null));assertThat(new BigDecimal(trial.get("debit").toString())).isEqualByComparingTo("25");
    }
    @Test void confirmedOpeningCutoffCannotOverlapAnEarlierOpenVoucherPeriod() throws Exception {
        seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(700,101,601,2026,9,'2026-09-01','2026-09-30','OPEN')");long d=account("1001","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");
        ok(201,"POST","/fin/opening-balances",Map.of("accountId",d,"amount",50,"direction","DEBIT","cutoffDate","2026-09-30"));ok(201,"POST","/fin/opening-balances",Map.of("accountId",c,"amount",50,"direction","CREDIT","cutoffDate","2026-09-30"));ok(201,"POST","/fin/opening-balances/confirm",Map.of());
        assertThat(call(201,"POST","/fin/vouchers",Map.of("voucherDate","2026-09-15","lines",lines(d,c,10))).body()).contains("FIN_OPENING_CUTOFF");
        assertThat(owner.queryForObject("select count(*) from fin_voucher",Integer.class)).isZero();
    }
    @Test void journalFiltersTheAuthorizedFundAuxiliaryUsingNumericIds() throws Exception {
        var cash=data(ok(201,"POST","/fin/accounts",Map.of("code","1001","name","Synthetic cash","isCash",true,"auxTypes",List.of("FUND"))));long equity=account("3001","EQUITY","CREDIT");
        seed("insert into md_fund_account(id,country_id,entity_id,book_id,name,account_type,currency,gl_account_id) values(901,101,301,601,'Synthetic cash drawer','CASH','MXN',?)",id(cash));
        var flow=data(ok(201,"POST","/fin/cashflow-items",Map.of("code","CF1","name","Synthetic inflow","category","OPERATING","direction","IN")));
        var v=data(ok(201,"POST","/fin/vouchers",Map.of("voucherDate","2026-10-15","lines",List.of(Map.of("accountId",id(cash),"debit",12,"aux",Map.of("fundAccountId",901),"cashflowItemId",id(flow)),Map.of("accountId",equity,"credit",12)))));v=action(201,id(v),"submit",v);v=action(202,id(v),"audit",v);action(201,id(v),"post",v);
        var journal=data(ok(201,"GET","/fin/ledgers/journal?periodId=701&fundAccountId=901",null));assertThat((List<?>)journal.get("lines")).hasSize(1);
        assertThat((List<?>)data(ok(201,"GET","/fin/ledgers/journal?periodId=701&fundAccountId=902",null)).get("lines")).isEmpty();
        assertThat(owner.queryForObject("select aux_key from fin_account_balance where period_id=701 and account_id=?",String.class,id(cash))).isEqualTo("{\"fundAccountId\": 901}");
    }
    @Test void stateTransitionsRequireCurrentReadableAmountsIncludingIdempotentReplay() throws Exception {
        long d=account("1001","ASSET","DEBIT"),c=account("3001","EQUITY","CREDIT");var v=create(d,c,12,"2026-10-15");v=action(201,id(v),"submit",v);
        seed("update sys_role set field_policies='{}' where id=203");assertThat(call(202,"POST","/fin/vouchers/"+id(v)+"/audit",Map.of("version",v.get("version"))).statusCode()).isEqualTo(403);
        seed("update sys_role set field_policies='{\"COST\":\"READ\",\"ORDER_TOTAL\":\"READ\",\"BANK_INFO\":\"READ\"}' where id=203");v=action(202,id(v),"audit",v);
        seed("update sys_role set field_policies='{}' where id=203");assertThat(call(201,"POST","/fin/vouchers/"+id(v)+"/post",Map.of("version",v.get("version"))).statusCode()).isEqualTo(403);
        seed("update sys_role set field_policies='{\"COST\":\"READ\",\"ORDER_TOTAL\":\"READ\",\"BANK_INFO\":\"READ\"}' where id=203");String key=UUID.randomUUID().toString();var body=Map.<String,Object>of("version",v.get("version"));String path="/fin/vouchers/"+id(v)+"/post";assertThat(call(201,"POST",path,body,key).statusCode()).isEqualTo(200);
        seed("update sys_role set field_policies='{}' where id=203");assertThat(call(201,"POST",path,body,key).statusCode()).isEqualTo(403);
        assertThat(owner.queryForObject("select count(*) from fin_voucher where status='POSTED'",Integer.class)).isEqualTo(1);
    }
    long account(String code,String category,String direction)throws Exception{return id(data(ok(201,"POST","/fin/accounts",Map.of("code",code,"name",code,"category",category,"direction",direction))));}
    Map<String,Object> create(long d,long c,int n,String date)throws Exception{return data(ok(201,"POST","/fin/vouchers",Map.of("voucherDate",date,"lines",lines(d,c,n))));}
    List<Map<String,Object>> lines(long d,long c,int n){return List.of(Map.of("accountId",d,"debit",n,"credit",0),Map.of("accountId",c,"debit",0,"credit",n));}
    Map<String,Object> action(int user,long id,String action,Map<String,Object> row)throws Exception{return data(ok(user,"POST","/fin/vouchers/"+id+"/"+action,Map.of("version",row.get("version"))));}
    long id(Map<String,Object> row){return ((Number)row.get("id")).longValue();}
    @SuppressWarnings("unchecked") Map<String,Object> data(HttpResponse<String> r){return (Map<String,Object>)json.readValue(r.body(),Map.class).get("data");}
    HttpResponse<String> ok(int user,String method,String path,Map<String,Object> body)throws Exception{var r=call(user,method,path,body);assertThat(r.statusCode()).withFailMessage(r.body()).isEqualTo(200);return r;}
    HttpResponse<String> call(int user,String method,String path,Map<String,Object> body)throws Exception{return call(user,method,path,body,UUID.randomUUID().toString());}
    HttpResponse<String> call(int user,String method,String path,Map<String,Object> body,String key)throws Exception{
        var b=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1"+path)).header("Authorization","Bearer ledger-"+user).header("X-Country-Id","101").header("Content-Type","application/json");
        if(!method.equals("GET"))b.header("Idempotency-Key",key);b.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        return http.send(b.build(),HttpResponse.BodyHandlers.ofString());
    }
}
