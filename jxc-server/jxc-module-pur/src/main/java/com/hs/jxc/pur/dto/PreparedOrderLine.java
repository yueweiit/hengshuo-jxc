package com.hs.jxc.pur.dto;

import java.math.BigDecimal;
import java.time.LocalDate;

/** 原采购创建与导入预览共用的已校验行，不包含任务凭证。 */
public record PreparedOrderLine(long productId, String unit, String baseUnit,
    BigDecimal factor, BigDecimal qty, BigDecimal baseQty, BigDecimal unitPrice,
    BigDecimal amount, BigDecimal taxRate, LocalDate deliveryDate) {}
