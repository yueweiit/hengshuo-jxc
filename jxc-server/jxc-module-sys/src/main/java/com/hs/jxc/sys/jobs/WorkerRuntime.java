package com.hs.jxc.sys.jobs;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.*;
import com.hs.jxc.sys.service.AuthorizationService;
import java.time.LocalDate;
import java.util.*;
import java.util.function.Supplier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
@Service
public class WorkerRuntime {
 private final JdbcTemplate db;private final DbContext context;private final AuthorizationService auth;private final ObjectProvider<CountryWorkProvider> providers;private final TransactionTemplate tx;private final boolean enabled;private final int limit;private final long delay;
 public WorkerRuntime(JdbcTemplate db,DbContext context,AuthorizationService auth,ObjectProvider<CountryWorkProvider> providers,PlatformTransactionManager tm,@Value("${jxc.jobs.enabled:true}")boolean enabled,@Value("${jxc.jobs.recovery.limit:20}")int limit,@Value("${jxc.jobs.recovery.delay-ms:30000}")long delay){this.db=db;this.context=context;this.auth=auth;this.providers=providers;this.tx=new TransactionTemplate(tm);this.enabled=enabled;this.limit=Math.max(1,Math.min(100,limit));this.delay=delay;}
 private void gates(long country){context.apply(null);auth.gate(0,false);context.apply(country);auth.gate(country,false);}
 public int limit(){return limit;}
 public void run(long country,String kind,Supplier<Integer> recovery,Runnable daily){
  LocalDate day=tx.execute(s->{gates(country);db.update("INSERT INTO sys_worker_runtime(country_id,kind,status) VALUES(?,?,'RUNNING') ON CONFLICT(country_id,kind) DO UPDATE SET status='RUNNING',last_started_at=clock_timestamp(),attempt_count=sys_worker_runtime.attempt_count+1",country,kind);return db.queryForObject("SELECT (clock_timestamp() AT TIME ZONE timezone)::date FROM sys_country WHERE id=?",LocalDate.class,country);});
  try{int recovered=recovery.get();boolean due=tx.execute(s->{gates(country);var previous=db.queryForObject("SELECT last_daily_date FROM sys_worker_runtime WHERE country_id=? AND kind=?",LocalDate.class,country,kind);return !day.equals(previous);});if(due)daily.run();tx.execute(s->{gates(country);db.update("UPDATE sys_worker_runtime SET status='SUCCESS',last_completed_at=clock_timestamp(),last_error=NULL,recovered_count=?,last_daily_date=? WHERE country_id=? AND kind=?",recovered,day,country,kind);return null;});}
  catch(RuntimeException e){tx.execute(s->{gates(country);db.update("UPDATE sys_worker_runtime SET status='FAILED',last_failure_at=clock_timestamp(),last_error=? WHERE country_id=? AND kind=?",e instanceof ApiException api?api.getCode():"WORKER_FAILED",country,kind);return null;});}
 }
 public Map<String,Object> status(RequestContext c){return tx.execute(s->{
  var a=auth.authorize(c);a.require("sys:worker:view");var out=new LinkedHashMap<String,Object>();out.put("enabled",enabled);out.put("recoveryLimit",limit);out.put("delayMs",delay);out.put("providers",providers.orderedStream().map(CountryWorkProvider::kind).toList());
  var runs=db.queryForList("SELECT *,last_started_at<clock_timestamp()-(?*interval '1 millisecond') stale_started,last_completed_at<clock_timestamp()-(?*interval '1 millisecond') stale_completed FROM sys_worker_runtime WHERE country_id=? ORDER BY kind",Math.max(60000L,delay*3),Math.max(60000L,delay*3),a.requireCountry()).stream().map(DbRows::camel).toList();out.put("runs",runs);var alerts=new ArrayList<Map<String,Object>>();
  for(var run:runs){if("FAILED".equals(run.get("status")))alerts.add(Map.of("code","WORKER_FAILED","severity","ERROR","kind",run.get("kind"),"lastError",Objects.toString(run.get("lastError"),"WORKER_FAILED")));else if("RUNNING".equals(run.get("status"))&&Boolean.TRUE.equals(run.get("staleStarted"))||enabled&&Boolean.TRUE.equals(run.get("staleCompleted")))alerts.add(Map.of("code","WORKER_STALE","severity","ERROR","kind",run.get("kind"),"message","后台任务心跳超时，请检查进程与恢复状态"));}
  var states=new LinkedHashMap<String,Integer>();for(var row:db.queryForList("SELECT c.*,e.source_type,e.source_id,c.updated_at<clock_timestamp()-interval '30 seconds' stale_lease FROM sys_biz_event_consume c JOIN sys_biz_event e ON e.country_id=c.country_id AND e.id=c.event_id WHERE c.country_id=? ORDER BY c.id",a.requireCountry())){if(!a.canBook(((Number)row.get("book_id")).longValue()))continue;String state=Objects.toString(row.get("status"));states.merge(state,1,Integer::sum);if(state.equals("FAILED"))alerts.add(Map.of("code","FAILED_EFFECT","severity","ERROR","consumer",row.get("consumer"),"eventId",row.get("event_id"),"sourceType",row.get("source_type"),"sourceId",row.get("source_id"),"lastError",Objects.toString(row.get("last_error"),"CONSUMER_FAILED")));else if(state.equals("PROCESSING")&&Boolean.TRUE.equals(row.get("stale_lease")))alerts.add(Map.of("code","STALE_LEASE","severity","WARNING","consumer",row.get("consumer"),"eventId",row.get("event_id"),"message","原进程租约已超时，等待当前权限下恢复"));}
  for(var row:db.queryForList("SELECT j.id,j.book_id FROM sys_export_job j WHERE j.country_id=? AND j.expires_at>clock_timestamp() AND j.created_at<clock_timestamp()-(?*interval '1 millisecond') AND NOT EXISTS(SELECT 1 FROM sys_biz_event e JOIN sys_biz_event_consume c ON c.country_id=e.country_id AND c.event_id=e.id AND c.consumer='SYS_EXPORT' WHERE e.country_id=j.country_id AND e.source_type='SYS_REPORT_EXPORT' AND e.source_id=j.id)",a.requireCountry(),Math.max(60000L,delay*3)))if(a.canBook(((Number)row.get("book_id")).longValue()))alerts.add(Map.of("code","QUEUED_STALE","severity","WARNING","jobId",row.get("id"),"message","导出长时间未开始，请检查后台任务进程"));
  out.put("effectStates",states);out.put("alerts",alerts);out.put("actionRequired",!alerts.isEmpty());return out;
 });}
}
