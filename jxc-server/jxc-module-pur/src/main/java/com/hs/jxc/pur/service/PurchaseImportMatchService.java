package com.hs.jxc.pur.service;

import java.util.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.attachment.AttachmentService;

/** 采购业务入口；原有校验和事务由唯一实现负责。 */
public interface PurchaseImportMatchService {
    Set<String> kinds();
    void validate(RequestContext ctx,Map<String,Object> task);
    Map<String,Object> start(RequestContext ctx,UUID batch,Map<String,Object> body,String key);
    Map<String,Object> explain(RequestContext ctx,UUID batch,long rowId,Map<String,Object> body,String key);
    void retry(RequestContext ctx,Map<String,Object> task);
    Map<String,Object> catalogSearch(UUID taskId,String credential,Map<String,Object> body);
    Map<String,Object> result(UUID taskId,String credential,Map<String,Object> body);
    AttachmentService.Download asset(RequestContext ctx,Map<String,Object> task,long asset);
}
