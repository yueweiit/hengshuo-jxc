package com.hs.jxc.it;

import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.common.db.DbContext;
import java.lang.reflect.InvocationTargetException;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermission;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.transaction.PlatformTransactionManager;
import static org.assertj.core.api.Assertions.*;

class BootstrapIT extends BasePgIT {
    @BeforeEach void emptyDatabase(){resetFixtures();}
    private Class<?> serviceClass() {
        Class<?> found=null;
        try {found=Class.forName("com.hs.jxc.bootstrap.BootstrapService");}catch(ClassNotFoundException ignored){}
        assertThat(found).as("explicit empty-database bootstrap must exist without automatic demo seeding").isNotNull();
        return found;
    }
    private Object service() throws Exception {return serviceClass().getConstructor(JdbcTemplate.class,PlatformTransactionManager.class,DbContext.class,JsonCodec.class).newInstance(jdbc,transactionManager,dbContext,new JsonCodec());}
    private void apply(Object service,Map<String,Object> config) throws Exception {
        try {serviceClass().getMethod("bootstrap",Map.class).invoke(service,config);}catch(InvocationTargetException e){if(e.getCause() instanceof RuntimeException runtime)throw runtime;throw e;}
    }
    private Map<String,Object> config(){return new JsonCodec().readMap("""
        {"schemaVersion":1,"databaseName":"jxc_m01_test","operator":"isolated-test-operator","reason":"initial authorized configuration",
         "currencies":[{"code":"TST","name":"Test currency","decimals":2}],
         "country":{"code":"TEST","name":"Isolated test country","defaultCurrency":"TST","timezone":"UTC","status":"DRAFT","locale":"zh-CN","enabledModules":["fin"]},
         "entity":{"code":"TEST-ENTITY","name":"Isolated entity"},
         "book":{"code":"TEST-BOOK","name":"Isolated draft book","baseCurrency":"TST","status":"DRAFT"},
         "admin":{"username":"bootstrap-it-user","displayName":"Bootstrap integration test","password":"test-only-explicit-secret","isPlatformAdmin":false},
         "role":{"code":"TEST-ADMIN","name":"Explicit test role","roleType":"ADMIN","permissions":["sys:user:edit"],"fieldPolicies":{"COST":"HIDDEN","CUSTOMER_PRICE":"HIDDEN","ORDER_TOTAL":"HIDDEN","BANK_INFO":"HIDDEN","PROFIT":"HIDDEN","CREDIT":"HIDDEN"}},
         "dataScope":{"scopeType":"COUNTRY_ALL"}}
        """);}
    @Test void explicitConfigurationCreatesOnlyFoundationAndOneRedactedAudit() throws Exception {
        apply(service(),config());
        assertThat(owner.queryForObject("select count(*) from sys_user",Integer.class)).isEqualTo(1);
        assertThat(new JsonCodec().readMap(owner.queryForObject("select config::text from sys_country",String.class))).containsEntry("locale","zh-CN").containsEntry("enabledModules",List.of("fin"));
        String hash=owner.queryForObject("select password_hash from sys_user",String.class);
        assertThat(hash).startsWith("$2").doesNotContain("test-only-explicit-secret");
        assertThat(new BCryptPasswordEncoder().matches("test-only-explicit-secret",hash)).isTrue();
        assertThat(owner.queryForObject("select permissions::text from sys_role",String.class)).isEqualTo("[\"sys:user:edit\"]");
        assertThat(owner.queryForObject("select count(*) from fin_period",Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from sys_biz_event",Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from sys_audit_log",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select after_value::text from sys_audit_log",String.class)).doesNotContain("password",hash,"test-only-explicit-secret");
    }
    @Test void repeatAndWildcardConfigurationAreRejectedWithoutAdditionalWrites() throws Exception {
        Object service=service();Map<String,Object> invalid=config();
        ((Map<String,Object>)invalid.get("role")).put("permissions",List.of("*"));
        assertThatThrownBy(()->apply(service,invalid)).isInstanceOf(RuntimeException.class);
        assertThat(owner.queryForObject("select count(*) from sys_country",Integer.class)).isZero();
        apply(service,config());
        assertThatThrownBy(()->apply(service,config())).isInstanceOf(RuntimeException.class);
        assertThat(owner.queryForObject("select count(*) from sys_user",Integer.class)).isEqualTo(1);
    }
    @Test void aLateDatabaseFailureRollsBackEveryBootstrapWrite() throws Exception {
        Object service=service();
        owner.execute("CREATE FUNCTION bootstrap_it_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'BOOTSTRAP_TEST_FAILURE'; END $$");
        owner.execute("CREATE TRIGGER bootstrap_it_fail BEFORE INSERT ON fin_book FOR EACH ROW EXECUTE FUNCTION bootstrap_it_fail()");
        try {
            assertThatThrownBy(()->apply(service,config())).isInstanceOf(RuntimeException.class);
            for(String table:List.of("md_currency","sys_country","sys_user","org_entity","sys_role","sys_audit_log")) assertThat(owner.queryForObject("select count(*) from "+table,Integer.class)).as(table).isZero();
        } finally {owner.execute("DROP TRIGGER bootstrap_it_fail ON fin_book");owner.execute("DROP FUNCTION bootstrap_it_fail()");}
    }
    @Test void bootstrapRejectsAnOtherwiseEmptyDatabaseContainingAnyNonWhitelistedMaster() throws Exception {
        owner.execute("INSERT INTO md_product(product_code,name,base_unit) VALUES('BOOTSTRAP-PREEXISTING','Existing master','PCS')");
        assertThatThrownBy(()->apply(service(),config())).isInstanceOf(IllegalStateException.class).hasMessage("BOOTSTRAP_DATABASE_NOT_EMPTY");
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_country",Integer.class)).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM md_product",Integer.class)).isEqualTo(1);
    }
    @Test void secretConfigurationRequiresAnOwnedRegular0600File() throws Exception {
        Class<?> type=serviceClass();Path file=Files.createTempFile("jxc-bootstrap-it-",".json");
        try {
            Files.writeString(file,new JsonCodec().write(config()));
            Files.setPosixFilePermissions(file,Set.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE));
            assertThat(type.getMethod("readConfiguration",Path.class).invoke(null,file)).isInstanceOf(Map.class);
            Files.setPosixFilePermissions(file,Set.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE,PosixFilePermission.GROUP_READ));
            assertThatThrownBy(()->type.getMethod("readConfiguration",Path.class).invoke(null,file)).isInstanceOf(InvocationTargetException.class);
        } finally {Files.deleteIfExists(file);}
    }
}
