package com.hs.jxc.lgs.api;
import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;import java.util.List;import java.util.Map;import java.util.Set;
public interface LogisticsApi {
 record PurchaseProgress(List<Map<String,Object>> shipments,List<Map<String,Object>> receipts){}
 /** Read only: the purchase owner supplies its authorized order and visible source line IDs. */
 PurchaseProgress purchaseProgress(Access access,long bookId,long orderId,Set<Long> visibleOrderLineIds);
 record SourcePlanning(BigDecimal plannedQty,BigDecimal remainingQty){}
 /** Original draft/pending-dispatch reservation, after source and editable-shipment authorization. No writes. */
 void requireEditablePlanningExclusion(Access access,long shipmentId);
 /** Empty only when a valid editable shipment belongs to another source book/entity. */
 java.util.Optional<SourcePlanning> sourcePlanning(Access access,String sourceType,long sourceLineId,Long excludeShipmentId);
 record PayableSource(String sourceType,long sourceId,long partnerId,long productId,long entityId,long bookId,String currency,BigDecimal originalQty,BigDecimal originalUnitPrice,BigDecimal totalAmount){}
 record Transit(BigDecimal intlQty,BigDecimal pendingDeliveryQty,BigDecimal onHoldQty,BigDecimal deliveringQty){}
 record CostFee(long id,long bookId,long entityId,long shipmentId,String docNo,String status,String currency,BigDecimal amount,String baseCurrency,BigDecimal baseAmount,BigDecimal rate,String costStatus,String treatment,String estimateFlag,Long estimateFeeId,Long actualFeeId,int version,java.time.LocalDate bizDate){}
 record CostTarget(long batchId,long warehouseId,long productId,BigDecimal qty,BigDecimal grossWeight,BigDecimal volume){}
 record InventoryAccountingFact(long feeId,long confirmationOrder,BigDecimal amount,java.time.LocalDate bizDate){}
 /** Frozen capitalized fee principal; actual fees contribute only their frozen difference. */
 List<InventoryAccountingFact> inventoryAccountingFacts(long countryId,long bookId);
 CostFee costFee(Access access,long feeId,boolean lock);
 List<CostTarget> costTargets(Access access,long shipmentId);
 Transit transit(Access access,long warehouseId,long productId);
 /** Derived read only, bound to the durable caller country transaction. */
 Transit projectionTransit(long countryId,long warehouseId,long productId);
 List<PayableSource> listPayableSources(Access access);
 PayableSource lockPayableSource(Access access,String sourceType,long sourceId);
}
