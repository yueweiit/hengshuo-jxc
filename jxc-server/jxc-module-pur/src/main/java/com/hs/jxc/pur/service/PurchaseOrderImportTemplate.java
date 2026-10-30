package com.hs.jxc.pur.service;

import java.util.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.pur.vo.PurchaseImportTemplateVO;

/** 采购业务入口；原有校验和事务由唯一实现负责。 */
public interface PurchaseOrderImportTemplate {
    PurchaseImportTemplateVO download(RequestContext context);
}
