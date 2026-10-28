package com.hs.jxc.pur.service.impl;
import com.hs.jxc.pur.vo.PurchaseImportTemplateVO;
import com.hs.jxc.pur.service.*;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.service.AuthorizationService;
import java.io.IOException;
import java.util.Base64;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PurchaseOrderImportTemplateImpl implements PurchaseOrderImportTemplate {
    private final AuthorizationService authorization;

    public PurchaseOrderImportTemplateImpl(AuthorizationService authorization) {
        this.authorization = authorization;
    }

    @Transactional
    public PurchaseImportTemplateVO download(RequestContext context) {
        var access = authorization.authorize(context);
        access.requireCountry();
        access.require("pur:order:create");
        try (var input = new ClassPathResource("templates/purchase-order-import-template.xlsx").getInputStream()) {
            return new PurchaseImportTemplateVO("采购单导入模板.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                Base64.getEncoder().encodeToString(input.readAllBytes()));
        } catch (IOException error) {
            throw new ApiException(500, "PUR_IMPORT_TEMPLATE_UNAVAILABLE", "采购单模板读取失败，请联系管理员检查模板文件");
        }
    }
}
