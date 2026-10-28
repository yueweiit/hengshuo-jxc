package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.SQLException;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.dao.DataAccessException;

/** Tests database protections through the real, non-owner runtime identity. */
class SchemaIT extends BasePgIT {
    @BeforeEach
    void fixtures() {
        resetFixtures();
        owner.update("INSERT INTO md_currency(code,name,decimals) VALUES ('USD','Test dollar',2),('EUR','Test euro',2)");
        owner.update("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES (101,'T1','Test one','USD','UTC','ACTIVE'),(102,'T2','Test two','EUR','UTC','ACTIVE')");
        owner.update("INSERT INTO sys_user(id,username,password_hash,display_name,status) VALUES (201,'schema-user','$2a$10$synthetic.fixture.only','Schema user','ENABLED')");
        owner.update("INSERT INTO org_entity(id,country_id,code,name) VALUES (301,101,'E1','Entity one'),(302,102,'E2','Entity two')");
        owner.update("INSERT INTO org_store(id,country_id,entity_id,code,name) VALUES (401,101,301,'S1','Store one'),(402,102,302,'S2','Store two')");
        owner.update("INSERT INTO org_warehouse(id,country_id,entity_id,store_id,code,name,type) VALUES (501,101,301,401,'W1','Warehouse one','STORE'),(502,102,302,402,'W2','Warehouse two','STORE')");
        owner.update("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status,start_period) VALUES (601,101,301,'B1','Book one','USD','ACTIVE','2026-01'),(602,102,302,'B2','Book two','EUR','ACTIVE','2026-01')");
        owner.update("INSERT INTO fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES (701,101,601,2026,1,'2026-01-01','2026-01-31','OPEN'),(702,102,602,2026,1,'2026-01-01','2026-01-31','OPEN')");
    }

    @Test
    void runtimeRoleCannotBypassRlsOrCreateObjects() {
        assertThat(jdbc.queryForObject("SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname=current_user", Boolean.class)).isFalse();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM org_entity", Integer.class)).isZero();
        assertThat(inCountry(101, () -> jdbc.queryForList("SELECT id FROM org_entity", Long.class))).containsExactly(301L);
        assertSqlState("42501", () -> jdbc.update("CREATE TABLE forbidden_runtime_ddl(id bigint)"));
        assertSqlState("42501", () -> inCountry(101, () -> jdbc.update("INSERT INTO org_entity(country_id,code,name) VALUES (102,'FOREIGN','Denied')")));
        assertThat(jdbc.queryForObject("SELECT count(*) FROM org_entity", Integer.class)).isZero();
    }

    @Test
    void everyCountryTableForcesRlsAndRuntimeOwnsNoTables() {
        var unprotected=owner.queryForList("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='country_id' AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT(c.relrowsecurity AND c.relforcerowsecurity)",String.class);
        assertThat(unprotected).as("every country-scoped business table forces RLS").isEmpty();
        assertThat(owner.queryForObject("SELECT count(*) FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='country_id' AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'",Integer.class)).isGreaterThanOrEqualTo(21);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM pg_class c JOIN pg_roles r ON c.relowner=r.oid WHERE c.relnamespace='public'::regnamespace AND r.rolname=current_user", Integer.class)).isZero();
    }

    @Test
    void compositeForeignKeysRejectCrossCountryReferences() {
        assertSqlState("23503", () -> inCountry(101, () -> jdbc.update("INSERT INTO org_store(country_id,entity_id,code,name) VALUES (101,302,'CROSS','Denied')")));
        assertSqlState("23503", () -> inCountry(101, () -> jdbc.update("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES (101,602,2026,2,'2026-02-01','2026-02-28','OPEN')")));
        assertSqlState("23503", () -> inCountry(101, () -> jdbc.update("INSERT INTO org_warehouse(country_id,entity_id,store_id,code,name,type) VALUES (101,301,402,'CROSS','Denied','STORE')")));
    }

