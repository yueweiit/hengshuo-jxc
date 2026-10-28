package com.hs.jxc.pur.mapper;

import java.util.*;
import org.apache.ibatis.annotations.Param;

/** 采购PurchaseImportTraceMapper：SQL主体位于同名资源XML，参数全部绑定。 */
public interface PurchaseImportTraceMapper {
    List<Map<String,Object>> selectSourceEvidence(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("groupId") Object groupId);
    List<Map<String,Object>> selectTargetOrder(@Param("countryId") Object countryId, @Param("id") Object id, @Param("bookId") Object bookId);
    List<Map<String,Object>> selectTargetLines(@Param("countryId") Object countryId, @Param("orderId") Object orderId);
    List<Map<String,Object>> selectGroupForUpdate(@Param("countryId") Object countryId, @Param("batchId") Object batchId, @Param("id") Object id);
    int saveFeeTodos(@Param("feeTodos") Object feeTodos, @Param("countryId") Object countryId, @Param("id") Object id);
}
