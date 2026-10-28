package com.hs.jxc.pur.mapper;

import javax.sql.DataSource;
import java.util.UUID;
import org.apache.ibatis.session.*;
import org.apache.ibatis.type.*;
import org.mybatis.spring.SqlSessionFactoryBean;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

/** 采购范围内配置；继续使用应用已有DataSource和Spring事务。 */
@Configuration(proxyBeanMethods = false)
public class PurchaseMyBatisConfiguration {
    @Bean
    public Sessions purchaseSessions(DataSource dataSource) throws Exception {
        var configuration = new org.apache.ibatis.session.Configuration();
        configuration.setMapUnderscoreToCamelCase(false);
        configuration.setCallSettersOnNulls(true);
        configuration.setReturnInstanceForEmptyRow(true);
        configuration.setCacheEnabled(false);
        configuration.setLocalCacheScope(LocalCacheScope.STATEMENT);
        configuration.setJdbcTypeForNull(JdbcType.NULL);
        configuration.getTypeHandlerRegistry().register(UUID.class, new PurchaseUuidTypeHandler());
        // Map投影沿用驱动原值，时间/JSONB/金额的转换继续由既有业务投影负责。
        for (JdbcType type : JdbcType.values())
            configuration.getTypeHandlerRegistry().register(Object.class, type, new ObjectTypeHandler());
        var factory = new SqlSessionFactoryBean();
        factory.setDataSource(dataSource);
        factory.setConfiguration(configuration);
        factory.setMapperLocations(new PathMatchingResourcePatternResolver().getResources("classpath*:mapper/pur/*.xml"));
        return new Sessions(new SqlSessionTemplate(factory.getObject()));
    }

    /** 不暴露SqlSessionFactory/Template类型Bean，保留其他模块既有自动配置。 */
    public record Sessions(SqlSessionTemplate template) {}

    @Bean public PurchaseMapper purchaseMapper(Sessions sessions) { return sessions.template().getMapper(PurchaseMapper.class); }
    @Bean public PurchaseImportMapper purchaseImportMapper(Sessions sessions) { return sessions.template().getMapper(PurchaseImportMapper.class); }
    @Bean public PurchaseImportTaskMapper purchaseImportTaskMapper(Sessions sessions) { return sessions.template().getMapper(PurchaseImportTaskMapper.class); }
    @Bean public PurchaseImportDraftMapper purchaseImportDraftMapper(Sessions sessions) { return sessions.template().getMapper(PurchaseImportDraftMapper.class); }
    @Bean public PurchaseImportProductMapper purchaseImportProductMapper(Sessions sessions) { return sessions.template().getMapper(PurchaseImportProductMapper.class); }
    @Bean public PurchaseImportPhotoMapper purchaseImportPhotoMapper(Sessions sessions) { return sessions.template().getMapper(PurchaseImportPhotoMapper.class); }
    @Bean public PurchaseImportMatchMapper purchaseImportMatchMapper(Sessions sessions) { return sessions.template().getMapper(PurchaseImportMatchMapper.class); }
    @Bean public PurchaseImportTraceMapper purchaseImportTraceMapper(Sessions sessions) { return sessions.template().getMapper(PurchaseImportTraceMapper.class); }
    @Bean public PurchaseOpeningMapper purchaseOpeningMapper(Sessions sessions) { return sessions.template().getMapper(PurchaseOpeningMapper.class); }
    @Bean public PurchaseFinancialSourceMapper purchaseFinancialSourceMapper(Sessions sessions) { return sessions.template().getMapper(PurchaseFinancialSourceMapper.class); }
    @Bean public PurchaseWorkItemMapper purchaseWorkItemMapper(Sessions sessions) { return sessions.template().getMapper(PurchaseWorkItemMapper.class); }
}
