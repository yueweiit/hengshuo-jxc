package com.hs.jxc.md.api;
import com.hs.jxc.common.context.RequestContext;
import java.util.Map;

/** 原商品/单位/本国经营的唯一维护端口；每次调用保持原权限、幂等与审计。 */
public interface MasterProductMaintenanceApi {
    Map<String,Object> saveProduct(RequestContext ctx,Long id,Map<String,Object> body,String key);
    Map<String,Object> saveSku(RequestContext ctx,long productId,Map<String,Object> body,String key);
    Map<String,Object> inspect(RequestContext ctx,long productId);
    void enrichProduct(Map<String,Object> product);
}
