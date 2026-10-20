package com.hs.jxc.sal.api;
import com.hs.jxc.sys.api.Access;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
/** Sales owns effective demand: approval time, base units, cancellations and warehouse allocation. */
public interface SalesStatsApi {
 /** Worker projection port: country must already be bound by the durable event consumer; creates no identity. */
 List<Map<String,Object>> projectionOrders(long country,String dimension,long dimensionId,long productId,LocalDate from,LocalDate through);
 List<Map<String,Object>> orders(Access access,String dimension,long dimensionId,long productId,LocalDate from,LocalDate through);
}
