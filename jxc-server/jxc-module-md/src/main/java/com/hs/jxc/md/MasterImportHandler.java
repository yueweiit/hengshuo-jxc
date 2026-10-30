package com.hs.jxc.md;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.md.api.MasterProductMaintenanceApi;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.imports.ImportHandler;
import com.hs.jxc.sys.service.CountryLifecycle;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Import is an adapter to the same maintenance commands; it does not own a second master writer. */
@Component
public class MasterImportHandler implements ImportHandler {
 private final JdbcTemplate db;private final MasterProductMaintenanceApi products;private final CustomerMasterService customers;private final SupplierService suppliers;private final CountryLifecycle lifecycle;
 public MasterImportHandler(JdbcTemplate db,MasterProductMaintenanceApi products,CustomerMasterService customers,SupplierService suppliers,CountryLifecycle lifecycle){this.db=db;this.products=products;this.customers=customers;this.suppliers=suppliers;this.lifecycle=lifecycle;}
 public List<String> types(){return List.of("PRODUCT","PRODUCT_UNIT","PRODUCT_BARCODE","CUSTOMER","CUSTOMER_ADDRESS","SUPPLIER","LOGISTICS_PROVIDER");}
 public List<String> columns(String type){return switch(type){case "PRODUCT"->List.of("productCode","name","baseUnit","categoryId","brand","spec","grossWeight","volume","units","barcodes");case "PRODUCT_UNIT"->List.of("productCode","unit","factorToBase","isPurchaseDefault","isSalesDefault");case "PRODUCT_BARCODE"->List.of("productCode","unit","barcode");case "CUSTOMER"->List.of("code","name","storeId","groupId","levelId","salesOwnerId","contact","phone","email","taxId","addresses","remark");case "CUSTOMER_ADDRESS"->List.of("customerCode","addresses");default->List.of("code","name","settleCurrency","locatedCountry","paymentTerms","contact","phone","address");};}
 @SuppressWarnings("unchecked") public Row validate(Access a,String type,LocalDate cutoff,int rowNo,Map<String,Object> raw){
  lifecycle.requireConfigurationWritable(a);var b=new LinkedHashMap<>(raw);String source;
  if(type.startsWith("PRODUCT")){
   a.require("md:product:edit");if(!a.platformAdmin())throw ApiException.forbidden();String code=Inputs.required(b,"productCode");source=code;
   if(type.equals("PRODUCT")){
    Inputs.required(b,"name");String base=Inputs.required(b,"baseUnit");absent("md_product","product_code",code,null);
    if(b.get("categoryId")!=null)reference("md_category",Inputs.id(b.get("categoryId")),null);
    for(String field:List.of("grossWeight","volume"))if(b.get(field)!=null&&Inputs.decimal(b.get(field),4,Inputs.PUBLIC_DECIMAL_MAX).signum()<0)throw Inputs.bad("重量/体积不能为负数");
    var units=maps(b.getOrDefault("units",List.of()));var names=new HashSet<String>();names.add(base);var explicitNames=new HashSet<String>();
    for(var unit:units){String name=Inputs.required(unit,"unit");if(!explicitNames.add(name))throw Inputs.bad("单位重复");names.add(name);factor(unit,base);}
    var barcodes=new HashSet<String>();for(var barcode:maps(b.getOrDefault("barcodes",List.of()))){String value=Inputs.required(barcode,"barcode");if(!barcodes.add(value)||!names.contains(Inputs.required(barcode,"unit")))throw Inputs.bad("条码重复或单位未配置");absent("md_product_barcode","barcode",value,null);}
   }else{
    var p=one("SELECT * FROM md_product WHERE product_code=?",code);b.put("productId",p.get("id"));b.put("productVersion",p.get("version"));String unit=Inputs.required(b,"unit");
    if(type.equals("PRODUCT_UNIT")){factor(b,p.get("base_unit").toString());absent("md_product_unit","unit",unit,((Number)p.get("id")).longValue());source+="/"+unit;}
    else{if(db.queryForObject("SELECT count(*) FROM md_product_unit WHERE product_id=? AND unit=?",Integer.class,p.get("id"),unit)!=1)throw Inputs.bad("条码单位未配置");String barcode=Inputs.required(b,"barcode");absent("md_product_barcode","barcode",barcode,null);source=barcode;}
   }
  }else if(type.equals("CUSTOMER_ADDRESS")){
   a.require("md:customer:edit");source=Inputs.required(b,"customerCode");var p=one("SELECT * FROM md_customer WHERE country_id=? AND code=?",a.requireCountry(),source);a.requireRow(DbRows.camel(p));addresses(b.get("addresses"));b.put("customerId",p.get("id"));b.put("customerVersion",p.get("version"));
  }else{
   String code=Inputs.required(b,"code");Inputs.required(b,"name");source=code;String table=type.equals("CUSTOMER")?"md_customer":type.equals("SUPPLIER")?"md_supplier":"md_logistics_provider";absent(table,"code",code,a.requireCountry());
   if(type.equals("CUSTOMER")){
    a.require("md:customer:edit");if(b.get("addresses")!=null)addresses(b.get("addresses"));
    Long store=b.get("storeId")==null?null:Inputs.id(b.get("storeId"));if(store!=null){reference("org_store",store,a.requireCountry());if(!a.scope().all()&&!a.scope().stores().contains(store))throw ApiException.notFound();}else if(!a.scope().all()&&a.scope().stores().isEmpty())throw ApiException.notFound();
    for(String field:List.of("groupId","levelId"))if(b.get(field)!=null)reference(field.equals("groupId")?"md_customer_group":"md_customer_level",Inputs.id(b.get(field)),a.requireCountry());
    if(b.get("salesOwnerId")!=null&&db.queryForObject("SELECT count(*) FROM sys_user u JOIN sys_user_role ur ON ur.user_id=u.id WHERE ur.country_id=? AND u.id=? AND u.status='ENABLED'",Integer.class,a.requireCountry(),Inputs.id(b.get("salesOwnerId")))==0)throw Inputs.bad("负责人未获本国授权");
   }else{
    a.require("md:partner:edit");String currency=Inputs.required(b,"settleCurrency");if(db.queryForObject("SELECT count(*) FROM md_currency WHERE code=? AND status='ENABLED'",Integer.class,currency)!=1)throw Inputs.bad("结算币种未启用");
    // Banking is deliberately maintained only in the existing protected bank interface.
    for(String field:List.of("bankName","accountName","accountNo","accountNoMasked","bankAddress","swiftCode"))if(b.containsKey(field))throw Inputs.bad("银行资料请使用受控账户维护入口");
   }
  }
  if(b.containsKey("status")&&!Set.of("ENABLED","DISABLED").contains(b.get("status")))throw Inputs.bad("档案状态不合法");return new Row(rowNo,b,source);
 }
 public Target apply(RequestContext c,Access a,Batch batch,Row row){
  var b=new LinkedHashMap<>(row.values());String key=ImportHandler.commandKey(batch,row,"master");Map<String,Object> result;
  switch(batch.type()){
   case "PRODUCT"->result=products.saveProduct(c,null,b,key);
   case "PRODUCT_UNIT","PRODUCT_BARCODE"->{long id=Inputs.id(b.get("productId"));var current=DbRows.camel(one("SELECT * FROM md_product WHERE id=? FOR UPDATE",id));long prior=db.queryForObject("SELECT count(*) FROM sys_import_row WHERE batch_id=? AND country_id=? AND target_id=? AND target_type IN ('PRODUCT_UNIT','PRODUCT_BARCODE')",Long.class,batch.id(),a.requireCountry(),id);if(Inputs.id(current.get("version"))!=Inputs.id(b.get("productVersion"))+prior)throw Inputs.conflict();var units=new ArrayList<Map<String,Object>>(db.queryForList("SELECT * FROM md_product_unit WHERE product_id=? ORDER BY id",id).stream().map(DbRows::camel).toList());var barcodes=new ArrayList<Map<String,Object>>(db.queryForList("SELECT * FROM md_product_barcode WHERE product_id=? ORDER BY id",id).stream().map(DbRows::camel).toList());if(batch.type().equals("PRODUCT_UNIT"))units.add(b);else barcodes.add(b);current.put("units",units);current.put("barcodes",barcodes);result=products.saveProduct(c,id,current,key);}
   case "CUSTOMER"->result=customers.save(c,"customers",null,b,key);
   case "CUSTOMER_ADDRESS"->{long id=Inputs.id(b.get("customerId"));var current=customers.get(c,"customers",id);current.put("version",b.get("customerVersion"));current.put("addresses",b.get("addresses"));result=customers.save(c,"customers",id,current,key);}
   default->result=suppliers.save(c,batch.type().equals("SUPPLIER")?"suppliers":"logistics-providers",null,b,key);
  }
  return new Target(batch.type(),Inputs.id(result.get("id")));
 }
 private void factor(Map<String,Object>b,String base){var value=Inputs.decimal(b.get("factorToBase"),8,new BigDecimal("9999999999"));if(value.signum()<=0||base.equals(b.get("unit"))&&value.compareTo(BigDecimal.ONE)!=0)throw Inputs.bad("单位换算不合法");}
 private void addresses(Object raw){if(!(raw instanceof List<?> list)||list.stream().anyMatch(v->!(v instanceof Map<?,?>)))throw Inputs.bad("客户地址必须为对象列表");}
 @SuppressWarnings("unchecked") private List<Map<String,Object>> maps(Object raw){if(!(raw instanceof List<?> list)||list.stream().anyMatch(v->!(v instanceof Map<?,?>)))throw Inputs.bad("明细必须为对象列表");return (List<Map<String,Object>>)(List<?>)list;}
 private Map<String,Object> one(String sql,Object...args){var rows=db.queryForList(sql,args);if(rows.isEmpty())throw ApiException.notFound();return rows.getFirst();}
 private void reference(String table,long id,Long country){if(db.queryForObject("SELECT count(*) FROM "+table+" WHERE id=?"+(country==null?"":" AND country_id=?"),Integer.class,country==null?new Object[]{id}:new Object[]{id,country})!=1)throw Inputs.bad("引用档案不存在");}
 private void absent(String table,String column,String value,Long parent){String where=column+"=?";var args=new ArrayList<Object>();args.add(value);if(parent!=null){where+=" AND "+(table.equals("md_product_unit")?"product_id":"country_id")+"=?";args.add(parent);}if(db.queryForObject("SELECT count(*) FROM "+table+" WHERE "+where,Integer.class,args.toArray())>0)throw new ApiException(409,"MD_IMPORT_EXISTS","档案或单位条码已存在");}
}
