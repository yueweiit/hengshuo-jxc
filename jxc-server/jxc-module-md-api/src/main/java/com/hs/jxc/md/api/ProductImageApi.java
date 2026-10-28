package com.hs.jxc.md.api;

import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.attachment.AttachmentService;
import java.util.*;

/** 商品照片关系和特征的唯一归属端口；采购模块不写主数据照片SQL。 */
public interface ProductImageApi {
    String MODEL="dinov2_vits14", MODEL_VERSION="b938bf1bc15cd2ec0feacfe3a1bb553fe8ea9ca46a7e1d8d00217f29aef60cd9", PREPROCESS="exif-rgb-short256-center224-imagenet-v1";
    Map<String,Object> link(RequestContext ctx,long productId,long attachmentId);
    List<Map<String,Object>> list(RequestContext ctx,long productId);
    AttachmentService.Download content(RequestContext ctx,long imageId);
    List<Map<String,Object>> pendingFeatures(RequestContext ctx);
    Map<String,Object> feature(RequestContext ctx,long featureId);
    AttachmentService.Download featureContent(RequestContext ctx,long featureId);
    void saveFeature(RequestContext ctx,long featureId,Map<String,Object> result);
    void failFeature(RequestContext ctx,long featureId,String message);
    Map<String,Object> galleryInput(RequestContext ctx);
    Map<String,Object> gallery(RequestContext ctx);
    void beginGeneration(RequestContext ctx,String generation,Map<String,Object> input);
    Map<String,Object> generationStatus(RequestContext ctx,String generation);
    void failGeneration(RequestContext ctx,String generation,String message);
    Map<String,Object> publishIndex(RequestContext ctx,String generation,Map<String,Object> input,Map<String,Object> result,Runnable commitGuard);
    Map<String,Object> indexReference(RequestContext ctx,String generation);
    AttachmentService.Download indexContent(RequestContext ctx,String generation);
    List<Map<String,Object>> resolveHits(RequestContext ctx,String generation,List<Map<String,Object>> hits);
}
