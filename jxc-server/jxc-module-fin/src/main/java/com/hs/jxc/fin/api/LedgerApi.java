package com.hs.jxc.fin.api;

import com.hs.jxc.sys.api.Access;
import java.time.LocalDate;
import java.util.*;

/** Join the existing authorized transaction; only posted voucher lines are GL facts. */
public interface LedgerApi {
    Map<String,Object> createPending(Access access,long bookId,long sourceEventId,Long mappingTemplateId,Integer mappingVersion,LocalDate date,List<Map<String,Object>> lines);
    /** Configuration only: begins an exclusive book gate before validating the reference. */
    Map<String,Object> validateAccountReference(Access access,Long bookId,long accountId);
    void initializePeriod(Access access,long bookId,long periodId);
    int baseScale(Access access,long bookId);
    List<Map<String,Object>> validateLines(Access access,long bookId,List<Map<String,Object>> lines);
    List<Map<String,Object>> balances(Access access,long bookId,long periodId);
    List<Map<String,Object>> postedLines(Access access,long bookId,long periodId);
}
