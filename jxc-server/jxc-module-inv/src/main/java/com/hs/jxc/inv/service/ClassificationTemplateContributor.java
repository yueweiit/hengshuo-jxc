package com.hs.jxc.inv.service;
import com.hs.jxc.common.api.*;
import com.hs.jxc.sys.api.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
/** Template copies configuration structure only. Thresholds and local scope require target review. */
@Component
public class ClassificationTemplateContributor implements TemplateStructureContributor {
 private final JdbcTemplate jdbc;private final JsonCodec json;private final InventoryClassification classification;
 public ClassificationTemplateContributor(JdbcTemplate jdbc,JsonCodec json,InventoryClassification classification){this.jdbc=jdbc;this.json=json;this.classification=classification;}
 public String key(){return "INVENTORY_CLASSIFICATION";}public String itemType(){return "INV_CLASSIFY";}public String label(){return "库存与订单联合分类规则";}public boolean requiresReview(){return true;}
 public Map<String,Object> snapshot(Access a){return Map.of("rules",jdbc.queryForList("SELECT name,dim_type,period_type,period_days,order_metric,stock_metric,conditions FROM inv_classify_rule WHERE country_id=? AND status='ACTIVE' ORDER BY id",a.requireCountry()).stream().map(r->{var copy=new LinkedHashMap<>(r);copy.put("conditions",json.readMap("{\"items\":"+r.get("conditions")+"}").get("items"));return copy;}).toList());}
 @SuppressWarnings("unchecked") public void apply(Access a,Map<String,Object> payload,long item){if(!(payload.get("rules") instanceof List<?> rules))throw Inputs.bad("分类规则模板不完整");for(Object raw:rules){var r=(Map<String,Object>)raw;classification.validateConditions(r.get("conditions"));jdbc.update("INSERT INTO inv_classify_rule(country_id,name,dim_type,period_type,period_days,order_metric,stock_metric,status,conditions,created_by,source_template_item_id) VALUES(?,?,?,?,?,?,?,'NEED_REVIEW',?::jsonb,?,?)",a.requireCountry(),r.get("name"),r.get("dim_type"),r.get("period_type"),r.get("period_days"),r.get("order_metric"),r.get("stock_metric"),json.write(r.get("conditions")),a.userId(),item);}}
 public boolean ready(Access a,long source){return jdbc.queryForObject("SELECT count(*) FROM inv_classify_rule WHERE country_id=? AND status='NEED_REVIEW' AND source_template_item_id=?",Integer.class,a.requireCountry(),source)==0;}
 public void confirm(Access a,long source,String comment){if(comment==null||comment.isBlank())throw Inputs.bad("请说明本国规则阈值核对结果");for(var r:jdbc.queryForList("SELECT conditions FROM inv_classify_rule WHERE country_id=? AND status='NEED_REVIEW' AND source_template_item_id=? FOR UPDATE",a.requireCountry(),source))classification.validateConditions(json.readMap("{\"items\":"+r.get("conditions")+"}").get("items"));jdbc.update("UPDATE inv_classify_rule SET status='ACTIVE' WHERE country_id=? AND status='NEED_REVIEW' AND source_template_item_id=?",a.requireCountry(),source);}
}
