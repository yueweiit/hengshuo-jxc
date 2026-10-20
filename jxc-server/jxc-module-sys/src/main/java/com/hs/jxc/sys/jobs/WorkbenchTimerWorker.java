package com.hs.jxc.sys.jobs;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.DbContext;
import com.hs.jxc.sys.api.*;
import com.hs.jxc.sys.service.AuthorizationService;
import java.util.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
/** Materializes the owners' current timed work in the existing todo store for explicit subjects only. */
@Component
public class WorkbenchTimerWorker implements CountryWorkProvider {
 private final JdbcTemplate db;private final DbContext context;private final AuthorizationService auth;private final ObjectProvider<WorkItemProvider> providers;private final TransactionTemplate tx;private final Map<Long,List<Long>> assignments;
 public WorkbenchTimerWorker(JdbcTemplate db,DbContext context,AuthorizationService auth,ObjectProvider<WorkItemProvider> providers,PlatformTransactionManager tm,@Value("${jxc.workbench.worker.assignments:}")String configured){this.db=db;this.context=context;this.auth=auth;this.providers=providers;this.tx=new TransactionTemplate(tm);var parsed=new TreeMap<Long,List<Long>>();for(String value:configured.split(",")){if(value.isBlank())continue;if(!value.trim().matches("[1-9][0-9]*:[1-9][0-9]*"))throw new IllegalArgumentException("Workbench assignments must be countryId:userId");var ids=value.trim().split(":");parsed.computeIfAbsent(Long.parseLong(ids[0]),k->new ArrayList<>()).add(Long.parseLong(ids[1]));}this.assignments=Map.copyOf(parsed);}
 public String kind(){return "WORKBENCH_TIMER";}
 public int recover(long country,int limit){int count=0;for(long user:new LinkedHashSet<>(assignments.getOrDefault(country,List.of())))count+=tx.execute(s->{context.apply(null);auth.gate(0,false);context.apply(country);auth.gate(country,false);var a=auth.accessForSubject(new Access(user,country,false,Set.of(),Map.of(),DataScope.none(),null),user);var current=new LinkedHashSet<String>();int touched=0;for(var provider:providers.orderedStream().toList())for(var item:provider.items(a)){String type=Objects.toString(item.get("todoType"),"");if(!Set.of("LOGISTICS_DELAY","HOLD_REVIEW").contains(type))continue;String key="TIMER:"+type+":"+Objects.toString(item.getOrDefault("dedupKey",item.get("id")))+":"+user;if(key.length()>200)throw Inputs.bad("定时待办来源键过长");current.add(key);String perm=Objects.toString(item.get("perm"),"");if(perm.isBlank()||!a.has(perm))continue;db.update("INSERT INTO sys_todo(country_id,todo_type,dedup_key,title,link,perm,assignee_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(country_id,dedup_key) DO UPDATE SET title=EXCLUDED.title,link=EXCLUDED.link,perm=EXCLUDED.perm,status='OPEN',resolved_at=NULL,version=sys_todo.version+CASE WHEN sys_todo.status<>'OPEN' THEN 1 ELSE 0 END",country,type,key,item.get("title"),item.get("link"),perm,user);touched++;}for(var old:db.queryForList("SELECT id,dedup_key FROM sys_todo WHERE country_id=? AND assignee_id=? AND status='OPEN' AND dedup_key LIKE 'TIMER:%'",country,user))if(!current.contains(old.get("dedup_key")))db.update("UPDATE sys_todo SET status='DONE',resolved_at=clock_timestamp(),version=version+1 WHERE country_id=? AND id=?",country,old.get("id"));return touched;});return count;}
 public void daily(long country){}
}
