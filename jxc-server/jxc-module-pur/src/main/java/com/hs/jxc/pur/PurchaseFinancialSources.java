package com.hs.jxc.pur;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.fin.api.FinancialSourceProvider;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
/** Procurement quantity progress is distinct from confirmed inbound-cost accounting. */
@Component
public class PurchaseFinancialSources implements FinancialSourceProvider {
    private final JdbcTemplate jdbc;private final BookResolver books;
    public PurchaseFinancialSources(JdbcTemplate jdbc,BookResolver books){this.jdbc=jdbc;this.books=books;}
    public boolean supports(String type){return Set.of("PURCHASE_ORDER","PUR_ORDER","DOMESTIC_RECEIPT","EXPORT_NODE").contains(type);}
    public Map<String,Object> accountingFact(Access a,String event,String type,long id,int seq,LocalDate day,Map<String,Object> frozen){
        String table=switch(type){case "PURCHASE_ORDER","PUR_ORDER"->"pur_order";case "DOMESTIC_RECEIPT"->"pur_domestic_receipt";case "EXPORT_NODE"->"pur_export_node";default->throw ApiException.notFound();};
        var rows=jdbc.queryForList("SELECT * FROM "+table+" WHERE country_id=? AND id=?",a.requireCountry(),id);if(rows.isEmpty())throw ApiException.notFound();var row=DbRows.camel(rows.getFirst());books.resolve(a,((Number)row.get("bookId")).longValue(),null);
        return Map.of("bookId",row.get("bookId"),"sourceNo",row.get("docNo"),"payload",Map.of("accountingImpact","NONE","docNo",row.get("docNo"),"reason","采购数量节点，金额由成本确认事实承接"));
    }
}
