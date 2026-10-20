package com.hs.jxc.ar.api;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;
import java.time.LocalDate;
public interface ArSalesApi {
    record CashEvidence(long bookId,long orderId,java.util.List<com.hs.jxc.attachment.AttachmentService.PreparedEvidence> proofs){}
    CashEvidence prepareCashEvidence(RequestContext context,long bookId,long orderId);
    void requireCashEvidence(RequestContext context,Access access,CashEvidence evidence);
    record Evaluation(Long ruleId,boolean ok,boolean overLimit,boolean overdue,boolean requiresApproval,BigDecimal available,String code,String message){}
    void lockCustomer(Access access,long bookId,long customerId,String currency);
    Evaluation evaluate(Access access,long bookId,long customerId,String currency,BigDecimal amount,String stage,Long orderId);
    void reserveOrder(Access access,long bookId,long customerId,String currency,long orderId,BigDecimal amount);
    void releaseOrder(Access access,long bookId,long customerId,String currency,long orderId,BigDecimal amount);
    boolean cashCovered(Access access,long bookId,long customerId,long orderId,BigDecimal required);
    long createFromOutbound(RequestContext context,Access access,long bookId,long customerId,long orderId,long outboundId,String currency,BigDecimal amount,LocalDate date,String paymentType);
    java.util.Map<String,Object> storeDaily(Access access,Long storeId,LocalDate date);
    BigDecimal allocated(Access access,long bookId,long orderId);
    /** Caller has authorized the order in its transaction. Payment display includes net native receipt writeoffs; it does not grant cash prepayment coverage. */
    BigDecimal paymentForOrder(Access access,long bookId,long orderId);
}