    @Test
    void scopesRequireOneTypedReferenceAndAValidWindow() {
        assertSqlState("23514", () -> inCountry(101, () -> jdbc.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,entity_id,store_id,granted_by) VALUES (101,201,'STORE',301,401,201)")));
        assertSqlState("23503", () -> inCountry(101, () -> jdbc.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,store_id,granted_by) VALUES (101,201,'STORE',402,201)")));
        assertSqlState("23514", () -> inCountry(101, () -> jdbc.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,effective_from,effective_to,granted_by) VALUES (101,201,'COUNTRY_ALL',now(),now()-interval '1 second',201)")));
        inCountry(101, () -> jdbc.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,store_id,granted_by) VALUES (101,201,'STORE',401,201)"));
    }

    @Test
    void periodsCannotOverlapWithinTheSameBook() {
        assertSqlState("23P01", () -> inCountry(101, () -> jdbc.update("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES (101,601,2026,2,'2026-01-31','2026-02-28','OPEN')")));
        inCountry(101, () -> jdbc.update("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES (101,601,2026,2,'2026-02-01','2026-02-28','NOT_STARTED')"));
    }

    @Test
    void eventFactsRequireAnActiveBookAndAnOpenPeriod() {
        assertThatThrownBy(() -> inCountry(101, () -> insertEvent("2026-02-01", 1))).isInstanceOf(DataAccessException.class).hasMessageContaining("FIN_PERIOD_NOT_FOUND");
        owner.update("UPDATE fin_period SET status='CLOSED' WHERE id=701");
        assertThatThrownBy(() -> inCountry(101, () -> insertEvent("2026-01-15", 1))).isInstanceOf(DataAccessException.class).hasMessageContaining("FIN_PERIOD_CLOSED");
        owner.update("UPDATE fin_period SET status='OPEN' WHERE id=701");
        owner.update("UPDATE fin_book SET status='DISABLED' WHERE id=601");
        assertThatThrownBy(() -> inCountry(101, () -> insertEvent("2026-01-15", 1))).isInstanceOf(DataAccessException.class).hasMessageContaining("FIN_BOOK_NOT_ACTIVE");
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event", Integer.class)).isZero();
    }

    @Test
    void eventDiagnosticsRemainWritableAfterCloseButFactsAreImmutable() {
        inCountry(101, () -> insertEvent("2026-01-15", 1));
        owner.update("UPDATE fin_period SET status='CLOSED' WHERE id=701");
        inCountry(101, () -> jdbc.update("UPDATE sys_biz_event SET status='FAILED',retry_count=retry_count+1,last_error='Missing mapping',version=version+1 WHERE source_id=301"));
        assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT retry_count FROM sys_biz_event", Integer.class))).isEqualTo(1);
        assertSqlState("42501", () -> inCountry(101, () -> jdbc.update("UPDATE sys_biz_event SET payload='{\"amount\":9}' WHERE source_id=301")));
        assertSqlState("42501", () -> inCountry(101, () -> jdbc.update("DELETE FROM sys_biz_event")));
        assertThatThrownBy(() -> owner.update("UPDATE sys_biz_event SET biz_date='2026-02-01' WHERE source_id=301")).isInstanceOf(DataAccessException.class).hasMessageContaining("FIN_PERIOD_CLOSED");
    }

    @Test
    void auditRowsCanOnlyBeAppended() {
        inCountry(101, () -> jdbc.update("INSERT INTO sys_audit_log(country_id,user_id,action,resource_type,resource_id) VALUES (101,201,'TEST','entity',301)"));
        assertSqlState("42501", () -> inCountry(101, () -> jdbc.update("UPDATE sys_audit_log SET action='TAMPER'")));
        assertSqlState("42501", () -> inCountry(101, () -> jdbc.update("DELETE FROM sys_audit_log")));
        assertThatThrownBy(() -> owner.update("UPDATE sys_audit_log SET action='TAMPER'")).isInstanceOf(DataAccessException.class).hasMessageContaining("JXC_APPEND_ONLY");
    }

    @Test
    void idempotencyAndEventBusinessKeysAreUnique() {
        inCountry(101, () -> jdbc.update("INSERT INTO sys_idempotency(country_id,user_id,key,method,endpoint,request_hash,book_id,response) VALUES (101,201,'same-key','POST','/test','hash',601,'{}')"));
        assertSqlState("23505", () -> inCountry(101, () -> jdbc.update("INSERT INTO sys_idempotency(country_id,user_id,key,method,endpoint,request_hash,book_id,response) VALUES (101,201,'same-key','POST','/test','hash',601,'{}')")));
        assertSqlState("23503", () -> inCountry(101, () -> jdbc.update("INSERT INTO sys_idempotency(country_id,user_id,key,method,endpoint,request_hash,book_id) VALUES (101,201,'cross-book','POST','/test','hash',602)")));
        inCountry(101, () -> insertEvent("2026-01-15", 1));
        assertSqlState("23505", () -> inCountry(101, () -> insertEvent("2026-01-15", 1)));
    }

    @Test
    void anIdempotencyPlaceholderCannotEscapeItsCommandTransaction() {
        assertThatThrownBy(() -> inCountry(101, () -> jdbc.update("INSERT INTO sys_idempotency(country_id,user_id,key,method,endpoint,request_hash) VALUES (101,201,'unfinished','POST','/test','hash')"))).hasMessageContaining("SYS_IDEMPOTENCY_INCOMPLETE");
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_idempotency", Integer.class)).isZero();
        inCountry(101, () -> {
            jdbc.update("INSERT INTO sys_idempotency(country_id,user_id,key,method,endpoint,request_hash) VALUES (101,201,'finished','POST','/test','hash')");
            return jdbc.update("UPDATE sys_idempotency SET response='{\"id\":301}' WHERE key='finished'");
        });
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_idempotency", Integer.class)).isEqualTo(1);
    }

    @Test
    void fundAccountsUseTheSameCountryAndEntityForTheirStoreAndBook() {
        assertSqlState("23503", () -> inCountry(101, () -> jdbc.update("INSERT INTO md_fund_account(country_id,entity_id,store_id,name,account_type,currency) VALUES (101,301,402,'Denied','CASH','USD')")));
        assertSqlState("23503", () -> inCountry(101, () -> jdbc.update("INSERT INTO md_fund_account(country_id,entity_id,book_id,name,account_type,currency) VALUES (101,301,602,'Denied','BANK','USD')")));
        inCountry(101, () -> jdbc.update("INSERT INTO md_fund_account(country_id,entity_id,store_id,book_id,name,account_type,currency) VALUES (101,301,401,601,'Local till','CASH','USD')"));
    }

    @Test
    void safeIdsApplyToRelationalAndJsonReferences() {
        assertSqlState("23514", () -> owner.update("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES (9007199254740992,'BIG','Denied','USD','UTC','ACTIVE')"));
        assertSqlState("23514", () -> inCountry(101, () -> jdbc.update("INSERT INTO sys_biz_event(country_id,book_id,event_type,source_type,source_id,event_seq,payload,biz_date) VALUES (101,601,'TEST','ENTITY',301,1,'{\"sourceId\":9007199254740992}','2026-01-15')")));
    }

    @Test
    void attachmentEvidenceCannotChangeItsObjectIdentity() {
        inCountry(101, () -> jdbc.update("INSERT INTO sys_attachment(id,country_id,category,file_name,content_type,size,storage_key,sha256,uploaded_by) VALUES (801,101,'PAYMENT_PROOF','proof.png','image/png',12,'fixture-proof',repeat('a',64),201)"));
        assertThatThrownBy(() -> inCountry(101, () -> jdbc.update("UPDATE sys_attachment SET sha256=repeat('b',64) WHERE id=801"))).isInstanceOf(DataAccessException.class);
        assertSqlState("23503", () -> inCountry(102, () -> jdbc.update("INSERT INTO sys_attachment_link(country_id,attachment_id,biz_type,biz_id,linked_by) VALUES (102,801,'ENTITY',302,201)")));
        inCountry(101, () -> jdbc.update("INSERT INTO sys_attachment_link(country_id,attachment_id,biz_type,biz_id,linked_by) VALUES (101,801,'ENTITY',301,201)"));
        inCountry(101, () -> jdbc.update("UPDATE sys_attachment SET object_status='MISSING',version=version+1 WHERE id=801"));
    }

    @Test
    void productCanExistWithoutAnyPhotoOrFeature() {
        seedProductImageFixtures();
        assertThat(jdbc.queryForObject("SELECT name FROM md_product WHERE id=1501", String.class)).isEqualTo("图片商品A");
        assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT count(*) FROM md_product_image", Integer.class))).isZero();
        assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT count(*) FROM image_feature", Integer.class))).isZero();
    }

    @Test
    void productPhotosCanShareOneFileAndHaveNoFeatures() {
        seedProductImageFixtures();
        insertProductPhoto(101, 1501, 1801, false);
        insertProductPhoto(101, 1502, 1801, false);
        assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT count(*) FROM md_product_image", Integer.class))).isEqualTo(2);
        assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT count(*) FROM image_feature", Integer.class))).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_attachment_link", Integer.class)).isZero();
    }

    @Test
    void productPhotoUniquenessAllowsSeveralPhotosAndReplacingAnArchivedPrimary() {
        seedProductImageFixtures();
        insertProductPhoto(101, 1501, 1801, true);
        insertProductPhoto(101, 1501, 1802, false);
        assertSqlState("23505", () -> insertProductPhoto(101, 1501, 1801, false));
        assertSqlState("23505", () -> inCountry(101, () -> jdbc.update("UPDATE md_product_image SET is_primary=true WHERE attachment_id=1802")));
        inCountry(101, () -> jdbc.update("UPDATE md_product_image SET status='DELETED' WHERE attachment_id=1801"));
        insertProductPhoto(101, 1501, 1801, true);
        assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT count(*) FROM md_product_image WHERE status='ACTIVE' AND is_primary", Integer.class))).isEqualTo(1);
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "INSERT INTO md_product_image(country_id,product_id,attachment_id,created_by) VALUES(101,9999,1801,201)",
        "INSERT INTO md_product_image(country_id,product_id,attachment_id,created_by) VALUES(101,1501,9999,201)",
        "INSERT INTO md_product_image(country_id,product_id,attachment_id,created_by) VALUES(101,1501,1803,201)",
        "INSERT INTO image_feature(country_id,attachment_id,model_name,model_version,preprocess_version,created_by) VALUES(101,9999,'dinov2_vits14','weights-1','rgb-1',201)",
        "INSERT INTO image_feature(country_id,attachment_id,model_name,model_version,preprocess_version,created_by) VALUES(101,1803,'dinov2_vits14','weights-1','rgb-1',201)"
    })
    void productImageReferencesRejectMissingOrForeignCountryParents(String sql) {
        seedProductImageFixtures();
        assertSqlState("23503", () -> inCountry(101, () -> jdbc.update(sql)));
    }

