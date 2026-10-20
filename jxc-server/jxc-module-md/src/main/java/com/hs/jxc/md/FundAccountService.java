package com.hs.jxc.md;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.*;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.fin.api.LedgerApi;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Original MD account configuration, backed by the existing fund table and FIN references. */
@Service @Transactional
public class FundAccountService implements com.hs.jxc.sys.api.StoreFundAccountPort {
    private final JdbcTemplate jdbc;private final AuthorizationService auth;private final FieldPolicyService fields;private final BookResolver books;private final BookGate gates;private final LedgerApi ledger;private final IdempotencyExecutor idem;private final BankAccountCipher cipher;private final AuditWriter audit;
    public FundAccountService(JdbcTemplate jdbc,AuthorizationService auth,FieldPolicyService fields,BookResolver books,BookGate gates,LedgerApi ledger,IdempotencyExecutor idem,BankAccountCipher cipher,AuditWriter audit){this.jdbc=jdbc;this.auth=auth;this.fields=fields;this.books=books;this.gates=gates;this.ledger=ledger;this.idem=idem;this.cipher=cipher;this.audit=audit;}
    @Override public Map<String,Object> createForStore(RequestContext c,long entityId,long storeId,Map<String,Object> configuration){
        if(!org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Store account extension requires its organization transaction");
        var body=new LinkedHashMap<>(configuration);
        if(body.get("entityId")!=null&&Inputs.id(body.get("entityId"))!=entityId||body.get("storeId")!=null&&Inputs.id(body.get("storeId"))!=storeId)throw Inputs.bad("资金账户必须属于新建门店及其主体");
        body.put("entityId",entityId);body.put("storeId",storeId);
        return save(c,null,body,UUID.randomUUID().toString());
    }
    public Map<String,Object> get(RequestContext c,long id){var a=auth.authorize(c);a.requireCountry();return output(a,row(a,id,false));}
    private Map<String,Object> row(Access a,long id,boolean lock){var rs=jdbc.queryForList("SELECT * FROM md_fund_account WHERE country_id=? AND id=?"+(lock?" FOR UPDATE":""),a.requireCountry(),id);if(rs.isEmpty())throw ApiException.notFound();var row=DbRows.camel(rs.getFirst());a.requireRow(row);return row;}
    private Map<String,Object> output(Access a,Map<String,Object> row){var out=new LinkedHashMap<>(row);out.remove("accountNoEncrypted");out.put("entityName",jdbc.queryForObject("SELECT name FROM org_entity WHERE country_id=? AND id=?",String.class,a.requireCountry(),out.get("entityId")));if(out.get("storeId")!=null)out.put("storeName",jdbc.queryForObject("SELECT name FROM org_store WHERE country_id=? AND id=?",String.class,a.requireCountry(),out.get("storeId")));return fields.mask(a,out,"BANK_INFO");}
    private void writable(Access a,Map<String,Object> body){a.require("md:fund-account:edit");if(FieldPolicyService.rank(a.fieldGroups().get("BANK_INFO"))<2)throw ApiException.forbidden();fields.requireWrite(a,body,"BANK_INFO");}
    private Long id(Map<String,Object> body,String name){return body.get(name)==null?null:Inputs.id(body.get(name));}
    public Map<String,Object> save(RequestContext c,Long id,Map<String,Object> body,String key){
        var a=auth.authorize(c);writable(a,body);var before=id==null?null:row(a,id,false);
        Long selected=body.containsKey("bookId")?id(body,"bookId"):before==null?null:id(before,"bookId");if(selected==null)throw Inputs.bad("请明确选择资金账户所属账套");long book=books.resolve(a,selected,null);
        if(before!=null&&before.get("bookId")!=null&&((Number)before.get("bookId")).longValue()!=book)throw Inputs.bad("已绑定账套的资金账户不能迁移到另一账套");
        // An unbound account may already be in use in another book of its entity.
        if(before!=null&&before.get("bookId")==null){for(var r:jdbc.queryForList("SELECT id FROM fin_book WHERE country_id=? AND entity_id=? ORDER BY id",a.requireCountry(),before.get("entityId")))gates.lock(a.requireCountry(),((Number)r.get("id")).longValue(),true);}else gates.lock(a.requireCountry(),book,true);
        String endpoint="/api/v1/md/fund-accounts"+(id==null?"":"/"+id);return idem.execute(c,id==null?"POST":"PUT",endpoint,key,body,book,()->{
            var old=id==null?null:row(a,id,true);if(old!=null&&Inputs.version(body)!=((Number)old.get("version")).longValue())throw Inputs.conflict();
            var b=new LinkedHashMap<String,Object>();if(old!=null)b.putAll(old);b.putAll(body);long entity=books.entityId(a,book);if(id(b,"entityId")==null||id(b,"entityId")!=entity)throw Inputs.bad("主体必须与所选账套一致");
            if(old!=null&&old.get("bookId")==null&&Boolean.TRUE.equals(jdbc.queryForObject("SELECT jxc_fund_has_sources(?,?)",Boolean.class,a.requireCountry(),id)))throw Inputs.bad("该未绑定资金账户已有财务来源，不能补改账套归属");
            Long store=id(b,"storeId");if(store!=null&&jdbc.queryForObject("SELECT count(*) FROM org_store WHERE country_id=? AND entity_id=? AND id=?",Integer.class,a.requireCountry(),entity,store)!=1)throw ApiException.notFound();
            String name=Inputs.required(b,"name"),type=Inputs.required(b,"accountType"),currency=Inputs.required(b,"currency");if(!Set.of("CASH","BANK","OTHER").contains(type))throw Inputs.bad("资金账户类型不合法");if(jdbc.queryForObject("SELECT count(*) FROM md_currency WHERE code=? AND status='ENABLED'",Integer.class,currency)!=1)throw Inputs.bad("币种未启用");
            Long account=id(b,"glAccountId");if(account!=null){var gl=ledger.validateAccountReference(a,book,account);boolean matches=type.equals("CASH")?Boolean.TRUE.equals(gl.get("isCash")):type.equals("BANK")?Boolean.TRUE.equals(gl.get("isBank")):!Boolean.TRUE.equals(gl.get("isCash"))&&!Boolean.TRUE.equals(gl.get("isBank"));if(!matches)throw Inputs.bad("会计科目必须与资金账户现金/银行类型一致");if(!currency.equals(books.baseCurrency(a,book))&&!Boolean.TRUE.equals(gl.get("fxEnabled")))throw Inputs.bad("外币资金账户需要启用外币核算的科目");}
            String raw=Inputs.text(body,"accountNo",null),encrypted=old==null?null:(String)old.get("accountNoEncrypted"),masked=old==null?null:(String)old.get("accountNoMasked");if(raw!=null&&!raw.isBlank()){encrypted=cipher.encrypt(raw);masked="**** "+raw.substring(Math.max(0,raw.length()-4));}
            long result;if(id==null)result=jdbc.queryForObject("INSERT INTO md_fund_account(country_id,entity_id,store_id,book_id,name,account_type,currency,bank_name,account_no_encrypted,account_no_masked,gl_account_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",Long.class,a.requireCountry(),entity,store,book,name,type,currency,Inputs.text(b,"bankName",""),encrypted,masked,account,c.userId());
            else{int changed=jdbc.update("UPDATE md_fund_account SET entity_id=?,store_id=?,book_id=?,name=?,account_type=?,currency=?,bank_name=?,account_no_encrypted=?,account_no_masked=?,gl_account_id=?,version=version+1,updated_by=?,updated_at=clock_timestamp() WHERE country_id=? AND id=? AND version=?",entity,store,book,name,type,currency,Inputs.text(b,"bankName",""),encrypted,masked,account,c.userId(),a.requireCountry(),id,Inputs.version(body));if(changed!=1)throw Inputs.conflict();result=id;}
            var out=output(a,row(a,result,false));audit.append(c,"配置资金账户","fund-account",result,old==null?null:output(a,old),out);return out;
        },r->row(a,((Number)r.get("id")).longValue(),false));
    }
    public Map<String,Object> toggle(RequestContext c,long id,boolean enabled,Map<String,Object> body,String key){var a=auth.authorize(c);writable(a,body);var before=row(a,id,false);Long book=id(before,"bookId");if(book==null)throw Inputs.bad("请先配置资金账户所属账套");books.resolve(a,book,null);gates.lock(a.requireCountry(),book,true);String endpoint="/api/v1/md/fund-accounts/"+id+"/"+(enabled?"enable":"disable");return idem.execute(c,"POST",endpoint,key,body,book,()->{var old=row(a,id,true);if(Inputs.version(body)!=((Number)old.get("version")).longValue())throw Inputs.conflict();jdbc.update("UPDATE md_fund_account SET status=?,version=version+1,updated_by=?,updated_at=clock_timestamp() WHERE country_id=? AND id=?",enabled?"ENABLED":"DISABLED",c.userId(),a.requireCountry(),id);var out=output(a,row(a,id,false));audit.append(c,"配置资金账户状态","fund-account",id,output(a,old),out);return out;},r->row(a,id,false));}
}
