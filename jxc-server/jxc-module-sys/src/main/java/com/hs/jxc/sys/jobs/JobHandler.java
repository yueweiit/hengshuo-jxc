package com.hs.jxc.sys.jobs;

import com.hs.jxc.sys.api.Access;
import java.util.Map;

/** Module-owned authorized export, executed inside the existing effect transaction. */
public interface JobHandler {
    String kind();
    void authorize(Access access,long bookId,Map<String,Object> request);
    /** Server-owned enqueue context; the original intent hash remains the caller's request. */
    default Map<String,Object> captureRequest(Access access,long bookId,Map<String,Object> request){return new java.util.LinkedHashMap<>(request);}
    Map<String,Object> execute(Access access,long bookId,Map<String,Object> request);
    Map<String,Object> download(Access access,long bookId,Map<String,Object> result);
}
