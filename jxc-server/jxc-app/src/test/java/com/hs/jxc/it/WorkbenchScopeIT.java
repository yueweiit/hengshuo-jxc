package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.workflow.service.WorkflowService;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import tools.jackson.databind.json.JsonMapper;

/** Reuses the existing workflow fixture and owner API; no alternate approval algorithm. */
class WorkbenchScopeIT extends BasePgIT {
    @Autowired WorkflowService workflow;
    @Value("${local.server.port}") int port;
    final HttpClient http=HttpClient.newHttpClient();final JsonMapper json=JsonMapper.builder().build();
    @BeforeEach void fixture(){WorkflowIT.seedWorkflowData();}
    @Test void approvalSummaryAndLaterTodoPagesIncludeMoreThanTheFirstTwoHundredTasks()throws Exception{
        var editor=new RequestContext(81101,81001L,"workbench-many-approvals",WorkflowIT.HASH);
        workflow.createRule(editor,Map.of("name","Synthetic approval backlog","docType","ORG_ENTITY","conditions",List.of(),"nodes",List.of(Map.of("nodeName","Approver","approverType","USER","approverRef",81102,"mode","ANY"))));
        seed("insert into org_entity(id,country_id,code,name) select 82000+n,81001,'WB-'||n,'Synthetic workflow entity '||n from generate_series(0,204) n");
        tx.executeWithoutResult(status->{for(long id=82000;id<82205;id++)workflow.submit(editor,"ORG_ENTITY",id,Map.of(),true);});
        assertThat(owner.queryForObject("select count(*) from wf_task where assignee_id=81102 and status='PENDING'",Integer.class)).isEqualTo(205);
        var summary=get("/sys/workbench/summary");var approvals=rows(summary.get("items")).stream().filter(r->"APPROVAL".equals(r.get("type"))).findFirst().orElseThrow();assertThat(((Number)approvals.get("count")).intValue()).isEqualTo(205);
        var page=get("/sys/todos?type=APPROVAL&page=2&size=200");assertThat(((Number)page.get("total")).intValue()).isEqualTo(205);assertThat(rows(page.get("records"))).hasSize(5);
    }
    @Test void blockedWorkflowConfigurationTodoIsReadFromItsOwnerAndRechecksSourceScope()throws Exception {
        var editor=new RequestContext(81101,81001L,"workbench-config",WorkflowIT.HASH);
        var result=tx.execute(status->workflow.submit(editor,"ORG_ENTITY",81301L,Map.of(),true));
        assertThat(result).containsEntry("status","BLOCKED");
        var summary=getAs("/sys/workbench/summary","workflow-fixture-token");
        assertThat(rows(summary.get("items"))).anySatisfy(r->assertThat(r).containsEntry("type","CONFIG_MISSING").containsEntry("count",1));
        seed("delete from sys_user_data_scope where user_id=81101");
        assertThat(rows(getAs("/sys/workbench/summary","workflow-fixture-token").get("items"))).noneSatisfy(r->assertThat(r).containsEntry("type","CONFIG_MISSING"));
        assertThat(owner.queryForObject("select count(*) from sys_todo",Integer.class)).isEqualTo(1);
    }
    @SuppressWarnings("unchecked") private List<Map<String,Object>> rows(Object value){return (List<Map<String,Object>>)value;}
    @SuppressWarnings("unchecked") private Map<String,Object> get(String path)throws Exception{return getAs(path,"approver-token");}
    @SuppressWarnings("unchecked") private Map<String,Object> getAs(String path,String token)throws Exception{var r=http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1"+path)).header("Authorization","Bearer "+token).header("X-Country-Id","81001").GET().build(),HttpResponse.BodyHandlers.ofString());assertThat(r.statusCode()).withFailMessage(r.body()).isEqualTo(200);return (Map<String,Object>)json.readValue(r.body(),Map.class).get("data");}
}
