package com.hs.jxc.sys.service;

import com.hs.jxc.common.api.*;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.api.ConfigReadinessContributor;
import java.util.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** Action-specific prerequisites use the same persisted country configuration as activation. */
@Service
public class ConfigReadinessService {
    private final JdbcTemplate jdbc;
    private final ObjectProvider<ConfigReadinessContributor> contributors;
    public ConfigReadinessService(JdbcTemplate jdbc,ObjectProvider<ConfigReadinessContributor> contributors){this.jdbc=jdbc;this.contributors=contributors;}
    public List<Map<String,Object>> check(long country,String action){
        var rows=jdbc.queryForList("SELECT * FROM sys_country WHERE id=?",country);if(rows.isEmpty())throw ApiException.notFound();var c=rows.getFirst();var missing=new ArrayList<Map<String,Object>>();String base="/settings/countries/"+country;
        if(String.valueOf(c.get("default_currency")).isBlank())add(missing,"CURRENCY","未设置默认币种","BLOCK",base);
        if(String.valueOf(c.get("timezone")).isBlank())add(missing,"TIMEZONE","未设置时区","BLOCK",base);
        if(action==null||action.isBlank()||action.equals("ACTIVATE")){
            if(count("sys_country_clone_job",country," AND status='DRAFT'")>0)add(missing,"CLONE_NOT_APPLIED","尚未生成配置草稿","BLOCK",base);
            if(count("org_entity",country," AND status='ENABLED'")==0)add(missing,"ENTITY","未建立有效经营主体","BLOCK","/settings/entities");
            if(count("org_warehouse",country," AND status='ENABLED'")==0)add(missing,"WAREHOUSE","未建立有效仓库","BLOCK","/settings/warehouses");
            if(jdbc.queryForObject("SELECT count(*) FROM sys_user_role ur JOIN sys_role r ON r.country_id=ur.country_id AND r.id=ur.role_id JOIN sys_user u ON u.id=ur.user_id WHERE ur.country_id=? AND (r.role_type='COUNTRY_ADMIN' OR r.code='COUNTRY_ADMIN') AND r.status='ENABLED' AND u.status='ENABLED'",Integer.class,country)==0)add(missing,"ADMIN","未指定国家管理员","BLOCK","/settings/users");
            if(count("sys_country_config_review",country," AND review_status='NEED_REVIEW'")>0)add(missing,"REVIEW","本地配置、财务和人员授权尚未复核","BLOCK",base);
            if(count("org_store",country," AND status='ENABLED'")==0)add(missing,"STORE","未建立门店，销售前补齐","WARN","/settings/stores");
            if(count("fin_book",country,"")==0)add(missing,"BOOK","未建立账套，财务模块不可用","WARN","/finance/books");
            if(count("md_fund_account",country," AND status='ENABLED'")==0)add(missing,"FUND_ACCOUNT","未设置资金账户，收付款前需补齐","WARN","/master/fund-accounts");
        }else switch(action){
            case "SALES_ORDER_SUBMIT"->{if(count("org_store",country," AND status='ENABLED'")==0)add(missing,"STORE","未设置启用门店或销售归属","BLOCK","/settings/stores");if(count("wf_doc_type_config",country," AND doc_type IN ('SALES_ORDER','SAL_ORDER')")==0)add(missing,"APPROVAL_RULE","销售审批设置缺失","BLOCK","/settings/approval-rules");}
            case "SALES_OUTBOUND"->{if(count("org_warehouse",country," AND status='ENABLED'")==0)add(missing,"WAREHOUSE","未设置有效仓库","BLOCK","/settings/warehouses");if(count("sys_doc_number_rule",country," AND doc_type='SAL_OUTBOUND'")==0)add(missing,"DOC_NUMBER_RULE","出库编号规则缺失","BLOCK",base);}
            case "COST_CONFIRM"->{if(count("cst_method_config",country," AND status='ACTIVE'")==0)add(missing,"COST_METHOD","成本计价方法缺失","BLOCK","/cost/methods");}
            case "VOUCHER_POST"->{if(count("fin_book",country," AND status='ACTIVE'")==0)add(missing,"BOOK","有效账套缺失","BLOCK","/finance/books");if(count("fin_period",country," AND status='OPEN'")==0)add(missing,"OPEN_PERIOD","开放期间缺失","BLOCK","/finance/periods");if(count("fin_account",country," AND status='ENABLED'")==0)add(missing,"ACCOUNT","会计科目缺失","BLOCK","/finance/accounts");if(count("fin_mapping_template",country," AND status='ACTIVE'")==0)add(missing,"MAPPING","凭证映射尚未复核","BLOCK","/finance/mappings");}
            case "RECEIPT_CONFIRM"->{if(count("md_fund_account",country," AND status='ENABLED' AND book_id IS NOT NULL")==0)add(missing,"FUND_ACCOUNT","有效收款账户缺失","BLOCK","/master/fund-accounts");}
            default->throw Inputs.bad("未知就绪检查动作");
        }
        if(action==null||action.isBlank()||action.equals("ACTIVATE"))contributors.orderedStream().forEach(contributor->missing.addAll(contributor.check(country,"ACTIVATE")));
        return missing;
    }
    public void requireReady(Access a,String action){var missing=check(a.requireCountry(),action);if(missing.stream().anyMatch(m->"BLOCK".equals(m.get("level"))))throw new ApiException(409,"SYS_CONFIG_MISSING","该操作缺少必要配置",Map.of("missing",missing));}
    private int count(String table,long country,String extra){return jdbc.queryForObject("SELECT count(*) FROM "+table+" WHERE country_id=?"+extra,Integer.class,country);}
    private void add(List<Map<String,Object>>out,String key,String label,String level,String link){out.add(Map.of("key",key,"label",label,"level",level,"link",link));}
}
