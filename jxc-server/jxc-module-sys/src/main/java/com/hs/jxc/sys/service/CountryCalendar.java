package com.hs.jxc.sys.service;

import com.hs.jxc.sys.api.Access;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Country business dates inside an already authorized transaction. Security deadlines use the database clock. */
@Component
public class CountryCalendar {
    private static final Object TRANSACTION_INSTANT = new Object();
    private final JdbcTemplate jdbc;
    private final Clock clock;

    public CountryCalendar(JdbcTemplate jdbc, ObjectProvider<Clock> clocks) {
        this.jdbc = jdbc;
        this.clock = clocks.getIfAvailable(Clock::systemUTC);
    }

    public LocalDate today(Access access) { return today(access.requireCountry()); }

    public LocalDate today(long country) {
        Instant instant = transactionInstant();
        return instant.atZone(timezone(country)).toLocalDate();
    }

    public LocalDate day(Access access, OffsetDateTime value) {
        requireTransaction();
        return value.atZoneSameInstant(timezone(access.requireCountry())).toLocalDate();
    }

    private ZoneId timezone(long country) {
        String timezone = jdbc.queryForObject("SELECT timezone FROM sys_country WHERE id=?", String.class, country);
        return ZoneId.of(timezone);
    }

    private void requireTransaction() {
        if (!TransactionSynchronizationManager.isActualTransactionActive()
                || !TransactionSynchronizationManager.isSynchronizationActive()) {
            throw new IllegalStateException("Country business dates require a transaction");
        }
    }

    private Instant transactionInstant() {
        requireTransaction();
        Instant existing = (Instant) TransactionSynchronizationManager.getResource(TRANSACTION_INSTANT);
        if (existing != null) return existing;
        Instant instant = clock.instant();
        TransactionSynchronizationManager.bindResource(TRANSACTION_INSTANT, instant);
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void suspend() { unbind(); }
            @Override public void resume() { TransactionSynchronizationManager.bindResource(TRANSACTION_INSTANT, instant); }
            @Override public void afterCompletion(int status) { unbind(); }
            private void unbind() {
                if (TransactionSynchronizationManager.getResource(TRANSACTION_INSTANT) == instant)
                    TransactionSynchronizationManager.unbindResource(TRANSACTION_INSTANT);
            }
        });
        return instant;
    }
}
