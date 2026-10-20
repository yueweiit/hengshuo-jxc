package com.hs.jxc.rtn;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.WorkItemProvider;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
@Component
public class ReturnWorkItems implements WorkItemProvider {
 private final JdbcTemplate jdbc;public ReturnWorkItems(JdbcTemplate jdbc){this.jdbc=jdbc;}
 public List<Map<String,Object>> items(Access a){var out=new ArrayList<Map<String,Object>>();for(var raw:jdbc.queryForList("SELECT r.*,r.return_warehouse_id warehouse_id FROM rtn_sales_return r WHERE r.country_id=? AND r.status IN ('PENDING_RECEIPT','PENDING_INSPECT','PENDING_SETTLE') ORDER BY r.id",a.requireCountry())){var r=DbRows.camel(raw);String status=r.get("status").toString(),permission=status.equals("PENDING_SETTLE")?"rtn:sales:settle":status.equals("PENDING_INSPECT")?"rtn:sales:inspect":"rtn:sales:receive";if(!a.has(permission)||!a.canRow(r))continue;String label=switch(status){case "PENDING_RECEIPT"->"退货待收货";case "PENDING_INSPECT"->"退货待质检";default->"退货待结算";};out.add(Map.of("id",r.get("id"),"todoType","RETURN_STEP","typeLabel",label,"title",label+" "+r.get("docNo"),"link","/returns/sales","createdAt",r.get("createdAt").toString()));}return out;}
}
