package com.hs.jxc.pur;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.service.AuthorizationService;
import java.io.IOException;
import java.util.Base64;
import java.util.Map;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PurchaseOrderImportTemplate {
    private final AuthorizationService authorization;

    public PurchaseOrderImportTemplate(AuthorizationService authorization) {
        this.authorization = authorization;
    }

    @Transactional
    public Map<String, String> download(RequestContext context) {
        var access = authorization.authorize(context);
        access.requireCountry();
        access.require("pur:order:create");
        try (var input = new ClassPathResource("templates/purchase-order-import-template.csv").getInputStream()) {
            return Map.of("fileName", "采购单导入模板.csv",
                "contentType", "text/csv;charset=utf-8",
                "contentBase64", Base64.getEncoder().encodeToString(input.readAllBytes()));
        } catch (IOException error) {
            throw new ApiException(500, "PUR_IMPORT_TEMPLATE_UNAVAILABLE", "采购单模板读取失败，请联系管理员检查模板文件");
        }
    }
}
