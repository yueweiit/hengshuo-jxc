package com.hs.jxc.pur.mapper;

import java.util.*;
import org.apache.ibatis.annotations.Param;

/** 采购PurchaseImportDraftMapper：SQL主体位于同名资源XML，参数全部绑定。 */
public interface PurchaseImportDraftMapper {
    List<Map<String,Object>> selectGroup(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("id") Object id, @Param("lock") boolean lock);
    List<Map<String,Object>> selectSourceRows(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("groupId") Object groupId);
    List<Map<String,Object>> selectRowsWithGroups(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Map<String,Object>> selectGroupByKey(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("groupKey") Object groupKey);
    List<Long> insertGroup(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("groupKey") Object groupKey, @Param("sourceOrderNo") Object sourceOrderNo, @Param("effectiveHeader") Object effectiveHeader, @Param("createKey") Object createKey);
    int assignRowGroup(@Param("groupId") Object groupId, @Param("countryId") Object countryId, @Param("id") Object id);
    List<Map<String,Object>> selectGroupsForUpdate(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    int savePreview(@Param("previewSnapshot") Object previewSnapshot, @Param("previewHash") Object previewHash, @Param("previewToken") Object previewToken, @Param("createStatus") Object createStatus, @Param("countryId") Object countryId, @Param("id") Object id);
    List<Long> insertOverrideGroup(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("groupKey") Object groupKey, @Param("sourceOrderNo") Object sourceOrderNo, @Param("effectiveHeader") Object effectiveHeader, @Param("createKey") Object createKey);
    int invalidateGroupPreview(@Param("countryId") Object countryId, @Param("id") Object id);
    int updateGroupHeader(@Param("effectiveHeader") Object effectiveHeader, @Param("countryId") Object countryId, @Param("id") Object id);
    int markCreating(@Param("outerKey") Object outerKey, @Param("requestHash") Object requestHash, @Param("createRequest") Object createRequest, @Param("countryId") Object countryId, @Param("id") Object id);
    int assignOrderLine(@Param("targetOrderLineId") Object targetOrderLineId, @Param("countryId") Object countryId, @Param("id") Object id);
    int markCreated(@Param("targetOrderId") Object targetOrderId, @Param("resultSnapshot") Object resultSnapshot, @Param("countryId") Object countryId, @Param("id") Object id);
    int saveVerification(@Param("verifyStatus") Object verifyStatus, @Param("errorCode") Object errorCode, @Param("errorMessage") Object errorMessage, @Param("countryId") Object countryId, @Param("id") Object id);
    int saveCreationFailure(@Param("createStatus") Object createStatus, @Param("outerKey") Object outerKey, @Param("requestHash") Object requestHash, @Param("createRequest") Object createRequest, @Param("errorCode") Object errorCode, @Param("errorMessage") Object errorMessage, @Param("countryId") Object countryId, @Param("id") Object id);
}
