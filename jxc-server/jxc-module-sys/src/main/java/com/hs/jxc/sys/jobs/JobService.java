package com.hs.jxc.sys.jobs;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.*;
import com.hs.jxc.common.event.OutboxPublisher;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.event.TransactionalEventConsumer;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.AuthorizationService;
import jakarta.annotation.PreDestroy;
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.*;

/** Owner-scoped technical jobs. Business facts remain in the owning module. */
@Service
public class JobService implements JobApi {
    private static final String SOURCE="SYS_REPORT_EXPORT", EVENT="SYS_REPORT_EXPORT_REQUESTED", CONSUMER="SYS_EXPORT";
    private final JdbcTemplate jdbc;
    private final DbContext db;
    private final BookGate books;
    private final AuthorizationService auth;
    private final IdempotencyExecutor idem;
    private final OutboxPublisher outbox;
    private final TransactionalEventConsumer consumer;
    private final JsonCodec json;
    private final AuditWriter audit;
    private final ObjectProvider<JobHandler> handlers;
    private final TransactionTemplate tx;
    private final boolean enabled;
    private final ThreadPoolExecutor executor=new ThreadPoolExecutor(1,2,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(100),r->{var t=new Thread(r,"jxc-export");t.setDaemon(true);return t;},new ThreadPoolExecutor.AbortPolicy());
    public JobService(JdbcTemplate jdbc,DbContext db,BookGate books,AuthorizationService auth,IdempotencyExecutor idem,OutboxPublisher outbox,TransactionalEventConsumer consumer,JsonCodec json,AuditWriter audit,ObjectProvider<JobHandler> handlers,PlatformTransactionManager tm,@Value("${jxc.jobs.enabled:true}") boolean enabled){
        this.jdbc=jdbc;this.db=db;this.books=books;this.auth=auth;this.idem=idem;this.outbox=outbox;this.consumer=consumer;this.json=json;this.audit=audit;this.handlers=handlers;this.tx=new TransactionTemplate(tm);this.enabled=enabled;
    }
    @PreDestroy void stop(){executor.shutdown();}
    private JobHandler handler(String kind){var matches=handlers.stream().filter(h->h.kind().equals(kind)).toList();if(matches.size()!=1)throw Inputs.bad("不支持的导出类型");return matches.getFirst();}
    @Override public Map<String,Object> enqueue(RequestContext c,String kind,long book,Map<String,Object> request,String key){return tx.execute(s->{
        var a=auth.authorize(c);a.requireCountry();if(!a.canBook(book))throw ApiException.notFound();var h=handler(kind);h.authorize(a,book,request);
        if(json.write(request).length()>60000)throw Inputs.bad("导出参数过大");
        return idem.execute(c,"POST","/api/v1/sys/jobs",key,Map.of("jobType",kind,"bookId",book,"params",request),book,()->{
            books.lock(a.requireCountry(),book,false);h.authorize(a,book,request);var captured=h.captureRequest(a,book,request);if(json.write(captured).length()>60000)throw Inputs.bad("导出参数过大");
            long id=jdbc.queryForObject("INSERT INTO sys_export_job(country_id,book_id,requested_by,session_hash,job_type,params) VALUES(?,?,?,?,?,?::jsonb) RETURNING id",Long.class,a.requireCountry(),book,a.userId(),c.tokenHash(),kind,json.write(captured));
            outbox.publish(a.requireCountry(),book,EVENT,SOURCE,id,1,LocalDate.now(java.time.ZoneOffset.UTC),Map.of("jobId",id));
            audit.append(c,"ENQUEUE","SYS_EXPORT_JOB",id,null,Map.of("jobType",kind,"bookId",book));
            dispatchAfterCommit(a.requireCountry(),id);return Map.of("id",id,"jobId",id,"bookId",book,"status","QUEUED");
        },result->authorized(a,Inputs.id(result.get("id"))));
    });}
    private void dispatchAfterCommit(long country,long id){if(!enabled)return;TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization(){@Override public void afterCommit(){try{executor.execute(()->{try{run(country,id);}catch(RuntimeException ignored){/* Durable QUEUED/FAILED state remains available for retry. */}});}catch(RejectedExecutionException ignored){/* Bounded queue: explicit retry reuses the same job. */}}});}
    private Map<String,Object> row(long country,long id){var rows=jdbc.queryForList("SELECT j.*,coalesce((SELECT i.session_hash FROM sys_job_execution_intent i WHERE i.country_id=j.country_id AND i.job_id=j.id ORDER BY i.id DESC LIMIT 1),j.session_hash) execution_session_hash,r.job_id IS NOT NULL has_result,c.status consume_status,c.last_error,clock_timestamp()>=j.expires_at expired FROM sys_export_job j LEFT JOIN sys_job_result r ON r.country_id=j.country_id AND r.job_id=j.id LEFT JOIN sys_biz_event e ON e.country_id=j.country_id AND e.source_type=? AND e.event_type=? AND e.source_id=j.id LEFT JOIN sys_biz_event_consume c ON c.country_id=e.country_id AND c.event_id=e.id AND c.consumer=? WHERE j.country_id=? AND j.id=?",SOURCE,EVENT,CONSUMER,country,id);if(rows.isEmpty())throw ApiException.notFound();return rows.getFirst();}
    private Map<String,Object> authorized(Access a,long id){var r=row(a.requireCountry(),id);long book=((Number)r.get("book_id")).longValue();if(((Number)r.get("requested_by")).longValue()!=a.userId()||!a.canBook(book))throw ApiException.notFound();handler(r.get("job_type").toString()).authorize(a,book,json.readMap(r.get("params").toString()));return r;}
    private Map<String,Object> view(Map<String,Object> r){var out=new LinkedHashMap<String,Object>();for(String name:List.of("id","country_id","book_id","job_type","created_at","expires_at"))out.put(name,r.get(name));out= new LinkedHashMap<>(DbRows.camel(out));out.put("status",Boolean.TRUE.equals(r.get("expired"))?"EXPIRED":Boolean.TRUE.equals(r.get("has_result"))?"SUCCESS":"PROCESSING".equals(r.get("consume_status"))?"RUNNING":"FAILED".equals(r.get("consume_status"))?"FAILED":"QUEUED");out.put("lastError",r.get("last_error"));return out;}
    public Map<String,Object> list(RequestContext c,Map<String,String> q){return tx.execute(s->{var a=auth.authorize(c);var out=new ArrayList<Map<String,Object>>();for(Long id:jdbc.queryForList("SELECT id FROM sys_export_job WHERE country_id=? AND requested_by=? ORDER BY id DESC",Long.class,a.requireCountry(),a.userId())){try{out.add(view(authorized(a,id)));}catch(ApiException e){if(e.getStatus()!=403&&e.getStatus()!=404)throw e;}}return page(out,q);});}
    public Map<String,Object> detail(RequestContext c,long id){return tx.execute(s->view(authorized(auth.authorize(c),id)));}
    public Map<String,Object> download(RequestContext c,long id){return tx.execute(s->{var a=auth.authorize(c);var r=authorized(a,id);if(Boolean.TRUE.equals(r.get("expired")))throw new ApiException(410,"SYS_JOB_EXPIRED","导出已过期，请重新发起");var result=jdbc.queryForList("SELECT content FROM sys_job_result WHERE country_id=? AND job_id=?",a.requireCountry(),id);if(result.isEmpty())throw new ApiException(409,"SYS_JOB_NOT_READY","导出尚未完成");return handler(r.get("job_type").toString()).download(a,((Number)r.get("book_id")).longValue(),json.readMap(result.getFirst().get("content").toString()));});}
    public Map<String,Object> retry(RequestContext c,long id,String key){return tx.execute(s->{var a=auth.authorize(c);var r=authorized(a,id);if(Boolean.TRUE.equals(r.get("expired")))throw new ApiException(410,"SYS_JOB_EXPIRED","导出已过期，请重新发起");long book=((Number)r.get("book_id")).longValue();return idem.execute(c,"POST","/api/v1/sys/jobs/"+id+"/retry",key,Map.of(),book,()->{jdbc.queryForObject("SELECT pg_advisory_xact_lock(hashtextextended(?,0))",Object.class,a.requireCountry()+":JOB_RETRY:"+id);var current=authorized(a,id);if(!Boolean.TRUE.equals(current.get("has_result"))){jdbc.update("INSERT INTO sys_job_execution_intent(country_id,book_id,job_id,requested_by,session_hash) VALUES(?,?,?,?,?)",a.requireCountry(),book,id,a.userId(),c.tokenHash());audit.append(c,"RETRY","SYS_EXPORT_JOB",id,null,Map.of("executionIntent","CURRENT_OWNER_SESSION"));dispatchAfterCommit(a.requireCountry(),id);}return view(current);},out->authorized(a,id));});}
    @Override public void run(long country,long id){
        Long eventId=tx.execute(s->{db.apply(null);auth.gate(0,false);db.apply(country);auth.gate(country,false);var ids=jdbc.queryForList("SELECT e.id FROM sys_biz_event e JOIN sys_export_job j ON j.country_id=e.country_id AND j.id=e.source_id WHERE e.country_id=? AND e.source_type=? AND e.event_type=? AND j.id=? AND j.expires_at>clock_timestamp()",Long.class,country,SOURCE,EVENT,id);return ids.isEmpty()?null:ids.getFirst();});
        if(eventId==null)return;
        consumer.runSnapshot(country,eventId,CONSUMER,event->{var r=row(country,id);var c=new RequestContext(((Number)r.get("requested_by")).longValue(),country,"export-worker",r.get("execution_session_hash").toString());var a=auth.authorize(c);var h=handler(r.get("job_type").toString());long book=((Number)r.get("book_id")).longValue();if(!a.canBook(book))throw ApiException.notFound();h.authorize(a,book,json.readMap(r.get("params").toString()));if(Boolean.TRUE.equals(r.get("expired")))throw new ApiException(410,"SYS_JOB_EXPIRED","导出已过期");
            String content=json.write(h.execute(a,book,json.readMap(r.get("params").toString())));if(content.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>1048576)throw Inputs.bad("导出结果过大，请缩小期间范围");
            jdbc.update("INSERT INTO sys_job_result(country_id,book_id,job_id,content) VALUES(?,?,?,?::jsonb)",country,book,id,content);
            jdbc.update("INSERT INTO sys_notification(country_id,user_id,job_id,title,content) VALUES(?,?,?,'导出已完成','可前往导出任务查看和下载')",country,a.userId(),id);
            audit.append(c,"COMPLETE","SYS_EXPORT_JOB",id,null,Map.of("jobType",h.kind()));
        });
    }
    /** Recovery does not invent an identity: each effect reauthorizes the latest explicit owner execution intent. */
    public int recoverCountry(long country,int limit){
        var ids=tx.execute(s->{db.apply(null);auth.gate(0,false);db.apply(country);auth.gate(country,false);
            return jdbc.queryForList("SELECT j.id FROM sys_export_job j JOIN sys_biz_event e ON e.country_id=j.country_id AND e.source_id=j.id AND e.source_type=? AND e.event_type=? LEFT JOIN sys_biz_event_consume c ON c.country_id=e.country_id AND c.event_id=e.id AND c.consumer=? WHERE j.country_id=? AND j.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM sys_job_result r WHERE r.country_id=j.country_id AND r.job_id=j.id) AND (c.id IS NULL OR c.status='FAILED' AND c.attempt_count<5 OR c.status='PROCESSING' AND c.updated_at<clock_timestamp()-interval '30 seconds') ORDER BY j.id LIMIT ?",Long.class,SOURCE,EVENT,CONSUMER,country,Math.max(1,Math.min(limit,100)));});
        for(long id:ids)run(country,id);return ids.size();
    }
    public List<Map<String,Object>> notices(Access a,boolean unread){var out=new ArrayList<Map<String,Object>>();for(var r:jdbc.queryForList("SELECT * FROM sys_notification WHERE country_id=? AND user_id=? AND (?=false OR read_at IS NULL) ORDER BY id DESC",a.requireCountry(),a.userId(),unread)){try{authorized(a,((Number)r.get("job_id")).longValue());out.add(DbRows.camel(r));}catch(ApiException e){if(e.getStatus()!=403&&e.getStatus()!=404)throw e;}}return out;}
    public Map<String,Object> notifications(RequestContext c,Map<String,String> q){return tx.execute(s->page(notices(auth.authorize(c),"true".equals(q.get("unread"))),q));}
    public Map<String,Object> readNotifications(RequestContext c,Long id){return tx.execute(s->{var a=auth.authorize(c);boolean found=id==null;for(var r:notices(a,false))if(id==null||id.equals(((Number)r.get("id")).longValue())){jdbc.update("UPDATE sys_notification SET read_at=COALESCE(read_at,clock_timestamp()) WHERE country_id=? AND id=? AND user_id=?",a.requireCountry(),r.get("id"),a.userId());found=true;}if(!found)throw ApiException.notFound();return Map.of("success",true);});}
    static Map<String,Object> page(List<Map<String,Object>> rows,Map<String,String> q){int page=bounded(q.get("page"),1,100000),size=bounded(q.get("size"),20,200);long offset=(long)(page-1)*size;int from=(int)Math.min(offset,rows.size());return Map.of("records",rows.subList(from,Math.min(from+size,rows.size())),"total",rows.size(),"page",page,"size",size);}
    private static int bounded(String value,int fallback,int max){try{return value==null?fallback:Math.max(1,Math.min(max,Integer.parseInt(value)));}catch(NumberFormatException e){throw Inputs.bad("分页参数不合法");}}
}
