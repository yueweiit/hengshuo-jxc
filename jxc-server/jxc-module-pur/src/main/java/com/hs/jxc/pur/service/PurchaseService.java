package com.hs.jxc.pur.service;

import java.util.*;
import java.math.BigDecimal;
import java.time.LocalDate;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.pur.dto.PreparedOrderLine;
import com.hs.jxc.pur.api.SupplyApi;

/** 采购业务入口；原有校验和事务由唯一实现负责。 */
public interface PurchaseService extends SupplyApi {
    Map<String,Object> get(RequestContext c,String k,long id);
    Object list(RequestContext c,String k);
    Object list(RequestContext c,String k,Map<String,String> query);
    Map<String,Object> progress(RequestContext c,long orderId);
    Map<String,Object> create(RequestContext c,String k,Map<String,Object>b,String key);
    Map<String,Object> importOpening(RequestContext c,Access a,Map<String,Object> body,String ref,LocalDate cutoff,LocalDate sourceDate,long rowId,String key);
    List<PreparedOrderLine> prepareOrderLines(Access a,Map<String,Object> body);
    Map<String,Object> previewOrder(RequestContext c,Map<String,Object> body);
    Map<String,Object> update(RequestContext c,String k,long id,Map<String,Object>b);
    Map<String,Object> action(RequestContext c,String k,long id,String action,Map<String,Object>b,String key);
    Map<String,Object> convert(RequestContext c,long lineId,Map<String,Object>b,String key);
    Source lockSource(Access a,String type,long sid);
    void shipped(Access a,String type,long sid,BigDecimal qty);
    void arrived(Access a,long lid,BigDecimal qty);
    PayableSource lockPayableSource(Access a,String type,long sid);
    List<PayableSource> payableSourcesForReceipt(Access a,long receiptId);
    List<PayableSource> listPayableSources(Access a);
    List<Map<String,Object>> listReturnSources(Access a,long orderId,String location);
    ReturnSource lockPurchaseReturnSource(Access a,long lid,String loc,Long sid);
    void applyReturn(Access a,long lid,String loc,Long sid,BigDecimal qty);
    Object sources(RequestContext c,boolean export);
    Object sources(RequestContext c,boolean export,Long excludeShipmentId);
    Map<String,Object> logisticsSourceReference(Access a,long book,long orderId,String type,long sourceLineId);
    Map<String,Object> financialOrderReference(Access a,long book,long orderId);
    Map<String,Object> costOrderReference(Access a,long book,long warehouse,long orderId);
}
