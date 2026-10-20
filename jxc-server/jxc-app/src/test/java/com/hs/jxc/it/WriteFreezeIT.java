package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.ApiExceptionAdvice;
import java.util.UUID;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Real connections prove that operational freeze drains writers and survives stale snapshots. */
class WriteFreezeIT extends BasePgIT {
    final UUID batch=UUID.randomUUID();
    @BeforeEach void data(){
        resetFixtures();
        seed("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(101,'MX','Freeze fixture','MXN','UTC','ACTIVE')");
    }
    @AfterEach void reopen(){
        if(!owner.queryForList("SELECT to_regclass('public.sys_write_control') AS name").getFirst().containsValue(null))
            mode("OPEN",epoch());
    }
    long epoch(){return owner.queryForObject("SELECT epoch FROM sys_write_control",Long.class);}
    String mode(String mode,long expected){return owner.queryForObject("SELECT jxc_set_write_mode(?, ?, ?::uuid, 'test operator', 'isolated rehearsal')::text",String.class,mode,expected,batch.toString());}
    TransactionTemplate adminTx(){return new TransactionTemplate(new DataSourceTransactionManager(owner.getDataSource()));}
    int write(){return inCountry(101,()->jdbc.update("UPDATE sys_country SET name='Written' WHERE id=101"));}

