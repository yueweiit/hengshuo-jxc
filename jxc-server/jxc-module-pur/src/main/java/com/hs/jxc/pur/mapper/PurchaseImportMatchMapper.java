package com.hs.jxc.pur.mapper;

import java.util.*;
import org.apache.ibatis.annotations.Param;

/** 采购PurchaseImportMatchMapper：SQL主体位于同名资源XML，参数全部绑定。 */
public interface PurchaseImportMatchMapper {
    List<Map<String,Object>> selectTask(@Param("countryId") Object countryId, @Param("id") Object id, @Param("lock") boolean lock);
    int assignMatchTask(@Param("matchTaskId") Object matchTaskId, @Param("countryId") Object countryId, @Param("id") Object id);
    int insertTask(@Param("id") Object id, @Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("sourceId") Object sourceId, @Param("kind") Object kind, @Param("inputRevision") Object inputRevision, @Param("inputHash") Object inputHash, @Param("requestedBy") Object requestedBy, @Param("authorizationBasis") Object authorizationBasis, @Param("inputData") Object inputData, @Param("result") Object result);
    int saveTextResult(@Param("result") Object result, @Param("countryId") Object countryId, @Param("id") Object id);
    List<Map<String,Object>> selectMatchingImages(@Param("countryId") Object countryId, @Param("rowId") Object rowId, @Param("batchId") Object batchId);
    int saveInput(@Param("inputData") Object inputData, @Param("countryId") Object countryId, @Param("id") Object id);
    int saveEvidence(@Param("result") Object result, @Param("countryId") Object countryId, @Param("id") Object id);
    int markInputStale(@Param("errorMessage") Object errorMessage, @Param("countryId") Object countryId, @Param("id") Object id);
    int insertCandidate(@Param("countryId") Object countryId, @Param("rowId") Object rowId, @Param("runId") Object runId, @Param("productId") Object productId, @Param("evidence") Object evidence);
    int saveMatchResult(@Param("matchResult") Object matchResult, @Param("countryId") Object countryId, @Param("id") Object id);
    int completeCallback(@Param("status") Object status, @Param("result") Object result, @Param("callbackHash") Object callbackHash, @Param("errorCode") Object errorCode, @Param("errorMessage") Object errorMessage, @Param("countryId") Object countryId, @Param("id") Object id);
}
