package com.hs.jxc.common.api;

import com.hs.jxc.common.context.RequestContextHolder;
import java.sql.SQLException;
import java.util.UUID;
import org.postgresql.util.PSQLException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionAdvice {
    private static final Logger log = LoggerFactory.getLogger(ApiExceptionAdvice.class);
    public static String trace() { var ctx = RequestContextHolder.get(); return ctx == null ? UUID.randomUUID().toString() : ctx.traceId(); }
    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiEnvelope> business(ApiException e) { return respond(e, trace()); }
    private ResponseEntity<ApiEnvelope> respond(ApiException e, String traceId) { return ResponseEntity.status(e.getStatus()).body(ApiEnvelope.error(e.getCode(), e.getMessage(), e.getData(), traceId)); }
    @ExceptionHandler(DataAccessException.class)
    public ResponseEntity<ApiEnvelope> database(DataAccessException e) {
        String traceId = trace();
        java.util.function.Function<ApiException, ResponseEntity<ApiEnvelope>> failure = rejected -> respond(rejected, traceId);
        Throwable cause = e;
        while (cause != null && !(cause instanceof SQLException)) cause = cause.getCause();
        String state = cause instanceof SQLException sql ? sql.getSQLState() : "";
        String message = cause == null ? "" : String.valueOf(cause.getMessage());
        String constraint = cause instanceof PSQLException pg && pg.getServerErrorMessage() != null
            ? pg.getServerErrorMessage().getConstraint() : null;
        log.warn("Database request rejected traceId={} sqlState={} constraint={}", traceId, state, constraint);
        if (message.contains("SYS_WRITES_FROZEN")) return failure.apply(new ApiException(503, "SYS_WRITES_FROZEN", "系统正在执行停写核验，请稍后使用原请求重试"));
        for (String code : new String[]{"SYS_COUNTRY_DISABLED", "SYS_COUNTRY_NOT_ACTIVE"}) if(message.contains(code)) return failure.apply(new ApiException(409,code,"国家当前状态不允许该写入"));
        for (String code : new String[]{"FIN_PERIOD_CLOSED", "FIN_PERIOD_NOT_FOUND", "FIN_BOOK_NOT_ACTIVE"}) if (message.contains(code)) return failure.apply(new ApiException(400, code, "业务日期所属账套或会计期间不可写入"));
        if ("23505".equals(state)) return failure.apply(new ApiException(409, "MD_DUPLICATE", "记录或来源已存在"));
        if ("42501".equals(state)) return failure.apply(ApiException.forbidden());
        if ("23514".equals(state) && "lgs_fee_cost_treatment_check".equals(constraint))
            return failure.apply(new ApiException(400, "LGS_FEE_TREATMENT_INVALID", "物流费用的处理类型与系统规则不一致，请联系管理员并提供错误编号：" + traceId));
        if ("23503".equals(state)) return failure.apply(new ApiException(400, "SYS_BAD_REQUEST", "关联资料不存在、已失效或不在当前可用范围内，请重新选择"));
        if ("23502".equals(state)) return failure.apply(new ApiException(400, "SYS_BAD_REQUEST", "保存失败：缺少必要数据，请核对表单；信息齐全时请联系管理员并提供错误编号：" + traceId));
        if ("23514".equals(state)) return failure.apply(new ApiException(400, "SYS_BAD_REQUEST", "保存失败：数据不符合业务校验规则，请核对后重试；仍失败时请提供错误编号：" + traceId));
        if ("40P01".equals(state) || "40001".equals(state) || "55P03".equals(state)) return failure.apply(new ApiException(409, "SYS_CONCURRENT_RETRY", "操作发生并发冲突，请重试"));
        return failure.apply(new ApiException(500, "SYS_ERROR", "服务暂时无法完成请求"));
    }
    @ExceptionHandler({IllegalArgumentException.class, org.springframework.http.converter.HttpMessageNotReadableException.class,
        org.springframework.web.method.annotation.MethodArgumentTypeMismatchException.class,
        org.springframework.web.bind.MissingServletRequestParameterException.class,
        org.springframework.web.bind.MethodArgumentNotValidException.class})
    public ResponseEntity<ApiEnvelope> invalid(Exception e) { return business(new ApiException(400, "SYS_BAD_REQUEST", "请求参数不正确")); }
    @ExceptionHandler({org.springframework.web.servlet.resource.NoResourceFoundException.class,org.springframework.web.servlet.NoHandlerFoundException.class})
    public ResponseEntity<ApiEnvelope> missing(Exception e){return business(new ApiException(404,"SYS_API_NOT_FOUND","页面所需接口不存在，请刷新页面或联系管理员核对服务版本"));}
    @ExceptionHandler(org.springframework.web.HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<ApiEnvelope> method(Exception e){return business(new ApiException(405,"SYS_METHOD_NOT_ALLOWED","此接口不支持该操作"));}
    @ExceptionHandler(org.springframework.web.multipart.MaxUploadSizeExceededException.class)
    public ResponseEntity<ApiEnvelope> size(Exception e){return business(new ApiException(413,"SYS_FILE_TOO_LARGE","文件超出允许大小"));}
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiEnvelope> unexpected(Exception e) { return business(new ApiException(500, "SYS_ERROR", "服务暂时无法完成请求")); }
}
