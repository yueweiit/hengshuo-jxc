package com.hs.jxc.common.db;
import org.springframework.stereotype.Component;
import org.springframework.jdbc.core.JdbcTemplate;
import com.hs.jxc.common.api.ApiException;
import org.springframework.transaction.support.*;
import java.util.*;
@Component
public class BookGate {
    private final JdbcTemplate jdbc;private static final Object HELD=new Object();
    private record Key(long country,long book){}
    public BookGate(JdbcTemplate jdbc){this.jdbc=jdbc;}
    @SuppressWarnings("unchecked")
    public void lock(long country,long book,boolean exclusive){
        if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Book gate requires a transaction");
        Map<Key,Boolean> held=(Map<Key,Boolean>)TransactionSynchronizationManager.getResource(HELD);
        if(held==null){held=new LinkedHashMap<>();TransactionSynchronizationManager.bindResource(HELD,held);final var resource=held;TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization(){
            @Override public void suspend(){TransactionSynchronizationManager.unbindResourceIfPossible(HELD);}
            @Override public void resume(){TransactionSynchronizationManager.bindResource(HELD,resource);}
            @Override public void afterCompletion(int status){if(TransactionSynchronizationManager.getResource(HELD)==resource)TransactionSynchronizationManager.unbindResource(HELD);}
        });}
        var key=new Key(country,book);
        if(held.containsKey(key)){if(exclusive&&!held.get(key))throw new IllegalStateException("Begin an exclusive book command before taking a shared gate");return;}
        if(held.keySet().stream().anyMatch(k->k.country()>country||k.country()==country&&k.book()>book))throw new IllegalStateException("Acquire book gates in country and ID order");
        if(jdbc.queryForList("SELECT id FROM fin_book WHERE country_id=? AND id=? FOR "+(exclusive?"UPDATE":"SHARE"),country,book).isEmpty())throw ApiException.notFound();
        held.put(key,exclusive);
    }
}
