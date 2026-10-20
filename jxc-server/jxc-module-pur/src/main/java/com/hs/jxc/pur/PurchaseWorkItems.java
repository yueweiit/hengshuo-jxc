package com.hs.jxc.pur;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.WorkItemProvider;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
@Component
public class PurchaseWorkItems implements WorkItemProvider {
 private final JdbcTemplate jdbc;public PurchaseWorkItems(JdbcTemplate jdbc){this.jdbc=jdbc;}
 public List<Map<String,Object>> items(Access a){if(!a.has("pur:receipt:create"))return List.of();var out=new ArrayList<Map<String,Object>>();for(var raw:jdbc.queryForList("SELECT o.* FROM pur_order o WHERE o.country_id=? AND o.status IN ('CONFIRMED','PARTIAL_DELIVERED') AND EXISTS(SELECT 1 FROM pur_order_line l WHERE l.country_id=o.country_id AND l.order_id=o.id AND l.base_qty>l.cancelled_qty+l.qualified_qty+l.pending_inspect_qty+l.opening_shipped_qty) ORDER BY o.id",a.requireCountry())){var r=DbRows.camel(raw);if(a.canRow(r))out.add(Map.of("id",r.get("id"),"todoType","PUR_RECEIPT","typeLabel","采购待收货","title","采购待收货 "+r.get("docNo"),"link","/purchase/orders/"+r.get("id"),"createdAt",r.get("createdAt").toString()));}return out;}
}
