package com.hs.jxc.sys.jobs;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.api.DataScope;
import com.hs.jxc.sys.service.AuthorizationService;
import com.hs.jxc.workflow.service.WorkflowService;
import java.time.OffsetDateTime;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.*;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;

class WorkbenchQueryTest {
    WorkbenchService service;
    final List<Map<String,Object>> source = new ArrayList<>();
    final RequestContext context = new RequestContext(1,1L,"workbench-query","synthetic");

    @BeforeEach @SuppressWarnings("unchecked") void setup() {
        var jdbc = mock(JdbcTemplate.class);
        var auth = mock(AuthorizationService.class);
        var workflow = mock(WorkflowService.class);
        var transactions = mock(PlatformTransactionManager.class);
        var providers = (ObjectProvider<WorkItemProvider>) mock(ObjectProvider.class);
        WorkItemProvider provider = access -> source;
        when(auth.authorize(context)).thenReturn(new Access(1,1L,false,Set.of("sys:todo:view"),Map.of(),DataScope.none(),null));
        when(workflow.tasks(eq(context),anyMap())).thenReturn(Map.of("records",List.of(),"total",0));
        when(transactions.getTransaction(any())).thenReturn(new SimpleTransactionStatus());
        when(providers.orderedStream()).thenAnswer(invocation -> Stream.of(provider));
        service = new WorkbenchService(jdbc,auth,workflow,mock(JobService.class),providers,transactions);
        for (int id=1; id<=25; id++) source.add(row(id,"FIN_EVENT","凭证待处理",OffsetDateTime.parse("2026-10-22T00:00:00Z").plusMinutes(id)));
        source.add(row(26,"STOCK_ALERT","库存预警",null));
    }
    Map<String,Object> row(long id,String type,String title,Object createdAt) {
        var row = new LinkedHashMap<String,Object>();
        row.put("id",id);row.put("todoType",type);row.put("title",title);row.put("typeLabel",type);row.put("link","/original/"+id);
        if(createdAt!=null)row.put("createdAt",createdAt);
        return row;
    }
    @SuppressWarnings("unchecked") List<Map<String,Object>> rows(Map<String,Object> result) { return (List<Map<String,Object>>)result.get("records"); }

    @Test void sortsAndFiltersTheCompleteAuthorizedBacklogBeforePagination() {
        var page=service.todos(context,Map.of("page","2","size","10","type","FIN_EVENT","keyword","凭证","order","desc"));
        assertThat(page.get("total")).isEqualTo(25);
        assertThat(rows(page)).extracting(row->row.get("id")).containsExactly(15L,14L,13L,12L,11L,10L,9L,8L,7L,6L);
        assertThat(rows(page)).allSatisfy(row->assertThat(row.get("link")).isEqualTo("/original/"+row.get("id")));
    }
    @Test void supportsCaseInsensitiveIdAndTitleSearchWithWhitespaceTrimmed() {
        assertThat(rows(service.todos(context,Map.of("keyword"," 25 ")))).extracting(row->row.get("id")).containsExactly(25L);
        source.add(row(27,"FIN_EVENT","Voucher ABC",null));
        assertThat(rows(service.todos(context,Map.of("keyword","voucher abc")))).hasSize(1);
        assertThat(rows(service.todos(context,Map.of("keyword","missing")))).isEmpty();
    }
    @Test void chronologicalSortingHandlesOffsetsAndMissingDatesInBothDirections() {
        source.clear();
        source.add(row(1,"FIN_EVENT","A","2026-10-22 01:00:00+00"));
        source.add(row(2,"FIN_EVENT","B","2026-10-21T22:00:00-06:00"));
        source.add(row(3,"STOCK_ALERT","C",null));
        for(String order:List.of("asc","desc")) {
            var page=service.todos(context,Map.of("order",order));
            assertThat(rows(page)).extracting(row->row.get("id")).containsExactlyElementsOf(order.equals("asc")?List.of(1L,2L,3L):List.of(2L,1L,3L));
        }
    }
    @Test void noOrderingParameterPreservesExistingProviderOrderAndSummaryIsUnaffected() {
        assertThat(rows(service.todos(context,Map.of("size","50")))).extracting(row->row.get("id")).containsExactlyElementsOf(source.stream().map(row->row.get("id")).toList());
        assertThat(service.summary(context).get("items")).asList().hasSize(2);
    }
    @Test void handlesExistingJdbcLocalTimestampsAndDateOnlyProviders() {
        source.clear();
        var local=LocalDateTime.of(2026,10,22,12,0);
        source.add(row(1,"FIN_EVENT","JDBC timestamp",java.sql.Timestamp.valueOf(local).toString()));
        source.add(row(2,"FIN_EVENT","Instant",local.atZone(ZoneId.systemDefault()).toInstant().plusSeconds(1).toString()));
        source.add(row(3,"STOCK_ALERT","Business date","2026-10-21"));
        assertThat(rows(service.todos(context,Map.of("order","desc")))).extracting(row->row.get("id")).containsExactly(2L,1L,3L);
    }
    @Test void invalidOrderAndInvalidTimestampRemainExplicitFailures() {
        assertThatThrownBy(()->service.todos(context,Map.of("order","wrong"))).isInstanceOf(ApiException.class);
        source.add(row(30,"FIN_EVENT","bad date","not-a-date"));
        assertThatThrownBy(()->service.todos(context,Map.of("order","desc"))).isInstanceOf(ApiException.class);
    }
}
