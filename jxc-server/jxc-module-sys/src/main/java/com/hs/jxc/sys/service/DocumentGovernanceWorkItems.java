package com.hs.jxc.sys.service;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.WorkItemProvider;
import java.util.*;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** CC delivery stays visible only while the recipient can still read the original source. */
@Component
public class DocumentGovernanceWorkItems implements WorkItemProvider {
    private static final Pattern REF=Pattern.compile("WF_CC:([A-Z_]{1,64}):([1-9][0-9]{0,15}):([1-9][0-9]{0,15})");
    private final JdbcTemplate jdbc;private final DocumentAccessService docs;
    public DocumentGovernanceWorkItems(JdbcTemplate jdbc,DocumentAccessService docs){this.jdbc=jdbc;this.docs=docs;}
    public List<Map<String,Object>>items(Access a){var out=new ArrayList<Map<String,Object>>();for(var row:jdbc.queryForList("SELECT * FROM sys_todo WHERE country_id=? AND assignee_id=? AND todo_type='WORKFLOW_CC' AND status='OPEN'",a.requireCountry(),a.userId())){var match=REF.matcher(String.valueOf(row.get("dedup_key")));if(!match.matches()||Long.parseLong(match.group(3))!=a.userId())continue;try{String type=match.group(1);long id=Long.parseLong(match.group(2));docs.requireDocumentAccess(a,type,id,false);var item=DbRows.camel(row);item.put("typeLabel","审批抄送");item.put("docType",type);item.put("docId",id);item.put("link",link(type,id));out.add(item);}catch(ApiException e){if(!Set.of(401,403,404).contains(e.getStatus()))throw e;}}return out;}
    private String link(String type,long id){return switch(type){case "ORG_ENTITY","ENTITY"->"/settings/entities";case "ORG_STORE","STORE"->"/settings/stores";case "ORG_WAREHOUSE","WAREHOUSE"->"/settings/warehouses";case "FIN_BOOK","BOOK"->"/finance/books";case "PURCHASE_ORDER"->"/purchase/orders/"+id;case "SALES_ORDER","SAL_ORDER"->"/sales/orders/"+id;case "SHIPMENT"->"/logistics/shipments/"+id;default->"/workbench";};}
}
