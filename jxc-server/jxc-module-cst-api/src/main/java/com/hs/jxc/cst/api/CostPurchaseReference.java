package com.hs.jxc.cst.api;

import com.hs.jxc.sys.api.Access;
import java.util.Map;

/** Minimal authorized immutable purchase-cost identity, excluding later valuation adjustments. */
public interface CostPurchaseReference {
    Map<String,Object> purchaseReference(Access access,long costId);
}
