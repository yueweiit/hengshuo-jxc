package com.hs.jxc.sys.service;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.sys.api.Access;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** Authorization establishes identity and scope; lifecycle independently bounds actions. */
@Service
public class CountryLifecycle {
    private final JdbcTemplate jdbc;
    public CountryLifecycle(JdbcTemplate jdbc){this.jdbc=jdbc;}
    public void requireReadable(Access access){requireReadable(access.requireCountry());}
    public void requireConfigurationWritable(Access access){requireConfigurationWritable(access.requireCountry());}
    public void requireTradeActive(Access access){requireTradeActive(access.requireCountry());}
    public void requireReadable(long country){status(country);}
    public void requireConfigurationWritable(long country){if("DISABLED".equals(status(country)))throw new ApiException(409,"SYS_COUNTRY_DISABLED","国家已停用，只能查询历史记录");}
    public void requireTradeActive(long country){if(!"ACTIVE".equals(status(country)))throw new ApiException(409,"SYS_COUNTRY_NOT_ACTIVE","国家未启用，不能执行普通业务交易");}
    private String status(long country){var rows=jdbc.queryForList("SELECT status FROM sys_country WHERE id=? FOR SHARE",String.class,country);if(rows.isEmpty())throw ApiException.notFound();return rows.getFirst();}
}
