package com.hs.jxc.pur.mapper;

import java.util.List;
import org.springframework.dao.IncorrectResultSizeDataAccessException;
import org.springframework.dao.EmptyResultDataAccessException;

/** 保留原单行读取的数量约束；单行SQL NULL与没有结果是两回事。 */
public final class PurchaseRows {
    private PurchaseRows() {}

    public static <T> T one(List<T> rows) {
        if (rows.isEmpty()) throw new EmptyResultDataAccessException(1);
        if (rows.size() != 1) throw new IncorrectResultSizeDataAccessException(1, rows.size());
        return rows.getFirst();
    }
}
