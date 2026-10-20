package com.hs.jxc.sal;
import com.hs.jxc.sal.api.SalesStatsApi;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.DbRows;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
@Service
public class SalesStatsService implements SalesStatsApi {
 private final JdbcTemplate jdbc;public SalesStatsService(JdbcTemplate jdbc){this.jdbc=jdbc;}
 public List<Map<String,Object>> orders(Access a,String dimension,long dim,long product,LocalDate from,LocalDate through){
  if(!Set.of("COUNTRY","WAREHOUSE","STORE").contains(dimension)||from==null||through==null||from.isAfter(through))throw Inputs.bad("统计范围不合法");
  if(!a.scope().all()&&dimension.equals("COUNTRY"))throw ApiException.notFound();
  if(!a.scope().all()&&dimension.equals("WAREHOUSE")&&!a.scope().warehouses().contains(dim)||!a.scope().all()&&dimension.equals("STORE")&&!a.scope().stores().contains(dim))throw ApiException.notFound();
  return query(a.requireCountry(),dimension,dim,product,from,through);
 }
 public List<Map<String,Object>> projectionOrders(long country,String dimension,long dim,long product,LocalDate from,LocalDate through){if(!org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()||!Objects.equals(jdbc.queryForObject("SELECT jxc_current_country_id()",Long.class),country))throw new IllegalStateException("Projection requires caller country transaction");return query(country,dimension,dim,product,from,through);}
 private List<Map<String,Object>> query(long country,String dimension,long dim,long product,LocalDate from,LocalDate through){
  String quantity=dimension.equals("WAREHOUSE")?"coalesce((SELECT sum(al.alloc_qty-al.cancelled_qty) FROM sal_order_alloc al WHERE al.country_id=l.country_id AND al.order_line_id=l.id AND al.warehouse_id=?),0)":"l.base_qty-l.cancelled_qty";
  String outbound=dimension.equals("WAREHOUSE")?"coalesce((SELECT sum(al.outbound_qty) FROM sal_order_alloc al WHERE al.country_id=l.country_id AND al.order_line_id=l.id AND al.warehouse_id=?),0)":"l.outbound_qty";
  String returned=dimension.equals("WAREHOUSE")?"coalesce((SELECT sum(rl.received_qty) FROM rtn_sales_return_line rl JOIN rtn_sales_return rt ON rt.country_id=rl.country_id AND rt.id=rl.return_id JOIN sal_outbound_line obl ON obl.country_id=rl.country_id AND obl.id=rl.outbound_line_id JOIN sal_outbound ob ON ob.country_id=obl.country_id AND ob.id=obl.outbound_id WHERE rl.country_id=l.country_id AND rl.order_line_id=l.id AND ob.warehouse_id=? AND rt.status NOT IN ('DRAFT','REJECTED','CANCELLED')),0)":"l.returned_qty";
  var args=new ArrayList<Object>();if(dimension.equals("WAREHOUSE")){args.add(dim);args.add(dim);args.add(dim);}args.add(country);args.add(product);args.add(from);args.add(through);if(dimension.equals("STORE"))args.add(dim);
  String sql="SELECT o.id,o.doc_no,c.name customer_name,sum("+quantity+") qty,sum("+outbound+") outbound_qty,sum("+returned+") returned_qty,sum(greatest(0,l.base_qty-l.cancelled_qty-coalesce((SELECT sum(al.alloc_qty-al.cancelled_qty) FROM sal_order_alloc al WHERE al.country_id=l.country_id AND al.order_line_id=l.id),0))) unassigned_qty,min(o.approved_at) approved_at FROM sal_order o JOIN sal_order_line l ON l.country_id=o.country_id AND l.order_id=o.id JOIN md_customer c ON c.country_id=o.country_id AND c.id=o.customer_id JOIN sys_country ct ON ct.id=o.country_id WHERE o.country_id=? AND l.product_id=? AND o.approval_status='APPROVED' AND (o.approved_at AT TIME ZONE ct.timezone)::date BETWEEN ? AND ?"+(dimension.equals("STORE")?" AND o.store_id=?":"")+" GROUP BY o.id,o.doc_no,c.name ORDER BY o.id";
  return jdbc.queryForList(sql,args.toArray()).stream().map(DbRows::camel).filter(r->((java.math.BigDecimal)r.get("qty")).signum()>0).toList();
 }
}
