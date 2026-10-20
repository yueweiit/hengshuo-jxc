package com.hs.jxc.inv.api;
import com.hs.jxc.common.context.RequestContext;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
/** The only inventory writer. Every operation participates in the authorized caller transaction. */
public interface InventoryApi {
    record Source(String type,long id,long lineId,String no) {}
    record PurchaseCost(long purchaseOrderId,long purchaseOrderLineId,String currency,BigDecimal unitPrice,BigDecimal originalAmount,BigDecimal baseQty,String unit,BigDecimal factor) {
      public PurchaseCost(long orderId,long orderLineId,String currency,BigDecimal unitPrice,BigDecimal originalAmount,BigDecimal baseQty){this(orderId,orderLineId,currency,unitPrice,originalAmount,baseQty,"PCS",BigDecimal.ONE);}
    }
    record Inbound(long bookId,long warehouseId,long productId,BigDecimal goodQty,BigDecimal damagedQty,BigDecimal pendingInspectQty,Source source,LocalDate bizDate,Long shipmentId,Long poLineId,PurchaseCost purchaseCost) {}
    record Batch(long id,long costId) {}
    record Part(long batchId,BigDecimal qty) { public Part { qty=qty.setScale(4); } }
    record Movement(List<Part> parts,Long cogsId) {}
    record Reservation(long bookId,long warehouseId,long productId,long orderId,long orderLineId,long allocId,BigDecimal qty,LocalDate bizDate,long approvalVersion) {
      public Reservation(long bookId,long warehouseId,long productId,long orderId,long orderLineId,long allocId,BigDecimal qty,LocalDate bizDate){this(bookId,warehouseId,productId,orderId,orderLineId,allocId,qty,bizDate,1);}
    }
    record Outbound(long bookId,long warehouseId,long productId,Long allocId,BigDecimal qty,Long batchId,Source source,LocalDate bizDate) {}
    record ReturnInbound(long bookId,long warehouseId,long productId,BigDecimal goodQty,BigDecimal damagedQty,BigDecimal pendingInspectQty,Source source,LocalDate bizDate,Long originalOutboundLineId,Long originalBatchId,BigDecimal manualUnitCost,String reason) {}
    record Availability(BigDecimal onHandQty,BigDecimal reservedQty,BigDecimal frozenQty,BigDecimal availableQty,BigDecimal ownReservationQty,BigDecimal freeIncludingOwnReservation) {}
    record ReturnableBatch(long warehouseId,long productId,long batchId,long poLineId,BigDecimal availableQty) {}
    List<ReturnableBatch> supplierReturnable(RequestContext context,long bookId,List<Long> purchaseOrderLineIds);
    List<Part> lockAvailableBatches(RequestContext context,long bookId,long warehouseId,long productId,BigDecimal qty,Long batchId,LocalDate bizDate);
    Availability availability(RequestContext context,long bookId,long warehouseId,long productId,Long allocId);
    BigDecimal lockSupplierReturnable(RequestContext context,long bookId,long warehouseId,long productId,long batchId,long purchaseOrderLineId,LocalDate bizDate);
    BigDecimal lockReturnable(RequestContext context,long bookId,long warehouseId,long productId,long batchId,LocalDate bizDate);
    record Adjustment(long bookId,long warehouseId,long productId,Long batchId,BigDecimal delta,BigDecimal unitCost,Source source,LocalDate bizDate) {}
    void adjust(RequestContext context,Adjustment input);
    record Opening(long bookId,long warehouseId,long productId,BigDecimal qty,BigDecimal unitCost,Source source,LocalDate cutoffDate,String batchNo) {}
    Batch opening(RequestContext context,Opening input);
    Batch inbound(RequestContext context,Inbound input);
    void reserve(RequestContext context,Reservation input);
    void release(RequestContext context,long bookId,long allocId,BigDecimal qty,LocalDate bizDate);
    Movement outbound(RequestContext context,Outbound input);
    Movement supplierReturnOut(RequestContext context,Outbound input);
    Batch returnIn(RequestContext context,ReturnInbound input);
    Movement transferOut(RequestContext context,Outbound input);
    Movement transferLoss(RequestContext context,long bookId,long warehouseId,long productId,Source transferSource,Source lossSource,List<Part> parts,LocalDate bizDate);
    void transferIn(RequestContext context,long bookId,long warehouseId,long productId,Source transferSource,List<Part> parts,LocalDate bizDate);
    long freeze(RequestContext context,long bookId,long warehouseId,long productId,long batchId,BigDecimal qty,String type,String reason,Source source,LocalDate bizDate);
    void unfreeze(RequestContext context,long bookId,long freezeId,BigDecimal qty,Source source,LocalDate bizDate);
    void lockStocktake(RequestContext context,long bookId,long warehouseId,List<Long> productIds,long stocktakeId,LocalDate bizDate);
    void unlockStocktake(RequestContext context,long warehouseId,long stocktakeId);
}
