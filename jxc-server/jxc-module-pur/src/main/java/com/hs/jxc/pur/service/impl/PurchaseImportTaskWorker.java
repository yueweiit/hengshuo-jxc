package com.hs.jxc.pur.service.impl;
import com.hs.jxc.pur.service.*;

import com.hs.jxc.sys.jobs.CountryWorkProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** 加入既有单一后台调度器，不创建第二套国家扫描/调度线程。 */
@Component
@ConditionalOnProperty(name="jxc.purchase-import.worker-enabled",havingValue="true")
public class PurchaseImportTaskWorker implements CountryWorkProvider {
    private final PurchaseImportTaskServiceImpl tasks;private final PurchaseImportClearService clearing;
    public PurchaseImportTaskWorker(PurchaseImportTaskServiceImpl tasks,PurchaseImportClearService clearing){this.tasks=tasks;this.clearing=clearing;}
    @Override public String kind(){return "PURCHASE_IMPORT";}
    @Override public int recover(long country,int limit){
        int cleared=0;RuntimeException cleanupFailure=null;
        try{cleared=clearing.recover(country,limit);}catch(RuntimeException failure){cleanupFailure=failure;}
        // 存储删除权限/故障不应阻止仍能正常读取原文件的导入任务；既有调度状态仍记录清理失败。
        int recovered;
        try{recovered=tasks.recover(country,Math.max(0,limit-cleared));}
        catch(RuntimeException failure){if(cleanupFailure!=null)failure.addSuppressed(cleanupFailure);throw failure;}
        if(cleanupFailure!=null)throw cleanupFailure;
        return cleared+recovered;
    }
    @Override public void daily(long country){}
}
