package com.hs.jxc.fin.service;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.common.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
@Component
public class BookResolver {
    private final JdbcTemplate jdbc;
    public BookResolver(JdbcTemplate jdbc){this.jdbc=jdbc;}
    public long entityId(Access access,long bookId){resolve(access,bookId,null);return jdbc.queryForObject("SELECT entity_id FROM fin_book WHERE country_id=? AND id=?",Long.class,access.requireCountry(),bookId);}
    public String baseCurrency(Access access,long bookId){resolve(access,bookId,null);return jdbc.queryForObject("SELECT base_currency FROM fin_book WHERE country_id=? AND id=?",String.class,access.requireCountry(),bookId);}
    public long resolve(Access a,Long explicit,Long entityId){
        var candidates=jdbc.queryForList("SELECT id,entity_id,status FROM fin_book WHERE country_id=?"+(explicit==null?"":" AND id=?"),explicit==null?new Object[]{a.requireCountry()}:new Object[]{a.requireCountry(),explicit});
        var allowed=candidates.stream().filter(r->a.canBook(((Number)r.get("id")).longValue())).filter(r->entityId==null||entityId.equals(r.get("entity_id"))).toList();
        if(explicit!=null){if(allowed.isEmpty())throw ApiException.notFound();if(!"ACTIVE".equals(allowed.getFirst().get("status")))throw new ApiException(400,"FIN_BOOK_NOT_ACTIVE","账套尚未启用");return explicit;}
        var active=allowed.stream().filter(r->"ACTIVE".equals(r.get("status"))).toList();
        if(active.isEmpty())throw new ApiException(400,"FIN_BOOK_NOT_CONFIGURED","未配置可用账套，请先完成账套归属");
        if(active.size()>1)throw new ApiException(400,"FIN_BOOK_AMBIGUOUS","存在多个可用账套，请明确选择账套");
        return ((Number)active.getFirst().get("id")).longValue();
    }
    /** A scoped business source may locate its own book without granting whole-book visibility. */
    public long resolveForWarehouse(Access a,Long explicit,long warehouseId){return source(a,explicit,"org_warehouse",warehouseId,"warehouseId");}
    public java.util.List<java.util.Map<String,Object>> booksForWarehouse(Access a,long warehouseId){return sourceBooks(a,null,"org_warehouse",Inputs.id(warehouseId),"warehouseId");}
    public long resolveForFundAccount(Access a,Long explicit,long accountId){return source(a,explicit,"md_fund_account",accountId,"fundAccountId");}
    private long source(Access a,Long explicit,String table,long id,String own){
        var books=sourceBooks(a,explicit,table,id,own);
        if(books.isEmpty())throw new ApiException(400,"FIN_BOOK_NOT_CONFIGURED","来源所属主体未配置可用账套");
        if(books.size()!=1)throw new ApiException(400,"FIN_BOOK_AMBIGUOUS","来源所属主体有多个账套，请明确选择");
        return ((Number)books.getFirst().get("id")).longValue();
    }
    private java.util.List<java.util.Map<String,Object>> sourceBooks(Access a,Long explicit,String table,long id,String own){
        var rows=jdbc.queryForList("SELECT * FROM "+table+" WHERE country_id=? AND id=?",a.requireCountry(),id);
        if(rows.isEmpty())throw ApiException.notFound();var source=com.hs.jxc.common.db.DbRows.camel(rows.getFirst());source.put(own,id);a.requireRow(source);
        if(source.get("bookId") instanceof Number book){if(explicit!=null&&explicit.longValue()!=book.longValue())throw ApiException.notFound();explicit=book.longValue();}
        Long entity=((Number)source.get("entityId")).longValue();
        return jdbc.queryForList("SELECT id,code,name,base_currency,entity_id,status FROM fin_book WHERE country_id=? AND entity_id=? AND status='ACTIVE'"+(explicit==null?"":" AND id=?")+" ORDER BY id",explicit==null?new Object[]{a.requireCountry(),entity}:new Object[]{a.requireCountry(),entity,explicit}).stream().map(com.hs.jxc.common.db.DbRows::camel).toList();
    }
}
