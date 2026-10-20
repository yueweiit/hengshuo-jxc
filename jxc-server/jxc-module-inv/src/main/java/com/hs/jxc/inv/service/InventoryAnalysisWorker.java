package com.hs.jxc.inv.service;
import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.common.db.DbContext;
import com.hs.jxc.event.TransactionalEventConsumer;
import com.hs.jxc.sys.api.*;
import com.hs.jxc.sys.jobs.CountryWorkProvider;
import com.hs.jxc.sys.service.AuthorizationService;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
@Component
public class InventoryAnalysisWorker implements CountryWorkProvider {
 private final com.hs.jxc.sys.service.CountryCalendar calendar;private final JdbcTemplate jdbc;private final DbContext db;private final AuthorizationService auth;private final InventoryClassification analysis;private final TransactionalEventConsumer consumer;private final TransactionTemplate tx;
 public InventoryAnalysisWorker(com.hs.jxc.sys.service.CountryCalendar calendar,JdbcTemplate jdbc,DbContext db,AuthorizationService auth,InventoryClassification analysis,TransactionalEventConsumer consumer,PlatformTransactionManager tm){this.calendar=calendar;this.jdbc=jdbc;this.db=db;this.auth=auth;this.analysis=analysis;this.consumer=consumer;this.tx=new TransactionTemplate(tm);}
 public String kind(){return "INV_ANALYSIS";}
 private void gates(long country){db.apply(null);auth.gate(0,false);db.apply(country);auth.gate(country,false);}

 public int recover(long country,int limit){var ids=tx.execute(s->{gates(country);if(!"ACTIVE".equals(jdbc.queryForObject("SELECT status FROM sys_country WHERE id=?",String.class,country)))return java.util.List.<Long>of();return jdbc.queryForList("SELECT e.id FROM sys_biz_event e LEFT JOIN sys_biz_event_consume c ON c.country_id=e.country_id AND c.event_id=e.id AND c.consumer='INV_ANALYSIS' WHERE e.country_id=? AND e.event_type IN ('INV_STOCK_CHANGED','SAL_ORDER_APPROVED','SAL_ORDER_QTY_CHANGED') AND (c.id IS NULL OR c.status='FAILED' AND c.attempt_count<5 OR c.status='PROCESSING' AND c.updated_at<clock_timestamp()-interval '30 seconds') ORDER BY e.id LIMIT ?",Long.class,country,Math.max(1,Math.min(100,limit)));});for(long id:ids)consumer.run(country,id,"INV_ANALYSIS",e->{if("INV_STOCK_CHANGED".equals(e.get("eventType"))&&e.get("payload") instanceof Map<?,?> payload){StockAlertEvaluator.evaluate(jdbc,country,((Number)payload.get("warehouseId")).longValue(),((Number)payload.get("productId")).longValue());}analysis.projectCountry(country,e.get("eventType").equals("INV_STOCK_CHANGED")?"STOCK":"ORDER",String.valueOf(id));});return ids.size();}
 public void daily(long country){tx.execute(s->{gates(country);if(!"ACTIVE".equals(jdbc.queryForObject("SELECT status FROM sys_country WHERE id=?",String.class,country)))return null;for(var row:jdbc.queryForList("SELECT warehouse_id,product_id FROM inv_stock_limit WHERE country_id=? ORDER BY warehouse_id,product_id",country))StockAlertEvaluator.evaluate(jdbc,country,((Number)row.get("warehouse_id")).longValue(),((Number)row.get("product_id")).longValue());analysis.projectCountry(country,"DAILY",calendar.today(country).toString());return null;});}
}
