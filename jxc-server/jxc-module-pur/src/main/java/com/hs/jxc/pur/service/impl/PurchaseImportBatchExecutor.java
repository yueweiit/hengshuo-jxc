package com.hs.jxc.pur.service.impl;

import java.util.*;
import java.util.concurrent.*;
import org.springframework.stereotype.Component;
import jakarta.annotation.PreDestroy;

/** 采购核对专用上限，不更改全系统后台线程；滚动提交避免排队持有大图。 */
@Component
final class PurchaseImportBatchExecutor implements AutoCloseable {
    private final ExecutorService pool=Executors.newFixedThreadPool(3,r->{var t=new Thread(r,"purchase-image-review");t.setDaemon(true);return t;});
    synchronized void run(List<Runnable> work){
        var completion=new ExecutorCompletionService<Void>(pool);int submitted=0,finished=0;RuntimeException failed=null;
        try{
            while(submitted<Math.min(3,work.size())){completion.submit(work.get(submitted++),null);}
            while(finished<work.size()){
                try{completion.take().get();}catch(ExecutionException e){if(failed==null)failed=new IllegalStateException("采购核对批次执行失败",e.getCause());else failed.addSuppressed(e.getCause());}
                finished++;if(submitted<work.size())completion.submit(work.get(submitted++),null);
            }
        }catch(InterruptedException e){Thread.currentThread().interrupt();throw new IllegalStateException("采购核对批次等待中断，原任务将按租约恢复",e);}
        if(failed!=null)throw failed;
    }
    @Override @PreDestroy public void close(){pool.shutdownNow();}
}
