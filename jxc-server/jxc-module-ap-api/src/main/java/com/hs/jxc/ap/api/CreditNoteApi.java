package com.hs.jxc.ap.api;
import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Map;
/** Trusted purchase-return and claim participants; joins caller transaction. */
public interface CreditNoteApi {
 long createFromPurchaseReturn(Access access,long bookId,long entityId,long partnerId,String sourceType,long sourceId,String currency,BigDecimal amount,LocalDate date);
 /** Original amount and frozen base conversion; excludes mutable remaining/used projections. */
 Map<String,Object> frozenBySource(Access access,long bookId,String sourceType,long sourceId);
}
