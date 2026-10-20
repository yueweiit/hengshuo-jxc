package com.hs.jxc.sys.api;

import java.util.Map;

/** Server allowlist of configuration structures. Never return record IDs, people, banks or balances. */
public interface TemplateStructureContributor {
    default int order(){return 100;}
    String key();
    String itemType();
    String label();
    boolean requiresReview();
    Map<String,Object> snapshot(Access source);
    void apply(Access target,Map<String,Object> payload,long sourceItemId);
    default boolean ready(Access target,long sourceItemId){return true;}
    default void confirm(Access target,long sourceItemId,String comment){}
}
