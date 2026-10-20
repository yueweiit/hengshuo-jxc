package com.hs.jxc.cst.api;
import com.hs.jxc.common.context.RequestContext;
/** Called by the original logistics fee confirmation, inside the existing transaction. */
public interface FeeCostReconciler { void prepareFee(RequestContext context,long bookId); void reconcileFee(RequestContext context,long feeId); }
