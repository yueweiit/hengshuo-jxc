package com.hs.jxc.sys.jobs;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.AuthorizationService;
import com.hs.jxc.workflow.service.WorkflowService;
import java.util.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class WorkbenchService {
    private final JdbcTemplate jdbc;private final AuthorizationService auth;private final WorkflowService workflow;private final JobService jobs;private final ObjectProvider<WorkItemProvider> providers;private final TransactionTemplate tx;
    public WorkbenchService(JdbcTemplate jdbc,AuthorizationService auth,WorkflowService workflow,JobService jobs,ObjectProvider<WorkItemProvider> providers,PlatformTransactionManager tm){this.jdbc=jdbc;this.auth=auth;this.workflow=workflow;this.jobs=jobs;this.providers=providers;this.tx=new TransactionTemplate(tm);}
    @SuppressWarnings("unchecked") private List<Map<String,Object>> items(RequestContext c,Access a){
        a.requireCountry();var out=new ArrayList<Map<String,Object>>();
        for(var row:jdbc.queryForList("SELECT * FROM sys_todo WHERE country_id=? AND assignee_id=? AND status='OPEN' AND dedup_key NOT LIKE 'TIMER:%' ORDER BY id DESC",a.requireCountry(),a.userId())){
            if(a.scope().all()&&row.get("perm")!=null&&a.has(row.get("perm").toString())){var r=DbRows.camel(row);r.put("typeLabel",r.get("todoType"));out.add(r);}
        }
        for(int page=1;;page++){
            var result=workflow.tasks(c,Map.of("size","200","page",String.valueOf(page)));
            for(var r:(List<Map<String,Object>>)result.get("records"))out.add(Map.of("id",r.get("id"),"todoType","APPROVAL","typeLabel","待审批","title","待处理审批","link","/workflow/tasks","createdAt",Objects.toString(r.get("createdAt"),"")));
            if((long)page*200>=((Number)result.get("total")).longValue())break;
        }
        providers.orderedStream().forEach(p->out.addAll(p.items(a)));return out;
    }
    public Map<String,Object> todos(RequestContext c,Map<String,String> q){return tx.execute(s->{var rows=items(c,auth.authorize(c));if(q.get("type")!=null)rows=rows.stream().filter(r->q.get("type").equals(r.get("todoType"))).toList();return JobService.page(rows,q);});}
    public Map<String,Object> summary(RequestContext c){return tx.execute(s->{var a=auth.authorize(c);var grouped=new LinkedHashMap<String,Map<String,Object>>();for(var r:items(c,a)){String type=r.get("todoType").toString();var item=grouped.computeIfAbsent(type,k->new LinkedHashMap<>(Map.of("type",k,"label",r.get("typeLabel"),"link",r.get("link"),"count",0)));item.put("count",((Number)item.get("count")).intValue()+1);}return Map.of("items",new ArrayList<>(grouped.values()),"unreadNotifications",jobs.notices(a,true).size());});}
}
