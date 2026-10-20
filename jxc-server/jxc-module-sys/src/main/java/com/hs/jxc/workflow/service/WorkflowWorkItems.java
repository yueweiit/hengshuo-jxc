package com.hs.jxc.workflow.service;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.WorkItemProvider;
import com.hs.jxc.sys.service.DocumentAccessService;
import java.util.*;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Configuration blockers keep the original workflow source policy and existing todo. */
@Component
public class WorkflowWorkItems implements WorkItemProvider {
    private static final Pattern REF=Pattern.compile("WF_BLOCKED:([A-Z_]{1,64}):([0-9]{1,16})");
    private final JdbcTemplate jdbc;private final DocumentAccessService documents;
    public WorkflowWorkItems(JdbcTemplate jdbc,DocumentAccessService documents){this.jdbc=jdbc;this.documents=documents;}
    public List<Map<String,Object>> items(Access a){var out=new ArrayList<Map<String,Object>>();
        if(!a.has("wf:rule:edit"))return out;
        for(var row:jdbc.queryForList("SELECT * FROM sys_todo WHERE country_id=? AND assignee_id IS NULL AND status='OPEN' AND todo_type='CONFIG_MISSING' ORDER BY id",a.requireCountry())){
            var match=REF.matcher(row.get("dedup_key").toString());if(!match.matches())continue;
            try{documents.requireDocumentAccess(a,match.group(1),Long.parseLong(match.group(2)),false);var item=DbRows.camel(row);item.put("typeLabel","审批配置缺失");out.add(item);}
            catch(ApiException e){if(e.getStatus()!=403&&e.getStatus()!=404)throw e;}
        }
        return out;
    }
}
