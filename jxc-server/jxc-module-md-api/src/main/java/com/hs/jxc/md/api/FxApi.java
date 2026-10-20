package com.hs.jxc.md.api;
import java.math.BigDecimal;
import java.time.LocalDate;
/** Confirmed immutable rate facts; missing rate is null and never a fabricated zero. */
public interface FxApi {
 record Rate(Long id,BigDecimal rate,LocalDate rateDate,int version) {}
 Rate resolve(long countryId,String from,String to,LocalDate bizDate,String scope);
}
