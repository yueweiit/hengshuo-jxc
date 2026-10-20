package com.hs.jxc.fin.service;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.fin.api.LedgerApi;
import org.springframework.beans.factory.ObjectProvider;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.sys.service.AuthorizationService;
import com.hs.jxc.sys.service.CountryLifecycle;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
@Service
public class BookService {
    private final JdbcTemplate jdbc;private final AuthorizationService auth;private final BookResolver resolver;private final PeriodGuard guard;private final IdempotencyExecutor idem;private final AuditWriter audit;private final TransactionTemplate tx;private final ObjectProvider<LedgerApi> ledger;private final CountryLifecycle lifecycle;
    public BookService(JdbcTemplate jdbc,AuthorizationService auth,BookResolver resolver,PeriodGuard guard,IdempotencyExecutor idem,AuditWriter audit,PlatformTransactionManager tm,ObjectProvider<LedgerApi> ledger,CountryLifecycle lifecycle){this.jdbc=jdbc;this.auth=auth;this.resolver=resolver;this.guard=guard;this.idem=idem;this.audit=audit;this.tx=new TransactionTemplate(tm);this.ledger=ledger;this.lifecycle=lifecycle;}
    public List<Map<String,Object>> books(RequestContext c,boolean periods){return tx.execute(s->{
        var a=auth.authorize(c);a.requireCountry();if(periods)a.require("fin:voucher:audit","fin:report:export","cst:profit:view","fin:book:config","fin:ledger:view","fin:report:view","fin:period:close","fin:period:reopen","fin:voucher:create","fin:voucher:generate","fin:mapping:edit","fin:mapping:review","fin:account:edit","fin:opening:edit");
        List<Map<String,Object>> out=new ArrayList<>();for(var row:jdbc.queryForList("SELECT * FROM fin_book WHERE country_id=? ORDER BY id",a.requireCountry())){
            long id=((Number)row.get("id")).longValue();if(!a.canBook(id))continue;var dto=DbRows.camel(row);
            if(periods)dto.put("periods",jdbc.queryForList("SELECT * FROM fin_period WHERE country_id=? AND book_id=? ORDER BY fiscal_year,period_no",a.requireCountry(),id).stream().map(DbRows::camel).map(p->{p.put("name",p.get("fiscalYear")+"-"+String.format("%02d",((Number)p.get("periodNo")).intValue()));return p;}).toList());out.add(dto);
        }return out;
    });}
    public List<Map<String,Object>> warehouseBooks(RequestContext c,long warehouseId){return tx.execute(s->resolver.booksForWarehouse(auth.authorize(c),warehouseId));}
    public Map<String,Object> rename(RequestContext c,long book,Map<String,Object> body,String key){return configure(c,book,body,key,false);}
    public Map<String,Object> activate(RequestContext c,long book,Map<String,Object> body,String key){return configure(c,book,body,key,true);}
    private Map<String,Object> configure(RequestContext c,long book,Map<String,Object> body,String key,boolean activate){return tx.execute(s->{
        var a=auth.authorize(c);a.require("fin:book:config");long country=a.requireCountry();lifecycle.requireConfigurationWritable(a);
        if(!a.canBook(book))throw ApiException.notFound();
        if(!body.keySet().stream().allMatch((activate?Set.of("version"):Set.of("name","version"))::contains))throw Inputs.bad("本入口仅支持修改账套名称或显式启用，不允许变更主体、本位币或其他状态");
        long version=Inputs.version(body);String name=activate?null:Inputs.required(body,"name");if(name!=null&&name.length()>100)throw Inputs.bad("账套名称最多100个字符");
        guard.lockExclusive(country,book);var before=DbRows.camel(jdbc.queryForMap("SELECT * FROM fin_book WHERE country_id=? AND id=?",country,book));
        String endpoint="/api/v1/fin/books/"+book+(activate?"/activate":"");
        return idem.execute(c,activate?"POST":"PUT",endpoint,key,body,book,()->{
            if(((Number)before.get("version")).longValue()!=version)throw Inputs.conflict();
            if(activate){
                if(!"DRAFT".equals(before.get("status")))throw new ApiException(409,"FIN_BOOK_NOT_DRAFT","仅草稿账套可以启用");
                String currency=String.valueOf(before.get("baseCurrency"));
                if(!currency.matches("[A-Z]{3}")||jdbc.queryForObject("SELECT count(*) FROM md_currency WHERE code=? AND status='ENABLED'",Integer.class,currency)!=1)throw Inputs.bad("账套本位币不存在或已停用");
                var entities=jdbc.queryForList("SELECT status FROM org_entity WHERE country_id=? AND id=? FOR SHARE",country,before.get("entityId"));
                if(entities.isEmpty()||!"ENABLED".equals(entities.getFirst().get("status")))throw Inputs.bad("账套所属经营主体不存在或已停用");
            }
            int changed=activate?jdbc.update("UPDATE fin_book SET status='ACTIVE',version=version+1,updated_by=?,updated_at=clock_timestamp() WHERE country_id=? AND id=? AND version=?",c.userId(),country,book,version):jdbc.update("UPDATE fin_book SET name=?,version=version+1,updated_by=?,updated_at=clock_timestamp() WHERE country_id=? AND id=? AND version=?",name,c.userId(),country,book,version);
            if(changed!=1)throw Inputs.conflict();
            var result=DbRows.camel(jdbc.queryForMap("SELECT * FROM fin_book WHERE country_id=? AND id=?",country,book));
            // Enabling business ownership never creates or confirms an unknown opening balance.
            audit.append(c,activate?"启用账套":"修改账套名称","book",book,before,result);return result;
        },r->{if(!a.canBook(book))throw ApiException.notFound();});
    });}
    public Map<String,Object> generatePeriods(RequestContext c,Long selected,Map<String,Object> b,String key){return tx.execute(s->{
        var a=auth.authorize(c);a.require("fin:book:config");long book=resolver.resolve(a,selected,null);
        int year;if(b.get("fiscalYear")==null){String zone=jdbc.queryForObject("SELECT timezone FROM sys_country WHERE id=?",String.class,a.requireCountry());year=LocalDate.now(ZoneId.of(zone)).getYear();}else{long raw=Inputs.id(b.get("fiscalYear"));if(raw<1900||raw>9999)throw Inputs.bad("会计年度不合法");year=(int)raw;}
        long rawMonth=b.get("firstMonth")==null?1:Inputs.id(b.get("firstMonth"));if(rawMonth>12)throw Inputs.bad("首个期间月份必须为1至12");int firstMonth=(int)rawMonth;
        java.util.function.Supplier<Map<String,Object>> work=()->{
            // Configuration takes the exclusive book gate from the start; it never upgrades a writer's share.
            guard.lockExclusive(a.requireCountry(),book);resolver.resolve(a,book,null);int count=0;for(int month=firstMonth;month<=12;month++){
                var start=LocalDate.of(year,month,1);var end=start.withDayOfMonth(start.lengthOfMonth());
                var created=jdbc.queryForList("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status,created_by) VALUES(?,?,?,?,?,?,'OPEN',?) ON CONFLICT(country_id,book_id,fiscal_year,period_no) DO NOTHING RETURNING id",a.requireCountry(),book,year,month,start,end,c.userId());count+=created.size();for(var row:created)ledger.ifAvailable(l->l.initializePeriod(a,book,((Number)row.get("id")).longValue()));
            }
            var result=Map.<String,Object>of("created",count);audit.append(c,"生成期间","book",book,null,Map.of("fiscalYear",year,"firstMonth",firstMonth,"created",count));return result;
        };
        return key==null?work.get():idem.execute(c,"POST","/api/v1/fin/periods",key,b,book,work,r->{if(!a.canBook(book))throw ApiException.notFound();});
    });}
}
