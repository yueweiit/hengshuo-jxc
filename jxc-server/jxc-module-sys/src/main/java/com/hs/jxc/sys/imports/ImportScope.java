package com.hs.jxc.sys.imports;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import java.time.LocalDate;
import java.util.function.Supplier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.*;

/** Server-only opening context established from a locked validated batch, never a client source flag. */
public final class ImportScope {
    private ImportScope(){}
    private static final Object KEY=new Object();
    private record State(long country,long batch,String type,LocalDate cutoff){}
    public static boolean allowsOpening(long country,LocalDate date){var state=(State)TransactionSynchronizationManager.getResource(KEY);return TransactionSynchronizationManager.isActualTransactionActive()&&state!=null&&state.country()==country&&date!=null&&!date.isAfter(state.cutoff());}
    public static boolean allowsOpeningCutoff(long country,LocalDate date){var state=(State)TransactionSynchronizationManager.getResource(KEY);return TransactionSynchronizationManager.isActualTransactionActive()&&state!=null&&state.country()==country&&date!=null&&date.equals(state.cutoff());}
    public static boolean allowsOpeningStart(long country,LocalDate date){var state=(State)TransactionSynchronizationManager.getResource(KEY);return TransactionSynchronizationManager.isActualTransactionActive()&&state!=null&&state.country()==country&&state.type().equals("OPENING_GL")&&date!=null&&date.equals(state.cutoff().plusDays(1));}
    static <T>T withinValidatedBatch(RequestContext c,ImportHandler.Batch batch,JdbcTemplate jdbc,Supplier<T>work){
        if(!batch.type().startsWith("OPENING_"))return work.get();
        if(!TransactionSynchronizationManager.isActualTransactionActive()||TransactionSynchronizationManager.hasResource(KEY)||batch.cutoffDate()==null)throw new IllegalStateException("Opening scope requires one confirmed import transaction");
        int valid=jdbc.queryForObject("SELECT count(*) FROM sys_import_batch WHERE country_id=? AND id=? AND import_type=? AND cutoff_date=? AND status='VALIDATED' AND requested_by=?",Integer.class,c.countryId(),batch.id(),batch.type(),batch.cutoffDate(),c.userId());
        if(valid!=1)throw new ApiException(409,"SYS_IMPORT_STATE","期初上下文必须来自本人的已校验导入批次");
        var state=new State(c.countryId(),batch.id(),batch.type(),batch.cutoffDate());TransactionSynchronizationManager.bindResource(KEY,state);
        String prior=jdbc.queryForObject("SELECT current_setting('app.opening_import_batch',true)",String.class);
        jdbc.queryForObject("SELECT set_config('app.opening_import_batch',?,true)",String.class,String.valueOf(batch.id()));
        boolean failed=false;
        try{return work.get();}catch(RuntimeException|Error e){failed=true;throw e;}finally{TransactionSynchronizationManager.unbindResourceIfPossible(KEY);try{jdbc.queryForObject("SELECT set_config('app.opening_import_batch',?,true)",String.class,prior==null?"":prior);}catch(org.springframework.dao.DataAccessException restore){if(!failed)throw restore;}}
    }
}
