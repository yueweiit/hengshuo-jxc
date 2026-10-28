package com.hs.jxc.md.api;
import java.math.BigDecimal;
/** Authoritative enabled SKU and existing unit conversion. Joins caller transaction. */
public interface MasterProductApi {
 record Product(long id,String code,String name,String baseUnit,String unit,BigDecimal factorToBase,BigDecimal grossWeight,BigDecimal volume) {
  public Product(long id,String code,String name,String baseUnit,String unit,BigDecimal factorToBase){this(id,code,name,baseUnit,unit,factorToBase,null,null);}
 }
 /** Historical source labels only, including disabled SKUs. Never records unit usage. */
 Product reference(long countryId,long productId);
 Product requireEnabled(long countryId,long productId,String unit);
 /** 采购输入准备使用共享行锁，保持商品、本国状态及单位换算到事务结束。 */
 Product requireEnabledLocked(long countryId,long productId,String unit);
 /** Same authoritative conversion and precision checks, without recording business usage. */
 BigDecimal previewToBase(Product product,BigDecimal qty);
 BigDecimal toBase(Product product,BigDecimal qty);
 /** Native stock facts are already in base units. Record their use in the caller's write transaction. */
 void recordBaseUnitUsage(long countryId,long productId);
}
