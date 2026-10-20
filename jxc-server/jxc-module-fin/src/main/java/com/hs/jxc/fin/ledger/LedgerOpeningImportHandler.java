package com.hs.jxc.fin.ledger;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.imports.ImportHandler;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
@Component
public class LedgerOpeningImportHandler implements ImportHandler {
 private final LedgerService ledger;private final JdbcTemplate db;
 public LedgerOpeningImportHandler(LedgerService ledger,JdbcTemplate db){this.ledger=ledger;this.db=db;}
 public List<String> types(){return List.of("OPENING_GL");}
 public List<String> columns(String type){return List.of("bookId","accountId","currency","origAmount","rate","amount","baseAmount","direction","aux","refNo");}
 public Row validate(Access a,String type,LocalDate cutoff,int rowNo,Map<String,Object> raw){long book=Inputs.id(raw.get("bookId"));String ref=Inputs.required(raw,"refNo");var body=ledger.validateImportedOpening(a,book,raw,cutoff);return new Row(rowNo,body,book+":"+raw.get("accountId")+":"+raw.getOrDefault("currency","")+":"+com.hs.jxc.common.idempotency.IdempotencyExecutor.canonical(raw.getOrDefault("aux",Map.of()))+":"+cutoff);}
 public Target apply(RequestContext c,Access a,Batch batch,Row row){if(!com.hs.jxc.sys.imports.ImportScope.allowsOpening(a.requireCountry(),batch.cutoffDate()))throw new ApiException(409,"SYS_IMPORT_STATE","期初必须通过已校验的导入批次确认");var r=ledger.importOpeningDraft(a,Inputs.id(row.values().get("bookId")),row.values(),"IMPORT:"+batch.id()+":"+row.rowNo(),batch.cutoffDate());return new Target("FIN_OPENING_BALANCE",Inputs.id(r.get("id")));}
 public void finish(RequestContext c,Access a,Batch batch,List<Target> targets){var books=new TreeSet<Long>();for(var target:targets)books.add(db.queryForObject("SELECT book_id FROM fin_opening_balance WHERE country_id=? AND id=?",Long.class,a.requireCountry(),target.id()));for(long book:books){if(db.queryForObject("SELECT count(*) FROM fin_opening_balance WHERE country_id=? AND book_id=? AND status='DRAFT' AND (import_source_ref IS NULL OR import_source_ref NOT LIKE ?)",Integer.class,a.requireCountry(),book,"IMPORT:"+batch.id()+":%")>0)throw Inputs.bad("账套存在本批导入之外的期初草稿，请先处理后重试");ledger.confirmOpening(c,book,Map.of(),UUID.randomUUID().toString());}}
}
