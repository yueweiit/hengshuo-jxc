package com.hs.jxc.it;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.api.ApiExceptionAdvice;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import static org.junit.jupiter.api.Assertions.*;

class ApiRouteErrorTest {
    private final ApiExceptionAdvice advice = new ApiExceptionAdvice();

    static Stream<Exception> missingRoutes() {
        String path = "/api/v1/sys/missing-owner-options";
        return Stream.of(new NoResourceFoundException(HttpMethod.GET, path, path),
            new NoHandlerFoundException("GET", path, HttpHeaders.EMPTY));
    }

    @ParameterizedTest
    @MethodSource("missingRoutes")
    void missingRouteExplainsUnavailableInterfaceInsteadOfRecordVisibility(Exception failure) {
        var response = advice.missing(failure);
        var body = response.getBody();
        assertEquals(404, response.getStatusCode().value());
        assertNotNull(body);
        assertEquals("SYS_API_NOT_FOUND", body.code());
        assertTrue(body.message().contains("接口"));
        assertTrue(body.message().contains("服务版本"));
        assertFalse(body.message().contains("数据范围"));
        assertFalse(body.message().contains("missing-owner-options"));
        assertNotNull(body.traceId());
        assertFalse(body.traceId().isBlank());
    }

    @Test
    void missingBusinessRecordKeepsVisibilityBoundaryAndOriginalClassification() {
        var response = advice.business(ApiException.notFound());
        var body = response.getBody();
        assertEquals(404, response.getStatusCode().value());
        assertNotNull(body);
        assertEquals("NOT_FOUND", body.code());
        assertTrue(body.message().contains("记录不存在或不在你的数据范围内"));
        assertFalse(body.message().contains("服务版本"));
    }
}
