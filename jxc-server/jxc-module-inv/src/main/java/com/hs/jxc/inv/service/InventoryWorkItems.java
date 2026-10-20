package com.hs.jxc.inv.service;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.WorkItemProvider;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
@Component
public class InventoryWorkItems implements WorkItemProvider {
 private final JdbcTemplate jdbc;public InventoryWorkItems(JdbcTemplate jdbc){this.jdbc=jdbc;}
 public List<Map<String,Object>> items(Access a){var out=new ArrayList<Map<String,Object>>();if(a.has("inv:transfer:receive"))for(var raw:jdbc.queryForList("SELECT t.*,t.to_warehouse_id warehouse_id FROM inv_transfer t WHERE t.country_id=? AND t.status IN ('IN_TRANSIT','PARTIAL_RECEIVED') ORDER BY t.id",a.requireCountry())){var r=DbRows.camel(raw);if(a.scope().all()||a.scope().warehouses().contains(((Number)r.get("warehouseId")).longValue()))out.add(item(r,"PENDING_RECEIPT","调拨待实收","/inventory/transfers"));}if(a.has("inv:stock:view"))for(var raw:jdbc.queryForList("SELECT * FROM inv_stock_alert WHERE country_id=? AND status='OPEN' ORDER BY id",a.requireCountry())){var r=DbRows.camel(raw);if(a.canRow(r))out.add(item(r,"STOCK_ALERT","库存预警","/inventory/alerts"));}if(a.has("inv:replenish:decide"))for(var raw:jdbc.queryForList("SELECT * FROM inv_replenish WHERE country_id=? AND status='PENDING' ORDER BY id",a.requireCountry())){var r=DbRows.camel(raw);if(a.canRow(r))out.add(item(r,"REPLENISH","补货待处理","/inventory/replenishments"));}return out;}
 private Map<String,Object> item(Map<String,Object>r,String type,String label,String link){return Map.of("id",r.get("id"),"todoType",type,"typeLabel",label,"title",label+" "+Objects.toString(r.get("docNo"),""),"link",link,"createdAt",Objects.toString(r.get("createdAt"),Objects.toString(r.get("firstTriggeredAt"),"")));}
}
