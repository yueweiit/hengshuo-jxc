package com.hs.jxc.pur.mapper;

import java.util.*;
import org.apache.ibatis.annotations.Param;

/** 采购PurchaseWorkItemMapper：SQL主体位于同名资源XML，参数全部绑定。 */
public interface PurchaseWorkItemMapper {
    List<Map<String,Object>> selectPendingReceipts(@Param("countryId") Object countryId);
}
