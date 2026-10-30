package com.hs.jxc.pur.mapper;

import java.util.*;
import org.apache.ibatis.annotations.Param;

/** 采购PurchaseImportPhotoMapper：SQL主体位于同名资源XML，参数全部绑定。 */
public interface PurchaseImportPhotoMapper {
    List<Map<String,Object>> selectSourceImage(@Param("countryId") Object countryId, @Param("rowId") Object rowId, @Param("id") Object id, @Param("batchId") Object batchId);
    int savePublishedImage(@Param("productImageId") Object productImageId, @Param("publishProductId") Object publishProductId, @Param("countryId") Object countryId, @Param("rowId") Object rowId, @Param("imageId") Object imageId);
    int insertTask(@Param("id") Object id, @Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("sourceId") Object sourceId, @Param("kind") Object kind, @Param("inputRevision") Object inputRevision, @Param("inputHash") Object inputHash, @Param("requestedBy") Object requestedBy, @Param("authorizationBasis") Object authorizationBasis, @Param("inputData") Object inputData, @Param("phase") Object phase, @Param("result") Object result);
    List<Long> selectFirstSource(@Param("countryId") Object countryId, @Param("batchId") Object batchId);
    List<Integer> countConfirmedPublishedImage(@Param("countryId") Object countryId, @Param("rowId") Object rowId, @Param("imageId") Object imageId, @Param("productImageId") Object productImageId);
    int saveFeatureInput(@Param("inputData") Object inputData, @Param("countryId") Object countryId, @Param("id") Object id);
    int saveIndexInput(@Param("inputData") Object inputData, @Param("result") Object result, @Param("countryId") Object countryId, @Param("id") Object id);
}
