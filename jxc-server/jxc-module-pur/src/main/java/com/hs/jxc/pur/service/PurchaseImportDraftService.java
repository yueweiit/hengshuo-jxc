package com.hs.jxc.pur.service;

import java.util.*;
import com.hs.jxc.common.context.RequestContext;

/** 采购业务入口；原有校验和事务由唯一实现负责。 */
public interface PurchaseImportDraftService {
    Map<String,Object> previews(RequestContext ctx,UUID batch,Map<String,Object> body);
    Map<String,Object> saveGroup(RequestContext ctx,UUID batch,long id,Map<String,Object> body);
    Map<String,Object> create(RequestContext ctx,UUID batch,long groupId,Map<String,Object> body,String key);
    Map<String,Object> creation(RequestContext ctx,UUID batch,long groupId);
}
