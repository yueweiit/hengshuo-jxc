package com.hs.jxc.cst.api;
import com.hs.jxc.common.context.RequestContext;
/** Transfers an already allocated sold-cost difference to returned inventory in the caller transaction. */
public interface ReturnCostReconciler { void reconcileReturn(RequestContext context,long inboundCostId); }
