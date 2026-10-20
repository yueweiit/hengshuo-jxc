package com.hs.jxc.fin.service;

import java.time.LocalDate;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.fin.api.PeriodApi;
import com.hs.jxc.common.db.BookGate;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Service
public class PeriodGuard implements PeriodApi {
    private final JdbcTemplate jdbc;private final BookGate books;private final com.hs.jxc.sys.service.CountryLifecycle lifecycle;
    public PeriodGuard(JdbcTemplate jdbc,BookGate books,com.hs.jxc.sys.service.CountryLifecycle lifecycle){this.jdbc=jdbc;this.books=books;this.lifecycle=lifecycle;}
    public void assertOpen(long countryId,long bookId,LocalDate date) {
        requireTransaction();
        if(date==null)throw new ApiException(400,"SYS_BAD_REQUEST","请提供业务日期");
        if(com.hs.jxc.sys.imports.ImportScope.allowsOpening(countryId,date))lifecycle.requireConfigurationWritable(countryId);else lifecycle.requireTradeActive(countryId);
        books.lock(countryId,bookId,false);
        checkState(countryId,bookId,date,true);
    }
    @Override public void assertOpeningPeriod(long countryId,long bookId,LocalDate date){
        if(!com.hs.jxc.sys.imports.ImportScope.allowsOpeningStart(countryId,date)){assertOpen(countryId,bookId,date);return;}
        requireTransaction();lifecycle.requireConfigurationWritable(countryId);books.lock(countryId,bookId,false);checkState(countryId,bookId,date,false);
    }
    @Override public void assertOpeningCutoff(long countryId,long bookId,LocalDate cutoff){
        requireTransaction();
        if(cutoff==null||!com.hs.jxc.sys.imports.ImportScope.allowsOpeningCutoff(countryId,cutoff))throw new ApiException(409,"SYS_IMPORT_SCOPE_REQUIRED","期初截止日期必须来自当前已校验导入事务");
        lifecycle.requireConfigurationWritable(countryId);books.lock(countryId,bookId,false);
        queryState("SELECT jxc_assert_opening_cutoff_period(?,?,?)",countryId,bookId,cutoff);
    }
    @Override public void assertImportedOpeningCutoff(long countryId,long bookId,LocalDate cutoff,String targetType,long targetId){
        requireTransaction();
        if(cutoff==null||targetId<1||!java.util.Set.of("PURCHASE_ORDER","SHIPMENT").contains(targetType))throw new ApiException(400,"SYS_BAD_REQUEST","原生期初来源不合法");
        lifecycle.requireTradeActive(countryId);books.lock(countryId,bookId,false);
        queryState("SELECT jxc_assert_imported_opening_source_period(?,?,?,?,?)",countryId,bookId,cutoff,targetType,targetId);
    }
    private void checkState(long country,long book,LocalDate date,boolean trade){
        queryState(trade?"SELECT jxc_assert_period_open(?,?,?)":"SELECT jxc_assert_period_state(?,?,?)",country,book,date);
    }
    private void queryState(String query,Object...args){
        try{jdbc.query(query,rs->{},args);}
        catch(DataAccessException e){String detail=String.valueOf(e.getMostSpecificCause().getMessage());for(String code:new String[]{"FIN_BOOK_NOT_ACTIVE","FIN_PERIOD_NOT_FOUND","FIN_PERIOD_CLOSED","FIN_OPENING_CUTOFF"})if(detail.contains(code))throw new ApiException(400,code,"业务日期所属账套或会计期间不可写入");for(String code:new String[]{"SYS_IMPORT_OPENING_SOURCE_MISMATCH","SYS_IMPORT_SOURCE_MISMATCH"})if(detail.contains(code))throw new ApiException(409,code,"期初来源与已确认导入事实不一致");throw e;}
    }
    public void lockExclusive(long countryId,long bookId) {
        requireTransaction();
        books.lock(countryId,bookId,true);
    }
    private static void requireTransaction(){if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Period gates require a business transaction");}
}
