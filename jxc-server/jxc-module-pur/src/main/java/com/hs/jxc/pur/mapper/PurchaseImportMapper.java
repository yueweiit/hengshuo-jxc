package com.hs.jxc.pur.mapper;

import java.util.*;
import org.apache.ibatis.annotations.Param;

/** 采购PurchaseImportMapper：SQL主体位于同名资源XML，参数全部绑定。 */
public interface PurchaseImportMapper {
    List<Map<String,Object>> selectClearTasks(@Param("countryId") long country,@Param("batchId") UUID batch);
    List<Long> selectClearAssets(@Param("countryId") long country,@Param("batchId") UUID batch);
    int clearRows(@Param("countryId") long country,@Param("batchId") UUID batch);
    int clearProgress(@Param("countryId") long country,@Param("batchId") UUID batch);
    int clearTasks(@Param("countryId") long country,@Param("batchId") UUID batch);
    int clearGroups(@Param("countryId") long country,@Param("batchId") UUID batch);
    int clearImages(@Param("countryId") long country,@Param("batchId") UUID batch);
    int clearSources(@Param("countryId") long country,@Param("batchId") UUID batch);
    int clearBatch(@Param("countryId") long country,@Param("batchId") UUID batch);
    int redactClearedSnapshots(@Param("countryId") long country,@Param("userId") long user,@Param("batchId") String batch,@Param("endpoint") String endpoint);
    List<Map<String,Object>> selectClearReceipt(@Param("countryId") long country,@Param("userId") long user,@Param("endpoint") String endpoint);
    List<Map<String,Object>> selectPendingClearReceipts(@Param("countryId") long country,@Param("limit") int limit);
    List<Map<String,Object>> selectBatch(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("lock") boolean lock);
    List<Map<String,Object>> selectGroupHeaders(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Integer> countActiveBook(@Param("countryId") Object countryId, @Param("id") Object id);
    List<Integer> countEnabledSupplier(@Param("countryId") Object countryId, @Param("id") Object id);
    List<Integer> countEnabledCurrency(@Param("code") Object code);
    int insertBatch(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("header") Object header, @Param("createdBy") Object createdBy);
    List<Long> insertSource(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("attachmentId") Object attachmentId, @Param("fileName") Object fileName, @Param("fileSha256") Object fileSha256);
    List<Long> insertManualImageSource(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("attachmentId") Object attachmentId, @Param("fileName") Object fileName, @Param("fileSha256") Object fileSha256);
    int insertParseTask(@Param("id") Object id, @Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("sourceId") Object sourceId, @Param("inputRevision") Object inputRevision, @Param("inputHash") Object inputHash, @Param("requestedBy") Object requestedBy, @Param("authorizationBasis") Object authorizationBasis);
    int markBatchParsing(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Map<String,Object>> selectRows(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Map<String,Object>> selectGroups(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Map<String,Object>> selectSources(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Map<String,Object>> selectTasks(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Map<String,Object>> selectRowImages(@Param("countryId") Object countryId, @Param("rowId") Object rowId);
    List<Map<String,Object>> selectRowForUpdate(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("id") Object id);
    int updateRowValues(@Param("sourceOrderNo") Object sourceOrderNo, @Param("photo") Object photo, @Param("productSpec") Object productSpec, @Param("purchaseQty") Object purchaseQty, @Param("saleUnitPrice") Object saleUnitPrice, @Param("saleTotal") Object saleTotal, @Param("purchaseUnitPrice") Object purchaseUnitPrice, @Param("freight") Object freight, @Param("landedUnitCost") Object landedUnitCost, @Param("usdUnitCost") Object usdUnitCost, @Param("usdTotal") Object usdTotal, @Param("fieldOrigins") Object fieldOrigins, @Param("countryId") Object countryId, @Param("id") Object id);
    int updateMatchInputs(@Param("suppliedProductCode") Object suppliedProductCode, @Param("suppliedProductName") Object suppliedProductName, @Param("supplierProductCode") Object supplierProductCode, @Param("fieldOrigins") Object fieldOrigins, @Param("countryId") Object countryId, @Param("id") Object id);
    List<Integer> countCreatedRows(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Map<String,Object>> selectRowVersionsForUpdate(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    int updateBatchHeader(@Param("header") Object header, @Param("countryId") Object countryId, @Param("batchId") Object batchId);
    int updateRowsHeader(@Param("bookId") Object bookId, @Param("supplierId") Object supplierId, @Param("currency") Object currency, @Param("orderDate") Object orderDate, @Param("expectedDate") Object expectedDate, @Param("paymentTerms") Object paymentTerms, @Param("prepayRatio") Object prepayRatio, @Param("termDays") Object termDays, @Param("countryId") Object countryId, @Param("batchId") Object batchId);
    int updateInheritedGroupHeaders(@Param("effectiveHeader") Object effectiveHeader, @Param("countryId") Object countryId, @Param("batchId") Object batchId);
    int deleteRow(@Param("countryId") Object countryId, @Param("id") Object id);
    List<Integer> countUnresolvedBatchGroups(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Integer> countUnresolvedGroup(@Param("countryId") Object countryId, @Param("id") Object id);
    int invalidatePreviews(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    int incrementBatchVersion(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Map<String,Object>> selectAsset(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("assetId") Object assetId, @Param("image") boolean image);
    List<Integer> countPublishedImage(@Param("countryId") Object countryId, @Param("rowId") Object rowId, @Param("imageId") Object imageId);
    int updateImageAssociation(@Param("associationStatus") Object associationStatus, @Param("confirmedBy") Object confirmedBy, @Param("countryId") Object countryId, @Param("rowId") Object rowId, @Param("imageId") Object imageId);
    int incrementRowVersion(@Param("countryId") Object countryId, @Param("id") Object id);
    List<Integer> selectBatchVersion(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
}
