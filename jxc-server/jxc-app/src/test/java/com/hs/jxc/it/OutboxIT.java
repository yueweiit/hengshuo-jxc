package com.hs.jxc.it;
import com.hs.jxc.common.event.OutboxPublisher;
import com.hs.jxc.common.db.BookGate;
import com.hs.jxc.event.TransactionalEventConsumer;
import static com.hs.jxc.event.TransactionalEventConsumer.Outcome.*;
import static org.assertj.core.api.Assertions.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

class OutboxIT extends BasePgIT {
    @Autowired OutboxPublisher publisher;
    @Autowired TransactionalEventConsumer consumer;
    @Autowired BookGate books;
    @BeforeEach void data(){resetFixtures();seed("insert into sys_country(id,code,name,default_currency,timezone,status) values(101,'MX','Test','MXN','UTC','ACTIVE')");seed("insert into sys_authz_epoch(country_id) values(101)");seed("insert into org_entity(id,country_id,code,name) values(301,101,'E1','Original')");seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(601,101,301,'B1','Book','MXN','ACTIVE')");seed("insert into fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(101,601,2026,10,'2026-10-01','2026-10-31','OPEN')");}
    long event(){return inCountry(101,()->publisher.publish(101,601,"TEST","TEST",301,1,LocalDate.of(2026,10,15),Map.of("name","source")));}
    @Test void publishIsAtomicWithItsBusinessWriteAndDeduplicatesOnlyIdenticalFacts(){
        assertThatThrownBy(()->inCountry(101,()->{jdbc.update("update org_entity set name='Half' where id=301");event();throw new IllegalStateException();})).isInstanceOf(IllegalStateException.class);
        assertThat(owner.queryForObject("select count(*) from sys_biz_event",Integer.class)).isZero();assertThat(owner.queryForObject("select name from org_entity where id=301",String.class)).isEqualTo("Original");
        long id=event();assertThat(event()).isEqualTo(id);
        assertThatThrownBy(()->inCountry(101,()->publisher.publish(101,601,"TEST","TEST",301,1,LocalDate.of(2026,10,15),Map.of("name","changed")))).isInstanceOf(Exception.class);
    }
    @Test void failedConsumerRollsBackEffectsThenRecordsDiagnosisAndCanRetry(){
        long id=event();assertThat(consumer.run(101,id,"test",e->{jdbc.update("update org_entity set name='Half' where id=301");throw new IllegalStateException("not persisted detail");})).isEqualTo(FAILED);
        assertThat(owner.queryForObject("select name from org_entity where id=301",String.class)).isEqualTo("Original");assertThat(owner.queryForObject("select status from sys_biz_event_consume",String.class)).isEqualTo("FAILED");
        assertThat(consumer.run(101,id,"test",e->jdbc.update("update org_entity set name='Complete' where id=301"))).isEqualTo(DONE);
        assertThat(consumer.run(101,id,"test",e->{throw new AssertionError("duplicate");})).isEqualTo(ALREADY_DONE);
        assertThat(owner.queryForObject("select attempt_count from sys_biz_event_consume",Integer.class)).isEqualTo(2);
    }
    @Test void simultaneousConsumersHaveOneCommittedEffect()throws Exception{
        long id=event();var effects=new AtomicInteger();var start=new CountDownLatch(1);var pool=Executors.newFixedThreadPool(8);try{var futures=new ArrayList<Future<?>>();for(int i=0;i<8;i++)futures.add(pool.submit(()->{start.await();return consumer.run(101,id,"test",e->{effects.incrementAndGet();jdbc.update("update org_entity set name='Complete' where id=301");});}));start.countDown();for(var f:futures)f.get(15,TimeUnit.SECONDS);assertThat(effects.get()).isEqualTo(1);assertThat(owner.queryForObject("select count(*) from sys_biz_event_consume",Integer.class)).isEqualTo(1);}finally{pool.shutdownNow();}
    }
    @Test void expiredLeaseRecoversAndOldFailureCannotOverwriteNewSuccess(){
        long id=event();seed("insert into sys_biz_event_consume(country_id,book_id,event_id,consumer,status,attempt_count,updated_at) values(101,601,?,'test','PROCESSING',1,clock_timestamp()-interval '5 minutes')",id);
        assertThat(consumer.run(101,id,"test",e->{})).isEqualTo(DONE);consumer.failure(101,id,"test",1,"OLD_FAILURE");assertThat(owner.queryForObject("select status from sys_biz_event_consume",String.class)).isEqualTo("DONE");
    }
    @Test void sharedBookGateCannotBeUpgradedInsideAWriter(){
        assertThatThrownBy(()->inCountry(101,()->{books.lock(101,601,false);books.lock(101,601,true);return null;})).isInstanceOf(IllegalStateException.class);
    }
}
