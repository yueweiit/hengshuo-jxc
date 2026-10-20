package com.hs.jxc.it;
import com.hs.jxc.workflow.api.WorkflowParticipant;
import com.hs.jxc.workflow.service.WorkflowService;
import com.hs.jxc.sys.service.DocumentAccessService;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import static org.junit.jupiter.api.Assertions.*;
/** A business participant failure must roll back both the approval and its business writes. */
class WorkflowParticipantIT extends BasePgIT {
 @Autowired DocumentAccessService sources;@Autowired WorkflowService workflow;
 @BeforeEach void fixture(){
  WorkflowIT.seedWorkflowData();
 }
 com.hs.jxc.common.context.RequestContext editor(){return new com.hs.jxc.common.context.RequestContext(81101L,81001L,"wf-tx",WorkflowIT.HASH);}
 com.hs.jxc.common.context.RequestContext approver(){return new com.hs.jxc.common.context.RequestContext(81102L,81001L,"wf-tx-approve",com.hs.jxc.sys.service.SessionService.digest("approver-token"));}
 Map<String,Object> rule(String name){return Map.of("name",name,"docType","ORG_ENTITY","conditions",List.of(),"nodes",List.of(Map.of("nodeName","负责人","approverType","USER","approverRef",81102L,"mode","ANY")));}
 @Test void approvalAndParticipantCommitTogetherAndFailureCanBeRetried(){
  String type="M2_TX_PARTICIPANT";var fail=new AtomicBoolean(true);
  sources.register(type,List.of("org:entity:edit"),List.of("org:entity:edit"),(a,id)->{
   var r=jdbc.queryForMap("SELECT * FROM org_entity WHERE country_id=? AND id=?",a.requireCountry(),id);
   return Map.of("id",id,"countryId",a.requireCountry(),"entityId",id,"name",r.get("name"),"version",r.get("version"));
  },(a,id)->jdbc.queryForObject("SELECT id FROM org_entity WHERE country_id=? AND id=? FOR UPDATE",Long.class,a.requireCountry(),id));
  workflow.registerCriticalFields(type,Set.of("name"));
  workflow.registerParticipant(type,new WorkflowParticipant(){
   public void onDecision(com.hs.jxc.common.context.RequestContext c,com.hs.jxc.sys.api.Access a,long id,String status){
    assertTrue(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive());
    jdbc.update("UPDATE org_entity SET name='business committed' WHERE country_id=? AND id=?",a.requireCountry(),id);
    if(fail.get())throw new IllegalStateException("injected participant failure");
   }
  });
  var rule=new HashMap<>(rule("事务参与者"));rule.put("docType",type);workflow.createRule(editor(),rule);
  tx.execute(s->workflow.submit(editor(),type,81301,Map.of(),true));
  long task=owner.queryForObject("SELECT id FROM wf_task",Long.class);
  assertThrows(IllegalStateException.class,()->workflow.approve(approver(),task,"同意"));
  assertEquals("PENDING",owner.queryForObject("SELECT status FROM wf_task",String.class));
  assertEquals("PENDING",owner.queryForObject("SELECT status FROM wf_instance",String.class));
  assertEquals("审批主体",owner.queryForObject("SELECT name FROM org_entity",String.class));
  fail.set(false);workflow.approve(approver(),task,"同意");
  assertEquals("APPROVED",owner.queryForObject("SELECT status FROM wf_instance",String.class));
  assertEquals("business committed",owner.queryForObject("SELECT name FROM org_entity",String.class));
 }
}
