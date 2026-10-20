package com.hs.jxc.common.audit;
import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.common.context.RequestContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronizationManager;
@Component
public class AuditWriter {
    private final JdbcTemplate jdbc;private final JsonCodec json;
    public AuditWriter(JdbcTemplate jdbc,JsonCodec json){this.jdbc=jdbc;this.json=json;}
    public void append(RequestContext c,String action,String type,long id,Object before,Object after){
        append(c.countryId(),c.userId(),action,type,id,before,after,null);
    }
    public void append(long country,long user,String action,String type,long id,Object before,Object after,String reason){
        if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Audit must join its command transaction");
        jdbc.update("INSERT INTO sys_audit_log(country_id,user_id,action,resource_type,resource_id,before_value,after_value,reason) VALUES(?,?,?,?,?,?::jsonb,?::jsonb,?)",country,user,action,type,id,before==null?null:json.write(before),after==null?null:json.write(after),reason);
    }
}
