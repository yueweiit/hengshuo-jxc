package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.fin.service.PeriodGuard;
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class PeriodIdempotencyIT extends BasePgIT {
    @Autowired PeriodGuard periods;
    @Autowired IdempotencyExecutor idempotency;
    RequestContext context = new RequestContext(201,101L,"pg-test",null);
    @BeforeEach void data() {
        resetFixtures();
        seed("insert into sys_country(id,code,name,default_currency,timezone,status) values(101,'MX','Test country','MXN','America/Mexico_City','ACTIVE')");
        seed("insert into sys_user(id,username,password_hash,display_name,status) values(201,'test','not-a-password','Test','ENABLED')");
        seed("insert into org_entity(id,country_id,code,name) values(301,101,'E1','Entity')");
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(601,101,301,'B1','Book','MXN','ACTIVE')");
        seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(701,101,601,2026,10,'2026-10-01','2026-10-31','OPEN')");
    }
    @Test void draftAndDisabledCountriesRejectOrdinaryTradeWhileHistoryRemainsReadable(){
        seed("UPDATE sys_country SET status='DRAFT' WHERE id=101");
        assertThatThrownBy(()->inCountry(101,()->{periods.assertOpen(101,601,LocalDate.of(2026,10,15));return null;})).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SYS_COUNTRY_NOT_ACTIVE");
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("INSERT INTO sys_biz_event(country_id,book_id,event_type,source_type,source_id,event_seq,payload,biz_date) VALUES(101,601,'TEST','TEST',1,1,'{}','2026-10-15')");return null;})).isInstanceOf(org.springframework.dao.DataAccessException.class);
        seed("UPDATE sys_country SET status='DISABLED' WHERE id=101");
        assertThat(inCountry(101,()->jdbc.queryForObject("SELECT count(*) FROM fin_period WHERE country_id=101",Integer.class))).isEqualTo(1);
        assertThatThrownBy(()->inCountry(101,()->{periods.assertOpen(101,601,LocalDate.of(2026,10,15));return null;})).isInstanceOf(ApiException.class);
    }
    @Test void guardRejectsClosedAndMissingPeriodsAndBooks() {
        inCountry(101,()->{periods.assertOpen(101,601,LocalDate.of(2026,10,15));return null;});
        seed("update fin_period set status='CLOSED' where id=701");
        assertThatThrownBy(()->inCountry(101,()->{periods.assertOpen(101,601,LocalDate.of(2026,10,15));return null;})).isInstanceOf(ApiException.class).extracting("code").isEqualTo("FIN_PERIOD_CLOSED");
        assertThatThrownBy(()->inCountry(101,()->{periods.assertOpen(101,601,LocalDate.of(2026,11,1));return null;})).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->inCountry(101,()->{periods.assertOpen(101,999,LocalDate.of(2026,10,15));return null;})).isInstanceOf(ApiException.class);
    }
    @Test void concurrentSameKeyExecutesOnceAndChangedPayloadOrPathConflicts() throws Exception {
        var key=UUID.randomUUID().toString();var effects=new AtomicInteger();
        var start=new CountDownLatch(1);var pool=Executors.newFixedThreadPool(6);
        try {
            var futures=new ArrayList<Future<Map<String,Object>>>();
            for(int i=0;i<6;i++)futures.add(pool.submit(()->{start.await();return inCountry(101,()->idempotency.execute(context,"POST","/api/v1/org/entities",key,Map.of("name","x"),null,()->{effects.incrementAndGet();return Map.of("id",301,"name","x");},result->{}));}));
            start.countDown();for(var future:futures)assertThat(future.get(15,TimeUnit.SECONDS)).containsEntry("name","x");
            assertThat(effects.get()).isEqualTo(1);
            assertThatThrownBy(()->inCountry(101,()->idempotency.execute(context,"POST","/api/v1/org/entities",key,Map.of("name","y"),null,Map::of,r->{}))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);
            assertThatThrownBy(()->inCountry(101,()->idempotency.execute(context,"POST","/api/v1/org/warehouses",key,Map.of("name","x"),null,Map::of,r->{}))).isInstanceOf(ApiException.class);
        } finally {pool.shutdownNow();}
    }
    @Test void rollbackClearsClaimAndSameKeyRetriesButCommittedResultReauthorizes() {
        var key=UUID.randomUUID().toString();
        assertThatThrownBy(()->inCountry(101,()->idempotency.execute(context,"POST","/api/v1/org/entities",key,Map.of(),null,()->{jdbc.update("update org_entity set name='half' where id=301");throw new IllegalStateException("injected");},r->{}))).isInstanceOf(IllegalStateException.class);
        assertThat(owner.queryForObject("select name from org_entity where id=301",String.class)).isEqualTo("Entity");
        assertThat(owner.queryForObject("select count(*) from sys_idempotency",Integer.class)).isZero();
        inCountry(101,()->idempotency.execute(context,"POST","/api/v1/org/entities",key,Map.of(),null,()->Map.of("id",301),r->{}));
        assertThatThrownBy(()->inCountry(101,()->idempotency.execute(context,"POST","/api/v1/org/entities",key,Map.of(),null,()->{throw new AssertionError("must not rerun");},r->{throw ApiException.notFound();}))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);
    }
    @Test void bookGateOrdersWriterAndClosingTransactionWithoutCheckThenWriteRace() throws Exception {
        var acquired=new CountDownLatch(1);var release=new CountDownLatch(1);var pool=Executors.newFixedThreadPool(2);
        try {
            var writer=pool.submit(()->inCountry(101,()->{periods.assertOpen(101,601,LocalDate.of(2026,10,15));acquired.countDown();try{if(!release.await(10,TimeUnit.SECONDS))throw new AssertionError("release");}catch(InterruptedException e){throw new RuntimeException(e);}jdbc.update("insert into sys_biz_event(country_id,book_id,event_type,source_type,source_id,event_seq,payload,biz_date) values(101,601,'TEST','TEST',1,1,'{}','2026-10-15')");return null;}));
            assertThat(acquired.await(10,TimeUnit.SECONDS)).isTrue();
            // This M1 lock-order fixture uses an independent owner connection for its
            // synthetic closing state; runtime closing authorization belongs to ClosingIT.
            var ownerClosingTx=new TransactionTemplate(new DataSourceTransactionManager(Objects.requireNonNull(owner.getDataSource())));
            var closer=pool.submit(()->ownerClosingTx.execute(status->{owner.queryForList("select id from fin_book where country_id=101 and id=601 for update");int count=owner.queryForObject("select count(*) from sys_biz_event where country_id=101 and book_id=601",Integer.class);owner.update("update fin_period set status='CLOSED' where country_id=101 and id=701");return count;}));
            assertThatThrownBy(()->closer.get(150,TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            release.countDown();writer.get(10,TimeUnit.SECONDS);assertThat(closer.get(10,TimeUnit.SECONDS)).isEqualTo(1);
            assertThatThrownBy(()->inCountry(101,()->{periods.assertOpen(101,601,LocalDate.of(2026,10,15));return null;})).isInstanceOf(ApiException.class);
        }finally{release.countDown();pool.shutdownNow();}
    }
}