    @Test void frozenRejectsEveryRuntimeWriteAndPreservesReads(){
        mode("FROZEN",epoch());
        assertThat(inCountry(101,()->jdbc.queryForObject("SELECT name FROM sys_country WHERE id=101",String.class))).isEqualTo("Freeze fixture");
        assertThatThrownBy(this::write).isInstanceOf(DataAccessException.class).hasMessageContaining("SYS_WRITES_FROZEN");
        assertThatThrownBy(()->inCountry(101,()->jdbc.update("INSERT INTO md_currency(code,name,decimals) VALUES('ZZZ','Blocked',2)"))).hasMessageContaining("SYS_WRITES_FROZEN");
        assertThatThrownBy(()->owner.execute("TRUNCATE sys_session")).hasMessageContaining("SYS_WRITES_FROZEN");
        assertThat(owner.queryForObject("SELECT name FROM sys_country WHERE id=101",String.class)).isEqualTo("Freeze fixture");
    }
    @Test void runtimeCannotOpenFreezeOrRewriteItsEvidence(){
        assertThatThrownBy(()->jdbc.queryForObject("SELECT jxc_set_write_mode('OPEN',0,?::uuid,'runtime','denied')",String.class,batch.toString())).hasStackTraceContaining("permission denied");
        assertThatThrownBy(()->jdbc.update("UPDATE sys_write_control SET mode='OPEN'")).hasStackTraceContaining("permission denied");
        mode("FROZEN",epoch());
        assertThatThrownBy(()->owner.update("UPDATE sys_write_control_log SET reason='tampered'")).hasMessageContaining("JXC_APPEND_ONLY");
    }
    @Test void retrySameTransitionDoesNotDuplicateAndStaleEpochCannotReopen(){
        long before=epoch();mode("FROZEN",before);long frozen=epoch();
        int logs=owner.queryForObject("SELECT count(*) FROM sys_write_control_log",Integer.class);
        mode("FROZEN",before);
        assertThat(epoch()).isEqualTo(frozen);
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_write_control_log",Integer.class)).isEqualTo(logs);
        assertThatThrownBy(()->mode("OPEN",before)).hasMessageContaining("SYS_WRITE_EPOCH_CONFLICT");
        mode("OPEN",frozen);assertThat(write()).isEqualTo(1);
    }
    @Test void freezeWaitsForAnExistingWriterToCommit() throws Exception {
        var pool=Executors.newFixedThreadPool(2);var acquired=new CountDownLatch(1);var release=new CountDownLatch(1);
        try{
            var writer=pool.submit(()->inCountry(101,()->{jdbc.update("UPDATE sys_country SET name='Committed before freeze' WHERE id=101");acquired.countDown();await(release);return null;}));
            assertThat(acquired.await(10,TimeUnit.SECONDS)).isTrue();
            long before=epoch();var freezer=pool.submit(()->mode("FROZEN",before));
            assertThatThrownBy(()->freezer.get(200,TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            release.countDown();writer.get(10,TimeUnit.SECONDS);freezer.get(10,TimeUnit.SECONDS);
            assertThat(owner.queryForObject("SELECT name FROM sys_country WHERE id=101",String.class)).isEqualTo("Committed before freeze");
            assertThatThrownBy(this::write).hasMessageContaining("SYS_WRITES_FROZEN");
        }finally{release.countDown();pool.shutdownNow();}
    }
    @Test void writerWaitingBehindFreezeIsRejectedAfterFreezeCommits() throws Exception {
        var pool=Executors.newFixedThreadPool(2);var acquired=new CountDownLatch(1);var release=new CountDownLatch(1);
        try{
            long before=epoch();var freezer=pool.submit(()->adminTx().execute(s->{mode("FROZEN",before);acquired.countDown();await(release);return null;}));
            assertThat(acquired.await(10,TimeUnit.SECONDS)).isTrue();var writer=pool.submit(this::write);
            assertThatThrownBy(()->writer.get(200,TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            release.countDown();freezer.get(10,TimeUnit.SECONDS);
            assertThatThrownBy(()->writer.get(10,TimeUnit.SECONDS)).hasStackTraceContaining("SYS_WRITES_FROZEN");
        }finally{release.countDown();pool.shutdownNow();}
    }
    @Test void repeatableReadSnapshotCannotContinueWritingAfterFreeze(){
        var stale=new TransactionTemplate(transactionManager);stale.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
        assertThatThrownBy(()->stale.execute(s->{dbContext.apply(101L);jdbc.queryForObject("SELECT count(*) FROM sys_country",Integer.class);mode("FROZEN",epoch());jdbc.update("UPDATE sys_country SET name='stale' WHERE id=101");return null;})).isInstanceOf(DataAccessException.class).hasMessageContaining("could not serialize access");
    }
    @Test void aFailedTransitionRollsBackModeAndEvidence(){
        long before=epoch();int logs=owner.queryForObject("SELECT count(*) FROM sys_write_control_log",Integer.class);
        assertThatThrownBy(()->adminTx().execute(s->{mode("FROZEN",before);throw new IllegalStateException("injected");})).hasMessage("injected");
        assertThat(epoch()).isEqualTo(before);assertThat(write()).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_write_control_log",Integer.class)).isEqualTo(logs);
    }
    @Test void everyExistingBusinessTableHasAStatementGate(){
        assertThat(owner.queryForList("SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND c.relname NOT IN ('flyway_schema_history','sys_write_control','sys_write_control_log') AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='jxc_write_gate' AND t.tgenabled IN ('O','A') AND t.tgfoid='public.jxc_assert_writes_open()'::regprocedure AND (t.tgtype::int & 3)=2 AND (t.tgtype::int & 60)=60)",String.class)).isEmpty();
    }
    @Test void freezeReturnsStableServiceUnavailableCode(){
        mode("FROZEN",epoch());
        try{write();fail("expected frozen write");}catch(DataAccessException e){
            var response=new ApiExceptionAdvice().database(e);assertThat(response.getStatusCode().value()).isEqualTo(503);
            assertThat(response.getBody().code()).isEqualTo("SYS_WRITES_FROZEN");
        }
    }
    @Test void missingSingletonCannotSilentlyAllowWrites(){
        adminTx().executeWithoutResult(s->{
            owner.update("DELETE FROM sys_write_control");
            assertThatThrownBy(()->owner.update("UPDATE sys_country SET name='not allowed' WHERE id=101")).hasMessageContaining("SYS_WRITES_FROZEN");
            s.setRollbackOnly();
        });
        assertThat(write()).isEqualTo(1);
    }
    @Test void recursiveJsonChecksWorkInPgRestoreEmptySearchPath(){
        tx.executeWithoutResult(s->{
            jdbc.execute("SET LOCAL search_path=''");
            assertThat(jdbc.queryForObject("SELECT public.jxc_json_ids_safe('{\"sources\":[{\"bookId\":601,\"sourceIds\":[101,201]}]}'::jsonb)",Boolean.class)).isTrue();
            assertThat(jdbc.queryForObject("SELECT public.jxc_json_ids_safe('{\"sources\":[{\"bookId\":9007199254740992}]}'::jsonb)",Boolean.class)).isFalse();
        });
    }
    static void await(CountDownLatch latch){try{if(!latch.await(10,TimeUnit.SECONDS))throw new AssertionError("barrier timeout");}catch(InterruptedException e){Thread.currentThread().interrupt();throw new RuntimeException(e);}}
}
