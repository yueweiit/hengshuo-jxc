package com.hs.jxc.it;

import com.hs.jxc.JxcApplication;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbContext;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest(classes = JxcApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
public abstract class BasePgIT {
    protected static final JdbcTemplate owner = PgDatabase.ownerJdbc();
    protected static final JdbcTemplate adminJdbc = owner;
    @Autowired protected JdbcTemplate jdbc;
    @Autowired protected DbContext dbContext;
    @Autowired protected PlatformTransactionManager transactionManager;
    protected TransactionTemplate tx;
    protected JdbcTemplate appJdbc;
    @org.junit.jupiter.api.BeforeEach
    void initializeTools() { tx = new TransactionTemplate(transactionManager); appJdbc = jdbc; }
    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("jxc.jobs.enabled", () -> false);
        registry.add("spring.datasource.url", PgDatabase.PG::getJdbcUrl);
        registry.add("spring.datasource.username", () -> "jxc_app");
        registry.add("spring.datasource.password", () -> PgDatabase.PASSWORD);
        registry.add("spring.flyway.user", () -> "jxc_owner");
        registry.add("spring.flyway.password", () -> PgDatabase.PASSWORD);
        registry.add("spring.flyway.placeholders.runtimeRole", () -> "jxc_app");
    }
    protected void resetFixtures() { PgDatabase.reset(); }
    protected void seed(String sql, Object... args) { owner.update(sql, args); }
    protected <T> T inCountry(long countryId, Supplier<T> work) {
        return new TransactionTemplate(transactionManager).execute(status -> { dbContext.apply(countryId); return work.get(); });
    }
    protected RequestContext context(long userId, long countryId, String tokenHash) { return new RequestContext(userId, countryId, UUID.randomUUID().toString(), tokenHash); }
}
