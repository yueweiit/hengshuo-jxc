package com.hs.jxc.ar.api;
import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
/** Return/refund commands share the same customer/currency row as writeoffs. */
public interface ArReturnApi {
 record Settlement(List<Long> creditNoteIds,Long writeoffId,BigDecimal offsetAmount,BigDecimal refundableAmount){}
 record Credit(long noteId,BigDecimal amount,BigDecimal used,BigDecimal reserved){}
 void lockCustomer(Access access,long bookId,long customerId,String currency);
 Settlement settleSalesReturn(Access access,long bookId,long returnId,long orderId,long customerId,String currency,BigDecimal amount,LocalDate date);
 Settlement settleNoOriginReturn(Access access,long bookId,long returnId,long customerId,String currency,BigDecimal amount,LocalDate date);
 void reverseSalesReturn(Access access,long bookId,long returnId,LocalDate date);
 Credit refundable(Access access,long bookId,long customerId,String currency,long creditNoteId);
 List<Credit> listRefundable(Access access,long bookId,long customerId,String currency);
 void reserveRefund(Access access,long bookId,long customerId,String currency,long creditNoteId,long refundId,BigDecimal amount,LocalDate date);
 void releaseRefund(Access access,long bookId,long customerId,String currency,long creditNoteId,long refundId,BigDecimal amount,LocalDate date);
 void consumeRefund(Access access,long bookId,long customerId,String currency,long creditNoteId,long refundId,BigDecimal amount,LocalDate date);
}
