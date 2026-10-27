package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.hs.jxc.common.api.JsonCodec;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.web.util.ContentCachingResponseWrapper;

/** Lose only this test client's response after the native receipt transaction commits. */
@Import(UnknownResponseIT.FaultConfiguration.class)
class UnknownResponseIT extends SupplyFixtures {
    @Value("${local.server.port}") int port;
    @Autowired HeldResponse fault;
    @Autowired JsonCodec json;
    final HttpClient http=HttpClient.newHttpClient();

    HttpRequest confirm(long receipt,String intent,String body,boolean hold) {
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1/lgs/receipts/"+receipt+"/confirm"))
            .timeout(Duration.ofSeconds(20)).header("Authorization","Bearer supply-fixture")
            .header("X-Country-Id","101").header("Idempotency-Key",intent).header("Content-Type","application/json");
        if(hold)request.header("X-Test-Hold-Response","true");
        return request.POST(HttpRequest.BodyPublishers.ofString(body)).build();
    }

    @Test void lostHttpResponseRetriesOneNativeReceiptWithoutAnotherBatchOrCost() throws Exception {
        var delivered=delivery();
        var receipt=receipt(delivered);
        long receiptId=id(receipt);
        String intent=key();
        var unknown=http.sendAsync(confirm(receiptId,intent,"{}",true),HttpResponse.BodyHandlers.ofString());
        try {
            assertThat(fault.committed.await(15,TimeUnit.SECONDS)).as("native handler completed before the response was sent").isTrue();
            assertThat(owner.queryForObject("SELECT status FROM lgs_receipt WHERE id=?",String.class,receiptId)).isEqualTo("CONFIRMED");
            assertThat(unknown).isNotDone();
            assertThat(unknown.cancel(true)).isTrue();
        } finally {
            fault.release.countDown();
        }
        assertThat(unknown).isCompletedExceptionally();
        assertThatThrownBy(unknown::join).satisfies(error->{
            Throwable cause=error;
            while(cause instanceof CompletionException&&cause.getCause()!=null)cause=cause.getCause();
            assertThat(cause).isInstanceOf(CancellationException.class);
        });
        var replay=http.send(confirm(receiptId,intent,"{}",false),HttpResponse.BodyHandlers.ofString());
        assertThat(replay.statusCode()).withFailMessage(replay.body()).isEqualTo(200);
        var conflict=http.send(confirm(receiptId,intent,"{\"remark\":\"changed\"}",false),HttpResponse.BodyHandlers.ofString());
        assertThat(conflict.statusCode()).withFailMessage(conflict.body()).isEqualTo(409);
        assertThat(conflict.body()).contains("SYS_IDEMPOTENCY_CONFLICT");
        var otherIntent=http.send(confirm(receiptId,key(),"{}",false),HttpResponse.BodyHandlers.ofString());
        assertThat(otherIntent.statusCode()).withFailMessage(otherIntent.body()).isEqualTo(200);
        assertThat(owner.queryForObject("SELECT count(*) FROM inv_batch",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_inbound_cost",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event WHERE event_type='LGS_RECEIPT_CONFIRMED'",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT on_hand_qty FROM inv_stock_summary",BigDecimal.class)).isEqualByComparingTo("9");
        assertThat(owner.queryForObject("SELECT frozen_qty FROM inv_stock_summary",BigDecimal.class)).isEqualByComparingTo("2");
        assertThat(owner.queryForObject("SELECT arrived_mx_qty FROM pur_order_line",BigDecimal.class)).isEqualByComparingTo("9");
        System.out.println("AI09_NATIVE_SOURCE "+json.write(Map.of(
            "purchaseId",owner.queryForObject("SELECT id FROM pur_order",Long.class),
            "purchaseLineId",owner.queryForObject("SELECT id FROM pur_order_line",Long.class),
            "deliveryId",id(delivered),"receiptId",receiptId,"receiptLineId",id(first(receipt)),
            "inventoryBatchId",owner.queryForObject("SELECT id FROM inv_batch",Long.class),
            "costId",owner.queryForObject("SELECT id FROM cst_inbound_cost",Long.class),
            "baseReceivedQty",9,"frozenQty",2,
            "originalCostAmount",owner.queryForObject("SELECT src_amount FROM cst_inbound_cost",BigDecimal.class))));
    }

    @TestConfiguration static class FaultConfiguration {
        @Bean HeldResponse heldResponse(){return new HeldResponse();}
    }
    static class HeldResponse implements Filter {
        final CountDownLatch committed=new CountDownLatch(1),release=new CountDownLatch(1);
        @Override public void doFilter(ServletRequest request,ServletResponse response,FilterChain chain) throws IOException,ServletException {
            var http=(HttpServletRequest)request;
            if(!"true".equals(http.getHeader("X-Test-Hold-Response"))){chain.doFilter(request,response);return;}
            var held=new ContentCachingResponseWrapper((HttpServletResponse)response);
            chain.doFilter(request,held);
            committed.countDown();
            try {
                if(!release.await(20,TimeUnit.SECONDS))throw new ServletException("test response hold was not released");
            } catch(InterruptedException e){Thread.currentThread().interrupt();throw new ServletException(e);}
            held.copyBodyToResponse();
        }
    }
}
