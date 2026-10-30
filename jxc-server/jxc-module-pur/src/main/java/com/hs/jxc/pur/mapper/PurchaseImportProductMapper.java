package com.hs.jxc.pur.mapper;

import java.util.*;
import org.apache.ibatis.annotations.Param;

/** 采购PurchaseImportProductMapper：SQL主体位于同名资源XML，参数全部绑定。 */
public interface PurchaseImportProductMapper {
    int resetDecision(@Param("decision") Object decision, @Param("countryId") Object countryId, @Param("id") Object id);
    List<Map<String,Object>> selectTaskResult(@Param("countryId") Object countryId, @Param("id") Object id);
    int saveDecision(@Param("matchedProductId") Object matchedProductId, @Param("purchaseUnit") Object purchaseUnit, @Param("decision") Object decision, @Param("readiness") Object readiness, @Param("productSnapshot") Object productSnapshot, @Param("setupReasons") Object setupReasons, @Param("confirmedBy") Object confirmedBy, @Param("confirmedAt") Object confirmedAt, @Param("countryId") Object countryId, @Param("id") Object id);
    List<Integer> countProductCode(@Param("code") Object code);
    List<Integer> countRequestedCode(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("rowId") Object rowId, @Param("code") Object code);
    int saveCreatedProduct(@Param("matchedProductId") Object matchedProductId, @Param("purchaseUnit") Object purchaseUnit, @Param("suppliedProductCode") Object suppliedProductCode, @Param("suppliedProductName") Object suppliedProductName, @Param("productSnapshot") Object productSnapshot, @Param("productOperation") Object productOperation, @Param("countryId") Object countryId, @Param("id") Object id);
    int saveProductOperation(@Param("productOperation") Object productOperation, @Param("countryId") Object countryId, @Param("id") Object id);
}
