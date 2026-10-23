package com.hs.jxc.workflow.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.api.*;
import com.hs.jxc.sys.service.*;
import java.util.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;

class ApprovalTaskQueryTest {
    final RequestContext context = new RequestContext(1,1L,"approval-query","synthetic");
    final List<Map<String,Object>> source = new ArrayList<>();
    final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    final DocumentGovernanceService governance = mock(DocumentGovernanceService.class);
    final DocumentAccessService docs = mock(DocumentAccessService.class);
    final FieldPolicyService fields = mock(FieldPolicyService.class);
    final JsonCodec json = new JsonCodec();
    WorkflowService service;

    @BeforeEach void setup() {
        var auth = mock(AuthorizationService.class);
        var transactions = mock(PlatformTransactionManager.class);
        when(auth.authorize(context)).thenReturn(new Access(1,1L,false,Set.of(),Map.of(),DataScope.none(),null));
        when(transactions.getTransaction(any())).thenReturn(new SimpleTransactionStatus());
        when(jdbc.queryForList(anyString(),eq(1L),eq(1L),eq(1L))).thenAnswer(invocation -> source);
        when(jdbc.queryForList(anyString(),eq(String.class),any(),eq(1L))).thenReturn(List.of("陈晓"));
        when(fields.mask(any(),anyMap(),anyString())).thenAnswer(invocation -> invocation.getArgument(1));
        service = new WorkflowService(jdbc,auth,docs,mock(SystemManagementService.class),fields,json,transactions,mock(AuditWriter.class),governance);
    }
    Map<String,Object> task(long id,String type,String status,String instance) {
        var row = new LinkedHashMap<String,Object>();
        row.put("id",id);row.put("doc_id",id);row.put("doc_type",type);row.put("status",status);row.put("instance_status",instance);
        row.put("submitted_by",1L);row.put("key_fields_snapshot",json.write(Map.of("docNo","SO-"+id,"docTitle","日常核对","facts",Map.of("currency","USD","amount",100))));
        return row;
    }
    @SuppressWarnings("unchecked") List<Map<String,Object>> rows(Map<String,Object> result) { return (List<Map<String,Object>>)result.get("records"); }

    @Test void filtersTheCompleteAuthorizedQueueBeforeApplyingPagination() {
        for(int id=1;id<=45;id++)source.add(task(id,id%2==0?"PURCHASE_ORDER":"SALES_ORDER","PENDING","PENDING"));
        var result = service.tasks(context,Map.of("docType","SALES_ORDER","keyword","SO-","page","2","size","20"));
        assertThat(result.get("total")).isEqualTo(23);
        assertThat(rows(result)).extracting(row->row.get("id")).containsExactly(41L,43L,45L);
    }
    @Test void keywordMatchesNumberSummaryAndSubmitterWithTrimmedCaseInsensitiveText() {
        source.add(task(45,"SALES_ORDER","PENDING","PENDING"));
        for(String keyword:List.of("  so-45  ","日常","陈晓")) {
            assertThat(service.tasks(context,Map.of("keyword",keyword)).get("total")).isEqualTo(1);
        }
        assertThat(service.tasks(context,Map.of("keyword","no match")).get("total")).isEqualTo(0);
        assertThat(service.tasks(context,Map.of("keyword","SO-45","docType","REFUND")).get("total")).isEqualTo(0);
    }
    @Test void searchNeverReintroducesInaccessibleRowsOrMaskedValues() {
        source.add(task(1,"SALES_ORDER","PENDING","PENDING"));
        source.add(task(2,"SALES_ORDER","PENDING","PENDING"));
        doThrow(new ApiException(403,"SYS_FORBIDDEN","无权读取")).when(governance).requireTaskAuthority(any(),eq(source.get(0)),anyString(),eq(1L));
        when(fields.mask(any(),anyMap(),anyString())).thenAnswer(invocation -> {
            Map<String,Object> value = new LinkedHashMap<>(invocation.<Map<String,Object>>getArgument(1));
            value.remove("docTitle");return value;
        });
        assertThat(service.tasks(context,Map.of("keyword","SO-1")).get("total")).isEqualTo(0);
        assertThat(service.tasks(context,Map.of("keyword","日常")).get("total")).isEqualTo(0);
        assertThat(service.tasks(context,Map.of("keyword","SO-2")).get("total")).isEqualTo(1);
    }
    @Test void pendingAndProcessedModesKeepTheirExistingVisibilityRules() {
        source.add(task(1,"SALES_ORDER","PENDING","PENDING"));
        source.add(task(2,"SALES_ORDER","PENDING","INVALIDATED"));
        source.add(task(3,"SALES_ORDER","APPROVED","PENDING"));
        source.add(task(4,"SALES_ORDER","SKIPPED","APPROVED"));
        assertThat(rows(service.tasks(context,Map.of()))).extracting(row->row.get("id")).containsExactly(1L);
        assertThat(rows(service.tasks(context,Map.of("mode","done")))).extracting(row->row.get("id")).containsExactly(3L);
    }
    @Test void usesSubmissionOrActionTimeAndAnIdTieBreakerInTheDatabaseQuery() {
        service.tasks(context,Map.of());
        verify(jdbc).queryForList(contains("ORDER BY i.submitted_at DESC NULLS LAST,t.id DESC"),eq(1L),eq(1L),eq(1L));
        service.tasks(context,Map.of("mode","done"));
        verify(jdbc).queryForList(contains("ORDER BY t.acted_at DESC NULLS LAST,t.id DESC"),eq(1L),eq(1L),eq(1L));
    }
}
