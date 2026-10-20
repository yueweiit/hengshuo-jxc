package com.hs.jxc.common.api;

public class ApiException extends RuntimeException {
    private final int status;
    private final String code;
    private final Object data;
    public ApiException(int status, String code, String message) { this(status, code, message, null); }
    public ApiException(int status, String code, String message, Object data) {
        super(message); this.status = status; this.code = code; this.data = data;
    }
    public int getStatus() { return status; }
    public String getCode() { return code; }
    public Object getData() { return data; }
    public static ApiException forbidden() { return new ApiException(403, "SYS_FORBIDDEN", "没有该操作权限"); }
    public static ApiException notFound() { return new ApiException(404, "NOT_FOUND", "记录不存在或不在你的数据范围内"); }
}
