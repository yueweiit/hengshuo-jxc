package com.hs.jxc.sys.api;

import java.util.List;
import java.util.Map;

/** Module-owned prerequisites evaluated under the caller's existing country authorization gates. */
public interface ConfigReadinessContributor {
    List<Map<String,Object>> check(long countryId,String action);
}
