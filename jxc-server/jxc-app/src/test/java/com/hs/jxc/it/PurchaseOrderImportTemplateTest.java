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
import java.io.ByteArrayInputStream;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipInputStream;
import javax.xml.parsers.DocumentBuilderFactory;
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
            .andExpect(jsonPath("$.data.fileName").value("采购单导入模板.xlsx"))
            .andExpect(jsonPath("$.data.contentType").value("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
        var downloaded = Base64.getDecoder().decode(template.download(context).get("contentBase64"));
        try (var original = getClass().getResourceAsStream("/templates/purchase-order-import-template.xlsx")) {
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

    @Test void expiredSessionIsPropagatedInsteadOfReturningAWorkbook() {
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

    @Test void workbookHasTheRequestedColumnsAndBlankDataInsteadOfInventedCosts() throws Exception {
        var resource = getClass().getResourceAsStream("/templates/purchase-order-import-template.xlsx");
        assertNotNull(resource, "采购模板必须作为真实Excel资源随应用打包");
        var entries = new HashMap<String, byte[]>();
        try (var zip = new ZipInputStream(resource)) {
            for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                entries.put(entry.getName(), zip.readAllBytes());
            }
        }
        var parser = DocumentBuilderFactory.newInstance();
        parser.setNamespaceAware(true);
        parser.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        var strings = new ArrayList<String>();
        var shared = entries.get("xl/sharedStrings.xml");
        if (shared != null) {
            var items = parser.newDocumentBuilder().parse(new ByteArrayInputStream(shared)).getElementsByTagNameNS("*", "si");
            for (int i = 0; i < items.getLength(); i++) strings.add(items.item(i).getTextContent());
        }
        var sheet = parser.newDocumentBuilder().parse(new ByteArrayInputStream(entries.get("xl/worksheets/sheet1.xml")));
        var cells = sheet.getElementsByTagNameNS("*", "c");
        var headers = new ArrayList<String>();
        for (int i = 0; i < cells.getLength(); i++) {
            var cell = (org.w3c.dom.Element) cells.item(i);
            assertEquals(0, cell.getElementsByTagNameNS("*", "f").getLength(), "未确认计算规则，不能擅自添加公式");
            var values = cell.getElementsByTagNameNS("*", "v");
            String value = "s".equals(cell.getAttribute("t"))
                ? strings.get(Integer.parseInt(values.item(0).getTextContent())) : cell.getTextContent();
            if (cell.getAttribute("r").matches("[A-K]1")) headers.add(value);
            else assertTrue(value.isBlank(), "数据行须为空白，不得填入零成本或示例金额");
        }
        assertEquals(List.of("采购单号", "商品照片", "尺码／规格配比", "采购数量", "单件售价", "售价合计",
            "供应商单价（采购单价）", "运费", "到货单位成本", "美元单位成本", "美元成本合计"), headers);
        assertFalse(entries.keySet().stream().anyMatch(name -> name.startsWith("xl/externalLinks/")));
    }
}
