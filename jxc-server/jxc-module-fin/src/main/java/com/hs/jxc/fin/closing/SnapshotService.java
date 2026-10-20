package com.hs.jxc.fin.closing;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.fin.api.SnapshotApi;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Deliberately independent of report/accounting services, so frozen reads cannot recompute facts. */
@Service
public class SnapshotService implements SnapshotApi {
    private final JdbcTemplate db;private final JsonCodec json;private final BookResolver books;
    public SnapshotService(JdbcTemplate db,JsonCodec json,BookResolver books){this.db=db;this.json=json;this.books=books;}
    @Override public Map<String,Object> latest(Access a,long book,long period,String type){
        if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Snapshot API requires caller transaction");
        books.resolve(a,book,null);if(!Set.of("BALANCE","REPORT","RECONCILE").contains(type))throw Inputs.bad("快照类型不合法");
        var rows=db.queryForList("SELECT * FROM fin_snapshot WHERE country_id=? AND book_id=? AND period_id=? AND snapshot_type=? ORDER BY close_generation DESC LIMIT 1",a.requireCountry(),book,period,type);
        return rows.isEmpty()?null:dto(rows.getFirst());
    }
    public List<Map<String,Object>> generation(Access a,long book,long period,int generation){books.resolve(a,book,null);return db.queryForList("SELECT * FROM fin_snapshot WHERE country_id=? AND book_id=? AND period_id=? AND close_generation=? ORDER BY snapshot_type",a.requireCountry(),book,period,generation).stream().map(this::dto).toList();}
    private Map<String,Object> dto(Map<String,Object> raw){var r=DbRows.camel(raw);for(String k:List.of("content","sourceVersions"))r.put(k,json.readMap(r.get(k).toString()));return r;}
}
