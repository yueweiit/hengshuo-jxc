package com.hs.jxc.pur.service;

import java.util.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.attachment.AttachmentService;

/** 采购业务入口；原有校验和事务由唯一实现负责。 */
public interface PurchaseImportPhotoService {
    Set<String> kinds();
    Map<String,Object> publish(RequestContext ctx,UUID batch,long rowId,Map<String,Object> body,String key);
    Map<String,Object> rebuild(RequestContext ctx,UUID batch,String key);
    void validate(RequestContext ctx,Map<String,Object> task);
    AttachmentService.Download asset(RequestContext ctx,Map<String,Object> task,long asset);
}
