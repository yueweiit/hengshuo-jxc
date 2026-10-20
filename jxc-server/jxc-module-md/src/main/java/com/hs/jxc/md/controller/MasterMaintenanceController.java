package com.hs.jxc.md.controller;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.*;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.AuthorizationService;
import java.util.*;
import java.util.function.Function;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;

/** Complete existing master maintenance paths; the original product/FX writers remain authoritative. */
@RestController @RequestMapping("/api/v1/md")
public class MasterMaintenanceController {
 private final JdbcTemplate db;private final AuthorizationService auth;private final IdempotencyExecutor idem;private final AuditWriter audit;private final JsonCodec json;private final TransactionTemplate tx;
 public MasterMaintenanceController(JdbcTemplate db,AuthorizationService auth,IdempotencyExecutor idem,AuditWriter audit,JsonCodec json,PlatformTransactionManager tm){this.db=db;this.auth=auth;this.idem=idem;this.audit=audit;this.json=json;this.tx=new TransactionTemplate(tm);}
 private ApiEnvelope read(Function<Access,Object> work){var c=RequestContextHolder.require();return ApiEnvelope.ok(tx.execute(s->work.apply(auth.authorize(c))),c.traceId());}
 private ApiEnvelope write(boolean global,String permission,String method,String path,String key,Map<String,Object> body,Function<Access,Map<String,Object>> work){var c=RequestContextHolder.require();return ApiEnvelope.ok(tx.execute(s->{var a=auth.authorizePolicyWrite(c,global);a.require(permission);if(global&&!a.platformAdmin())throw ApiException.forbidden();return idem.execute(c,method,"/api/v1/md"+path,key,body,null,()->work.apply(a),out->{a.require(permission);});}),c.traceId());}
 private Map<String,Object> row(String table,long id,boolean lock){var found=db.queryForList("SELECT * FROM "+table+" WHERE id=?"+(lock?" FOR UPDATE":""),id);if(found.isEmpty())throw ApiException.notFound();return DbRows.camel(found.getFirst());}
 private Map<String,Object> dict(Access a,long id,boolean lock){var r=row("md_dict",id,lock);if(r.get("countryId")!=null&&((Number)r.get("countryId")).longValue()!=a.requireCountry())throw ApiException.notFound();r.put("label",label(r));return r;}
 private String label(Map<String,Object> row){var values=json.readMap(row.get("labelI18n").toString());return String.valueOf(values.getOrDefault("zh-CN",values.values().stream().findFirst().orElse(row.get("code"))));}
 private void version(Map<String,Object> row,Map<String,Object> body){if(((Number)row.get("version")).longValue()!=Inputs.version(body))throw Inputs.conflict();}
 private int integer(Object value,int fallback,int max){if(value==null)return fallback;try{int n=new java.math.BigDecimal(value.toString()).intValueExact();if(n<0||n>max)throw Inputs.bad("整数参数不合法");return n;}catch(ArithmeticException|NumberFormatException e){throw Inputs.bad("整数参数不合法");}}

