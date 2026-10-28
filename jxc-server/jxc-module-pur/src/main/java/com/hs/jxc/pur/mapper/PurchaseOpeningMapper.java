package com.hs.jxc.pur.mapper;

import java.util.*;
import org.apache.ibatis.annotations.Param;

/** 采购PurchaseOpeningMapper：SQL主体位于同名资源XML，参数全部绑定。 */
public interface PurchaseOpeningMapper {
    List<Long> selectBookEntities(@Param("countryId") Object countryId, @Param("id") Object id);
    List<Integer> countExistingReferences(@Param("countryId") Object countryId, @Param("openingRef") Object openingRef, @Param("docNo") Object docNo);
    List<Long> selectEnabledSuppliers(@Param("countryId") Object countryId, @Param("code") Object code);
    List<Long> selectEnabledProducts(@Param("productCode") Object productCode);
    List<Long> selectImportRowId(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("rowNo") Object rowNo);
}
