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
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HashMap;
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

    @Test void xlsxContainsOnlyGenericHeadersWithDefaultCellStylesAndNoInventedData() throws Exception {
        var parts = new HashMap<String, byte[]>();
        try (var resource = getClass().getResourceAsStream("/templates/purchase-order-import-template.xlsx")) {
            assertNotNull(resource, "采购模板必须为真正的XLSX文件");
            try (var zip = new ZipInputStream(resource)) {
                for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) parts.put(entry.getName(), zip.readAllBytes());
            }
        }
        assertTrue(parts.containsKey("[Content_Types].xml"));
        var sheet = xml(parts.get("xl/worksheets/sheet1.xml"));
        assertEquals(1, sheet.getElementsByTagNameNS("*", "row").getLength(), "只提供表头，不填示例、金额或公式");
        var cells = sheet.getElementsByTagNameNS("*", "c");
        var expected = List.of("采购单号", "商品照片", "商品规格", "采购数量", "单件售价", "售价合计",
            "供应商单价（采购单价）", "运费", "到货单位成本", "美元单位成本", "美元成本合计");
        assertEquals(expected.size(), cells.getLength());
        for (int i = 0; i < cells.getLength(); i++) {
            var cell = (org.w3c.dom.Element) cells.item(i);
            assertEquals("str", cell.getAttribute("t"));
            assertEquals(expected.get(i), cell.getElementsByTagNameNS("*", "v").item(0).getTextContent());
            assertTrue(!cell.hasAttribute("s") || cell.getAttribute("s").equals("0"), "不得设置表头或单元格样式");
        }
        var styles = xml(parts.get("xl/styles.xml"));
        var formats = (org.w3c.dom.Element) styles.getElementsByTagNameNS("*", "cellXfs").item(0);
        assertEquals("1", formats.getAttribute("count"));
        var format = (org.w3c.dom.Element) formats.getElementsByTagNameNS("*", "xf").item(0);
        for (var key : List.of("numFmtId", "fontId", "fillId", "borderId")) assertEquals("0", format.getAttribute(key));
        assertEquals("1", ((org.w3c.dom.Element) styles.getElementsByTagNameNS("*", "fonts").item(0)).getAttribute("count"));
        assertEquals(0, styles.getElementsByTagNameNS("*", "b").getLength(), "默认字体不能加粗");
        assertEquals("2", ((org.w3c.dom.Element) styles.getElementsByTagNameNS("*", "fills").item(0)).getAttribute("count"));
        assertEquals("1", ((org.w3c.dom.Element) styles.getElementsByTagNameNS("*", "borders").item(0)).getAttribute("count"));
        assertEquals(0, sheet.getElementsByTagNameNS("*", "tableParts").getLength());
        assertEquals(0, sheet.getElementsByTagNameNS("*", "conditionalFormatting").getLength());
        assertEquals(0, sheet.getElementsByTagNameNS("*", "f").getLength());
        assertNull(getClass().getResource("/templates/purchase-order-import-template.csv"), "被替代的CSV资源不能继续打包");
    }

    private org.w3c.dom.Document xml(byte[] bytes) throws Exception {
        assertNotNull(bytes, "XLSX缺少必要组成部分");
        var factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(bytes));
    }
}
