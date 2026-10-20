package com.hs.jxc.fin.service;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.BookGate;
import com.hs.jxc.fin.api.SnapshotApi;
import com.hs.jxc.sys.api.Access;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Pins the period state and immutable closed generation when the export is queued. */
@Component
public class ExportPeriodContext {
    private static final String KEY="_periodContext";
    private final JdbcTemplate db;private final BookGate gates;private final SnapshotApi snapshots;
    public ExportPeriodContext(JdbcTemplate db,BookGate gates,SnapshotApi snapshots){this.db=db;this.gates=gates;this.snapshots=snapshots;}
    private Map<String,Object> current(Access a,long book,long period,String snapshotType){
        gates.lock(a.requireCountry(),book,false);
        var rows=db.queryForList("SELECT status,close_generation FROM fin_period WHERE country_id=? AND book_id=? AND id=?",a.requireCountry(),book,period);
        if(rows.isEmpty())throw ApiException.notFound();
        var out=new LinkedHashMap<String,Object>();String status=rows.getFirst().get("status").toString();out.put("status",status);out.put("closeGeneration",rows.getFirst().get("close_generation").toString());
        if(status.equals("CLOSED")){
            var saved=snapshots.latest(a,book,period,snapshotType);
            if(saved==null)throw new ApiException(409,"FIN_SNAPSHOT_MISSING","已结账期间缺少导出快照");
            out.put("snapshotId",saved.get("id").toString());if(!out.get("closeGeneration").equals(saved.get("closeGeneration").toString()))throw new ApiException(409,"FIN_SNAPSHOT_MISSING","结账代次与导出快照不一致");
        }
        return out;
    }
    public Map<String,Object> capture(Access a,long book,Map<String,Object> request,String snapshotType){
        var out=new LinkedHashMap<>(request);out.put(KEY,current(a,book,Inputs.id(request.get("periodId")),snapshotType));return out;
    }
    public void verify(Access a,long book,Map<String,Object> request,String snapshotType){
        if(!Objects.equals(request.get(KEY),current(a,book,Inputs.id(request.get("periodId")),snapshotType)))
            throw new ApiException(409,"JOB_CONTEXT_CHANGED","会计期间或结账代次已变化，请回到业务页面重新发起导出");
    }
}
