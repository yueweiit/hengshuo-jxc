package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.sys.jobs.*;
import com.hs.jxc.sys.service.AuthorizationService;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;
@TestPropertySource(properties="jxc.workbench.worker.assignments=101:201")
class OperationalWorkItemsIT extends SupplyFixtures {
 @Autowired List<WorkItemProvider> providers;@Autowired WorkbenchTimerWorker timer;@Autowired AuthorizationService authorization;
 List<Map<String,Object>> items(){return inCountry(101,()->{var a=authorization.authorize(c());var result=new ArrayList<Map<String,Object>>();for(var provider:providers)result.addAll(provider.items(a));return result;});}
 @Test void timedDelayAndHoldTasksUseCurrentNativeFactsDeduplicateAndResolveWithoutGetWrites(){
  seed("UPDATE sys_country SET config=jsonb_build_object('lgs.delay.toleranceHours',0) WHERE id=101");var o=order();var domestic=domestic(o,20,0,0,true);var ex=export(domestic,20,true);var sh=lgs.create(c(),"shipments",Map.of("bookId",601,"destWarehouseId",401,"carrierId",802,"transportMode","AIR","flightNo","F","awbNo","A","plannedEta","2026-10-01T00:00:00Z","bizDate","2026-10-15","submit",true,"lines",List.of(Map.of("sourceLineId",id(first(ex)),"baseQty",10))),key());lgs.action(c(),"shipments",id(sh),"dispatch",Map.of("actualEtd","2026-10-15T00:00:00Z"),key());assertThat(items()).anyMatch(i->"LOGISTICS_DELAY".equals(i.get("todoType")));int audits=owner.queryForObject("SELECT count(*) FROM sys_audit_log",Integer.class);items();assertThat(owner.queryForObject("SELECT count(*) FROM sys_audit_log",Integer.class)).isEqualTo(audits);assertThat(owner.queryForObject("SELECT count(*) FROM sys_todo",Integer.class)).isZero();timer.recover(101,100);timer.recover(101,100);assertThat(owner.queryForObject("SELECT count(*) FROM sys_todo WHERE todo_type='LOGISTICS_DELAY' AND status='OPEN'",Integer.class)).isEqualTo(1);
  lgs.action(c(),"shipments",id(sh),"nodes",Map.of("nodeType","ARRIVED_PORT","actualAt","2026-10-15T01:00:00Z"),key());lgs.action(c(),"shipments",id(sh),"nodes",Map.of("nodeType","CUSTOMS_RELEASED","actualAt","2026-10-15T02:00:00Z"),key());timer.recover(101,100);assertThat(owner.queryForObject("SELECT count(*) FROM sys_todo WHERE todo_type='LOGISTICS_DELAY' AND status='DONE'",Integer.class)).isEqualTo(1);assertThat(items()).anyMatch(i->"PENDING_DISPATCH".equals(i.get("todoType")));
  var hold=lgs.create(c(),"holds",Map.of("shipmentId",id(sh),"bizDate","2026-10-15","reasonCode","WAIT","parkLocation","PORT","ownerId",201,"reviewDate","2026-10-15","lines",List.of(Map.of("shipmentLineId",id(first(sh)),"holdQty",4))),key());assertThat(items()).anyMatch(i->"HOLD_REVIEW".equals(i.get("todoType")));timer.recover(101,100);timer.recover(101,100);assertThat(owner.queryForObject("SELECT count(*) FROM sys_todo WHERE todo_type='HOLD_REVIEW' AND status='OPEN'",Integer.class)).isEqualTo(1);lgs.action(c(),"holds",id(hold),"release",Map.of("bizDate","2026-10-15","lines",List.of(Map.of("holdLineId",id(first(hold)),"qty",4))),key());timer.recover(101,100);assertThat(owner.queryForObject("SELECT count(*) FROM sys_todo WHERE todo_type='HOLD_REVIEW' AND status='DONE'",Integer.class)).isEqualTo(1);
 }
}
