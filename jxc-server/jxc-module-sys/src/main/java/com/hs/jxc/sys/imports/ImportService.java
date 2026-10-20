package com.hs.jxc.sys.imports;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.AuthorizationService;
import java.time.LocalDate;
import java.util.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class ImportService {
 private final com.hs.jxc.sys.service.CountryLifecycle lifecycle;private final JdbcTemplate jdbc;private final AuthorizationService auth;private final IdempotencyExecutor idem;private final JsonCodec json;private final AuditWriter audit;private final ObjectProvider<ImportHandler> handlers;private final TransactionTemplate tx;
 public ImportService(com.hs.jxc.sys.service.CountryLifecycle lifecycle,JdbcTemplate jdbc,AuthorizationService auth,IdempotencyExecutor idem,JsonCodec json,AuditWriter audit,ObjectProvider<ImportHandler> handlers,PlatformTransactionManager tm){this.lifecycle=lifecycle;this.jdbc=jdbc;this.auth=auth;this.idem=idem;this.json=json;this.audit=audit;this.handlers=handlers;this.tx=new TransactionTemplate(tm);}
 private ImportHandler handler(String type){return handlers.orderedStream().filter(h->h.types().contains(type)).findFirst().orElseThrow(()->Inputs.bad("不支持的导入类型"));}
 private void permission(Access a,String type){a.requireCountry();a.require("sys:import:"+type.toLowerCase(Locale.ROOT).replace('_','-'));}
 public Object types(RequestContext c){return tx.execute(s->{var a=auth.authorize(c);a.requireCountry();return handlers.orderedStream().flatMap(h->h.types().stream()).distinct().filter(type->a.has("sys:import:"+type.toLowerCase(Locale.ROOT).replace('_','-'))).sorted().toList();});}
 public Object template(RequestContext c,String type){return tx.execute(s->{var a=auth.authorize(c);permission(a,type);return Map.of("importType",type,"version",1,"columns",handler(type).columns(type),"cutoffRequired",type.startsWith("OPENING_"));});}
 @SuppressWarnings("unchecked")
 public Map<String,Object> create(RequestContext c,Map<String,Object> body){return tx.execute(s->{var a=auth.authorize(c);lifecycle.requireConfigurationWritable(a);String type=Objects.toString(body.get("importType"),"");permission(a,type);var h=handler(type);LocalDate cutoff=null;try{if(body.get("cutoffDate")!=null&&!body.get("cutoffDate").toString().isBlank())cutoff=LocalDate.parse(body.get("cutoffDate").toString());}catch(RuntimeException e){throw Inputs.bad("截止日期格式错误");}if(type.startsWith("OPENING_")&&cutoff==null)throw Inputs.bad("期初必须填写截止日期");
  String sourceText=body.get("sourceFileText")==null?null:Inputs.text(body,"sourceFileText",null);Object provided=body.get("rows");
  if(sourceText!=null){if(sourceText.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>2000000)throw Inputs.bad("导入文件过大");Object parsed;try{parsed=json.read(sourceText,List.class);}catch(RuntimeException e){throw Inputs.bad("源文件须为有效JSON行数组");}if(provided!=null&&!json.write(IdempotencyExecutor.canonical(provided)).equals(json.write(IdempotencyExecutor.canonical(parsed))))throw new ApiException(400,"SYS_IMPORT_SOURCE_MISMATCH","文件内容与提交的行数据不一致");provided=parsed;}
  if(!(provided instanceof List<?> input)||input.isEmpty()||input.size()>10000)throw Inputs.bad("导入须包含1至10000行");
  var raw=new ArrayList<Map<String,Object>>();for(var value:input){if(!(value instanceof Map<?,?> map))throw Inputs.bad("每行必须为对象");raw.add(new LinkedHashMap<>((Map<String,Object>)map));}
  String serialized=json.write(IdempotencyExecutor.canonical(Map.of("type",type,"cutoffDate",cutoff==null?"":cutoff.toString(),"rows",raw)));if(serialized.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>2000000)throw Inputs.bad("导入文件过大");String contentHash=Digests.sha256(serialized),hash=sourceText==null?contentHash:Digests.sha256(sourceText);String hashBasis=sourceText==null?"CANONICAL_ROWS":"SOURCE_BYTES";
  jdbc.queryForObject("SELECT pg_advisory_xact_lock(hashtextextended(?,0))",Object.class,a.requireCountry()+":"+type+":"+hash);
  var previous=jdbc.queryForList("SELECT id,status,attempt_no,requested_by,content_sha256 FROM sys_import_batch WHERE country_id=? AND import_type=? AND file_sha256=? ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE",a.requireCountry(),type,hash);int attempt=1;Long previousId=null;
  if(!previous.isEmpty()){var old=previous.getFirst();if(((Number)old.get("requested_by")).longValue()!=a.userId()&&!a.platformAdmin())throw ApiException.notFound();previousId=((Number)old.get("id")).longValue();if(!Set.of("VALIDATION_FAILED","CANCELLED").contains(old.get("status"))){if(!contentHash.equals(old.get("content_sha256")))throw new ApiException(409,"SYS_IMPORT_INTENT_CONFLICT","同一文件已有不同截止日期或内容的批次，请先取消或核对原批次");var result=view(a,previousId);result.put("duplicate",true);return result;}attempt=((Number)old.get("attempt_no")).intValue()+1;}

  var normalized=new ArrayList<ImportHandler.Row>();var errors=new ArrayList<List<Map<String,Object>>>();var keys=new HashSet<String>();int rowNo=0,valid=0;for(var row:raw){int number=++rowNo;try{var result=h.validate(a,type,cutoff,number,row);if(result.sourceKey()==null||result.sourceKey().isBlank()||result.sourceKey().length()>500)throw Inputs.bad("来源标识不完整");if(!keys.add(result.sourceKey()))throw new ApiException(409,"SYS_IMPORT_DUPLICATE_KEY","文件内来源重复");normalized.add(result);errors.add(List.of());valid++;}catch(ApiException e){normalized.add(new ImportHandler.Row(number,Map.of(),null));errors.add(List.of(Map.of("rowNo",number,"code",e.getCode(),"message",e.getMessage())));}catch(IllegalArgumentException e){normalized.add(new ImportHandler.Row(number,Map.of(),null));errors.add(List.of(Map.of("rowNo",number,"code","SYS_VALIDATION_ERROR","message","字段格式不正确")));}}
  var inserted=jdbc.queryForList("INSERT INTO sys_import_batch(country_id,import_type,file_sha256,cutoff_date,status,requested_by,total_rows,valid_rows,error_rows,source_file_text,content_sha256,hash_basis,attempt_no,previous_batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(country_id,import_type,file_sha256,attempt_no) DO NOTHING RETURNING id",a.requireCountry(),type,hash,cutoff,valid==raw.size()?"VALIDATED":"VALIDATION_FAILED",a.userId(),raw.size(),valid,raw.size()-valid,sourceText,contentHash,hashBasis,attempt,previousId);
  if(inserted.isEmpty())throw new ApiException(409,"SYS_IMPORT_DUPLICATE_FILE","该文件已存在，请刷新导入历史");long id=((Number)inserted.getFirst().get("id")).longValue();for(int i=0;i<raw.size();i++)jdbc.update("INSERT INTO sys_import_row(country_id,batch_id,row_no,raw,normalized,source_key,errors) VALUES(?,?,?,?::jsonb,?::jsonb,?,?::jsonb)",a.requireCountry(),id,i+1,json.write(raw.get(i)),json.write(normalized.get(i).values()),normalized.get(i).sourceKey(),json.write(errors.get(i)));audit.append(c,"PREVALIDATE","SYS_IMPORT",id,null,Map.of("type",type,"hash",hash,"validRows",valid));return view(a,id);
 });}
 private Map<String,Object> authorized(Access a,long id,boolean lock){var rows=jdbc.queryForList("SELECT * FROM sys_import_batch WHERE country_id=? AND id=?"+(lock?" FOR UPDATE":""),a.requireCountry(),id);if(rows.isEmpty())throw ApiException.notFound();var r=rows.getFirst();permission(a,r.get("import_type").toString());if(((Number)r.get("requested_by")).longValue()!=a.userId()&&!a.platformAdmin())throw ApiException.notFound();return r;}
 private Map<String,Object> view(Access a,long id){var batch=DbRows.camel(authorized(a,id,false));var preview=new ArrayList<Map<String,Object>>();var errors=new ArrayList<Map<String,Object>>();for(var raw:jdbc.queryForList("SELECT * FROM sys_import_row WHERE country_id=? AND batch_id=? ORDER BY row_no",a.requireCountry(),id)){var row=DbRows.camel(raw);row.put("raw",json.readMap(raw.get("raw").toString()));row.put("values",json.readMap(raw.get("normalized").toString()));row.remove("normalized");row.remove("errors");preview.add(row);errors.addAll(json.readMap("{\"items\":"+raw.get("errors")+"}").get("items") instanceof List<?> list?(List<Map<String,Object>>)(List<?>)list:List.of());}batch.put("preview",preview);batch.put("errors",errors);return batch;}
 public Map<String,Object> detail(RequestContext c,long id){return tx.execute(s->view(auth.authorize(c),id));}
 public Object list(RequestContext c){return tx.execute(s->{var a=auth.authorize(c);a.requireCountry();var out=new ArrayList<Map<String,Object>>();for(var r:jdbc.queryForList("SELECT id,import_type FROM sys_import_batch WHERE country_id=? AND requested_by=? ORDER BY id DESC LIMIT 100",a.requireCountry(),a.userId()))if(a.has("sys:import:"+r.get("import_type").toString().toLowerCase(Locale.ROOT).replace('_','-')))out.add(DbRows.camel(authorized(a,((Number)r.get("id")).longValue(),false)));return Map.of("records",out,"total",out.size());});}
 public Map<String,Object> confirm(RequestContext c,long id,String key){return tx.execute(s->{
  var a=auth.authorizeCoordinatedWrite(c);lifecycle.requireConfigurationWritable(a);a.require("sys:import:confirm");var batch=authorized(a,id,true);
  return idem.execute(c,"POST","/api/v1/sys/imports/"+id+"/confirm",key,Map.of(),null,()->{
   if(!"VALIDATED".equals(batch.get("status")))throw new ApiException(409,"SYS_IMPORT_STATE","只有预校验通过批次可以确认");
   String type=batch.get("import_type").toString();var h=handler(type);var cutoff=batch.get("cutoff_date")==null?null:((java.sql.Date)batch.get("cutoff_date")).toLocalDate();var command=new ImportHandler.Batch(id,type,cutoff);
   return ImportScope.withinValidatedBatch(c,command,jdbc,()->{
    var persisted=jdbc.queryForList("SELECT * FROM sys_import_row WHERE country_id=? AND batch_id=? ORDER BY source_key,row_no FOR UPDATE",a.requireCountry(),id);
    var validated=new TreeMap<Integer,ImportHandler.Row>();var rowIds=new HashMap<Integer,Long>();
    // Validate and reserve every source before any owner command can change a shared basis/version.
    for(var r:persisted){int number=((Number)r.get("row_no")).intValue();var row=h.validate(a,type,cutoff,number,json.readMap(r.get("raw").toString()));
     if(!Objects.equals(row.sourceKey(),r.get("source_key"))||!json.write(IdempotencyExecutor.canonical(row.values())).equals(json.write(IdempotencyExecutor.canonical(json.readMap(r.get("normalized").toString())))))throw new ApiException(409,"SYS_IMPORT_STALE","预校验依据已变化，请建立新批次");
     int claimed=jdbc.update("INSERT INTO sys_import_source(country_id,import_type,source_key,row_id) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",a.requireCountry(),type,row.sourceKey(),r.get("id"));if(claimed!=1)throw new ApiException(409,"SYS_IMPORT_DUPLICATE_SOURCE","来源已导入");validated.put(number,row);rowIds.put(number,((Number)r.get("id")).longValue());
    }
    var targets=new ArrayList<ImportHandler.Target>();
    for(var row:validated.values()){var target=h.apply(c,a,command,row);targets.add(target);jdbc.update("UPDATE sys_import_row SET target_type=?,target_id=? WHERE country_id=? AND id=?",target.type(),target.id(),a.requireCountry(),rowIds.get(row.rowNo()));}
    h.finish(c,a,command,targets);jdbc.update("UPDATE sys_import_batch SET status='COMPLETED',confirmed_by=?,confirmed_at=clock_timestamp() WHERE country_id=? AND id=?",a.userId(),a.requireCountry(),id);audit.append(c,"CONFIRM","SYS_IMPORT",id,null,Map.of("type",type));return view(a,id);
   });
  },r->authorized(a,id,false));
 });}
 public Map<String,Object> cancel(RequestContext c,long id){return tx.execute(s->{var a=auth.authorize(c);lifecycle.requireConfigurationWritable(a);var r=authorized(a,id,true);if(!Set.of("VALIDATED","VALIDATION_FAILED").contains(r.get("status")))throw new ApiException(409,"SYS_IMPORT_STATE","当前批次不能取消");jdbc.update("UPDATE sys_import_batch SET status='CANCELLED' WHERE country_id=? AND id=?",a.requireCountry(),id);audit.append(c,"CANCEL","SYS_IMPORT",id,null,Map.of());return view(a,id);});}
}
