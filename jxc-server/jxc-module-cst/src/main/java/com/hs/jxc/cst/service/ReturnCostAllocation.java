package com.hs.jxc.cst.service;

import com.hs.jxc.common.api.ApiException;
import java.math.*;
import org.springframework.jdbc.core.JdbcTemplate;

/** One cumulative allocation for immediate returns and later source-cost completion. Caller holds the book valuation lock. */
final class ReturnCostAllocation {
 private ReturnCostAllocation(){}
 static BigDecimal amount(JdbcTemplate jdbc,long country,long original,BigDecimal totalAmount,BigDecimal totalQty,BigDecimal qty,Long beforeCost){
  BigDecimal previous=jdbc.queryForObject("SELECT coalesce(sum(qty),0) FROM cst_inbound_cost WHERE country_id=? AND original_cogs_id=?"+(beforeCost==null?"":" AND id<?"),BigDecimal.class,beforeCost==null?new Object[]{country,original}:new Object[]{country,original,beforeCost});
  BigDecimal cumulative=previous.add(qty);if(cumulative.compareTo(totalQty)>0)throw new ApiException(409,"CST_RETURN_EXCEEDED","退回成本数量超过原出库数量");
  return totalAmount.multiply(cumulative).divide(totalQty,4,RoundingMode.HALF_UP).subtract(totalAmount.multiply(previous).divide(totalQty,4,RoundingMode.HALF_UP));
 }
}
