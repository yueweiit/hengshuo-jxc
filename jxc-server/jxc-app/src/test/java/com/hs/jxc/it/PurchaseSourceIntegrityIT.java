package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;

import com.hs.jxc.ap.PayablesService;
import com.hs.jxc.common.api.ApiException;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** Purchase facts and AP claims must agree even when source mutation races billing. */
class PurchaseSourceIntegrityIT extends SupplyFixtures {
    @Autowired PayablesService ap;

    Map<String,Object> bill(String type,long source) {
        return ap.createBill(c(),Map.of("billDate","2026-10-15","sources",List.of(Map.of("sourceType",type,"sourceId",source,"qty",3))),key());
    }
    Map<String,Object> edit(Map<String,Object> order) {
        return Map.of("version",order.get("version"),"remark","changed","lines",List.of(Map.of("productId",501,"unit","BOX","qty",10,"unitPrice",99)));
    }
    int count(String table) { return owner.queryForObject("select count(*) from "+table,Integer.class); }

    @Test void activeOrderClaimRejectsRebuildingTheOriginalEconomicLines() {
        var order=order();long orderId=id(order),lineId=id(first(order));var bill=bill("PUR_ORDER_LINE",lineId);
        int audits=count("sys_audit_log");
        assertThatThrownBy(()->pur.update(c(),"orders",orderId,edit(order))).isInstanceOf(ApiException.class).extracting("code").isEqualTo("PUR_SOURCE_IN_USE");
        var unchanged=pur.get(c(),"orders",orderId);
        assertThat(unchanged.get("version")).isEqualTo(order.get("version"));
        assertThat(id(first(unchanged))).isEqualTo(lineId);
        assertThat(new BigDecimal(first(unchanged).get("unitPrice").toString())).isEqualByComparingTo("10");
        assertThat(count("sys_audit_log")).isEqualTo(audits);
        assertThat(owner.queryForObject("select source_id from ap_bill_line where bill_id=?",Long.class,id(bill))).isEqualTo(lineId);
    }

    @Test void aVoidedBillStillPreservesItsHistoricalPurchaseLineIdentityAndEconomics() {
        var order=order();long line=id(first(order));var bill=bill("PUR_ORDER_LINE",line);
        ap.voidBill(c(),id(bill),Map.of(),key());
        assertThatThrownBy(()->pur.update(c(),"orders",id(order),edit(order))).isInstanceOf(ApiException.class).extracting("code").isEqualTo("PUR_SOURCE_IN_USE");
        assertThatThrownBy(()->inCountry(101,()->jdbc.update("update pur_order_line set unit_price=11 where id=?",line))).isInstanceOf(RuntimeException.class).hasStackTraceContaining("PUR_SOURCE_IN_USE");
        assertThatThrownBy(()->inCountry(101,()->jdbc.update("delete from pur_order_line where id=?",line))).isInstanceOf(RuntimeException.class).hasStackTraceContaining("PUR_SOURCE_IN_USE");
        assertThat(id(first(pur.get(c(),"orders",id(order))))).isEqualTo(line);
    }

