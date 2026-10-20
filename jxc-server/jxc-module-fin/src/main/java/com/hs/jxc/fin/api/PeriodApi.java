package com.hs.jxc.fin.api;

import java.time.LocalDate;

/** Joins the caller's authorized transaction. All participants use the same book gate. */
public interface PeriodApi {
    void assertOpen(long countryId,long bookId,LocalDate date);
    /** Opening confirmation targets the first period after cutoff; implementations still validate book and period. */
    default void assertOpeningPeriod(long countryId,long bookId,LocalDate date){assertOpen(countryId,bookId,date);}
    /** A sealed native opening import keeps its cutoff fact date while validating the first writable period. */
    default void assertOpeningCutoff(long countryId,long bookId,LocalDate cutoff){assertOpen(countryId,bookId,cutoff);}
    /** Existing native opening drafts may continue only with the owner's persisted import-source proof. */
    default void assertImportedOpeningCutoff(long countryId,long bookId,LocalDate cutoff,String targetType,long targetId){assertOpen(countryId,bookId,cutoff);}
    void lockExclusive(long countryId,long bookId);
}
