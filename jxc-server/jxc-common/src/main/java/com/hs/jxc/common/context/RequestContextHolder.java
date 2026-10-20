package com.hs.jxc.common.context;

import com.hs.jxc.common.api.ApiException;

public final class RequestContextHolder {
    private static final ThreadLocal<RequestContext> CURRENT = new ThreadLocal<>();
    private RequestContextHolder() {}
    public static void set(RequestContext context) { CURRENT.set(context); }
    public static RequestContext get() { return CURRENT.get(); }
    public static RequestContext require() {
        var context = get();
        if (context == null) throw new ApiException(401, "AUTH_REQUIRED", "请先登录");
        return context;
    }
    public static void clear() { CURRENT.remove(); }
}
