package com.hs.jxc.it;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.api.ApiExceptionAdvice;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.context.RequestContextHolder;
import com.hs.jxc.pur.PurchaseController;
import com.hs.jxc.pur.PurchaseOrderImportTemplate;
import com.hs.jxc.pur.PurchaseService;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.api.DataScope;
import com.hs.jxc.sys.service.AuthorizationService;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class PurchaseOrderImportTemplateTest {
    private final AuthorizationService authorization = mock(AuthorizationService.class);
    private final PurchaseOrderImportTemplate template = new PurchaseOrderImportTemplate(authorization);
    private final RequestContext context = new RequestContext(7, 1L, "template-test", null);

    @AfterEach void clearContext() { RequestContextHolder.clear(); }

    private Access access(Long countryId, Set<String> permissions) {
        return new Access(7, countryId, false, permissions, Map.of(), DataScope.none(), Instant.now().plusSeconds(60));
    }

    @Test void authorizedDownloadUsesTheTemplateRouteRatherThanParsingItAsAnOrderId() throws Exception {
        when(authorization.authorize(context)).thenReturn(access(1L, Set.of("pur:order:create")));
        var purchases = mock(PurchaseService.class);
        var mvc = MockMvcBuilders.standaloneSetup(new PurchaseController(purchases, template))
            .setControllerAdvice(new ApiExceptionAdvice()).build();
        RequestContextHolder.set(context);
        mvc.perform(get("/api/v1/pur/orders/import-template"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.code").value("OK"))
            .andExpect(jsonPath("$.data.fileName").value("采购单导入模板.csv"))
            .andExpect(jsonPath("$.data.contentType").value("text/csv;charset=utf-8"));
        var downloaded = Base64.getDecoder().decode(template.download(context).get("contentBase64"));
        try (var original = getClass().getResourceAsStream("/templates/purchase-order-import-template.csv")) {
            assertArrayEquals(original.readAllBytes(), downloaded);
        }
        verifyNoInteractions(purchases);
    }

    @Test void viewPermissionAloneCannotDownloadThePurchaseCreationTemplate() {
        when(authorization.authorize(context)).thenReturn(access(1L, Set.of("pur:order:view")));
        var failure = assertThrows(ApiException.class, () -> template.download(context));
        assertEquals(403, failure.getStatus());
        assertEquals("SYS_FORBIDDEN", failure.getCode());
    }

    @Test void downloadRequiresASelectedCountryEvenWithCreationPermission() {
        when(authorization.authorize(context)).thenReturn(access(null, Set.of("pur:order:create")));
        var failure = assertThrows(ApiException.class, () -> template.download(context));
        assertEquals("SYS_COUNTRY_REQUIRED", failure.getCode());
    }

    @Test void expiredSessionIsPropagatedInsteadOfReturningATemplate() {
        var denied = new ApiException(401, "AUTH_REQUIRED", "登录已过期，请重新登录");
        when(authorization.authorize(context)).thenThrow(denied);
        assertSame(denied, assertThrows(ApiException.class, () -> template.download(context)));
    }

    @Test void templateEndpointWithoutLoginReturnsAnAuthenticationFailure() throws Exception {
        var mvc = MockMvcBuilders.standaloneSetup(new PurchaseController(mock(PurchaseService.class), template))
            .setControllerAdvice(new ApiExceptionAdvice()).build();
        mvc.perform(get("/api/v1/pur/orders/import-template"))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("AUTH_REQUIRED"));
        verifyNoInteractions(authorization);
    }

    @Test void csvContainsOnlyTheRequestedHeaderWithNoStyledWorkbookOrInventedData() throws Exception {
        byte[] bytes;
        try (var resource = getClass().getResourceAsStream("/templates/purchase-order-import-template.csv")) {
            assertNotNull(resource, "采购模板必须作为CSV纯文本资源随应用打包");
            bytes = resource.readAllBytes();
        }
        assertArrayEquals(new byte[]{(byte) 0xef, (byte) 0xbb, (byte) 0xbf}, java.util.Arrays.copyOf(bytes, 3), "Excel中文读取兼容标记必须保留");
        String text = new String(bytes, StandardCharsets.UTF_8);
        var rows = text.substring(1).lines().toList();
        assertEquals(1, rows.size(), "CSV只提供表头，不填示例、金额或公式");
        var headers = List.of(rows.getFirst().split(",", -1));
        assertEquals(List.of("采购单号", "商品照片", "尺码／规格配比", "采购数量", "单件售价", "售价合计",
            "供应商单价（采购单价）", "运费", "到货单位成本", "美元单位成本", "美元成本合计"), headers);
        assertTrue(text.endsWith("\n"), "CSV表头须有换行结束，兼容仓库的LF或CRLF换行规则");
        assertNull(getClass().getResource("/templates/purchase-order-import-template.xlsx"), "被替代的带样式Excel模板不能继续打包");
    }
}
