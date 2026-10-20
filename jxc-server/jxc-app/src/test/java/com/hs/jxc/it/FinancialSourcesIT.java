package com.hs.jxc.it;

import com.hs.jxc.fin.api.FinancialReferenceProvider;
import com.hs.jxc.fin.api.FinancialSourceProvider;
import com.hs.jxc.sys.service.AuthorizationService;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import static org.assertj.core.api.Assertions.*;

/** Reuses real AP fixtures; checks the accounting bridge, not a second balance implementation. */
class FinancialSourcesIT extends PayablesFixtures {
    @Autowired(required=false) List<FinancialSourceProvider> sources=List.of();
    @Autowired(required=false) List<FinancialReferenceProvider> references=List.of();
    @Autowired AuthorizationService authorization;
    @Autowired com.hs.jxc.ar.ReceivablesService receivables;
    private final LocalDate day=LocalDate.of(2026,10,15);
    FinancialSourceProvider source(String type) {
        return sources.stream().filter(p->p.supports(type)).findFirst()
                .orElseThrow(()->new AssertionError("Missing real source provider: "+type));
    }
    @Test void payableHistoryUsesFrozenBaseFactsWithoutRevaluingFromLaterExchangeRates() {
        billFact(2101,"CNY",100,"2.5");
        creditFact(2102,"MXN",200,"1");
        seed("insert into md_exchange_rate(country_id,from_ccy,to_ccy,rate_date,scope,rate,status,confirmed_by,confirmed_at) values(101,'CNY','MXN','2026-10-15','SETTLEMENT',99,'CONFIRMED',201,clock_timestamp())");
        var rows=inCountry(101,()->source("AP_BILL").balances(authorization.authorize(c()),601,day,"AP"));
        assertThat(rows.stream().map(r->new BigDecimal(r.get("amount").toString())).reduce(BigDecimal.ZERO,BigDecimal::add)).isEqualByComparingTo("50");
        assertThat(inCountry(101,()->source("AP_BILL").balances(authorization.authorize(c()),601,day.minusDays(1),"AP"))).isEmpty();
    }
    @Test void settlementAndReversalExposeOppositeFrozenFxFacts() {
        billFact(2201,"CNY",100,"2.5");creditFact(2202,"MXN",200,"1");
        var settled=ap.settle(c(),settlement(2201,2202,200,100,"0.5"),key());
        var fact=inCountry(101,()->source("AP_SETTLEMENT").accountingFact(authorization.authorize(c()),"AP_SETTLEMENT_DONE","AP_SETTLEMENT",id(settled),1,day,Map.of()));
        var payload=(Map<?,?>)fact.get("payload");
        assertThat(new BigDecimal(payload.get("billBaseAmount").toString())).isEqualByComparingTo("250");
        assertThat(new BigDecimal(payload.get("fxDiff").toString())).isEqualByComparingTo("-50");
        var reversed=ap.reverse(c(),id(settled),Map.of("bizDate","2026-10-15","reason","correction"),key());
        var reverseFact=inCountry(101,()->source("AP_SETTLEMENT").accountingFact(authorization.authorize(c()),"AP_SETTLEMENT_REVERSED","AP_SETTLEMENT",id(reversed),1,day,Map.of()));
        var reversePayload=(Map<?,?>)reverseFact.get("payload");
        assertThat(new BigDecimal(reversePayload.get("billBaseAmount").toString())).isEqualByComparingTo("-250");
        assertThat(new BigDecimal(reversePayload.get("fxDiff").toString())).isEqualByComparingTo("50");
    }
    @Test void payableBalanceRecognizesRealizedFxOnlyFromSettlementBusinessDateAndReversal() {
        billFact(2251,"CNY",100,"2.5");creditFact(2252,"MXN",200,"1");
        assertThat(apBalance(day)).isEqualByComparingTo("50");
        var body=new java.util.LinkedHashMap<String,Object>(settlement(2251,2252,200,100,"0.5"));body.put("bizDate","2026-10-16");
        var settled=ap.settle(c(),body,key());
        assertThat(apBalance(day)).isEqualByComparingTo("50");
        assertThat(apBalance(day.plusDays(1))).isZero();
        var cash=inCountry(101,()->source("AP_BILL").balances(authorization.authorize(c()),601,day.plusDays(1),"CASH"));
        assertThat(cash).noneMatch(r->"AP_SETTLEMENT".equals(r.get("sourceType")));
        ap.reverse(c(),id(settled),Map.of("bizDate","2026-10-17","reason","correction"),key());
        assertThat(apBalance(day.plusDays(1))).isZero();assertThat(apBalance(day.plusDays(2))).isEqualByComparingTo("50");
    }
    BigDecimal apBalance(LocalDate date){return inCountry(101,()->source("AP_BILL").balances(authorization.authorize(c()),601,date,"AP").stream().map(r->new BigDecimal(r.get("amount").toString())).reduce(BigDecimal.ZERO,BigDecimal::add));}
    @Test void financialReferencesCannotUseAnotherBookAccountOfTheSameEntity() {
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,301,'B2','Book 2','MXN','ACTIVE')");
        seed("insert into md_fund_account(id,country_id,entity_id,book_id,name,account_type,currency) values(902,101,301,602,'Other bank','BANK','MXN')");
        var provider=references.stream().filter(p->p.supports("fundAccountId")).findFirst()
                .orElseThrow(()->new AssertionError("Missing MD financial references"));
        assertThat(inCountry(101,()->provider.validate(authorization.authorize(c()),601,"fundAccountId",901))).containsEntry("name","Bank");
        assertThatThrownBy(()->inCountry(101,()->provider.validate(authorization.authorize(c()),601,"fundAccountId",902)))
                .extracting("code").isEqualTo("FIN_AUX_INVALID");
    }
    @Test void confirmedReceiptVoidPublishesAnOppositeCashFactWithoutErasingConfirmation() {
        seed("insert into md_customer(id,country_id,code,name) values(2301,101,'FIN-C','Customer')");
        var receipt=receivables.createReceipt(c(),Map.of("customerId",2301,"fundAccountId",901,"method","CASH","amount",42,"bizTime","2026-10-15T10:00:00Z"),key());
        long receiptId=id(receipt);
        receivables.receiptAction(c(),receiptId,"confirm",Map.of("arrivalDate","2026-10-15"),key());
        receivables.receiptAction(c(),receiptId,"void",Map.of("bizDate","2026-10-16","reason","recording correction"),key());
        assertThat(owner.queryForObject("select count(*) from sys_biz_event where source_type='AR_RECEIPT' and source_id=? and event_type='AR_RECEIPT_VOIDED'",Integer.class,receiptId)).isEqualTo(1);
        var positive=inCountry(101,()->source("AR_RECEIPT").accountingFact(authorization.authorize(c()),"AR_RECEIPT_CONFIRMED","AR_RECEIPT",receiptId,1,day,Map.of()));
        var negative=inCountry(101,()->source("AR_RECEIPT").accountingFact(authorization.authorize(c()),"AR_RECEIPT_VOIDED","AR_RECEIPT",receiptId,1,day.plusDays(1),Map.of("wasConfirmed",true)));
        assertThat(new BigDecimal(((Map<?,?>)positive.get("payload")).get("amount").toString())).isEqualByComparingTo("42");
        assertThat(new BigDecimal(((Map<?,?>)negative.get("payload")).get("amount").toString())).isEqualByComparingTo("-42");
        var beforeVoid=inCountry(101,()->source("AR_RECEIPT").balances(authorization.authorize(c()),601,day,"CASH"));
        var afterVoid=inCountry(101,()->source("AR_RECEIPT").balances(authorization.authorize(c()),601,day.plusDays(1),"CASH"));
        assertThat(beforeVoid.stream().map(r->new BigDecimal(r.get("amount").toString())).reduce(BigDecimal.ZERO,BigDecimal::add)).isEqualByComparingTo("42");
        assertThat(afterVoid.stream().map(r->new BigDecimal(r.get("amount").toString())).reduce(BigDecimal.ZERO,BigDecimal::add)).isZero();
    }
    @Test void warehouseReferenceMustBelongToTheSelectedBooksEntity() {
        seed("insert into org_entity(id,country_id,code,name) values(302,101,'OTHER','Other entity')");
        seed("insert into org_warehouse(id,country_id,entity_id,code,name) values(402,101,302,'OTHER','Other warehouse')");
        var provider=references.stream().filter(p->p.supports("warehouseId")).findFirst().orElseThrow(()->new AssertionError("Missing organization references"));
        assertThat(inCountry(101,()->provider.validate(authorization.authorize(c()),601,"warehouseId",401))).containsEntry("name","Returns Warehouse");
        assertThatThrownBy(()->inCountry(101,()->provider.validate(authorization.authorize(c()),601,"warehouseId",402))).extracting("code").isEqualTo("FIN_AUX_INVALID");
    }
    @Test void repeatedSettlementConversionsAbsorbTheBaseCurrencyPostingPrecisionTail() {
        billFact(2401,"CNY",1,"1");creditFact(2402,"MXN",1,"1");
        var amounts=new ArrayList<BigDecimal>();var settlements=new ArrayList<Long>();
        for(String part:List.of("0.3333","0.3333","0.3334")){
            int billVersion=owner.queryForObject("select version from ap_bill where id=2401",Integer.class);
            int creditVersion=owner.queryForObject("select version from ap_credit_note where id=2402",Integer.class);
            var s=ap.settle(c(),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("billId",2401,"billVersion",billVersion,"fromType","CREDIT_NOTE","fromId",2402,"fromVersion",creditVersion,"fromAmount",new BigDecimal(part),"billAmount",new BigDecimal(part),"settleRate",1,"rateSource","ACTUAL"))),key());
            var fact=inCountry(101,()->source("AP_SETTLEMENT").accountingFact(authorization.authorize(c()),"AP_SETTLEMENT_DONE","AP_SETTLEMENT",id(s),1,day,Map.of()));
            amounts.add(new BigDecimal(((Map<?,?>)fact.get("payload")).get("billBaseAmount").toString()));settlements.add(id(s));
        }
        assertThat(amounts).usingElementComparator(BigDecimal::compareTo).containsExactly(new BigDecimal("0.33"),new BigDecimal("0.34"),new BigDecimal("0.33"));
        var reversed=ap.reverse(c(),settlements.get(1),Map.of("bizDate","2026-10-15","reason","reverse middle precision allocation"),key());
        var fact=inCountry(101,()->source("AP_SETTLEMENT").accountingFact(authorization.authorize(c()),"AP_SETTLEMENT_REVERSED","AP_SETTLEMENT",id(reversed),1,day,Map.of()));
        assertThat(new BigDecimal(((Map<?,?>)fact.get("payload")).get("billBaseAmount").toString())).isEqualByComparingTo("-0.34");
        // Re-reading an original conversion after later reversal keeps its original posting allocation.
        var original=inCountry(101,()->source("AP_SETTLEMENT").accountingFact(authorization.authorize(c()),"AP_SETTLEMENT_DONE","AP_SETTLEMENT",settlements.get(1),1,day,Map.of()));
        assertThat(new BigDecimal(((Map<?,?>)original.get("payload")).get("billBaseAmount").toString())).isEqualByComparingTo("0.34");
    }
    @Test void rateReadyNotificationCannotRecognizeTheOriginalPayableAmountAgain(){
        creditFact(2501,"CNY",100,"2.5");
        var original=inCountry(101,()->source("AP_CREDIT_NOTE").accountingFact(authorization.authorize(c()),"AP_CREDIT_CREATED","AP_CREDIT_NOTE",2501,1,day,Map.of()));
        var ready=inCountry(101,()->source("AP_CREDIT_NOTE").accountingFact(authorization.authorize(c()),"AP_ORIGINAL_RATE_READY","AP_CREDIT_NOTE",2501,1,day,Map.of()));
        assertThat(new BigDecimal(((Map<?,?>)original.get("payload")).get("amount").toString())).isEqualByComparingTo("250");
        assertThat(((Map<?,?>)ready.get("payload")).get("accountingImpact")).isEqualTo("NONE");
        assertThat(((Map<?,?>)ready.get("payload")).get("amount")).isNull();
    }
    @Test void manualDebitAdjustmentBillRetainsItsOwnAccountingEffect(){
        seed("insert into ap_bill(id,country_id,entity_id,book_id,partner_type,partner_id,doc_no,bill_type,currency,amount,bill_date,due_date,status,base_currency,rate,rate_date,base_amount,valuation_status) values(2601,101,301,601,'SUPPLIER',801,'ADJ-BILL','OTHER','MXN',100.335,'2026-10-15','2026-10-15','CONFIRMED','MXN',1,'2026-10-15',100.335,'READY')");
        var original=inCountry(101,()->source("AP_BILL").accountingFact(authorization.authorize(c()),"AP_BILL_CONFIRMED","AP_BILL",2601,1,day,Map.of()));
        var payload=(Map<?,?>)original.get("payload");
        assertThat(payload.get("accountingImpact")).isNotIn("NONE","SOURCE_CONFIRMATION");
        assertThat(new BigDecimal(payload.get("amount").toString())).isEqualByComparingTo("100.34");
        var balances=inCountry(101,()->source("AP_BILL").balances(authorization.authorize(c()),601,day,"AP"));
        assertThat(new BigDecimal(balances.getFirst().get("amount").toString())).isEqualByComparingTo("100.34");
    }

}
