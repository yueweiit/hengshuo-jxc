package com.hs.jxc.fin.api;

import com.hs.jxc.sys.api.Access;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/** Owned by each business module: FIN never reads another module's business tables. */
public interface FinancialSourceProvider {
    boolean supports(String sourceType);
    /**
     * Re-authorize the real source and return {bookId,sourceNo,payload}. The event's
     * immutable sequence/date/payload identify a partial historical fact; a provider
     * must never replace it with a current cumulative total or guess missing facts.
     */
    Map<String,Object> accountingFact(Access access, String eventType, String sourceType,
            long sourceId, int eventSeq, LocalDate bizDate, Map<String,Object> frozenPayload);
    /** New interpretations only, after existing-result lookup, inside the original FIN effect transaction. */
    default void beforeInterpretation(Access access,String eventType,String sourceType,long sourceId,long eventId) {}
    /** Historical business balances as of the date, with source drilldown and explicit missing-data flags. */
    default List<Map<String,Object>> balances(Access access, long bookId, LocalDate asOf, String type) {
        return List.of();
    }
    /** Optional fixed posting precision explanation: {bookId,sourceAccountingAmount,details}. Never rebuilds facts. */
    default Map<String,Object> reconciliationPrecision(Access access,long bookId,LocalDate asOf,String type) {
        return Map.of();
    }

    /** Structural close blockers owned by the source module; never filtered to a partial book. */
    default List<Map<String,Object>> closingIssues(Access access,long bookId,LocalDate asOf) {
        return List.of();
    }
}
