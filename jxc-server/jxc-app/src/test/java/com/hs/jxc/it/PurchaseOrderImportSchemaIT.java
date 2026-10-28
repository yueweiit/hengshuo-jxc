package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;

import java.math.BigDecimal;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** 在现有隔离PostgreSQL和完整Flyway迁移上验证独立导入表，不启动正式业务写入。 */
class PurchaseOrderImportSchemaIT extends BasePgIT {
    private UUID batch;

    @BeforeEach void fixture() { InventoryIT.seedBase(); batch = UUID.randomUUID();
        inCountry(101,()->jdbc.update("INSERT INTO pur_order_import_batch(country_id,batch_id,header,created_by) VALUES(101,?,'{\"bookId\":991}',201)",batch));
    }

    private long insert(int line, String spec) {
        return inCountry(101, () -> jdbc.queryForObject("""
            INSERT INTO pur_order_import
              (country_id,batch_id,row_no,book_id,supplier_id,currency,order_date,
               source_order_no,product_spec,purchase_qty,purchase_unit_price,created_by)
            VALUES (101,?,?,991,992,'USD','2026-10-28','NY-051',?,10,53.1234567890,201)
            RETURNING id
            """, Long.class, batch, line, spec));
    }

    @Test void differentSpecificationsShareSourceOrderAndKeepExactPricesWithoutBusinessLinks() {
        int orders = owner.queryForObject("SELECT count(*) FROM pur_order", Integer.class);
        long first = insert(1, "S");
        insert(2, "M");
        var stored = inCountry(101, () -> jdbc.queryForMap("SELECT * FROM pur_order_import WHERE id=?", first));
        assertThat((BigDecimal) stored.get("purchase_unit_price")).isEqualByComparingTo("53.1234567890");
        assertThat(stored.get("freight")).isNull();
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import", Integer.class)).isEqualTo(2);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order", Integer.class)).isEqualTo(orders);
        assertThat(owner.queryForObject("SELECT count(*) FROM pg_constraint WHERE conrelid='pur_order_import'::regclass AND contype='f' AND confrelid NOT IN ('pur_order_import_batch'::regclass,'pur_order_import_source'::regclass,'sys_user'::regclass)", Integer.class)).isZero();
    }

    @Test void invalidNumbersAndDuplicateSourceRowsAreRejectedByTheDatabase() {
        long id = insert(1, "S");
        assertThatThrownBy(() -> insert(1, "M")).isInstanceOf(RuntimeException.class);
        for (String expression : new String[]{"purchase_qty=0", "purchase_qty=-1", "purchase_qty='NaN'", "purchase_unit_price=-1", "purchase_unit_price='NaN'", "prepay_ratio=1.1", "term_days=-1", "version=0", "source_order_no=' '"}) {
            assertThatThrownBy(() -> inCountry(101, () -> jdbc.update("UPDATE pur_order_import SET " + expression + " WHERE id=?", id)))
                .isInstanceOf(RuntimeException.class);
        }
        for (String column : new String[]{"sale_unit_price", "sale_total", "freight", "landed_unit_cost", "usd_unit_cost", "usd_total"}) {
            for (String value : new String[]{"-1", "'NaN'"}) {
                assertThatThrownBy(() -> inCountry(101, () -> jdbc.update("UPDATE pur_order_import SET " + column + "=" + value + " WHERE id=?", id)))
                    .isInstanceOf(RuntimeException.class);
            }
        }
        assertThat(inCountry(101, () -> jdbc.queryForObject("SELECT purchase_qty FROM pur_order_import WHERE id=?", BigDecimal.class, id)))
            .isEqualByComparingTo("10");
    }

    @Test void runtimeCrudRespectsCountryIsolation() {
        long id = insert(1, "S");
        assertThat(inCountry(102, () -> jdbc.queryForObject("SELECT count(*) FROM pur_order_import", Integer.class))).isZero();
        assertThat(inCountry(102, () -> jdbc.update("DELETE FROM pur_order_import WHERE id=?", id))).isZero();
        assertThat(inCountry(101, () -> jdbc.update("UPDATE pur_order_import SET purchase_qty=12,version=version+1 WHERE id=? AND version=1", id))).isEqualTo(1);
        assertThat(inCountry(101, () -> jdbc.update("DELETE FROM pur_order_import WHERE id=? AND version=2", id))).isEqualTo(1);
    }
}
