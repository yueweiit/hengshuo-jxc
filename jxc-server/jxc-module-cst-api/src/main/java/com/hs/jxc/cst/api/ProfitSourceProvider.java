package com.hs.jxc.cst.api;

import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;
import java.time.*;
import java.util.*;

/** Module-owned immutable business facts. The caller owns the authorized consistent transaction.
 * Amount and quantity are signed sales effects; a cost reference is an additional, independent fact.
 * Implementations apply current row scope before returning a fact, including historical reversals.
 */
public interface ProfitSourceProvider {
    record Fact(String sourceType,long sourceId,long sourceLineId,String sourceNo,long productId,
                long warehouseId,LocalDate bizDate,BigDecimal netQty,BigDecimal originalSalesAmount,
                String currency,BigDecimal taxRate,String costSourceType,Long costSourceLineId,
                Long inboundBatchId,Long originalOutboundLineId) {}
    /** Only the sales module answers its frozen tax basis; absent or unauthorized references remain unknown. */
    default Map<Long,Boolean> outboundTaxBases(Access access,long bookId,Set<Long> lineIds,Instant knownAt){return Map.of();}
    List<Fact> profitFacts(Access access,long bookId,LocalDate from,LocalDate to,Instant knownAt);
}
