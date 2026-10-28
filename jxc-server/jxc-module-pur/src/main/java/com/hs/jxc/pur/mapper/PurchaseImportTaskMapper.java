package com.hs.jxc.pur.mapper;

import java.util.*;
import org.apache.ibatis.annotations.Param;

/** 采购PurchaseImportTaskMapper：SQL主体位于同名资源XML，参数全部绑定。 */
public interface PurchaseImportTaskMapper {
    List<Map<String,Object>> selectClaimableTask(@Param("countryId") Object countryId, @Param("id") Object id);
    List<Map<String,Object>> lockBatch(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Map<String,Object>> selectClaimableTaskForUpdate(@Param("countryId") Object countryId, @Param("id") Object id);
    int markNeedsReauth(@Param("errorCode") Object errorCode, @Param("errorMessage") Object errorMessage, @Param("countryId") Object countryId, @Param("id") Object id);
    int markStale(@Param("countryId") Object countryId, @Param("id") Object id);
    int claimTask(@Param("leaseOwner") Object leaseOwner, @Param("credentialHash") Object credentialHash, @Param("countryId") Object countryId, @Param("id") Object id);
    int markSourceParsing(@Param("countryId") Object countryId, @Param("id") Object id);
    List<Map<String,Object>> selectParseOptions(@Param("countryId") Object countryId, @Param("id") Object id);
    List<Long> insertImage(@Param("countryId") Object countryId, @Param("sourceId") Object sourceId, @Param("attachmentId") Object attachmentId, @Param("imageSha256") Object imageSha256, @Param("mediaPart") Object mediaPart, @Param("mimeType") Object mimeType, @Param("width") Object width, @Param("height") Object height);
    List<Long> insertSourceRow(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("rowNo") Object rowNo, @Param("bookId") Object bookId, @Param("supplierId") Object supplierId, @Param("currency") Object currency, @Param("orderDate") Object orderDate, @Param("expectedDate") Object expectedDate, @Param("paymentTerms") Object paymentTerms, @Param("prepayRatio") Object prepayRatio, @Param("termDays") Object termDays, @Param("sourceOrderNo") Object sourceOrderNo, @Param("photo") Object photo, @Param("productSpec") Object productSpec, @Param("purchaseQty") Object purchaseQty, @Param("saleUnitPrice") Object saleUnitPrice, @Param("saleTotal") Object saleTotal, @Param("purchaseUnitPrice") Object purchaseUnitPrice, @Param("freight") Object freight, @Param("landedUnitCost") Object landedUnitCost, @Param("usdUnitCost") Object usdUnitCost, @Param("usdTotal") Object usdTotal, @Param("createdBy") Object createdBy, @Param("sourceId") Object sourceId, @Param("sourceSheet") Object sourceSheet, @Param("sourceRow") Object sourceRow, @Param("originalValues") Object originalValues, @Param("formulaProvenance") Object formulaProvenance, @Param("fieldOrigins") Object fieldOrigins);
    int upsertRowImage(@Param("countryId") Object countryId, @Param("rowId") Object rowId, @Param("imageId") Object imageId, @Param("anchor") Object anchor);
    int completeSource(@Param("parserVersion") Object parserVersion, @Param("sheets") Object sheets, @Param("warnings") Object warnings, @Param("associations") Object associations, @Param("countryId") Object countryId, @Param("id") Object id);
    int completeBatch(@Param("nextRowNo") Object nextRowNo, @Param("countryId") Object countryId, @Param("batchId") Object batchId);
    int completeParseTask(@Param("result") Object result, @Param("countryId") Object countryId, @Param("id") Object id);
    int failOwnedTask(@Param("status") Object status, @Param("errorCode") Object errorCode, @Param("errorMessage") Object errorMessage, @Param("result") Object result, @Param("countryId") Object countryId, @Param("id") Object id, @Param("leaseOwner") Object leaseOwner);
    int failSource(@Param("status") Object status, @Param("errorCode") Object errorCode, @Param("errorMessage") Object errorMessage, @Param("countryId") Object countryId, @Param("id") Object id);
    int failBatch(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Map<String,Object>> selectActiveTaskForUpdate(@Param("countryId") Object countryId, @Param("id") Object id, @Param("leaseOwner") Object leaseOwner);
    int renewOwnedLease(@Param("countryId") Object countryId, @Param("id") Object id, @Param("leaseOwner") Object leaseOwner);
    List<Map<String,Object>> selectTask(@Param("countryId") Object countryId, @Param("id") Object id);
    List<Map<String,Object>> selectTaskForUpdate(@Param("countryId") Object countryId, @Param("id") Object id);
    int requeueTask(@Param("inputRevision") Object inputRevision, @Param("authorizationBasis") Object authorizationBasis, @Param("requestedBy") Object requestedBy, @Param("countryId") Object countryId, @Param("id") Object id);
    int requeueSource(@Param("parseOptions") Object parseOptions, @Param("countryId") Object countryId, @Param("id") Object id);
    int markBatchQueued(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<UUID> selectRecoverableIds(@Param("countryId") Object countryId, @Param("leaseUntil") Object leaseUntil);
    List<Map<String,Object>> selectUnexpiredTask(@Param("countryId") Object countryId, @Param("id") Object id);
    List<Boolean> selectLeaseValid(@Param("countryId") Object countryId, @Param("id") Object id);
    int renewCredentialLease(@Param("countryId") Object countryId, @Param("id") Object id, @Param("credentialHash") Object credentialHash);
    int completeTask(@Param("result") Object result, @Param("countryId") Object countryId, @Param("id") Object id);
}
