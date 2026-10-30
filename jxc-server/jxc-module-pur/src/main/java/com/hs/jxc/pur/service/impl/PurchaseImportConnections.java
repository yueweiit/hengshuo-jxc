package com.hs.jxc.pur.service.impl;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.sys.integrations.ExternalServiceConfig;
import java.util.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 绑定版本复用原任务锁；运行读取复用原 scoped 授权，不另建任务凭证流程。 */
@Service
public class PurchaseImportConnections {
    private final JdbcTemplate jdbc;private final ExternalServiceConfig config;private final ObjectProvider<PurchaseImportTaskServiceImpl> tasks;
    public PurchaseImportConnections(JdbcTemplate jdbc,ExternalServiceConfig config,ObjectProvider<PurchaseImportTaskServiceImpl> tasks){this.jdbc=jdbc;this.config=config;this.tasks=tasks;}
    @Transactional public void pin(long country,UUID task){jdbc.update("UPDATE pur_order_import_task SET service_config_version=coalesce(service_config_version,?) WHERE country_id=? AND id=?",config.currentVersion(),country,task);}
    public Map<String,Object> forTask(UUID task,String credential){return snapshot(tasks.getObject().scoped(task,credential,false).task());}
    public int versionForTask(UUID task,String credential){return version(tasks.getObject().scoped(task,credential,false).task());}
    public Map<String,Object> snapshot(Map<String,Object> task){
        return config.snapshot(version(task));
    }
    private int version(Map<String,Object> task){if(!(task.get("service_config_version") instanceof Number value))throw new ApiException(503,"INTEGRATION_TASK_VERSION_MISSING","采购任务尚未绑定服务配置版本，请重新领取任务");return value.intValue();}
}
