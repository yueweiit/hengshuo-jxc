package com.hs.jxc.sys.api;
import java.util.Map;
/** Minimal references for a caller-authorized book entity; no user or organization mutations. */
public interface OrganizationReferenceApi {
    Map<String,Object> reference(Access access,String type,long id,long entityId);
}
