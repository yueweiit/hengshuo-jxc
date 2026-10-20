package com.hs.jxc.sal;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.WorkItemProvider;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
@Component
public class SalesWorkItems implements WorkItemProvider {
 private final JdbcTemplate jdbc;public SalesWorkItems(JdbcTemplate jdbc){this.jdbc=jdbc;}
 public List<Map<String,Object>> items(Access a){var out=new ArrayList<Map<String,Object>>();if(a.has("sal:outbound:create"))for(var raw:jdbc.queryForList("SELECT o.*,al.warehouse_id FROM sal_order o JOIN sal_order_alloc al ON al.country_id=o.country_id AND al.order_id=o.id WHERE o.country_id=? AND o.approval_status='APPROVED' AND al.alloc_qty>al.cancelled_qty+al.outbound_qty GROUP BY o.id,al.warehouse_id ORDER BY o.id,al.warehouse_id",a.requireCountry())){var r=DbRows.camel(raw);if(a.canRow(r))out.add(Map.of("id",r.get("id"),"todoType","PENDING_OUTBOUND","typeLabel","销售待出库","title","销售待出库 "+r.get("docNo"),"link","/sales/orders/"+r.get("id"),"createdAt",r.get("createdAt").toString(),"warehouseId",r.get("warehouseId")));}if(a.has("sal:sign:record"))for(var raw:jdbc.queryForList("SELECT dl.id,ob.doc_no,ob.book_id,ob.warehouse_id,o.entity_id,o.store_id,si.signed_at created_at,ob.country_id FROM sal_sign_line dl JOIN sal_sign si ON si.country_id=dl.country_id AND si.id=dl.sign_id JOIN sal_outbound ob ON ob.country_id=si.country_id AND ob.id=si.outbound_id JOIN sal_order o ON o.country_id=ob.country_id AND o.id=ob.order_id WHERE dl.country_id=? AND dl.diff_status='OPEN' ORDER BY dl.id",a.requireCountry())){var r=DbRows.camel(raw);if(a.canRow(r))out.add(Map.of("id",r.get("id"),"todoType","SIGN_DIFF","typeLabel","签收差异待处理","title","签收差异待处理 "+r.get("docNo"),"link","/sales/signs","createdAt",r.get("createdAt").toString()));}return out;}
}
