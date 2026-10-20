package com.hs.jxc.workflow.api;

import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.api.Access;

/** Trusted business participant. Both methods join the existing approval transaction. */
public interface WorkflowParticipant {
    /** Acquire ordered book and partner gates before the workflow locks its source row. */
    default void prepare(RequestContext context,Access access,long documentId) {}
    /** Called once for a terminal task decision, including rejection and withdrawal. */
    void onDecision(RequestContext context,Access access,long documentId,String status);
}
