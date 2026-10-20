package com.hs.jxc.sys.api;

import com.hs.jxc.common.context.RequestContext;
import java.util.Map;

/** Narrow extension point: SYS owns store orchestration; MD owns every account rule and write. */
public interface StoreFundAccountPort {
    Map<String,Object> createForStore(RequestContext context,long entityId,long storeId,Map<String,Object> configuration);
}
