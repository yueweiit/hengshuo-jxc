package com.hs.jxc.sys.jobs;

import com.hs.jxc.common.context.RequestContext;
import java.util.Map;

/** Explicit user export intent; the existing outbox owns delivery and retry. */
public interface JobApi {
    Map<String,Object> enqueue(RequestContext context,String kind,long bookId,Map<String,Object> request,String key);
    void run(long countryId,long jobId);
}
