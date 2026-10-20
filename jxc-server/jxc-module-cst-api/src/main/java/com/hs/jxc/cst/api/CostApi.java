package com.hs.jxc.cst.api;
import com.hs.jxc.common.context.RequestContext;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
/** Immutable M2 cost source facts. No asynchronous reconstruction from current inventory. */
public interface CostApi {
    record Purchase(long orderId,long orderLineId,String currency,BigDecimal unitPrice,BigDecimal originalAmount,BigDecimal baseQty,String unit,BigDecimal factor) {}
    record Inbound(long bookId,long warehouseId,long productId,long batchId,String sourceType,long sourceLineId,BigDecimal qty,LocalDate bizDate,Purchase purchase,Long originalOutboundLineId,BigDecimal manualUnitCost,Long selectedCostBatchId) {}
    record Part(long batchId,BigDecimal qty) {}
    record Outbound(long bookId,long warehouseId,long productId,String sourceType,long sourceLineId,BigDecimal qty,LocalDate bizDate,List<Part> consumed,List<Part> valuationPool) {}
    record ReturnCost(long selectedBatchId,Long costSnapshotId,BigDecimal unitCost,String status) {}
    ReturnCost selectReturnCost(RequestContext context,long bookId,long warehouseId,long productId,String source,Long batchId);
    record BatchCost(long id,BigDecimal unitCost,String status,String baseCurrency) {}
    record OutboundCost(long id,BigDecimal unitCost,BigDecimal amount,String status) {}
    record CostAmount(long id,BigDecimal qty,BigDecimal amount,BigDecimal unitCost,String status) {}
    BatchCost batchCost(long countryId,long batchId);
    OutboundCost outboundCost(long countryId,String sourceType,long sourceLineId);
    OutboundCost outboundCostById(long countryId,long cogsId);
    /** Frozen initial inbound amount; later valuation differences have separate immutable events. */
    CostAmount batchCostAmount(long countryId,long batchId);
    /** Signed inventory impact at book posting precision, allocated from the shared immutable economic prefix. */
    record AccountingDelta(BigDecimal rawDelta,BigDecimal amount,BigDecimal beforeAmount,BigDecimal afterAmount,String status) {}
    AccountingDelta inventoryAccountingDelta(long countryId,long bookId,String sourceType,long sourceId,int scale);
    boolean feeAllocated(long countryId,long feeId);
    boolean feeAllocated(long countryId,long feeId,LocalDate asOf);
    record TransferPart(long batchId,BigDecimal qty,BigDecimal amount) {}
    record TransferCost(long id,BigDecimal amount,BigDecimal unitCost,List<TransferPart> parts) {}
    void preparePurchaseSource(RequestContext context,long bookId);
    void prepareReturnSource(RequestContext context,long bookId,Long originalOutboundLineId);
    long captureTransferLoss(RequestContext context,Outbound input,String transferSourceType,long transferSourceLineId);
    TransferCost captureTransferOut(RequestContext context,Outbound input);
    List<TransferPart> captureTransferIn(RequestContext context,long bookId,long warehouseId,long productId,String sourceType,long sourceLineId,List<Part> parts,int firstSeq,LocalDate bizDate);
    String requireMethod(long countryId,long bookId);
    long captureInbound(RequestContext context,Inbound input);
    long captureOutbound(RequestContext context,Outbound input);
}
