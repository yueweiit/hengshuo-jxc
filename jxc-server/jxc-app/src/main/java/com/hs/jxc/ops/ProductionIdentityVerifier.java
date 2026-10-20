package com.hs.jxc.ops;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.*;
import org.springframework.context.annotation.Profile;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
@Component @Profile("production") @Order(-1)
public class ProductionIdentityVerifier implements ApplicationRunner {
 private final JdbcTemplate db;private final String expected;private final boolean flyway;
 public ProductionIdentityVerifier(JdbcTemplate db,@Value("${JXC_EXPECT_DATABASE:}")String expected,@Value("${spring.flyway.enabled:true}")boolean flyway){this.db=db;this.expected=expected;this.flyway=flyway;}
 public void run(ApplicationArguments args){if(flyway||expected.isBlank()||!expected.equals(db.queryForObject("SELECT current_database()",String.class)))throw new IllegalStateException("Production runtime requires the exact reviewed database and disabled Flyway");}
}
