package com.hs.jxc.sys.jobs;

import com.hs.jxc.sys.api.Access;
import java.util.List;
import java.util.Map;

/** Each business module supplies its own current, scoped work items. */
public interface WorkItemProvider {
    List<Map<String,Object>> items(Access access);
}
