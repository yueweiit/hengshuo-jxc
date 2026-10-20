package com.hs.jxc.ap;

import com.hs.jxc.ap.api.SourceUsageApi;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.sys.api.Access;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Uses AP's append-only claim provenance, shared with the database source guards. */
@Component
public class SourceUsageService implements SourceUsageApi {
    private final JdbcTemplate db;
    public SourceUsageService(JdbcTemplate db) { this.db=db; }

    @Override public void requireNoPurchaseOrderHistory(Access access,long orderLineId) {
        requireTransaction();
        if(Boolean.TRUE.equals(db.queryForObject("SELECT jxc_ap_purchase_order_has_history(?,?)",Boolean.class,access.requireCountry(),orderLineId)))
            throw new ApiException(409,"PUR_SOURCE_IN_USE","采购来源已有应付历史，不能重建原始明细；请取消未履行部分或另建采购单");
    }

    @Override public void requireNoEffectiveReceiptClaims(Access access,long receiptLineId) {
        requireTransaction();
        if(Boolean.TRUE.equals(db.queryForObject("SELECT jxc_ap_receipt_has_effective_claims(?,?)",Boolean.class,access.requireCountry(),receiptLineId)))
            throw new ApiException(409,"PUR_SOURCE_IN_USE","收货来源已被应付账单占用，请先作废未核销账单再作废收货");
    }

    private static void requireTransaction() {
        if(!TransactionSynchronizationManager.isActualTransactionActive())
            throw new IllegalStateException("Source usage checks require the authorized caller transaction and purchase source lock");
    }
}
