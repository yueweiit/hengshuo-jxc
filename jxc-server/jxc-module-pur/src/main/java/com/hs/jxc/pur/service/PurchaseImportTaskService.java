package com.hs.jxc.pur.service;

import java.util.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.attachment.AttachmentService;

/** 采购业务入口；原有校验和事务由唯一实现负责。 */
public interface PurchaseImportTaskService {
    void execute(long country,UUID taskId);
    Map<String,Object> get(RequestContext ctx,UUID id);
    Map<String,Object> retry(RequestContext ctx,UUID id,String key,String sheet);
    int recover(long country,int limit);
    AttachmentService.Download taskAsset(UUID taskId,long sourceId,String token);
    void reportProgress(UUID taskId,String token,Map<String,Object> input);
}
