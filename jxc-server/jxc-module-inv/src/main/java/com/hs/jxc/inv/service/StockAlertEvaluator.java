package com.hs.jxc.inv.service;
import java.math.BigDecimal;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
/** One evaluator reused by limit commands and durable stock event consumption. */
final class StockAlertEvaluator {
 static void evaluate(JdbcTemplate jdbc,long country,long wh,long product){
  if(!"ACTIVE".equals(jdbc.queryForObject("SELECT status FROM sys_country WHERE id=?",String.class,country)))return;
  var rules=jdbc.queryForList("SELECT min_qty,max_qty,alert_enabled FROM inv_stock_limit WHERE country_id=? AND warehouse_id=? AND product_id=? FOR UPDATE",country,wh,product);if(rules.isEmpty())return;var rule=rules.getFirst();
  var available=jdbc.queryForObject("SELECT coalesce((SELECT on_hand_qty-reserved_qty-frozen_qty FROM inv_stock_summary WHERE country_id=? AND warehouse_id=? AND product_id=?),0)",BigDecimal.class,country,wh,product);
  for(String type:List.of("OUT_OF_STOCK","BELOW_MIN","ABOVE_MAX")){BigDecimal threshold=type.equals("OUT_OF_STOCK")?BigDecimal.ZERO:(BigDecimal)rule.get(type.equals("BELOW_MIN")?"min_qty":"max_qty");boolean active=Boolean.TRUE.equals(rule.get("alert_enabled"))&&(type.equals("OUT_OF_STOCK")?available.signum()==0:threshold!=null&&(type.equals("BELOW_MIN")?available.compareTo(threshold)<0:available.compareTo(threshold)>0));
   if(active)jdbc.update("INSERT INTO inv_stock_alert(country_id,warehouse_id,product_id,alert_type,available_qty,threshold) VALUES(?,?,?,?,?,?) ON CONFLICT(country_id,warehouse_id,product_id,alert_type) WHERE status='OPEN' DO UPDATE SET available_qty=excluded.available_qty,threshold=excluded.threshold,last_evaluated_at=clock_timestamp()",country,wh,product,type,available,threshold);
   else jdbc.update("UPDATE inv_stock_alert SET status='CLOSED',closed_at=clock_timestamp(),last_evaluated_at=clock_timestamp() WHERE country_id=? AND warehouse_id=? AND product_id=? AND alert_type=? AND status='OPEN'",country,wh,product,type);
  }
 }
}