    @Test
    void imageFeatureVersionsCoexistButTheSameVersionCannotBeDuplicated() {
        seedProductImageFixtures();
        insertImageFeature(101, 1801, "weights-1", "rgb-1");
        insertImageFeature(101, 1801, "weights-2", "rgb-1");
        insertImageFeature(101, 1801, "weights-1", "rgb-2");
        assertSqlState("23505", () -> insertImageFeature(101, 1801, "weights-1", "rgb-1"));
        assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT count(*) FROM image_feature", Integer.class))).isEqualTo(3);
    }

    @Test
    void imageFeatureCanWaitFailRetryAndBecomeIndexedWithoutBlockingItsPhoto() {
        seedProductImageFixtures();
        insertProductPhoto(101, 1501, 1801, true);
        long feature = insertImageFeature(101, 1801, "weights-1", "rgb-1");
        assertThat(inCountry(101, () -> jdbc.queryForMap("SELECT feature_status,index_status,feature_data FROM image_feature WHERE id=?", feature)))
            .containsEntry("feature_status", "PENDING").containsEntry("index_status", "PENDING").containsEntry("feature_data", null);
        inCountry(101, () -> jdbc.update("UPDATE image_feature SET feature_status='FAILED',error_message='模型暂不可用' WHERE id=?", feature));
        assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT count(*) FROM md_product_image WHERE status='ACTIVE'", Integer.class))).isEqualTo(1);
        inCountry(101, () -> jdbc.update("UPDATE image_feature SET feature_status='READY',dimension=2,feature_data=decode('0000803f00000000','hex'),error_message=NULL WHERE id=?", feature));
        inCountry(101, () -> jdbc.update("UPDATE image_feature SET index_status='FAILED',error_message='索引写入失败' WHERE id=?", feature));
        inCountry(101, () -> jdbc.update("UPDATE image_feature SET index_status='READY',error_message=NULL WHERE id=?", feature));
        assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT octet_length(feature_data) FROM image_feature WHERE id=? AND feature_status='READY' AND index_status='READY'", Integer.class, feature))).isEqualTo(8);
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "feature_status='READY'",
        "feature_status='READY',dimension=2,feature_data=decode('0000803f','hex')",
        "feature_status='READY',dimension=0,feature_data=decode('','hex')",
        "feature_status='READY',feature_data=decode('0000803f','hex')",
        "dimension=1,feature_data=decode('0000803f','hex')",
        "feature_status='FAILED'",
        "feature_status='FAILED',error_message=' '",
        "index_status='READY'",
        "index_status='FAILED',error_message='索引失败'",
        "feature_status='READY',dimension=2,feature_data=decode('0000803f00000000','hex'),index_status='FAILED'",
        "feature_status='READY',dimension=2,feature_data=decode('0000803f00000000','hex'),error_message='过期错误'",
        "model_name=' '",
        "model_version=' '",
        "preprocess_version=' '"
    })
    void imageFeatureRejectsInvalidDataAndContradictoryStates(String assignment) {
        seedProductImageFixtures();
        long feature = insertImageFeature(101, 1801, "weights-1", "rgb-1");
        assertSqlState("23514", () -> inCountry(101, () -> jdbc.update("UPDATE image_feature SET " + assignment + " WHERE id=?", feature)));
    }

    @Test
    void productImagesAndFeaturesUseRuntimeCountryIsolation() {
        seedProductImageFixtures();
        insertProductPhoto(101, 1501, 1801, true);
        insertProductPhoto(102, 1501, 1803, true);
        insertImageFeature(101, 1801, "weights-1", "rgb-1");
        insertImageFeature(102, 1803, "weights-1", "rgb-1");
        for (String table : new String[]{"md_product_image", "image_feature"}) {
            assertThat(jdbc.queryForObject("SELECT count(*) FROM " + table, Integer.class)).isZero();
            assertThat(inCountry(101, () -> jdbc.queryForList("SELECT country_id FROM " + table, Long.class))).containsExactly(101L);
            assertThat(inCountry(102, () -> jdbc.queryForList("SELECT country_id FROM " + table, Long.class))).containsExactly(102L);
            assertSqlState("42501", () -> inCountry(101, () -> jdbc.update("UPDATE " + table + " SET country_id=102")));
        }
        assertSqlState("42501", () -> inCountry(101, () -> jdbc.update("INSERT INTO md_product_image(country_id,product_id,attachment_id,created_by) VALUES(102,1502,1803,201)")));
        assertSqlState("42501", () -> inCountry(101, () -> jdbc.update("INSERT INTO image_feature(country_id,attachment_id,model_name,model_version,preprocess_version,created_by) VALUES(102,1803,'dinov2_vits14','weights-2','rgb-1',201)")));
    }

    @ParameterizedTest
    @ValueSource(strings = {"md_product_image", "image_feature"})
    void productImageTablesRespectDisabledCountryWriteProtection(String table) {
        seedProductImageFixtures();
        insertProductPhoto(101, 1501, 1801, true);
        insertImageFeature(101, 1801, "weights-1", "rgb-1");
        owner.update("UPDATE sys_country SET status='DISABLED' WHERE id=101");
        assertThatThrownBy(() -> inCountry(101, () -> jdbc.update("UPDATE " + table + " SET version=version+1")))
            .isInstanceOf(DataAccessException.class).hasMessageContaining("SYS_COUNTRY_DISABLED");
        assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT count(*) FROM " + table, Integer.class))).isEqualTo(1);
    }

    @ParameterizedTest
    @ValueSource(strings = {"md_product_image", "image_feature"})
    void productImageTablesRespectOperationalFreezeWithoutBlockingReads(String table) {
        seedProductImageFixtures();
        insertProductPhoto(101, 1501, 1801, true);
        insertImageFeature(101, 1801, "weights-1", "rgb-1");
        setImageTestWriteMode("FROZEN");
        try {
            assertThatThrownBy(() -> inCountry(101, () -> jdbc.update("UPDATE " + table + " SET version=version+1")))
                .isInstanceOf(DataAccessException.class).hasMessageContaining("SYS_WRITES_FROZEN");
            assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT count(*) FROM " + table, Integer.class))).isEqualTo(1);
        } finally {
            setImageTestWriteMode("OPEN");
        }
    }

    private void seedProductImageFixtures() {
        owner.update("INSERT INTO md_product(id,product_code,name) VALUES(1501,'PIC-A','图片商品A'),(1502,'PIC-B','图片商品B')");
        // Only database metadata is exercised here; no fixture claims a real MinIO upload.
        owner.update("INSERT INTO sys_attachment(id,country_id,category,file_name,content_type,size,storage_key,sha256,uploaded_by) VALUES"
            + "(1801,101,'PRODUCT_PHOTO','a.png','image/png',8,'schema/photo-a',repeat('a',64),201),"
            + "(1802,101,'PRODUCT_PHOTO','b.png','image/png',8,'schema/photo-b',repeat('b',64),201),"
            + "(1803,102,'PRODUCT_PHOTO','c.png','image/png',8,'schema/photo-c',repeat('c',64),201)");
    }

    private int insertProductPhoto(long country, long product, long attachment, boolean primary) {
        return inCountry(country, () -> jdbc.update("INSERT INTO md_product_image(country_id,product_id,attachment_id,is_primary,created_by) VALUES(?,?,?,?,201)", country, product, attachment, primary));
    }

    private long insertImageFeature(long country, long attachment, String modelVersion, String preprocessVersion) {
        return inCountry(country, () -> jdbc.queryForObject("INSERT INTO image_feature(country_id,attachment_id,model_name,model_version,preprocess_version,created_by) VALUES(?,?,'dinov2_vits14',?,?,201) RETURNING id", Long.class, country, attachment, modelVersion, preprocessVersion));
    }

    private void setImageTestWriteMode(String mode) {
        long epoch = owner.queryForObject("SELECT epoch FROM sys_write_control", Long.class);
        owner.queryForObject("SELECT jxc_set_write_mode(?, ?, ?::uuid, '商品图片建表测试', '隔离数据库维护门禁验证')::text", String.class, mode, epoch, UUID.randomUUID().toString());
    }

    private int insertEvent(String date, int sequence) {
        return jdbc.update("INSERT INTO sys_biz_event(country_id,book_id,event_type,source_type,source_id,event_seq,payload,biz_date) VALUES (101,601,'TEST','ENTITY',301,?,'{}',?::date)", sequence, date);
    }

    private void assertSqlState(String expected, Runnable operation) {
        assertThatThrownBy(operation::run).isInstanceOf(DataAccessException.class).satisfies(error -> {
            Throwable cause = error;
            while (cause != null && !(cause instanceof SQLException)) cause = cause.getCause();
            assertThat(cause).isInstanceOf(SQLException.class);
            assertThat(((SQLException) cause).getSQLState()).isEqualTo(expected);
        });
    }
}