    @Test void receiptClaimBlocksVoidUntilTheBillReleasesItsEffectiveClaims() {
        var order=order();var receipt=domestic(order,10,0,0,true);long receiptId=id(receipt);var bill=bill("PUR_RECEIPT_LINE",id(first(receipt)));
        assertThatThrownBy(()->pur.action(c(),"domestic-receipts",receiptId,"void",Map.of(),key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("PUR_SOURCE_IN_USE");
        assertThat(pur.get(c(),"domestic-receipts",receiptId)).containsEntry("status","CONFIRMED");
        assertThat(owner.queryForObject("select qualified_qty from pur_order_line where id=?",BigDecimal.class,id(first(order)))).isEqualByComparingTo("10");
        ap.voidBill(c(),id(bill),Map.of(),key());
        String retry=key();var body=Map.<String,Object>of("bizDate","2026-10-15");
        assertThat(pur.action(c(),"domestic-receipts",receiptId,"void",body,retry)).containsEntry("status","VOIDED");
        pur.action(c(),"domestic-receipts",receiptId,"void",body,retry);
        assertThat(owner.queryForObject("select count(*) from sys_biz_event where event_type='PUR_DOMESTIC_RECEIPT_VOIDED'",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select qualified_qty from pur_order_line where id=?",BigDecimal.class,id(first(order)))).isZero();
    }

    @Test void ordinaryOrderEditStillRequiresVersionAndUnclaimedSourcesRemainEditable() {
        var order=order();long originalLine=id(first(order));
        assertThatThrownBy(()->pur.update(c(),"orders",id(order),Map.of("remark","missing-version"))).isInstanceOf(ApiException.class);
        assertThat(id(first(pur.get(c(),"orders",id(order))))).isEqualTo(originalLine);
        var changed=pur.update(c(),"orders",id(order),edit(order));
        assertThat(changed).containsEntry("status","DRAFT");
        assertThat(id(first(changed))).isNotEqualTo(originalLine);
    }

    @Test void runtimeSqlCannotRewriteOrDeleteAnActivelyClaimedOrderFact() {
        var order=order();long orderId=id(order),line=id(first(order));bill("PUR_ORDER_LINE",line);
        for(String sql:List.of("update pur_order_line set unit_price=11 where id="+line,"update pur_order_line set qty=11,base_qty=22,amount=110 where id="+line,"delete from pur_order_line where id="+line,"update pur_order set currency='MXN' where id="+orderId,"update pur_order set status='DRAFT' where id="+orderId))
            assertThatThrownBy(()->inCountry(101,()->jdbc.update(sql))).isInstanceOf(RuntimeException.class).hasStackTraceContaining("PUR_SOURCE_IN_USE");
        assertThat(owner.queryForObject("select unit_price from pur_order_line where id=?",BigDecimal.class,line)).isEqualByComparingTo("10");
    }

    @Test void runtimeSqlCannotVoidOrRewriteAnActivelyClaimedReceiptFact() {
        var order=order();var receipt=domestic(order,10,0,0,true);long receiptId=id(receipt),line=id(first(receipt));bill("PUR_RECEIPT_LINE",line);
        for(String sql:List.of("update pur_domestic_receipt set status='VOIDED' where id="+receiptId,"update pur_domestic_receipt_line set qualified_qty=9 where id="+line,"delete from pur_domestic_receipt_line where id="+line))
            assertThatThrownBy(()->inCountry(101,()->jdbc.update(sql))).isInstanceOf(RuntimeException.class).hasStackTraceContaining("PUR_SOURCE_IN_USE");
        assertThat(pur.get(c(),"domestic-receipts",receiptId)).containsEntry("status","CONFIRMED");
    }

    @Test void aClaimCannotBeInsertedForANonexistentTypedPurchaseSource() {
        var order=order();var bill=bill("PUR_ORDER_LINE",id(first(order)));
        seed("insert into ap_source_capacity(country_id,entity_id,book_id,source_type,source_id,original_qty,original_amount,current_max_qty,current_max_amount) values(101,301,601,'PUR_ORDER_LINE',999999,10,100,10,100)");
        long billLine=owner.queryForObject("select id from ap_bill_line where bill_id=?",Long.class,id(bill));
        assertThatThrownBy(()->inCountry(101,()->jdbc.update("insert into ap_source_claim(country_id,bill_id,bill_line_id,source_type,source_id,qty,amount) values(101,?,?, 'PUR_ORDER_LINE',999999,1,10)",id(bill),billLine))).isInstanceOf(RuntimeException.class).hasStackTraceContaining("ap_claim_purchase_order_source_fk");
    }

    @Test void runtimeSqlCannotReleaseEffectiveClaimsWithoutVoidingTheirBill() {
        var order=order();var bill=bill("PUR_ORDER_LINE",id(first(order)));
        assertThatThrownBy(()->inCountry(101,()->jdbc.update("update ap_source_claim set effective=false,version=version+1 where bill_id=?",id(bill)))).isInstanceOf(RuntimeException.class).hasStackTraceContaining("AP_CLAIM_RELEASE_REQUIRES_VOID");
        assertThat(owner.queryForObject("select count(*) from ap_source_claim where bill_id=? and effective",Integer.class,id(bill))).isEqualTo(2);
        assertThat(owner.queryForObject("select claimed_qty from ap_source_capacity where source_type='PUR_ORDER_LINE'",BigDecimal.class)).isEqualByComparingTo("3");
    }

    @Test void runtimeSqlCannotRewriteCapacityBalancesAwayFromEffectiveClaims() {
        var order=order();bill("PUR_ORDER_LINE",id(first(order)));
        assertThatThrownBy(()->inCountry(101,()->jdbc.update("update ap_source_capacity set claimed_qty=0,claimed_amount=0,version=version+1 where source_type='PUR_ORDER_LINE'"))).isInstanceOf(RuntimeException.class).hasStackTraceContaining("AP_SOURCE_BALANCE_INCONSISTENT");
        assertThat(owner.queryForObject("select claimed_qty from ap_source_capacity where source_type='PUR_ORDER_LINE'",BigDecimal.class)).isEqualByComparingTo("3");
    }

    @Test void competingOrderRebuildAndBillCreationCannotLeaveAnOrphanClaim() throws Exception {
        var order=order();long line=id(first(order));
        assertThat(compete(()->pur.update(c(),"orders",id(order),edit(order)),()->bill("PUR_ORDER_LINE",line))).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from ap_source_claim c left join pur_order_line l on l.country_id=c.country_id and l.id=c.source_id where c.source_type in ('PUR_ORDER_LINE','PUR_ORDER_LINE_BASE') and c.effective and l.id is null",Integer.class)).isZero();
        assertThat(count("ap_bill")).isBetween(0,1);
    }

    @Test void competingReceiptVoidAndBillCreationCannotLeaveAClaimOnAVoidedReceipt() throws Exception {
        var order=order();var receipt=domestic(order,10,0,0,true);long line=id(first(receipt));
        assertThat(compete(()->pur.action(c(),"domestic-receipts",id(receipt),"void",Map.of(),key()),()->bill("PUR_RECEIPT_LINE",line))).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from ap_source_claim c join pur_domestic_receipt_line l on l.country_id=c.country_id and l.id=c.source_id join pur_domestic_receipt r on r.country_id=l.country_id and r.id=l.receipt_id where c.source_type='PUR_RECEIPT_LINE' and c.effective and r.status<>'CONFIRMED'",Integer.class)).isZero();
    }
}
