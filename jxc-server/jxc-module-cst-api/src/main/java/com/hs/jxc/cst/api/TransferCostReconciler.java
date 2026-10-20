package com.hs.jxc.cst.api;
import com.hs.jxc.common.context.RequestContext;
import java.math.BigDecimal;
import java.time.LocalDate;
/** Carries post-dispatch valuation differences into receipt/loss facts without rewriting the dispatch snapshot. */
public interface TransferCostReconciler {
 BigDecimal receiveDifference(RequestContext context,long book,long warehouse,long product,long transferCostId,long batch,BigDecimal qty,LocalDate date);
 void lossDifference(RequestContext context,long book,long transferCostId,long cogsId,long batch,BigDecimal qty,LocalDate date);
}
