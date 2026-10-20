package com.hs.jxc.workflow.api;
import com.hs.jxc.common.context.RequestContext;
import java.util.Map;
/** Synchronous participant in the calling business transaction; never REQUIRES_NEW. */
public interface WorkflowApi {
    void registerCriticalFields(String type,java.util.Set<String> required);
    void registerParticipant(String type,WorkflowParticipant participant);
    Map<String,Object> submit(RequestContext ctx,String docType,long docId,Map<String,Object> facts,boolean forceRequired);
    void requireApproved(RequestContext ctx,String docType,long docId);
    void invalidate(RequestContext ctx,String docType,long docId,String reason);
    Map<String,Object> withdraw(RequestContext ctx,long instanceId);
}
