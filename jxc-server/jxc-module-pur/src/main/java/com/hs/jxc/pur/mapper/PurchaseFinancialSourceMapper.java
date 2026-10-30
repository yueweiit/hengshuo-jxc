package com.hs.jxc.pur.mapper;

import java.util.*;
import org.apache.ibatis.annotations.Param;

/** 采购PurchaseFinancialSourceMapper：SQL主体位于同名资源XML，参数全部绑定。 */
public interface PurchaseFinancialSourceMapper {
    List<Map<String,Object>> selectAccountingDocument(@Param("countryId") Object countryId, @Param("id") Object id, @Param("table") String table);
}
