package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.sys.imports.*;
import com.hs.jxc.sys.service.AuthorizationService;
import com.hs.jxc.fin.api.FinancialSourceProvider;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
class FinancialOpeningImportsIT extends PayablesFixtures {
 @Autowired ImportService imports;@Autowired AuthorizationService auth;@Autowired List<FinancialSourceProvider> sources;
 final LocalDate cutoff=LocalDate.of(2026,9,30);
 Map<String,Object> batch(String type,List<Map<String,Object>> rows){var b=imports.create(c(),Map.of("importType",type,"cutoffDate",cutoff.toString(),"rows",rows));assertThat(b.get("status")).as(b.toString()).isEqualTo("VALIDATED");return b;}
 void confirm(Map<String,Object> b){imports.confirm(c(),id(b),key());}
 @Test void openingPayableAndPrepaymentAreNativeSettleableFactsWithoutInventedCashOrVoucher(){
  seed("UPDATE sys_country SET status='DRAFT' WHERE id=101");
  for(String type:List.of("OPENING_AP","OPENING_PREPAYMENT"))confirm(batch(type,List.of(Map.of("bookId",601,"partnerId",801,"currency","MXN","amount",40,"baseAmount",40,"refNo",type))));
  long bill=owner.queryForObject("SELECT id FROM ap_bill WHERE origin_kind='OPENING'",Long.class),prepaid=owner.queryForObject("SELECT id FROM ap_prepayment WHERE origin_kind='OPENING'",Long.class);
  assertThat(owner.queryForObject("SELECT status FROM ap_bill WHERE id=?",String.class,bill)).isEqualTo("CONFIRMED");assertThat(owner.queryForObject("SELECT fund_account_id FROM ap_prepayment WHERE id=?",Long.class,prepaid)).isNull();
  assertThat(owner.queryForObject("SELECT count(*) FROM ap_payment",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event",Integer.class)).isZero();
  var cash=inCountry(101,()->sources.stream().filter(p->p.supports("AP_BILL")).findFirst().orElseThrow().balances(auth.authorize(c()),601,cutoff,"CASH"));assertThat(cash).isEmpty();
  seed("UPDATE sys_country SET status='ACTIVE' WHERE id=101");ap.settle(c(),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("billId",bill,"fromType","PREPAYMENT","fromId",prepaid,"fromAmount",40,"billAmount",40))),key());assertThat(owner.queryForObject("SELECT paid_amount FROM ap_bill WHERE id=?",BigDecimal.class,bill)).isEqualByComparingTo("40");
 }
 @Test void payableOpeningRetainsSourceDateAndRejectsSourcesAfterCutoff(){
  for(String type:List.of("OPENING_AP","OPENING_PREPAYMENT")){
   var row=new HashMap<String,Object>(Map.of("bookId",601,"partnerId",801,"currency","MXN","amount",40,"baseAmount",40,"refNo",type+"-FUTURE","sourceDate","2026-10-01"));
   var invalid=imports.create(c(),Map.of("importType",type,"cutoffDate",cutoff.toString(),"rows",List.of(row)));assertThat(invalid.get("status")).isEqualTo("VALIDATION_FAILED");
   row.put("sourceDate","2026-09-15");row.put("refNo",type+"-PRIOR");var valid=batch(type,List.of(row));assertThat(valid.get("preview").toString()).contains("sourceDate=2026-09-15");
  }
 }
 @Test void openingProofRejectsChangedReviewedValuationBasis(){
  seed("UPDATE sys_country SET status='DRAFT' WHERE id=101");
  int number=0;
  for(String mutation:List.of("NEW.rate:=2;","NEW.base_currency:='CNY';","NEW.rate_date:=NEW.rate_date-1;")){
   var b=batch("OPENING_AP",List.of(Map.of("bookId",601,"partnerId",801,"currency","MXN","amount",40,"baseAmount",40,"refNo","DRIFT-"+(++number))));
   seed("CREATE FUNCTION synthetic_opening_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "+mutation+" RETURN NEW;END $$");seed("CREATE TRIGGER aaa_synthetic_opening_drift BEFORE INSERT ON ap_bill FOR EACH ROW EXECUTE FUNCTION synthetic_opening_drift()");
   try{assertThatThrownBy(()->confirm(b)).hasStackTraceContaining("SYS_IMPORT_OPENING_SOURCE_MISMATCH");assertThat(owner.queryForObject("SELECT count(*) FROM ap_bill",Integer.class)).isZero();}
   finally{seed("DROP TRIGGER aaa_synthetic_opening_drift ON ap_bill");seed("DROP FUNCTION synthetic_opening_drift()");}
  }
 }
 @Test void glOpeningAuxiliarySourceKeySurvivesPersistedJsonObjectOrdering(){
  seed("INSERT INTO fin_account(id,country_id,book_id,code,name,category,direction,aux_types) VALUES(9901,101,601,'1001','Asset','ASSET','DEBIT','[\"fundAccountId\",\"supplierId\"]'),(9902,101,601,'3001','Equity','EQUITY','CREDIT','[]')");
  var aux=new LinkedHashMap<String,Object>();aux.put("fundAccountId",901);aux.put("supplierId",801);
  confirm(batch("OPENING_GL",List.of(Map.of("bookId",601,"accountId",9901,"amount",50,"refNo","AUX-D","aux",aux),Map.of("bookId",601,"accountId",9902,"amount",50,"refNo","AUX-C"))));
  assertThat(owner.queryForObject("SELECT count(*) FROM fin_opening_balance WHERE status='CONFIRMED'",Integer.class)).isEqualTo(2);
 }
 @Test void glOpeningBatchUsesExistingBalancedAtomicConfirmationAndRollback(){
  seed("UPDATE sys_country SET status='DRAFT' WHERE id=101");
  seed("INSERT INTO fin_account(id,country_id,book_id,code,name,category,direction) VALUES(9901,101,601,'1001','Asset','ASSET','DEBIT'),(9902,101,601,'3001','Equity','EQUITY','CREDIT')");
  var unbalanced=batch("OPENING_GL",List.of(Map.of("bookId",601,"accountId",9901,"amount",50,"refNo","D")));assertThatThrownBy(()->confirm(unbalanced)).hasMessageContaining("不平");assertThat(owner.queryForObject("SELECT count(*) FROM fin_opening_balance",Integer.class)).isZero();
  confirm(batch("OPENING_GL",List.of(Map.of("bookId",601,"accountId",9901,"amount",50,"refNo","D"),Map.of("bookId",601,"accountId",9902,"amount",50,"refNo","C"))));
  assertThatThrownBy(()->inCountry(101,()->jdbc.queryForObject("SELECT jxc_assert_period_open(101,601,'2026-10-01')",Object.class))).hasStackTraceContaining("SYS_COUNTRY_NOT_ACTIVE");
  assertThat(owner.queryForObject("SELECT count(*) FROM fin_opening_balance WHERE status='CONFIRMED'",Integer.class)).isEqualTo(2);assertThat(owner.queryForObject("SELECT count(*) FROM fin_voucher",Integer.class)).isZero();
 }
}
