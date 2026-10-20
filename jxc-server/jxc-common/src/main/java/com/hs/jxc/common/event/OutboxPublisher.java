package com.hs.jxc.common.event;
import org.springframework.stereotype.Component;
import java.time.LocalDate;
import java.util.Map;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.common.db.BookGate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;
@Component
public class OutboxPublisher {
    private final JdbcTemplate jdbc;private final JsonCodec json;private final BookGate books;
    public OutboxPublisher(JdbcTemplate jdbc,JsonCodec json,BookGate books){this.jdbc=jdbc;this.json=json;this.books=books;}
    /** Read existing immutable source snapshots; never scans documents to create replacement events. */
    public java.util.List<Map<String,Object>> history(long country,long book,String source,long sourceId,String eventType,LocalDate through){
        if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Event history requires caller transaction");
        return jdbc.queryForList("SELECT id,event_type,event_seq,biz_date,payload FROM sys_biz_event WHERE country_id=? AND book_id=? AND source_type=? AND source_id=? AND event_type=? AND biz_date<=? ORDER BY event_seq,id",country,book,source,sourceId,eventType,through).stream().map(raw->{var r=com.hs.jxc.common.db.DbRows.camel(raw);r.put("payload",json.readMap(r.get("payload").toString()));return r;}).toList();
    }
    /** Immutable confirmation order. Callers authorize their own source before reading it. */
    public Long sourceEventOrder(long country,long book,String source,long sourceId,String eventType,int sequence){
        if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Event order requires caller transaction");
        var ids=jdbc.queryForList("SELECT id FROM sys_biz_event WHERE country_id=? AND book_id=? AND source_type=? AND source_id=? AND event_type=? AND event_seq=?",Long.class,country,book,source,sourceId,eventType,sequence);
        return ids.isEmpty()?null:ids.getFirst();
    }
    public long publish(long country,long book,String type,String source,long sourceId,int seq,LocalDate date,Map<String,Object> payload){
        if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Publish must join the business transaction");
        books.lock(country,book,false);String serialized=json.write(IdempotencyExecutor.canonical(payload));
        var inserted=jdbc.queryForList("INSERT INTO sys_biz_event(country_id,book_id,event_type,source_type,source_id,event_seq,payload,biz_date) VALUES(?,?,?,?,?,?,?::jsonb,?) ON CONFLICT(country_id,event_type,source_type,source_id,event_seq) DO NOTHING RETURNING id",country,book,type,source,sourceId,seq,serialized,date);
        if(!inserted.isEmpty())return ((Number)inserted.getFirst().get("id")).longValue();
        var rows=jdbc.queryForList("SELECT id,book_id,payload,biz_date FROM sys_biz_event WHERE country_id=? AND event_type=? AND source_type=? AND source_id=? AND event_seq=?",country,type,source,sourceId,seq);
        if(rows.isEmpty())throw new ApiException(409,"SYS_CONCURRENT_RETRY","来源事件正在处理，请重试");var r=rows.getFirst();
        if(((Number)r.get("book_id")).longValue()!=book||!date.equals(((java.sql.Date)r.get("biz_date")).toLocalDate())||!serialized.equals(json.write(IdempotencyExecutor.canonical(json.readMap(r.get("payload").toString())))))throw new ApiException(409,"SYS_EVENT_CONFLICT","同一来源事件不能替换事实内容");
        return ((Number)r.get("id")).longValue();
    }
}
