package com.hs.jxc.ap;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.*;
import com.hs.jxc.common.event.OutboxPublisher;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.event.TransactionalEventConsumer;
import com.hs.jxc.lgs.api.LogisticsApi;
import com.hs.jxc.pur.api.SupplyApi;
import com.hs.jxc.sys.api.*;
import com.hs.jxc.sys.jobs.CountryWorkProvider;
import com.hs.jxc.sys.service.*;
import java.util.*;
import java.time.LocalDate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** A configured execution subject may draft claims; bill confirmation remains an explicit command. */
@Service
public class PayableRecognitionService implements CountryWorkProvider, ConfigReadinessContributor {
 private final JdbcTemplate db;private final DbContext context;private final AuthorizationService auth;private final FieldPolicyService fields;private final PayablesService ap;private final SupplyApi supply;private final LogisticsApi logistics;private final TransactionalEventConsumer consumer;private final OutboxPublisher events;private final AuditWriter audit;private final TransactionTemplate tx;private final IdempotencyExecutor idem;
 public PayableRecognitionService(JdbcTemplate db,DbContext context,AuthorizationService auth,FieldPolicyService fields,PayablesService ap,SupplyApi supply,LogisticsApi logistics,TransactionalEventConsumer consumer,OutboxPublisher events,AuditWriter audit,IdempotencyExecutor idem,PlatformTransactionManager tm){this.db=db;this.context=context;this.auth=auth;this.fields=fields;this.ap=ap;this.supply=supply;this.logistics=logistics;this.consumer=consumer;this.events=events;this.audit=audit;this.idem=idem;this.tx=new TransactionTemplate(tm);}
 public String kind(){return "AP_RECOGNITION";}
 private String sourceKind(String value){if(!Set.of("PURCHASE","LOGISTICS","OTHER").contains(value))throw Inputs.bad("应付来源类型不合法");return value;}
 private Map<String,Object> rule(Access a,String type){return rule(a.requireCountry(),type);}
 private Map<String,Object> rule(long country,String type){var rows=db.queryForList("SELECT * FROM ap_recognition_rule WHERE country_id=? AND source_kind=?",country,sourceKind(type));return rows.isEmpty()?new LinkedHashMap<>(Map.of("sourceKind",type,"mode","BILL_CONFIRMED")):DbRows.camel(rows.getFirst());}
 public Map<String,Object> get(RequestContext c,String type){return tx.execute(s->{var a=auth.authorize(c);a.require("ap:recognition:edit","ap:bill:view");return rule(a,type);});}
 private Access subject(Access actor,long user){var a=auth.accessForSubject(actor,user);a.require("ap:bill:create");if(FieldPolicyService.rank(a.fieldGroups().get("COST"))<2||!a.scope().all()&&a.scope().books().isEmpty())throw ApiException.forbidden();return a;}
 public Map<String,Object> save(RequestContext c,String type,Map<String,Object>b,String key){return tx.execute(s->{var a=auth.authorizePolicyWrite(c,false);a.require("ap:recognition:edit");if(!a.scope().all())throw ApiException.forbidden();sourceKind(type);String mode=Inputs.required(b,"mode");if(!Set.of("BILL_CONFIRMED","MANUAL","RECEIPT_CONFIRMED").contains(mode)||type.equals("OTHER")&&mode.equals("RECEIPT_CONFIRMED"))throw Inputs.bad("应付确认规则不合法");Long user=b.get("executionSubjectUserId")==null?null:Inputs.id(b.get("executionSubjectUserId"));if(mode.equals("RECEIPT_CONFIRMED")){if(user==null)throw Inputs.bad("自动生成草稿必须明确配置执行账号");subject(a,user);}return idem.execute(c,"PUT","/api/v1/ap/recognition-rules/"+type,key,b,null,()->{db.queryForObject("SELECT pg_advisory_xact_lock(hashtextextended(?,0))",Object.class,a.requireCountry()+":AP_RULE:"+type);var old=rule(a,type);if(old.get("id")!=null&&Inputs.version(b)!=((Number)old.get("version")).longValue())throw Inputs.conflict();db.update("INSERT INTO ap_recognition_rule(country_id,source_kind,mode,execution_subject_user_id,configured_by) VALUES(?,?,?,?,?) ON CONFLICT(country_id,source_kind) DO UPDATE SET mode=EXCLUDED.mode,execution_subject_user_id=EXCLUDED.execution_subject_user_id,configured_by=EXCLUDED.configured_by,version=ap_recognition_rule.version+1,updated_at=clock_timestamp()",a.requireCountry(),type,mode,user,a.userId());var out=rule(a,type);audit.append(c,"配置应付确认规则","AP_RECOGNITION_RULE",Inputs.id(out.get("id")),old,out);auth.bump(a.requireCountry());return out;},out->rule(a,type));});}
 private void gates(long country){context.apply(null);auth.gate(0,false);context.apply(country);auth.gate(country,false);}
 private Access pointer(long country,long user){return new Access(user,country,false,Set.of(),Map.of(),DataScope.none(),null);}
 public int recover(long country,int limit){var candidates=tx.execute(s->{gates(country);return db.queryForList("SELECT e.id,r.execution_subject_user_id FROM sys_biz_event e JOIN ap_recognition_rule r ON r.country_id=e.country_id AND r.source_kind=CASE WHEN e.event_type='PUR_DOMESTIC_RECEIPT_CONFIRMED' THEN 'PURCHASE' ELSE 'LOGISTICS' END AND r.mode='RECEIPT_CONFIRMED' LEFT JOIN sys_biz_event_consume c ON c.country_id=e.country_id AND c.event_id=e.id AND c.consumer='AP_RECOGNITION' WHERE e.country_id=? AND ((e.event_type='PUR_DOMESTIC_RECEIPT_CONFIRMED' AND e.source_type='DOMESTIC_RECEIPT') OR(e.event_type='LGS_FEE_CONFIRMED' AND e.source_type='LGS_FEE')) AND (c.id IS NULL OR c.status='FAILED' AND c.attempt_count<5 OR c.status='PROCESSING' AND c.updated_at<clock_timestamp()-interval '30 seconds') ORDER BY e.id LIMIT ?",country,Math.max(1,Math.min(100,limit)));});for(var row:candidates){long event=((Number)row.get("id")).longValue();consumer.run(country,event,kind(),e->{String type=e.get("eventType").equals("PUR_DOMESTIC_RECEIPT_CONFIRMED")?"PURCHASE":"LOGISTICS";var configured=rule(country,type);if(!configured.get("mode").equals("RECEIPT_CONFIRMED"))return;long user=Inputs.id(configured.get("executionSubjectUserId"));var a=subject(pointer(country,user),user);long book=Inputs.id(e.get("bookId"));if(!a.canBook(book))throw ApiException.notFound();var inputs=new ArrayList<Map<String,Object>>();if(type.equals("PURCHASE")){for(var src:supply.payableSourcesForReceipt(a,Inputs.id(e.get("sourceId")))){var used=db.queryForObject("SELECT coalesce(sum(qty),0) FROM ap_source_claim WHERE country_id=? AND source_type=? AND source_id=? AND effective",java.math.BigDecimal.class,country,src.sourceType(),src.sourceId());var open=src.originalQty().subtract(used);if(open.signum()>0)inputs.add(Map.of("sourceType",src.sourceType(),"sourceId",src.sourceId(),"qty",open));}}else{for(var src:logistics.listPayableSources(a))if(src.sourceId()==Inputs.id(e.get("sourceId"))&&db.queryForObject("SELECT count(*) FROM ap_source_claim WHERE country_id=? AND source_type=? AND source_id=? AND effective",Integer.class,country,src.sourceType(),src.sourceId())==0)inputs.add(Map.of("sourceType",src.sourceType(),"sourceId",src.sourceId()));}if(inputs.isEmpty())return;var c=new RequestContext(user,country,"ap-recognition",null);var created=ap.createBillEffect(c,a,Map.of("sources",inputs,"billDate",e.get("bizDate").toString()));events.publish(country,book,"AP_BILL_CREATED","AP_BILL",Inputs.id(created.get("id")),1,LocalDate.parse(e.get("bizDate").toString()),Map.of("draftOnly",true,"recognitionRuleId",configured.get("id")));});}return candidates.size();}
 public void daily(long country){}
 public List<Map<String,Object>> readiness(Access a){return readinessForCountry(a.requireCountry());}
 private List<Map<String,Object>> readinessForCountry(long country){var out=new ArrayList<Map<String,Object>>();for(var r:db.queryForList("SELECT * FROM ap_recognition_rule WHERE country_id=? AND mode='RECEIPT_CONFIRMED'",country))try{long user=Inputs.id(r.get("execution_subject_user_id"));subject(pointer(country,user),user);}catch(ApiException e){out.add(Map.of("code","AP_RECOGNITION_SUBJECT_INVALID","sourceKind",r.get("source_kind"),"message","自动应付草稿执行账号缺少当前权限或数据范围"));}return out;}
 @Override public List<Map<String,Object>> check(long country,String action){
  if(action!=null&&!action.isBlank()&&!action.equals("ACTIVATE"))return List.of();
  return tx.execute(s->{gates(country);return readinessForCountry(country).stream().map(issue->Map.<String,Object>of("key",issue.get("code"),"label",issue.get("message")+"（"+issue.get("sourceKind")+"）","level","BLOCK","link","/ap/bills")).toList();});
 }

}
