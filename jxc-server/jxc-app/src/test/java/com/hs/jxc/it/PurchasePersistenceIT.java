package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;

import java.math.BigDecimal;
import java.util.*;
import com.hs.jxc.pur.mapper.PurchaseMyBatisConfiguration.Sessions;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.annotation.Autowired;

/** 采购实际映射必须与原JDBC业务共享事务，且不能用缓存绕过国家行隔离。 */
class PurchasePersistenceIT extends SupplyFixtures {
    @Autowired Sessions sessions;
    @Autowired com.hs.jxc.org.mapper.CurrencyMapper currencies;
    private static final String READ = "com.hs.jxc.pur.mapper.PurchaseMapper.selectDocument";

    private SqlSessionTemplate session() {
        assertThat(sessions.template().getConfiguration().hasStatement(READ)).as("采购XML必须注册").isTrue();
        return sessions.template();
    }

    private Map<String,Object> parameters(long id, String kind) {
        return Map.of("countryId",101L,"id",id,"kind",kind,"lock",false);
    }

    private Map<String,Object> draft() {
        return pur.create(c(),"orders",Map.of("bookId",601,"supplierId",801,
            "orderDate","2026-10-15","lines",List.of(Map.of("productId",501,
                "unit","PCS","qty",10,"unitPrice",10))),key());
    }

    @Test void mapperPreservesNullColumnsAmountsAndJoinsNativeRollback() {
        var sql=session();
        long created=tx.execute(status->{
            long orderId=id(draft());
            List<Map<String,Object>> found=sql.selectList(READ,parameters(orderId,"orders"));
            assertThat(found).hasSize(1);
            assertThat(found.getFirst()).containsKey("cutoff_date").containsEntry("cutoff_date",null);
            assertThat((BigDecimal)found.getFirst().get("total_qty")).isEqualByComparingTo("10.0000");
            assertThat((BigDecimal)found.getFirst().get("total_amount")).isEqualByComparingTo("100.0000");
            status.setRollbackOnly();return orderId;
        });
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order WHERE id=?",Integer.class,created)).isZero();
    }

    @Test void repeatedReadsObserveJdbcChangesAndCurrentCountryRatherThanSessionCache() {
        var sql=session();long orderId=id(draft());
        inCountry(101,()->{
            assertThat(sql.<Map<String,Object>>selectList(READ,parameters(orderId,"orders"))).hasSize(1);
            jdbc.update("UPDATE pur_order SET remark='本事务新值' WHERE id=?",orderId);
            assertThat(sql.<Map<String,Object>>selectList(READ,parameters(orderId,"orders")).getFirst())
                .containsEntry("remark","本事务新值");
            dbContext.apply(102L);
            assertThat(sql.selectList(READ,parameters(orderId,"orders"))).isEmpty();
            dbContext.apply(101L);
            assertThat(sql.selectList(READ,parameters(orderId,"orders"))).hasSize(1);return null;
        });
    }

    @Test void dynamicDocumentSelectionRejectsUnapprovedSqlIdentifiers() {
        var sql=session();long orderId=id(draft());
        assertThatThrownBy(()->inCountry(101,()->sql.selectList(READ,
            parameters(orderId,"pur_order; DELETE FROM pur_order"))))
            .hasRootCauseInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(()->pur.get(c(),"unexpected-kind",orderId))
            .isInstanceOf(com.hs.jxc.common.api.ApiException.class).extracting("status").isEqualTo(404);
        assertThat(owner.queryForObject("SELECT count(*) FROM pur_order WHERE id=?",Integer.class,orderId)).isEqualTo(1);
    }

    @Test void purchaseConfigurationPreservesTheExistingCurrencyMapperAndPlusStatements() {
        var query=new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<com.hs.jxc.org.mapper.CurrencyMapper.Currency>();
        query.eq("code","MXN");
        assertThat(currencies.selectCount(query)).isEqualTo(1);
        assertThat(currencies.selectList(query).getFirst().name).isEqualTo("比索");
    }
}
