package com.hs.jxc.sal.api;
import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;
import java.util.List;
/** Authoritative original delivery facts; joins caller transaction after book/customer gates. */
public interface SalesSourceApi {
 record DeliveryPart(long outboundId,long outboundLineId,long warehouseId,Long batchId,Long cogsId,BigDecimal qty){}
 record DeliveredLine(long bookId,long entityId,long orderId,long orderLineId,long customerId,long productId,String currency,BigDecimal deliveredQty,BigDecimal returnedQty,BigDecimal claimedQty,BigDecimal netUnitPrice,BigDecimal originalAmount,List<DeliveryPart> parts){}
 DeliveredLine lockDeliveredLine(Access access,long orderId,long orderLineId);
 DeliveredLine lockDeliveredOutboundLine(Access access,long outboundLineId);
 void claimReturn(Access access,long orderLineId,BigDecimal qty);
 void releaseReturn(Access access,long orderLineId,BigDecimal qty);
 void markReturned(Access access,long orderLineId,BigDecimal qty);
}
