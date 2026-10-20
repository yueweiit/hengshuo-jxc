package com.hs.jxc.common.db;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Component
public class DbContext {
    private final JdbcTemplate jdbc;
    public DbContext(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    public void apply(Long countryId) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) throw new IllegalStateException("数据库上下文必须位于事务中");
        jdbc.queryForObject("select set_config('app.country_id', ?, true)", String.class, countryId == null ? "" : countryId.toString());
    }
}
