package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.inv.api.InventoryApi;
import com.hs.jxc.sal.SalesService;
import com.hs.jxc.workflow.service.WorkflowService;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Autowired;

/** The original owner submissions supply immutable task summaries; field grants never expand with workflow access. */
class WorkflowTaskSummaryIT extends SupplyFixtures {
 @Autowired WorkflowService workflow;@Autowired SalesService sales;@Autowired InventoryApi inventory;
 Map<String,Object> rule(String type,String name){return Map.of("docType",type,"name",name,"conditions",List.of(),"nodes",List.of(Map.of("nodeName","Owner review","approverType","USER","approverRef",201,"mode","ANY")));}
 @SuppressWarnings("unchecked") Map<String,Object> task(String mode){return ((List<Map<String,Object>>)workflow.tasks(c(),Map.of("mode",mode)).get("records")).getFirst();}
 void visibleSummary(Map<String,Object> row,String currency){assertThat(row.get("amount")).as("Frozen native amount").isNotNull();assertThat(new BigDecimal(row.get("amount").toString())).isEqualByComparingTo("14");assertThat(row).containsEntry("currency",currency).containsEntry("ruleName","Submitted rule").containsEntry("ruleVersionNo",1).containsEntry("submittedByName","Supply");assertThat(row.get("submittedAt")).isNotNull();assertThat(row).doesNotContainKeys("keyFieldsSnapshot","key_fields_snapshot","keyFieldsHash","facts","fields","lines");}
 @ParameterizedTest @CsvSource({"PURCHASE_ORDER,CNY,COST,ORDER_TOTAL","SALES_ORDER,MXN,ORDER_TOTAL,COST"})
 void nativePendingAndDoneTasksExposeFrozenSummaryAndUseTheirOwnerFieldGroup(String type,String currency,String needed,String other){
  workflow.configure(c(),type,Map.of("version",1,"approvalRequired",true,"keyFields",List.of()));var firstRule=workflow.createRule(c(),rule(type,"Submitted rule"));
  long document;
  if(type.equals("PURCHASE_ORDER")){var po=pur.create(c(),"orders",Map.of("bookId",601,"supplierId",801,"orderDate","2026-10-15","lines",List.of(Map.of("productId",501,"unit","PCS","qty",2,"unitPrice",7))),key());document=id(po);pur.action(c(),"orders",document,"submit",Map.of("bizDate","2026-10-15"),key());}
  else{
   seed("INSERT INTO md_customer(id,country_id,code,name) VALUES(804,101,'CUSTOMER','Customer')");seed("INSERT INTO sal_price(country_id,product_id,price_type,unit,min_qty,price,currency,effective_from) VALUES(101,501,'BASE','PCS',1,7,'MXN','2026-10-01')");
   inCountry(101,()->inventory.inbound(c(),new InventoryApi.Inbound(601,401,501,BigDecimal.TEN,BigDecimal.ZERO,BigDecimal.ZERO,new InventoryApi.Source("LGS_RECEIPT",901,902,"WF-INITIAL"),LocalDate.of(2026,10,15),null,null,null)));
   var order=sales.create(c(),Map.of("bookId",601,"customerId",804,"paymentType","CASH","orderDate","2026-10-15","lines",List.of(Map.of("productId",501,"unit","PCS","qty",2,"warehouseId",401))),key());document=id(order);sales.submit(c(),document,Map.of("bizDate","2026-10-15"),key());
  }
  var pending=task("todo");visibleSummary(pending,currency);long taskId=id(pending);assertThat(pending.get("docId").toString()).isEqualTo(String.valueOf(document));
  var replacement=new LinkedHashMap<String,Object>(rule(type,"New rule version"));replacement.put("version",firstRule.get("version"));workflow.updateRule(c(),id(firstRule),replacement);visibleSummary(task("todo"),currency);
  seed("UPDATE sys_role SET field_policies=?::jsonb WHERE id=202","{\""+needed+"\":\"READ\",\""+other+"\":\"HIDDEN\"}");visibleSummary(task("todo"),currency);
  seed("UPDATE sys_role SET field_policies=?::jsonb WHERE id=202","{\""+needed+"\":\"HIDDEN\",\""+other+"\":\"READ\"}");var masked=task("todo");assertThat(masked.values()).noneMatch(value->value instanceof String text&&text.contains("\"facts\""));assertThat(masked).doesNotContainKeys("amount","totalAmount","facts","fields","keyFieldsSnapshot","key_fields_snapshot");assertThat(masked).containsEntry("currency",currency).containsEntry("ruleVersionNo",1);
  seed("UPDATE sys_role SET field_policies='{\"COST\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\"}' WHERE id=202");workflow.approve(c(),taskId,"Owner approved the submitted version");visibleSummary(task("done"),currency);
  seed("UPDATE sys_role SET field_policies='{}' WHERE id=202");int audits=owner.queryForObject("SELECT count(*) FROM sys_audit_log",Integer.class);assertThat(task("done")).doesNotContainKeys("amount","totalAmount","facts","fields","keyFieldsSnapshot","key_fields_snapshot");assertThat(owner.queryForObject("SELECT count(*) FROM sys_audit_log",Integer.class)).isEqualTo(audits);
 }
}
