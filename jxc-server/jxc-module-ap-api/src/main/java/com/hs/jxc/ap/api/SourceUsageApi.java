package com.hs.jxc.ap.api;

import com.hs.jxc.sys.api.Access;

/**
 * AP owns source usage. Callers must join an authorized transaction and hold the
 * same purchase source row lock used by SupplyApi.lockPayableSource before checking.
 * Historical order economics stay stable after release; receipt void only needs
 * to wait for effective claims to be released by bill void.
 */
public interface SourceUsageApi {
    void requireNoPurchaseOrderHistory(Access access,long orderLineId);
    void requireNoEffectiveReceiptClaims(Access access,long receiptLineId);
}
