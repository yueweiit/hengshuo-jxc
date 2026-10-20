package com.hs.jxc.fin.ledger;

import com.hs.jxc.attachment.AttachmentService;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.*;
import com.hs.jxc.sys.service.DocumentAccessService;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Voucher attachments and source drilldowns reuse the existing trusted document registry. */
@Component
public class LedgerDocumentPolicies {
    public LedgerDocumentPolicies(DocumentAccessService documents,AttachmentService attachments,JdbcTemplate jdbc,BookGate gates){
        for(String type:List.of("FIN_VOUCHER","VOUCHER")){
            documents.register(type,List.of("fin:ledger:view","fin:voucher:create","fin:voucher:audit"),List.of("fin:voucher:edit"),(a,id)->{
                var rs=jdbc.queryForList("SELECT id,country_id,book_id,version,status FROM fin_voucher WHERE country_id=? AND id=?",a.requireCountry(),id);if(rs.isEmpty())return null;var r=DbRows.camel(rs.getFirst());if(!a.canBook(((Number)r.get("bookId")).longValue()))throw ApiException.notFound();return r;
            },(a,id)->{var rs=jdbc.queryForList("SELECT book_id FROM fin_voucher WHERE country_id=? AND id=?",a.requireCountry(),id);if(rs.isEmpty())throw ApiException.notFound();long book=((Number)rs.getFirst().get("book_id")).longValue();if(!a.canBook(book))throw ApiException.notFound();gates.lock(a.requireCountry(),book,false);jdbc.queryForList("SELECT id FROM fin_voucher WHERE country_id=? AND id=? FOR UPDATE",a.requireCountry(),id);});
            attachments.registerCategories(type,Map.of("VOUCHER_ATTACH",Set.of("COST","ORDER_TOTAL","BANK_INFO")));
            attachments.registerMutationGuard(type,(a,source,category,operation)->{if(!"DRAFT".equals(source.get("status")))throw new ApiException(400,"FIN_POSTED_LOCKED","凭证提交后附件只读，请保留审计证据");long book=((Number)source.get("bookId")).longValue();var dates=jdbc.queryForList("SELECT voucher_date FROM fin_voucher WHERE country_id=? AND id=?",a.requireCountry(),source.get("id"));jdbc.query("SELECT jxc_assert_period_open(?,?,?)",rs->{},a.requireCountry(),book,dates.getFirst().get("voucher_date"));});
        }
    }
}
