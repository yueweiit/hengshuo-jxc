package com.hs.jxc.event;
import org.springframework.stereotype.Service;
import java.util.Map;
import java.util.function.Consumer;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.*;
import com.hs.jxc.sys.service.AuthorizationService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.*;
import java.time.Instant;
@Service
public class TransactionalEventConsumer {
    public enum Outcome{DONE,ALREADY_DONE,BUSY,FAILED}
    private record Claim(long book,int version,Outcome outcome){}
    private final JdbcTemplate jdbc;private final DbContext db;private final BookGate books;private final AuthorizationService auth;private final JsonCodec json;private final TransactionTemplate tx;private final TransactionTemplate snapshotTx;
    public TransactionalEventConsumer(JdbcTemplate jdbc,DbContext db,BookGate books,AuthorizationService auth,JsonCodec json,PlatformTransactionManager tm){this.jdbc=jdbc;this.db=db;this.books=books;this.auth=auth;this.json=json;this.tx=new TransactionTemplate(tm);this.tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);this.snapshotTx=new TransactionTemplate(tm);this.snapshotTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);this.snapshotTx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);}
    private Map<String,Object> event(long country,long id){var rows=jdbc.queryForList("SELECT * FROM sys_biz_event WHERE country_id=? AND id=?",country,id);if(rows.isEmpty())throw ApiException.notFound();return rows.getFirst();}
    private void gates(long country){db.apply(null);auth.gate(0,false);db.apply(country);auth.gate(country,false);}
    /** Worker-only API: no HTTP route and no business consumer is registered in M1. */
    public Outcome run(long country,long eventId,String consumer,Consumer<Map<String,Object>> work){return run(country,eventId,consumer,work,tx);}
    /** The effect itself owns the consistent snapshot; no nested transaction under its book gate. */
    public Outcome runSnapshot(long country,long eventId,String consumer,Consumer<Map<String,Object>> work){return run(country,eventId,consumer,work,snapshotTx);}
    private Outcome run(long country,long eventId,String consumer,Consumer<Map<String,Object>> work,TransactionTemplate effect){
        if(TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Outbox worker must start after the business transaction finishes");
        if(consumer==null||!consumer.matches("[A-Za-z0-9_.:-]{1,100}"))throw new IllegalArgumentException("Invalid consumer");
        Claim claim=tx.execute(s->{
            gates(country);var event=event(country,eventId);long book=((Number)event.get("book_id")).longValue();books.lock(country,book,false);
            var created=jdbc.queryForList("INSERT INTO sys_biz_event_consume(country_id,book_id,event_id,consumer,status,attempt_count) VALUES(?,?,?,?,'PROCESSING',1) ON CONFLICT(event_id,consumer) DO NOTHING RETURNING version",country,book,eventId,consumer);
            if(!created.isEmpty())return new Claim(book,1,null);
            var row=jdbc.queryForMap("SELECT *,updated_at < clock_timestamp()-interval '30 seconds' expired FROM sys_biz_event_consume WHERE country_id=? AND event_id=? AND consumer=? FOR UPDATE",country,eventId,consumer);
            if("DONE".equals(row.get("status")))return new Claim(book,0,Outcome.ALREADY_DONE);
            if("PROCESSING".equals(row.get("status"))&&!Boolean.TRUE.equals(row.get("expired")))return new Claim(book,0,Outcome.BUSY);
            int version=jdbc.queryForObject("UPDATE sys_biz_event_consume SET status='PROCESSING',attempt_count=attempt_count+1,last_error=NULL,updated_at=clock_timestamp(),version=version+1 WHERE country_id=? AND event_id=? AND consumer=? RETURNING version",Integer.class,country,eventId,consumer);
            return new Claim(book,version,null);
        });
        if(claim.outcome()!=null)return claim.outcome();
        try{return effect.execute(s->{
            gates(country);books.lock(country,claim.book(),false);
            var row=jdbc.queryForMap("SELECT status,version FROM sys_biz_event_consume WHERE country_id=? AND event_id=? AND consumer=? FOR UPDATE",country,eventId,consumer);
            if(((Number)row.get("version")).intValue()!=claim.version()||!"PROCESSING".equals(row.get("status")))return Outcome.BUSY;
            var source=DbRows.camel(event(country,eventId));source.put("payload",json.readMap(source.get("payload").toString()));work.accept(source);
            jdbc.update("UPDATE sys_biz_event_consume SET status='DONE',processed_at=clock_timestamp(),updated_at=clock_timestamp(),last_error=NULL,version=version+1 WHERE country_id=? AND event_id=? AND consumer=? AND version=?",country,eventId,consumer,claim.version());
            return Outcome.DONE;
        });}catch(RuntimeException e){
            // The effect transaction has rolled back and released its locks before this new diagnostic transaction.
            failure(country,eventId,consumer,claim.version(),e instanceof ApiException api?api.getCode():"CONSUMER_FAILED");return Outcome.FAILED;
        }
    }
    public void failure(long country,long eventId,String consumer,int version,String code){
        if(TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Record failure only after effect rollback");
        tx.executeWithoutResult(s->{gates(country);var e=event(country,eventId);books.lock(country,((Number)e.get("book_id")).longValue(),false);
            jdbc.update("UPDATE sys_biz_event_consume SET status='FAILED',last_error=?,updated_at=clock_timestamp(),version=version+1 WHERE country_id=? AND event_id=? AND consumer=? AND version=? AND status='PROCESSING'",code!=null&&code.matches("[A-Z0-9_]{1,100}")?code:"CONSUMER_FAILED",country,eventId,consumer,version);
        });
    }
}
