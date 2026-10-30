package com.hs.jxc.pur.service.impl;
import com.hs.jxc.pur.service.*;

import com.hs.jxc.attachment.AttachmentService;
import com.hs.jxc.common.context.RequestContext;
import java.util.*;

/** 各业务阶段共用同一领取、凭证、恢复和重试执行器。 */
interface PurchaseImportTaskHandler {
    Set<String> kinds();
    void execute(PurchaseImportTaskServiceImpl.Lease lease,PurchaseImportTaskServiceImpl runtime);
    default void executeBatch(long country,List<UUID> ids,PurchaseImportTaskServiceImpl runtime){ids.forEach(id->runtime.execute(country,id));}
    void validate(RequestContext ctx,Map<String,Object> task);
    default void retry(RequestContext ctx,Map<String,Object> task){validate(ctx,task);}
    AttachmentService.Download asset(RequestContext ctx,Map<String,Object> task,long assetId);
}
