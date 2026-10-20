package com.hs.jxc.md;

import com.hs.jxc.common.api.*;
import com.hs.jxc.sys.api.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Only configuration structure crosses countries. Business partners, people and bank data are absent. */
@Component
public class MasterTemplateContributor implements TemplateStructureContributor {
 private final JdbcTemplate db;private final JsonCodec json;
 public MasterTemplateContributor(JdbcTemplate db,JsonCodec json){this.db=db;this.json=json;}
 public String key(){return "master-structure";}public String itemType(){return "MASTER";}public String label(){return "经营SKU、业务字典与费用项目";}public boolean requiresReview(){return true;}public int order(){return 20;}
 public Map<String,Object> snapshot(Access a){
  var out=new LinkedHashMap<String,Object>();
  out.put("skus",db.queryForList("SELECT p.product_code,s.local_name,s.tax_category FROM md_country_sku s JOIN md_product p ON p.id=s.product_id WHERE s.country_id=? AND s.status='ENABLED' ORDER BY p.product_code",a.requireCountry()));
  out.put("dictionaries",db.queryForList("SELECT dict_type,code,label_i18n,seq,status FROM md_dict WHERE country_id=? ORDER BY dict_type,code",a.requireCountry()).stream().map(r->{var c=new LinkedHashMap<>(r);c.put("label_i18n",json.readMap(r.get("label_i18n").toString()));return c;}).toList());
  out.put("expenseItems",db.queryForList("SELECT e.code,e.name,e.cost_treatment,e.fee_category,e.status,a.code AS account_code FROM md_expense_item e LEFT JOIN fin_account a ON a.country_id=e.country_id AND a.id=e.account_id WHERE e.country_id=? ORDER BY e.code",a.requireCountry()));return out;
 }
 public void apply(Access a,Map<String,Object> payload,long item){
  for(var r:rows(payload,"skus")){var matches=db.queryForList("SELECT id FROM md_product WHERE product_code=?",Long.class,Inputs.required(r,"product_code"));if(matches.size()!=1)throw Inputs.bad("模板全局商品引用不存在");db.update("INSERT INTO md_country_sku(country_id,product_id,local_name,tax_category,status) VALUES(?,?,?,?,'DISABLED') ON CONFLICT(country_id,product_id) DO NOTHING",a.requireCountry(),matches.getFirst(),r.get("local_name"),r.get("tax_category"));}
  for(var r:rows(payload,"dictionaries"))db.update("INSERT INTO md_dict(country_id,dict_type,code,label_i18n,seq,status) VALUES(?,?,?,?::jsonb,?,?) ON CONFLICT(country_id,dict_type,code) DO NOTHING",a.requireCountry(),r.get("dict_type"),r.get("code"),json.write(r.get("label_i18n")),r.get("seq"),r.get("status"));
  for(var r:rows(payload,"expenseItems")){Long account=null;if(r.get("account_code")!=null){var matches=db.queryForList("SELECT a.id FROM fin_account a JOIN fin_book b ON b.country_id=a.country_id AND b.id=a.book_id WHERE a.country_id=? AND a.code=? AND b.status='ACTIVE'",Long.class,a.requireCountry(),r.get("account_code"));if(matches.size()!=1)throw new ApiException(409,"SYS_CONFIG_MISSING","费用项目科目必须在目标国唯一账套内重新匹配");account=matches.getFirst();}db.update("INSERT INTO md_expense_item(country_id,code,name,cost_treatment,fee_category,account_id,status,created_by) VALUES(?,?,?,?,?,?,'DISABLED',?) ON CONFLICT(country_id,code) DO NOTHING",a.requireCountry(),r.get("code"),r.get("name"),r.get("cost_treatment"),r.get("fee_category"),account,a.userId());}
 }
 public boolean ready(Access a,long item){
  var reviews=db.queryForList("SELECT payload FROM sys_country_config_review WHERE country_id=? AND source_template_item_id=? AND item_key=?",a.requireCountry(),item,key());if(reviews.isEmpty())return false;var payload=json.readMap(reviews.getFirst().get("payload").toString());
  for(var r:rows(payload,"skus"))if(db.queryForObject("SELECT count(*) FROM md_country_sku s JOIN md_product p ON p.id=s.product_id WHERE s.country_id=? AND p.product_code=? AND s.version>1",Integer.class,a.requireCountry(),r.get("product_code"))!=1)return false;
  for(var r:rows(payload,"expenseItems"))if(db.queryForObject("SELECT count(*) FROM md_expense_item WHERE country_id=? AND code=? AND version>1",Integer.class,a.requireCountry(),r.get("code"))!=1)return false;return true;
 }
 public void confirm(Access a,long item,String comment){if(!ready(a,item))throw new ApiException(409,"SYS_CONFIG_MISSING","请在原经营SKU和费用项目页面逐项复核本地名称、税类、成本处理及科目，再确认国家配置");}
 @SuppressWarnings("unchecked") private List<Map<String,Object>> rows(Map<String,Object> payload,String key){Object value=payload.get(key);if(!(value instanceof List<?> list)||list.stream().anyMatch(v->!(v instanceof Map<?,?>)))throw Inputs.bad("主档配置结构不完整");return (List<Map<String,Object>>)(List<?>)list;}
}
