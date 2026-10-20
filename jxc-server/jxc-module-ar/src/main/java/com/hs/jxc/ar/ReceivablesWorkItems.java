package com.hs.jxc.ar;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.WorkItemProvider;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
@Component
public class ReceivablesWorkItems implements WorkItemProvider {
 private final JdbcTemplate jdbc;public ReceivablesWorkItems(JdbcTemplate jdbc){this.jdbc=jdbc;}
 public List<Map<String,Object>> items(Access a){var out=new ArrayList<Map<String,Object>>();if(a.has("ar:receipt:confirm"))for(var raw:jdbc.queryForList("SELECT r.*,b.entity_id FROM ar_receipt r JOIN fin_book b ON b.country_id=r.country_id AND b.id=r.book_id WHERE r.country_id=? AND r.status='PENDING_CONFIRM' ORDER BY r.id",a.requireCountry())){var r=DbRows.camel(raw);if(a.canRow(r))out.add(item(r,"PENDING_PAYMENT_CONFIRM","收款待确认","/ar/receipts"));}if(a.has("ar:receivable:view"))for(var raw:jdbc.queryForList("SELECT r.*,b.entity_id,c.store_id FROM ar_receivable r JOIN fin_book b ON b.country_id=r.country_id AND b.id=r.book_id JOIN md_customer c ON c.country_id=r.country_id AND c.id=r.customer_id JOIN sys_country ct ON ct.id=r.country_id WHERE r.country_id=? AND r.open_amount>0 AND r.due_date<(clock_timestamp() AT TIME ZONE ct.timezone)::date ORDER BY r.id",a.requireCountry())){var r=DbRows.camel(raw);if(a.canRow(r))out.add(item(r,"OVERDUE_FOLLOWUP","应收已逾期","/ar/receivables"));}return out;}
 private Map<String,Object> item(Map<String,Object>r,String type,String label,String link){return Map.of("id",r.get("id"),"todoType",type,"typeLabel",label,"title",label+" "+r.get("docNo"),"link",link,"createdAt",r.get("createdAt").toString());}
}
