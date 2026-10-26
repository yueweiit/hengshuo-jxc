package com.hs.jxc.fin.workbench;
import com.hs.jxc.sys.jobs.WorkItemProvider;
import com.hs.jxc.sys.api.Access;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
/** Read existing module facts; GET never repairs events or creates tasks. */
@Component
public class FinancialWorkItems implements WorkItemProvider {
    private final JdbcTemplate jdbc;
    public FinancialWorkItems(JdbcTemplate jdbc){this.jdbc=jdbc;}
    public List<Map<String,Object>> items(Access a){var out=new ArrayList<Map<String,Object>>();
        if(a.has("fin:voucher:audit"))for(var r:jdbc.queryForList("SELECT id,book_id,created_at FROM fin_voucher WHERE country_id=? AND status='PENDING_AUDIT' ORDER BY id",a.requireCountry()))if(a.canBook(((Number)r.get("book_id")).longValue()))out.add(Map.of("id",r.get("id"),"todoType","VOUCHER_AUDIT","typeLabel","凭证待审核","title","凭证待审核","link","/finance/vouchers?bookId="+r.get("book_id")+"&voucherId="+r.get("id"),"createdAt",r.get("created_at").toString()));
        if(a.has("fin:voucher:generate")||a.has("fin:ledger:view")||a.has("fin:mapping:edit"))for(var r:jdbc.queryForList("SELECT e.id,e.book_id,e.occurred_at FROM sys_biz_event e WHERE e.country_id=? AND NOT(e.source_type='SYS_REPORT_EXPORT' AND e.event_type='SYS_REPORT_EXPORT_REQUESTED') AND NOT EXISTS(SELECT 1 FROM sys_biz_event_consume c WHERE c.country_id=e.country_id AND c.event_id=e.id AND c.consumer='FIN_VOUCHER' AND c.status='DONE') ORDER BY e.id",a.requireCountry()))if(a.canBook(((Number)r.get("book_id")).longValue()))out.add(Map.of("id",r.get("id"),"todoType","FIN_EVENT","typeLabel","财务事件待处理","title","业务事件待生成凭证","link","/finance/events","createdAt",r.get("occurred_at").toString()));
        return out;
    }
}
