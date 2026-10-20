package com.hs.jxc.ap.api;

import com.hs.jxc.sys.api.Access;
import java.util.Map;

/** AP owns the explicit assignment of confirmed bill principal to physical cost facts. */
public interface CostPayableBasisApi {
    /** Safe for owner fact reads: unavailable basis is explicit data, not an exception. */
    Map<String,Object> principal(Access access,long costId);
    /** Joins the original FIN effect transaction; never used for previews or existing results. */
    void freeze(Access access,long costId,long eventId);
}
