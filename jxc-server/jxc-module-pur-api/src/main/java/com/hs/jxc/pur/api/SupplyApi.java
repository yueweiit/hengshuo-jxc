package com.hs.jxc.pur.api;
import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;import java.util.*;
/** Joins the authorized caller transaction. Command methods lock sources; explicit reference reads never lock or mutate facts. */
public interface SupplyApi {
 record Source(String sourceType,long sourceLineId,String sourceNo,long orderId,long orderLineId,long productId,long supplierId,long entityId,long bookId,String currency,String unit,BigDecimal unitPrice,BigDecimal factor,BigDecimal baseQty,BigDecimal availableQty,BigDecimal originalAmount,BigDecimal orderBaseQty){}
 record PayableSource(String sourceType,long sourceId,long partnerId,long productId,long entityId,long bookId,String currency,BigDecimal originalQty,BigDecimal originalUnitPrice,BigDecimal totalAmount,String canonicalSourceType,long canonicalSourceId,BigDecimal canonicalQty,BigDecimal canonicalAmount,String unit,BigDecimal factor){}
 record ReturnSource(long orderId,long orderLineId,long supplierId,long productId,long entityId,long bookId,String currency,BigDecimal unitPrice,BigDecimal availableQty,BigDecimal orderAvailableQty){}
 /** Minimal immutable order identity for authorized accounting; no price or master-data grant. */
 Map<String,Object> financialOrderReference(Access access,long bookId,long orderId);
 /** Caller authorizes its cost row and supplies that row's exact book/warehouse/order; returns identity only. */
 Map<String,Object> costOrderReference(Access access,long bookId,long warehouseId,long orderId);
 /** Minimal labels for a caller-authorized logistics source; country/book/order/source identity is rechecked by PUR. */
 Map<String,Object> logisticsSourceReference(Access access,long bookId,long orderId,String sourceType,long sourceLineId);
 Source lockSource(Access access,String sourceType,long sourceLineId);
 void shipped(Access access,String sourceType,long sourceLineId,BigDecimal qty);
 void arrived(Access access,long orderLineId,BigDecimal qty);
 List<PayableSource> listPayableSources(Access access);
 List<Map<String,Object>> listReturnSources(Access access,long orderId,String location);
 PayableSource lockPayableSource(Access access,String sourceType,long sourceId);
 ReturnSource lockPurchaseReturnSource(Access access,long orderLineId,String location,Long sourceId);
 void applyReturn(Access access,long orderLineId,String location,Long sourceId,BigDecimal qty);
    java.util.List<PayableSource> payableSourcesForReceipt(Access access,long receiptId);
}
