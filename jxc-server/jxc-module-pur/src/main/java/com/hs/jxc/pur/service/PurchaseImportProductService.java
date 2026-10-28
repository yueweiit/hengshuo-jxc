package com.hs.jxc.pur.service;

import java.util.*;
import com.hs.jxc.common.context.RequestContext;

/** 采购业务入口；原有校验和事务由唯一实现负责。 */
public interface PurchaseImportProductService {
    Map<String,Object> decide(RequestContext ctx,UUID batch,long rowId,Map<String,Object> body);
    Map<String,Object> createProduct(RequestContext ctx,UUID batch,long rowId,Map<String,Object> body,String key);
}
