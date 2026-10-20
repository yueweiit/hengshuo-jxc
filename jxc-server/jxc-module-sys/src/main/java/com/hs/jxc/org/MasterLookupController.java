package com.hs.jxc.org;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.*;
import com.hs.jxc.org.mapper.CurrencyMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;

/** Existing scoped master lookups remain readable without granting maintenance privileges. */
@RestController
@RequestMapping("/api/v1/md")
public class MasterLookupController {
    private final JdbcTemplate jdbc;private final AuthorizationService auth;private final FieldPolicyService fields;private final CurrencyMapper currencies;private final TransactionTemplate tx;
    public MasterLookupController(JdbcTemplate jdbc,AuthorizationService auth,FieldPolicyService fields,CurrencyMapper currencies,PlatformTransactionManager tm){this.jdbc=jdbc;this.auth=auth;this.fields=fields;this.currencies=currencies;this.tx=new TransactionTemplate(tm);}
    @GetMapping("/currencies") public ApiEnvelope currencies(@RequestParam Map<String,String> q){
        var c=RequestContextHolder.require();return ApiEnvelope.ok(tx.execute(s->{auth.authorize(c);int page=positive(q.get("page"),1,1000000),size=positive(q.get("size"),20,200);
            var count=new QueryWrapper<CurrencyMapper.Currency>();if(q.containsKey("status"))count.eq("status",q.get("status"));long total=currencies.selectCount(count);
            var query=new QueryWrapper<CurrencyMapper.Currency>().select("id","code","name","decimals","status","version");if(q.containsKey("status"))query.eq("status",q.get("status"));query.orderByAsc("code").last("LIMIT "+size+" OFFSET "+((page-1)*size));
            return Map.of("records",currencies.selectMaps(query),"total",total,"page",page,"size",size);
        }),c.traceId());
    }
    @GetMapping("/fund-accounts") public ApiEnvelope funds(@RequestParam Map<String,String> q){
        var c=RequestContextHolder.require();return ApiEnvelope.ok(tx.execute(s->{
            var a=auth.authorize(c);List<Object> args=new ArrayList<>();args.add(a.requireCountry());String where="f.country_id=? AND "+scope(a,args);
            for(String field:List.of("status","accountType","storeId","currency"))if(q.containsKey(field)&&!q.get(field).isBlank()){where+=" AND f."+switch(field){case "accountType"->"account_type";case "storeId"->"store_id";default->field;}+"=?";args.add(field.equals("storeId")?parseId(q.get(field)):q.get(field));}
            if(q.containsKey("keyword")&&!q.get("keyword").isBlank()){where+=" AND (f.name ILIKE ?"+(FieldPolicyService.rank(a.fieldGroups().get("BANK_INFO"))>0?" OR f.bank_name ILIKE ?":"")+")";String search="%"+q.get("keyword")+"%";args.add(search);if(FieldPolicyService.rank(a.fieldGroups().get("BANK_INFO"))>0)args.add(search);}
            int page=positive(q.get("page"),1,1000000),size=positive(q.get("size"),20,200);int total=jdbc.queryForObject("SELECT count(*) FROM md_fund_account f WHERE "+where,Integer.class,args.toArray());args.add(size);args.add((page-1)*size);
            var records=jdbc.queryForList("SELECT f.id,f.country_id,f.entity_id,f.store_id,f.book_id,f.name,f.account_type,f.currency,f.bank_name,f.account_no_masked,f.gl_account_id,f.status,f.version,e.name AS entity_name,st.name AS store_name FROM md_fund_account f JOIN org_entity e ON e.country_id=f.country_id AND e.id=f.entity_id LEFT JOIN org_store st ON st.country_id=f.country_id AND st.id=f.store_id WHERE "+where+" ORDER BY f.id LIMIT ? OFFSET ?",args.toArray()).stream().map(DbRows::camel).map(r->fields.mask(a,r,"BANK_INFO")).toList();
            return Map.of("records",records,"total",total,"page",page,"size",size);
        }),c.traceId());
    }
    private static String scope(Access a,List<Object> args){if(a.scope().all())return "TRUE";List<String> clauses=new ArrayList<>();for(var item:List.of(Map.entry("entity_id",a.scope().entities()),Map.entry("store_id",a.scope().stores()),Map.entry("book_id",a.scope().books()))){if(item.getValue().isEmpty())continue;clauses.add("f."+item.getKey()+" IN ("+String.join(",",Collections.nCopies(item.getValue().size(),"?"))+")");args.addAll(item.getValue());}return clauses.isEmpty()?"FALSE":"("+String.join(" OR ",clauses)+")";}
    private static int positive(String raw,int fallback,int max){if(raw==null)return fallback;try{int n=Integer.parseInt(raw);if(n<1||n>max)throw Inputs.bad("分页参数不合法");return n;}catch(NumberFormatException e){throw Inputs.bad("分页参数不合法");}}
    private static long parseId(String raw){try{return Inputs.id(new java.math.BigDecimal(raw));}catch(NumberFormatException e){throw Inputs.bad("ID不合法");}}
}
