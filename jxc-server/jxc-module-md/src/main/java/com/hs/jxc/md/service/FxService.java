package com.hs.jxc.md.service;
import com.hs.jxc.md.api.FxApi;
import com.hs.jxc.common.api.Inputs;
import java.math.BigDecimal;
import java.time.LocalDate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;
@Service
public class FxService implements FxApi {
 private final JdbcTemplate jdbc;
 public FxService(JdbcTemplate jdbc){this.jdbc=jdbc;}
 public Rate resolve(long country,String from,String to,LocalDate date,String scope){
  if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("FX resolver requires caller transaction");
  if(from==null||to==null||!from.matches("[A-Z]{3}")||!to.matches("[A-Z]{3}")||date==null)throw Inputs.bad("币种或汇率日期不合法");
  if(from.equals(to))return new Rate(null,BigDecimal.ONE,date,0);
  var rows=jdbc.queryForList("SELECT id,rate,rate_date,version_no FROM md_exchange_rate WHERE country_id=? AND from_ccy=? AND to_ccy=? AND rate_date<=? AND scope IN (?,'ALL') AND status='CONFIRMED' ORDER BY rate_date DESC,version_no DESC,id DESC LIMIT 1",country,from,to,date,scope);
  if(rows.isEmpty())return null;var r=rows.getFirst();return new Rate(((Number)r.get("id")).longValue(),(BigDecimal)r.get("rate"),((java.sql.Date)r.get("rate_date")).toLocalDate(),((Number)r.get("version_no")).intValue());
 }
}
