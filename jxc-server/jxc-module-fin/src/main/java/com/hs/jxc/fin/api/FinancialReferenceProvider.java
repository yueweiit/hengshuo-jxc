package com.hs.jxc.fin.api;

import com.hs.jxc.sys.api.Access;
import java.util.Map;

/** Domain-owned financial references. Call only inside the authorized accounting transaction. */
public interface FinancialReferenceProvider {
    boolean supports(String type);
    Map<String,Object> validate(Access access,long bookId,String type,long id);
    /** FUND_ACCOUNT / EXPENSE_ITEM mappings; category mappings remain owned by FIN. */
    default Long accountId(Access access,long bookId,String rule,long referenceId) { return null; }
}
