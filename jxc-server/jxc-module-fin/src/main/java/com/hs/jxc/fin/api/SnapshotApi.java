package com.hs.jxc.fin.api;

import com.hs.jxc.sys.api.Access;
import java.util.Map;

/** Immutable close-generation snapshots. Caller owns the authorized transaction. */
public interface SnapshotApi {
    /** Latest retained generation, or null. DTO contains content and sourceVersions. */
    Map<String,Object> latest(Access access,long bookId,long periodId,String type);
}
