package com.hs.jxc.sys.service;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** One database allocator for every new number, called inside the original document transaction. */
@Service
public class DocumentNumberService {
    private final JdbcTemplate jdbc;private final AuthorizationService auth;private final CountryLifecycle lifecycle;private final AuditWriter audit;
    public DocumentNumberService(JdbcTemplate jdbc,AuthorizationService auth,CountryLifecycle lifecycle,AuditWriter audit){this.jdbc=jdbc;this.auth=auth;this.lifecycle=lifecycle;this.audit=audit;}
    public String next(Access access,String type,LocalDate day){return next(access.requireCountry(),type,day);}
    public String next(long country,String type,LocalDate day){
        if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Number allocation requires original document transaction");
        validType(type);if(day==null)throw Inputs.bad("单据日期必填");
        if(jdbc.queryForObject("SELECT count(*) FROM sys_doc_number_rule WHERE country_id=? AND doc_type=?",Integer.class,country,type)!=1)throw new ApiException(409,"SYS_CONFIG_MISSING","请先配置 "+type+" 的单据编号规则",Map.of("missing",List.of(Map.of("key","DOC_NUMBER_RULE","label",type+" 编号规则缺失","level","BLOCK","link","/settings/countries/"+country))));
        return jdbc.queryForObject("SELECT jxc_next_doc_number(?,?,?::date)",String.class,country,type,day.toString());
    }
    @Transactional public List<Map<String,Object>> rules(RequestContext c){var a=auth.authorize(c);a.require("sys:country-param:edit","sys:country:view");return jdbc.queryForList("SELECT * FROM sys_doc_number_rule WHERE country_id=? ORDER BY doc_type",a.requireCountry()).stream().map(DbRows::camel).toList();}
    @Transactional public Map<String,Object> save(RequestContext c,String type,Map<String,Object>b){var a=auth.authorizePolicyWrite(c,false);if(!a.platformAdmin())a.require("sys:country-param:edit");if(!a.platformAdmin()&&!a.scope().all())throw ApiException.forbidden();lifecycle.requireConfigurationWritable(a);validType(type);
        String prefix=Inputs.required(b,"prefix"),pattern=Inputs.text(b,"datePattern","yyyyMMdd"),reset=Inputs.text(b,"resetPeriod","NONE");long width=Inputs.id(b.getOrDefault("sequenceWidth",6));
        if(!prefix.matches("[A-Z0-9-]{1,20}")||!Set.of("","yyyy","yyyyMM","yyyyMMdd").contains(pattern)||!Set.of("NONE","YEAR","MONTH","DAY").contains(reset)||width<3||width>12)throw Inputs.bad("编号规则格式不合法");
        if(reset.equals("DAY")&&!pattern.equals("yyyyMMdd")||reset.equals("MONTH")&&!Set.of("yyyyMM","yyyyMMdd").contains(pattern)||reset.equals("YEAR")&&pattern.isBlank())throw Inputs.bad("日期格式必须包含重置周期，防止生成重复号码");
        var old=jdbc.queryForList("SELECT * FROM sys_doc_number_rule WHERE country_id=? AND doc_type=? FOR UPDATE",a.requireCountry(),type);
        if(old.isEmpty()){if(b.containsKey("version"))throw Inputs.conflict();jdbc.update("INSERT INTO sys_doc_number_rule(country_id,doc_type,prefix,date_pattern,sequence_width,reset_period) VALUES(?,?,?,?,?,?)",a.requireCountry(),type,prefix,pattern,width,reset);}
        else {if(!Objects.equals(old.getFirst().get("reset_period"),reset)&&jdbc.queryForObject("SELECT count(*) FROM sys_doc_number_counter WHERE country_id=? AND doc_type=?",Integer.class,a.requireCountry(),type)>0)throw Inputs.bad("已发号规则不能改变重置周期");if(jdbc.update("UPDATE sys_doc_number_rule SET prefix=?,date_pattern=?,sequence_width=?,reset_period=?,version=version+1 WHERE country_id=? AND doc_type=? AND version=?",prefix,pattern,width,reset,a.requireCountry(),type,Inputs.version(b))!=1)throw Inputs.conflict();}
        var result=DbRows.camel(jdbc.queryForMap("SELECT * FROM sys_doc_number_rule WHERE country_id=? AND doc_type=?",a.requireCountry(),type));audit.append(c,"配置编号规则","doc-number-rule",((Number)result.get("id")).longValue(),old.isEmpty()?null:DbRows.camel(old.getFirst()),result);auth.bump(a.requireCountry());return result;
    }
    private void validType(String type){if(type==null||!type.matches("[A-Z][A-Z0-9_]{0,63}"))throw Inputs.bad("单据类型不合法");}
}
