package com.hs.jxc.md.api;
import com.hs.jxc.sys.api.Access;
import java.util.Map;
/** Historical names for IDs from a caller-authorized source. No independent list, banking or write grant. */
public interface MasterReferenceApi {
    Map<String,Object> reference(Access access,String type,long id);
}
