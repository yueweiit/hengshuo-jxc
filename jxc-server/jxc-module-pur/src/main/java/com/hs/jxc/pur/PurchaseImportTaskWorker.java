package com.hs.jxc.pur;

import com.hs.jxc.sys.jobs.CountryWorkProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** 加入既有单一后台调度器，不创建第二套国家扫描/调度线程。 */
@Component
@ConditionalOnProperty(name="jxc.purchase-import.worker-enabled",havingValue="true")
public class PurchaseImportTaskWorker implements CountryWorkProvider {
    private final PurchaseImportTaskService tasks;
    public PurchaseImportTaskWorker(PurchaseImportTaskService tasks){this.tasks=tasks;}
    @Override public String kind(){return "PURCHASE_IMPORT";}
    @Override public int recover(long country,int limit){return tasks.recover(country,limit);}
    @Override public void daily(long country){}
}