 @GetMapping("/dicts") public ApiEnvelope dictionaries(@RequestParam Map<String,String> query){return read(a->{a.requireCountry();int page=integer(query.get("page"),1,1000000),size=integer(query.get("size"),20,200);if(page==0||size==0)throw Inputs.bad("分页参数不合法");var args=new ArrayList<Object>();args.add(a.requireCountry());String where="(country_id=? OR country_id IS NULL)";for(String k:List.of("dictType","status"))if(query.get(k)!=null&&!query.get(k).isBlank()){where+=" AND "+(k.equals("dictType")?"dict_type":"status")+"=?";args.add(query.get(k));}if(query.get("keyword")!=null&&!query.get("keyword").isBlank()){where+=" AND (code ILIKE ? OR label_i18n::text ILIKE ?)";args.add("%"+query.get("keyword")+"%");args.add("%"+query.get("keyword")+"%");}var total=db.queryForObject("SELECT count(*) FROM md_dict WHERE "+where,Long.class,args.toArray());args.add(size);args.add((page-1)*size);var rows=db.queryForList("SELECT * FROM md_dict WHERE "+where+" ORDER BY seq,id LIMIT ? OFFSET ?",args.toArray()).stream().map(DbRows::camel).toList();rows.forEach(r->r.put("label",label(r)));return Map.of("records",rows,"total",total,"page",page,"size",size);});}
 @GetMapping("/dicts/{id}") public ApiEnvelope dictionary(@PathVariable long id){return read(a->dict(a,Inputs.id(id),false));}
 @PostMapping("/dicts") public ApiEnvelope createDictionary(@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return saveDictionary(null,body,key);}
 @PutMapping("/dicts/{id}") public ApiEnvelope updateDictionary(@PathVariable long id,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return saveDictionary(Inputs.id(id),body,key);}
 private ApiEnvelope saveDictionary(Long id,Map<String,Object> b,String key){return write(false,"md:dict:edit",id==null?"POST":"PUT","/dicts"+(id==null?"":"/"+id),key,b,a->{var old=id==null?null:dict(a,id,true);if(old!=null){if(old.get("countryId")==null)throw ApiException.forbidden();version(old,b);}String type=Inputs.required(b,"dictType"),code=Inputs.required(b,"code"),name=Inputs.required(b,"label");if(!type.matches("[A-Z][A-Z0-9_]{0,63}")||code.length()>64||name.length()>200)throw Inputs.bad("字典格式不合法");if(old!=null&&(!type.equals(old.get("dictType"))||!code.equals(old.get("code"))))throw Inputs.bad("已创建字典的类型与编码不能修改");int seq=integer(b.get("seq"),old==null?1:((Number)old.get("seq")).intValue(),1000000);long result;if(id==null)result=db.queryForObject("INSERT INTO md_dict(country_id,dict_type,code,label_i18n,seq) VALUES(?,?,?,?::jsonb,?) RETURNING id",Long.class,a.requireCountry(),type,code,json.write(Map.of("zh-CN",name)),seq);else{result=id;db.update("UPDATE md_dict SET label_i18n=?::jsonb,seq=?,version=version+1 WHERE id=?",json.write(Map.of("zh-CN",name)),seq,id);}var out=dict(a,result,false);audit.append(RequestContextHolder.require(),"SAVE","DICT",result,old,out);return out;});}
 @PostMapping("/dicts/{id}/{action:enable|disable}") public ApiEnvelope toggleDictionary(@PathVariable long id,@PathVariable String action,@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false)String key){return write(false,"md:dict:edit","POST","/dicts/"+id+"/"+action,key,b,a->{var old=dict(a,Inputs.id(id),true);if(old.get("countryId")==null)throw ApiException.forbidden();version(old,b);db.update("UPDATE md_dict SET status=?,version=version+1 WHERE id=?",action.equals("enable")?"ENABLED":"DISABLED",id);var out=dict(a,id,false);audit.append(RequestContextHolder.require(),action,"DICT",id,old,out);return out;});}

 @GetMapping("/categories/{id}") public ApiEnvelope category(@PathVariable long id){return read(a->{a.require("md:product:view","md:product:edit");return row("md_category",Inputs.id(id),false);});}
 @PutMapping("/categories/{id}") public ApiEnvelope editCategory(@PathVariable long id,@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false)String key){return write(true,"md:product:edit","PUT","/categories/"+id,key,b,a->{var old=row("md_category",Inputs.id(id),true);version(old,b);String code=Inputs.required(b,"code"),name=Inputs.required(b,"name");Long parent=b.get("parentId")==null?null:Inputs.id(b.get("parentId"));int level=categoryLevel(db,parent,id);db.update("UPDATE md_category SET code=?,name=?,parent_id=?,level=?,version=version+1 WHERE id=?",code,name,parent,level,id);relevelDescendants(db,id,level);var out=row("md_category",id,false);audit.append(RequestContextHolder.require(),"UPDATE","MD_CATEGORY",id,old,out);return out;});}
 // Both original category writers hold the global policy lock before using these helpers.
 static int categoryLevel(JdbcTemplate db,Long parent,Long movingId){
  if(parent==null)return 1;
  var chain=db.queryForList("WITH RECURSIVE chain AS (SELECT id,parent_id FROM md_category WHERE id=? UNION SELECT p.id,p.parent_id FROM md_category p JOIN chain c ON p.id=c.parent_id) SELECT id FROM chain",parent);
  if(chain.isEmpty())throw ApiException.notFound();
  if(movingId!=null&&chain.stream().anyMatch(r->((Number)r.get("id")).longValue()==movingId))throw Inputs.bad("分类不能形成循环");
  return chain.size()+1;
 }
 private static void relevelDescendants(JdbcTemplate db,long id,int level){
  db.update("WITH RECURSIVE subtree AS (SELECT id,?+1 AS depth FROM md_category WHERE parent_id=? UNION ALL SELECT c.id,p.depth+1 FROM md_category c JOIN subtree p ON c.parent_id=p.id) UPDATE md_category c SET level=s.depth,version=c.version+1 FROM subtree s WHERE c.id=s.id AND c.level IS DISTINCT FROM s.depth",level,id);
 }
 @PostMapping({"/products/{id}/{action:enable|disable}","/categories/{id}/{action:enable|disable}"}) public ApiEnvelope toggleGlobal(@PathVariable long id,@PathVariable String action,@RequestBody Map<String,Object> b,@RequestHeader(value="Idempotency-Key",required=false)String key,jakarta.servlet.http.HttpServletRequest request){String kind=request.getRequestURI().contains("/products/")?"products":"categories",table=kind.equals("products")?"md_product":"md_category";return write(true,"md:product:edit","POST","/"+kind+"/"+id+"/"+action,key,b,a->{var old=row(table,Inputs.id(id),true);version(old,b);db.update("UPDATE "+table+" SET status=?,version=version+1 WHERE id=?",action.equals("enable")?"ENABLED":"DISABLED",id);var out=row(table,id,false);audit.append(RequestContextHolder.require(),action,kind,id,old,out);return out;});}
 @GetMapping("/exchange-rates/{id}") public ApiEnvelope exchangeRate(@PathVariable long id){return read(a->{a.require("md:rate:edit","md:rate:confirm");var r=row("md_exchange_rate",Inputs.id(id),false);if(((Number)r.get("countryId")).longValue()!=a.requireCountry())throw ApiException.notFound();return r;});}
}
