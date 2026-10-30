package com.hs.jxc.pur.mapper;

/** XML只选择模块固定的表和列，无法识别的标识符必须明确失败。 */
public final class PurchaseSqlGuard {
    private PurchaseSqlGuard() {}

    public static String reject() {
        throw new IllegalArgumentException("不支持的采购数据库标识符");
    }
}
