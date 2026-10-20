package com.hs.jxc.md;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.fin.api.FinancialReferenceProvider;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.Access;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Reference lookup exposes no banking, customer prices or master-data write capability. */
@Component
public class MasterFinancialReferences implements FinancialReferenceProvider,com.hs.jxc.md.api.MasterReferenceApi {
    private final JdbcTemplate jdbc;
    private final BookResolver books;
    public MasterFinancialReferences(JdbcTemplate jdbc,BookResolver books){this.jdbc=jdbc;this.books=books;}
    private String normalized(String type){return switch(type){case "FUND","FUND_ACCOUNT"->"fundAccountId";case "EXPENSE","EXPENSE_ITEM"->"expenseItemId";case "PRODUCT"->"productId";default->type;};}
    public boolean supports(String type){return Set.of("customerId","supplierId","partnerId","carrierId","productId","expenseItemId","fundAccountId").contains(normalized(type));}
    public Map<String,Object> validate(Access a,long book,String type,long id){
        type=normalized(type);books.resolve(a,book,null);var r=lookup(a,type,id);
        if(type.equals("fundAccountId")){
            long entity=books.entityId(a,book);
            if(((Number)r.get("entityId")).longValue()!=entity||r.get("bookId")!=null&&((Number)r.get("bookId")).longValue()!=book)throw invalid();
        }
        Map<String,Object> out=new LinkedHashMap<>();out.put("id",id);out.put("countryId",a.requireCountry());
        for(String key:List.of("name","categoryId","status","accountType","currency"))if(r.get(key)!=null)out.put(key,r.get(key));
        return out;
    }
    @Override public Map<String,Object> reference(Access a,String type,long id){
        if(!Set.of("customerId","supplierId","carrierId","expenseItemId").contains(type))throw ApiException.notFound();
        var row=lookup(a,type,id);
        return Map.of("id",id,"countryId",a.requireCountry(),"name",row.get("name"));
    }
    private Map<String,Object> lookup(Access a,String type,long id){
        Inputs.id(id);
        String table=switch(type){case "customerId"->"md_customer";case "supplierId","partnerId"->"md_supplier";case "carrierId"->"md_logistics_provider";case "productId"->"md_product";case "expenseItemId"->"md_expense_item";case "fundAccountId"->"md_fund_account";default->throw invalid();};
        var rows=jdbc.queryForList("SELECT * FROM "+table+" WHERE "+(type.equals("productId")?"id=?":"country_id=? AND id=?"),type.equals("productId")?new Object[]{id}:new Object[]{a.requireCountry(),id});
        if(rows.isEmpty()&&Set.of("supplierId","partnerId").contains(type))rows=jdbc.queryForList("SELECT * FROM md_logistics_provider WHERE country_id=? AND id=?",a.requireCountry(),id);
        if(rows.isEmpty())throw invalid();var r=DbRows.camel(rows.getFirst());
        if(type.equals("productId")&&jdbc.queryForObject("SELECT count(*) FROM md_country_sku WHERE country_id=? AND product_id=?",Integer.class,a.requireCountry(),id)!=1)throw invalid();
        return r;
    }
    public Long accountId(Access a,long book,String rule,long id){
        String type=switch(rule){case "FUND","FUND_ACCOUNT"->"fundAccountId";case "EXPENSE","EXPENSE_ITEM"->"expenseItemId";default->null;};
        if(type==null)return null;validate(a,book,type,id);
        var rows=jdbc.queryForList("SELECT "+(type.equals("fundAccountId")?"gl_account_id":"account_id")+" account FROM "+(type.equals("fundAccountId")?"md_fund_account":"md_expense_item")+" WHERE country_id=? AND id=?",a.requireCountry(),id);
        Object value=rows.getFirst().get("account");return value instanceof Number n?n.longValue():null;
    }
    private ApiException invalid(){return new ApiException(400,"FIN_AUX_INVALID","辅助项不存在或不属于该账套");}
}
