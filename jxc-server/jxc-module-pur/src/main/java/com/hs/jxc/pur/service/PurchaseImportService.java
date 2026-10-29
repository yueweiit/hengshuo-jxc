package com.hs.jxc.pur.service;

import java.util.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.attachment.AttachmentService;

/** 采购业务入口；原有校验和事务由唯一实现负责。 */
public interface PurchaseImportService {
    Map<String,Object> capabilities(RequestContext ctx);
    Map<String,Object> upload(RequestContext ctx,String name,byte[] bytes,Map<String,Object> input,UUID existing,String key);
    Map<String,Object> get(RequestContext ctx,UUID id);
    Map<String,Object> saveRow(RequestContext ctx,UUID id,long rowId,Map<String,Object> input);
    Map<String,Object> saveGrid(RequestContext ctx,Map<String,Object> input,String key);
    Map<String,Object> confirmReview(RequestContext ctx,UUID id,Map<String,Object> input,String key);
    Map<String,Object> uploadPhoto(RequestContext ctx,UUID id,long rowId,String name,String mime,byte[] bytes,Map<String,Object> input,String key);
    Map<String,Object> saveHeader(RequestContext ctx,UUID id,Map<String,Object> input);
    Map<String,Object> deleteRow(RequestContext ctx,UUID id,long rowId,long version);
    AttachmentService.Download content(RequestContext ctx,UUID id,long assetId,boolean image);
    Map<String,Object> associate(RequestContext ctx,UUID id,long rowId,long imageId,Map<String,Object> input);
}
