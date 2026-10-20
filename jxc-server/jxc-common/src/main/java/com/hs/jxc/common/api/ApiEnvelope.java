package com.hs.jxc.common.api;

public record ApiEnvelope(String code, String message, Object data, String traceId) {
    public static ApiEnvelope ok(Object data, String traceId) { return new ApiEnvelope("OK", "", data, traceId); }
    public static ApiEnvelope error(String code, String message, Object data, String traceId) { return new ApiEnvelope(code, message, data, traceId); }
}
