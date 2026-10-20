package com.hs.jxc.md.service;
import com.hs.jxc.md.api.MasterProductApi;
import com.hs.jxc.common.api.*;
import java.math.BigDecimal;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionSynchronization;
@Service
public class MasterProductService implements MasterProductApi {
 private static final Object USAGES=new Object();
 private record Usage(long product,String unit){}
 private final JdbcTemplate jdbc;public MasterProductService(JdbcTemplate jdbc){this.jdbc=jdbc;}
 private Map<String,Object> product(long country,long product,boolean enabled){
  return product(country,product,enabled,false);
 }
 private Map<String,Object> product(long country,long product,boolean enabled,boolean lock){
  if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Product resolver requires caller transaction");
  var rows=jdbc.queryForList("SELECT p.id,p.product_code,p.name,p.base_unit,p.gross_weight,p.volume FROM md_product p JOIN md_country_sku s ON s.product_id=p.id WHERE s.country_id=? AND p.id=?"+(enabled?" AND p.status='ENABLED' AND s.status='ENABLED'":"")+(lock?" FOR SHARE OF p":""),country,product);
  if(rows.isEmpty()){if(enabled)throw new ApiException(409,"MD_SKU_DISABLED","商品未在本国启用");throw ApiException.notFound();}return rows.getFirst();
 }
 @Override public Product reference(long country,long product){var p=product(country,product,false);String base=String.valueOf(p.get("base_unit"));return new Product(product,String.valueOf(p.get("product_code")),String.valueOf(p.get("name")),base,base,BigDecimal.ONE,(BigDecimal)p.get("gross_weight"),(BigDecimal)p.get("volume"));}
 public Product requireEnabled(long country,long product,String unit){
  var p=product(country,product,true);String base=String.valueOf(p.get("base_unit"));if(unit==null||unit.isBlank())throw Inputs.bad("请选择商品单位");
  BigDecimal factor;if(unit.equals(base))factor=BigDecimal.ONE;else{var conversions=jdbc.queryForList("SELECT factor_to_base FROM md_product_unit WHERE product_id=? AND unit=?",product,unit);if(conversions.isEmpty())throw new ApiException(400,"MD_BAD_UNIT","商品未配置该单位换算");factor=(BigDecimal)conversions.getFirst().get("factor_to_base");}
  return new Product(product,String.valueOf(p.get("product_code")),String.valueOf(p.get("name")),base,unit,factor,(BigDecimal)p.get("gross_weight"),(BigDecimal)p.get("volume"));
 }
 public BigDecimal previewToBase(Product p,BigDecimal qty){Inputs.decimal(qty,4,new BigDecimal("999999999999"));if(qty.signum()<=0)throw Inputs.bad("数量必须大于0");var base=qty.multiply(p.factorToBase());Inputs.decimal(base,4,new BigDecimal("999999999999"));return base;}
 public BigDecimal toBase(Product p,BigDecimal qty){var base=previewToBase(p,qty);recordUsage(p.id(),p.unit());return base;}
 public void recordBaseUnitUsage(long country,long product){var p=product(country,product,true,true);recordUsage(product,String.valueOf(p.get("base_unit")));}
 @SuppressWarnings("unchecked") private void recordUsage(long product,String unit){
  if(!TransactionSynchronizationManager.isActualTransactionActive()||!TransactionSynchronizationManager.isSynchronizationActive())throw new IllegalStateException("Unit usage requires caller transaction");
  var pending=(NavigableSet<Usage>)TransactionSynchronizationManager.getResource(USAGES);
  if(pending==null){
   pending=new TreeSet<>(Comparator.comparingLong(Usage::product).thenComparing(Usage::unit));var resource=pending;
   TransactionSynchronizationManager.bindResource(USAGES,resource);
   TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization(){
    // Usage can wait on a first-use unique key; current authority must be checked after that wait.
    @Override public int getOrder(){return org.springframework.core.Ordered.HIGHEST_PRECEDENCE;}
    @Override public void suspend(){TransactionSynchronizationManager.unbindResourceIfPossible(USAGES);}
    @Override public void resume(){TransactionSynchronizationManager.bindResource(USAGES,resource);}
    @Override public void beforeCommit(boolean readOnly){
     // All business locks are already held. A single global ordering also covers first-use unique keys.
     for(var usage:resource)jdbc.update("INSERT INTO md_product_unit_used(product_id,unit) VALUES(?,?) ON CONFLICT DO NOTHING",usage.product(),usage.unit());
    }
    @Override public void afterCompletion(int status){if(TransactionSynchronizationManager.getResource(USAGES)==resource)TransactionSynchronizationManager.unbindResourceIfPossible(USAGES);}
   });
  }
  pending.add(new Usage(product,unit));
 }
}
