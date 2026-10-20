package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.sys.jobs.JobApi;import com.hs.jxc.sys.jobs.JobService;
import java.util.*;import org.junit.jupiter.api.Test;import org.springframework.beans.factory.annotation.Autowired;
class PayableStatementExportIT extends PayablesFixtures {
 @Autowired JobApi jobs;@Autowired JobService service;
 @Test void statementExportReadsTheSavedOwnerSnapshotAndRechecksItsDedicatedPermission(){
  billFact(7961,"MXN",42,"1");var statement=ap.statement(c(),Map.of("bookId",601,"partnerId",801,"currency","MXN","periodStart","2026-10-01","periodEnd","2026-10-31"),key());
  var job=jobs.enqueue(c(),"AP_STATEMENT_EXPORT",601,Map.of("statementId",id(statement)),key());jobs.run(101,id(job));assertThat(service.download(c(),id(job)).get("content").toString()).contains("42");
  seed("UPDATE sys_role SET permissions='[\"ap:statement:view\"]' WHERE id=202");assertThatThrownBy(()->service.download(c(),id(job))).isInstanceOf(com.hs.jxc.common.api.ApiException.class).extracting("status").isEqualTo(403);
 }
}
