package com.hs.jxc.pur.service;

import java.util.*;
import com.hs.jxc.common.context.RequestContext;

/** 采购业务入口；原有校验和事务由唯一实现负责。 */
public interface PurchaseImportTraceService {
    Map<String,Object> save(RequestContext ctx,UUID batch,long groupId,Map<String,Object> body);
}
