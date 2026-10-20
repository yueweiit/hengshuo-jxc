package com.hs.jxc.fin.api;

import com.hs.jxc.sys.api.Access;
import java.util.Map;

/** Caller owns the authorized transaction and book gate, including an exclusive closing gate. */
public interface ReportApi {
    /** Unmasked immutable-input facts for closing: {balance,income,cashflow}. Never starts a transaction. */
    Map<String,Object> snapshot(Access access,long bookId,long periodId);
}
