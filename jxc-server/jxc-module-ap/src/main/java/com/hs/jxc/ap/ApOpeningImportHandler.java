package com.hs.jxc.ap;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.BookGate;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.imports.ImportHandler;
import com.hs.jxc.sys.service.FieldPolicyService;
import java.math.*;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Actual native opening subledger facts. No payment, cash event, or GL voucher is invented. */
@Component
public class ApOpeningImportHandler implements ImportHandler {
 private final JdbcTemplate db;private final BookResolver books;private final BookGate gates;private final FieldPolicyService fields;private final AuditWriter audit;
 public ApOpeningImportHandler(JdbcTemplate db,BookResolver books,BookGate gates,FieldPolicyService fields,AuditWriter audit){this.db=db;this.books=books;this.gates=gates;this.fields=fields;this.audit=audit;}
 public List<String> types(){return List.of("OPENING_AP","OPENING_PREPAYMENT");}
 public List<String> columns(String type){return List.of("bookId","partnerType","partnerId","currency","amount","baseAmount","rate","refNo","sourceDate");}
 private String table(String type){return switch(type){case "OPENING_AP"->"ap_bill";case "OPENING_PREPAYMENT"->"ap_prepayment";default->throw Inputs.bad("期初类型不支持");};}
 public Row validate(Access a,String type,LocalDate cutoff,int rowNo,Map<String,Object> raw){
  a.require("ap:opening:edit");fields.requireWrite(a,raw,"COST");long book=Inputs.id(raw.get("bookId"));books.resolve(a,book,null);String party=Inputs.text(raw,"partnerType","SUPPLIER");if(!Set.of("SUPPLIER","CARRIER").contains(party))throw Inputs.bad("往来对象类型不支持");long partner=Inputs.id(raw.get("partnerId"));String partnerTable=party.equals("SUPPLIER")?"md_supplier":"md_logistics_provider";
  if(db.queryForObject("SELECT count(*) FROM "+partnerTable+" WHERE country_id=? AND id=? AND status='ENABLED'",Integer.class,a.requireCountry(),partner)!=1)throw ApiException.notFound();
  if(cutoff==null||cutoff.isAfter(db.queryForObject("SELECT (clock_timestamp() AT TIME ZONE timezone)::date FROM sys_country WHERE id=?",LocalDate.class,a.requireCountry())))throw Inputs.bad("请填写真实的期初截止日期");
  LocalDate sourceDate;try{sourceDate=raw.get("sourceDate")==null?cutoff:LocalDate.parse(Inputs.required(raw,"sourceDate"));}catch(java.time.DateTimeException invalid){throw Inputs.bad("期初来源日期格式不合法");}if(sourceDate.isAfter(cutoff))throw Inputs.bad("期初来源日期不能晚于截止日期");
  var first=db.queryForList("SELECT start_date,status FROM fin_period WHERE country_id=? AND book_id=? ORDER BY start_date LIMIT 1",a.requireCountry(),book);if(first.isEmpty()||!cutoff.plusDays(1).equals(((java.sql.Date)first.getFirst().get("start_date")).toLocalDate())||!"OPEN".equals(first.getFirst().get("status")))throw Inputs.bad("期初截止日必须紧接首个开放核算期间之前");
  String currency=Inputs.required(raw,"currency"),base=books.baseCurrency(a,book);int scale=scale(base);BigDecimal amount=Inputs.decimal(raw.get("amount"),scale(currency),Inputs.PUBLIC_DECIMAL_MAX),baseAmount=Inputs.decimal(raw.get("baseAmount"),scale,Inputs.PUBLIC_DECIMAL_MAX);if(amount.signum()<=0||baseAmount.signum()<0)throw Inputs.bad("期初原币金额必须为正且本位币金额不能为负");
  BigDecimal rate=currency.equals(base)?BigDecimal.ONE:Inputs.decimal(raw.get("rate"),8,Inputs.PUBLIC_DECIMAL_MAX);if(rate.signum()<=0||amount.multiply(rate).setScale(scale,RoundingMode.HALF_UP).compareTo(baseAmount)!=0)throw Inputs.bad("期初原币、汇率与本位币金额不一致");String ref=Inputs.required(raw,"refNo");if(ref.length()>128)throw Inputs.bad("期初来源编号过长");
  if(db.queryForObject("SELECT count(*) FROM "+table(type)+" WHERE country_id=? AND book_id=? AND partner_type=? AND partner_id=? AND opening_ref_no=?",Integer.class,a.requireCountry(),book,party,partner,ref)>0)throw new ApiException(409,"AP_OPENING_EXISTS","该来源期初余额已存在");
  var value=new LinkedHashMap<String,Object>();value.put("bookId",book);value.put("entityId",books.entityId(a,book));value.put("partnerType",party);value.put("partnerId",partner);value.put("currency",currency);value.put("baseCurrency",base);value.put("amount",amount);value.put("baseAmount",baseAmount);value.put("rate",rate);value.put("refNo",ref);value.put("sourceDate",sourceDate.toString());return new Row(rowNo,value,book+":"+party+":"+partner+":"+ref);
 }
 private int scale(String currency){var rows=db.queryForList("SELECT decimals FROM md_currency WHERE code=? AND status='ENABLED'",currency);if(rows.isEmpty())throw Inputs.bad("币种未启用");return ((Number)rows.getFirst().get("decimals")).intValue();}
 public Target apply(RequestContext c,Access a,Batch batch,Row row){
  if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Opening requires caller transaction");if(!com.hs.jxc.sys.imports.ImportScope.allowsOpening(a.requireCountry(),batch.cutoffDate()))throw new ApiException(409,"SYS_IMPORT_STATE","期初必须通过已校验的导入批次确认");long book=Inputs.id(row.values().get("bookId"));gates.lock(a.requireCountry(),book,true);var r=validate(a,batch.type(),batch.cutoffDate(),row.rowNo(),row.values()).values();String source="IMPORT:"+batch.id()+":"+row.rowNo(),table=table(batch.type()),day=batch.type().equals("OPENING_AP")?"bill_date":"pay_date";
  String extra=batch.type().equals("OPENING_AP")?",bill_type,due_date":",confirmed_by,confirmed_at";String values=batch.type().equals("OPENING_AP")?",'OTHER',?":",?,clock_timestamp()";
  var args=new ArrayList<Object>(Arrays.asList(a.requireCountry(),r.get("entityId"),book,r.get("partnerType"),r.get("partnerId"),"OPEN-"+batch.id()+"-"+row.rowNo(),r.get("currency"),r.get("amount"),batch.cutoffDate(),r.get("baseCurrency"),r.get("rate"),batch.cutoffDate(),r.get("baseAmount"),source,r.get("refNo"),batch.cutoffDate()));args.add(batch.type().equals("OPENING_AP")?batch.cutoffDate():a.userId());
  long id=db.queryForObject("INSERT INTO "+table+"(country_id,entity_id,book_id,partner_type,partner_id,doc_no,currency,amount,"+day+",base_currency,rate,rate_date,base_amount,valuation_status,status,origin_kind,opening_source_ref,opening_ref_no,opening_cutoff"+extra+") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'READY','CONFIRMED','OPENING',?,?,?"+values+") RETURNING id",Long.class,args.toArray());
  audit.append(c,"导入真实期初余额",batch.type(),id,null,Map.of("sourceRef",source,"cutoffDate",batch.cutoffDate().toString(),"refNo",r.get("refNo")));return new Target(batch.type().equals("OPENING_AP")?"AP_BILL":"AP_PREPAYMENT",id);
 }
}
