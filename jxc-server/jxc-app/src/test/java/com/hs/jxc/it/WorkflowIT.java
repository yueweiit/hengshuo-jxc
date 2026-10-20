package com.hs.jxc.it;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.service.SessionService;
import com.hs.jxc.workflow.service.WorkflowService;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class WorkflowIT extends BasePgIT {
    @Autowired WorkflowService workflow;
    @Autowired com.hs.jxc.sys.service.DocumentGovernanceService governance;
    @Autowired com.hs.jxc.sys.jobs.WorkbenchService workbench;
    static final String HASH=SessionService.digest("workflow-fixture-token");
    @BeforeEach void seedWorkflow(){seedWorkflowData();}
    static void seedWorkflowData(){
        PgDatabase.reset();
        owner.execute("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(81001,'WF','审批测试','CNY','Asia/Shanghai','ACTIVE')");
        owner.execute("INSERT INTO sys_authz_epoch(country_id) VALUES(81001)");
        owner.execute("INSERT INTO sys_user(id,username,password_hash,display_name,created_country_id) VALUES(81101,'wf-editor','unused','Editor',81001),(81102,'wf-approver','unused','Approver',81001)");
        owner.update("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,81101,clock_timestamp()+interval '1 hour'),(?,81102,clock_timestamp()+interval '1 hour')",HASH,SessionService.digest("approver-token"));
        owner.execute("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(81201,81001,'WF_EDITOR','审批配置','[\"*\"]','{}'),(81202,81001,'WF_APPROVER','业务审批','[\"org:entity:edit\"]','{}')");
        owner.execute("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(81001,81101,81201),(81001,81102,81202)");
        owner.execute("INSERT INTO org_entity(id,country_id,code,name) VALUES(81301,81001,'WF_ENTITY','审批主体')");
        owner.execute("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(81001,81101,'COUNTRY_ALL',81101),(81001,81102,'COUNTRY_ALL',81101)");
    }
    RequestContext editor(){return new RequestContext(81101L,81001L,"wf-test",HASH);}
    RequestContext approver(){return new RequestContext(81102L,81001L,"wf-approve",SessionService.digest("approver-token"));}
    Map<String,Object> rule(String name){return Map.of("name",name,"docType","ORG_ENTITY","conditions",List.of(),"nodes",List.of(Map.of("nodeName","负责人","approverType","USER","approverRef",81102L,"mode","ANY")));}
    @Test void delegatedApprovalUsesTheActualActorAndNeverTransfersSourceScope(){
        workflow.createRule(editor(),rule("代理审批"));
        tx.execute(s->workflow.submit(editor(),"ORG_ENTITY",81301L,Map.of(),true));
        long task=owner.queryForObject("SELECT id FROM wf_task",Long.class);
        var delegated=governance.delegate(approver(),Map.of("toUserId",81101L,"scope",List.of("ORG_ENTITY"),"endAt",java.time.Instant.now().plusSeconds(3600).toString(),"reason","isolated temporary coverage"));
        owner.execute("DELETE FROM sys_user_data_scope WHERE user_id=81101");
        assertEquals(404,assertThrows(ApiException.class,()->workflow.approve(editor(),task,"denied without own scope")).getStatus());
        assertEquals("PENDING",owner.queryForObject("SELECT status FROM wf_task WHERE id=?",String.class,task));
        owner.execute("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(81001,81101,'COUNTRY_ALL',81101)");
        assertEquals(1,((List<?>)workflow.tasks(editor(),Map.of()).get("records")).size());
        workflow.approve(editor(),task,"approved by eligible delegated user");
        assertEquals(81101L,owner.queryForObject("SELECT acted_by FROM wf_task WHERE id=?",Long.class,task));
        assertEquals(81102L,owner.queryForObject("SELECT delegate_from_id FROM wf_task WHERE id=?",Long.class,task));
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM sys_user_role WHERE user_id=81101 AND role_id=81202",Integer.class));
    }
    @Test void revokedAndExpiredDelegationsCannotExecuteOriginalApproverTasks(){
        workflow.createRule(editor(),rule("限时代理"));tx.execute(s->workflow.submit(editor(),"ORG_ENTITY",81301L,Map.of(),true));long task=owner.queryForObject("SELECT id FROM wf_task",Long.class);
        var delegated=governance.delegate(approver(),Map.of("toUserId",81101L,"scope",List.of("ORG_ENTITY"),"endAt",java.time.Instant.now().plusSeconds(3600).toString(),"reason","revocation test"));long id=((Number)delegated.get("id")).longValue();governance.revoke(approver(),id);
        assertEquals(404,assertThrows(ApiException.class,()->workflow.approve(editor(),task,"revoked")).getStatus());
        owner.update("UPDATE sys_delegation SET status='ACTIVE',start_at=clock_timestamp()-interval '1 hour',end_at=clock_timestamp()-interval '1 second' WHERE id=?",id);
        assertEquals(0,((List<?>)workflow.tasks(editor(),Map.of()).get("records")).size());
        assertEquals(404,assertThrows(ApiException.class,()->workflow.approve(editor(),task,"expired")).getStatus());
    }

    @Test void ccArrivesInExistingWorkbenchAndDisappearsWhenSourceAuthorityIsRevoked(){
        governance.saveWatcher(editor(),null,Map.of("watchType","CC","targetType","DOC","docType","ORG_ENTITY","docId",81301L,"userId",81102L,"fieldGroups",List.of()));
        workflow.createRule(editor(),rule("抄送审批"));tx.execute(s->workflow.submit(editor(),"ORG_ENTITY",81301L,Map.of(),true));
        var before=(List<Map<String,Object>>)workbench.todos(approver(),Map.of()).get("records");assertEquals(1,before.stream().filter(r->"WORKFLOW_CC".equals(r.get("todoType"))).count());
        owner.execute("DELETE FROM sys_user_data_scope WHERE user_id=81102");
        var after=(List<Map<String,Object>>)workbench.todos(approver(),Map.of()).get("records");assertEquals(0,after.stream().filter(r->"WORKFLOW_CC".equals(r.get("todoType"))).count());
    }

    @Test void copiedApprovalDraftCannotActivateWithoutLocalApproverAndConditionValues(){
        owner.execute("INSERT INTO wf_rule(id,country_id,rule_key,doc_type,name,nodes,status,created_by) VALUES(81901,81001,'TPL-LOCAL','ORG_ENTITY','Copied draft','[{\"seq\":1,\"nodeName\":\"Local owner\",\"approverType\":\"USER\",\"requiresLocalApprover\":true,\"mode\":\"ANY\"}]','DRAFT',81101)");
        assertEquals(400,assertThrows(ApiException.class,()->workflow.toggleRule(editor(),81901,true)).getStatus());
        var incomplete=new LinkedHashMap<>(rule("Local amount required"));incomplete.put("conditions",List.of(Map.of("field","amount","op","gte")));
        assertEquals(400,assertThrows(ApiException.class,()->workflow.createRule(editor(),incomplete)).getStatus());
    }

    @Test void missingRequiredConfigurationBlocksAndCreatesOneTodo(){
        var result=tx.execute(s->workflow.submit(editor(),"ORG_ENTITY",81301L,Map.of(),true));
        assertEquals("BLOCKED",result.get("status"));
        assertEquals(1,owner.queryForObject("SELECT count(*) FROM sys_todo WHERE todo_type='CONFIG_MISSING'",Integer.class));
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM wf_instance WHERE status='APPROVED'",Integer.class));
    }
    @Test void onlyAnExplicitNoApprovalConfigurationCanAutoApprove(){
        owner.execute("INSERT INTO wf_doc_type_config(country_id,doc_type,approval_required,key_fields) VALUES(81001,'ORG_ENTITY',false,'[\"name\"]')");
        assertEquals("APPROVED",tx.execute(s->workflow.submit(editor(),"ORG_ENTITY",81301L,Map.of(),false)).get("status"));
    }
    @Test void disabledApproverBlocksInsteadOfCreatingAnExecutableTask(){
        workflow.createRule(editor(),rule("负责人审批"));
        owner.execute("UPDATE sys_user SET status='DISABLED' WHERE id=81102");
        assertEquals("BLOCKED",tx.execute(s->workflow.submit(editor(),"ORG_ENTITY",81301L,Map.of(),true)).get("status"));
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM wf_task",Integer.class));
    }
    @Test void rolePermissionRevocationMakesAnApproverIneligible(){
        workflow.createRule(editor(),rule("负责人审批"));
        owner.execute("UPDATE sys_role SET permissions='[]' WHERE id=81202");
        assertEquals("BLOCKED",tx.execute(s->workflow.submit(editor(),"ORG_ENTITY",81301L,Map.of(),true)).get("status"));
    }
    @Test void editingActiveRuleCreatesANewVersionAndKeepsInflightReference(){
        var first=workflow.createRule(editor(),rule("版本一"));
        var submitted=tx.execute(s->workflow.submit(editor(),"ORG_ENTITY",81301L,Map.of(),true));
        assertEquals("PENDING",submitted.get("status"));
        var change=new HashMap<>(rule("版本二"));change.put("version",first.get("version"));
        var second=workflow.updateRule(editor(),((Number)first.get("id")).longValue(),change);
        assertEquals(2,((Number)second.get("versionNo")).intValue());
        assertNotEquals(first.get("id"),second.get("id"));
        assertEquals(((Number)first.get("id")).longValue(),owner.queryForObject("SELECT rule_id FROM wf_instance",Long.class));
    }
    @Test void approvedKeyFieldsMustStillMatchTheCurrentSource(){
        owner.execute("INSERT INTO wf_doc_type_config(country_id,doc_type,approval_required,key_fields) VALUES(81001,'ORG_ENTITY',true,'[\"name\"]')");
        workflow.createRule(editor(),rule("关键字段审批"));
        tx.execute(s->workflow.submit(editor(),"ORG_ENTITY",81301L,Map.of(),true));
        long taskId=owner.queryForObject("SELECT id FROM wf_task",Long.class);
        workflow.approve(approver(),taskId,"同意");
        tx.execute(s->{workflow.requireApproved(editor(),"ORG_ENTITY",81301L);return null;});
        owner.execute("UPDATE org_entity SET name='关键字段已修改' WHERE id=81301");
        assertEquals("WF_APPROVAL_INVALIDATED",assertThrows(ApiException.class,()->tx.execute(s->{workflow.requireApproved(editor(),"ORG_ENTITY",81301L);return null;})).getCode());
        tx.execute(s->{workflow.invalidate(editor(),"ORG_ENTITY",81301L,"主档已修改");return null;});
        assertEquals("INVALIDATED",owner.queryForObject("SELECT status FROM wf_instance",String.class));
    }
    @Test void unregisteredBusinessSourcesFailClosed(){
        assertEquals(404,assertThrows(ApiException.class,()->tx.execute(s->workflow.submit(editor(),"FUTURE_GL_POSTING",999L,Map.of(),true))).getStatus());
    }
    @Test void editingDisabledRuleDoesNotImplicitlyEnableTheNewVersion(){
        var first=workflow.createRule(editor(),rule("停用规则"));
        var disabled=workflow.toggleRule(editor(),((Number)first.get("id")).longValue(),false);
        var body=new HashMap<>(rule("停用规则新版本"));body.put("version",disabled.get("version"));
        var next=workflow.updateRule(editor(),((Number)first.get("id")).longValue(),body);
        assertEquals("DISABLED",next.get("status"));
    }
    @Test void configurationResponseUsesAnArrayForVueKeyFieldsAndReturnsNewVersion(){
        var config=workflow.configure(editor(),"ORG_ENTITY",Map.of("approvalRequired",true,"keyFields",List.of("name")));
        assertEquals(List.of("name"),config.get("keyFields"));
        assertEquals(1,((Number)config.get("version")).intValue());
    }
    @Test void documentHistoryDoesNotExposeSensitiveSnapshotHashes(){
        workflow.createRule(editor(),rule("历史负责人"));
        tx.execute(s->workflow.submit(editor(),"ORG_ENTITY",81301L,Map.of(),true));
        var history=workflow.instances(editor(),"ORG_ENTITY",81301L);
        assertEquals(1,history.size());
        assertFalse(history.getFirst().containsKey("keyFieldsHash"));
        assertFalse(history.getFirst().containsKey("keyFieldsSnapshot"));
        assertEquals("Editor",history.getFirst().get("submittedByName"));
        assertEquals("历史负责人",history.getFirst().get("ruleName"));
        var tasks=(List<Map<String,Object>>)history.getFirst().get("tasks");
        assertEquals("Approver",tasks.getFirst().get("assigneeName"));
        owner.execute("UPDATE sys_user SET status='DISABLED' WHERE id=81102");
        assertEquals("Approver",((List<Map<String,Object>>)workflow.instances(editor(),"ORG_ENTITY",81301L).getFirst().get("tasks")).getFirst().get("assigneeName"));
    }

}
