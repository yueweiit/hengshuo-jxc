package com.hs.jxc.cst.service;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.cst.api.CostApi;
import com.hs.jxc.lgs.api.LogisticsApi;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Allocates posting precision from original inventory facts; never writes cost or GL facts. */
@Service
public class CostInventoryAccountingService {
    private final JdbcTemplate db;
    private final LogisticsApi logistics;
    public CostInventoryAccountingService(JdbcTemplate db,LogisticsApi logistics){this.db=db;this.logistics=logistics;}
    private record Fact(long order,Set<String> sources,BigDecimal delta,String type,long sourceId,LocalDate bizDate) {}
    private String key(String type,long id){return type+":"+id;}
    private LocalDate date(Object value){return LocalDate.parse(value.toString());}
    private void guard(long country,long book,int scale){
        if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Cost accounting requires caller transaction");
        if(scale<0||scale>4)throw new IllegalArgumentException("Invalid posting precision");
        db.queryForObject("SELECT pg_advisory_xact_lock(hashtextextended(?,0))",Object.class,country+":"+book+":CST_VALUATION");
    }
    private List<Fact> facts(long country,long book,LocalDate completionAsOf){
        List<Fact> facts=new ArrayList<>();
        // Return COGS and its inbound movement are aliases of one economic fact.
        for(var m:db.queryForList("SELECT m.id,m.biz_date,m.action,m.cogs_id,i.id inbound_id,coalesce(m.amount_change,x.amount_change) amount FROM cst_valuation_movement m LEFT JOIN cst_movement_completion x ON x.country_id=m.country_id AND x.movement_id=m.id AND x.biz_date<=? LEFT JOIN cst_inbound_cost i ON i.country_id=m.country_id AND i.batch_id=m.batch_id AND m.action='INBOUND' WHERE m.country_id=? AND m.book_id=? AND m.action IN ('INBOUND','OUTBOUND') ORDER BY m.id",completionAsOf,country,book)){
            Set<String> aliases=new HashSet<>();
            if(m.get("inbound_id") instanceof Number n)aliases.add(key("CST_INBOUND_COST",n.longValue()));
            if(m.get("cogs_id") instanceof Number n)aliases.add(key("CST_COGS",n.longValue()));
            if(aliases.isEmpty())throw new ApiException(409,"CST_COST_MISSING","库存变动缺少冻结金额来源");
            boolean cogs=m.get("cogs_id") instanceof Number;String type=cogs?"CST_COGS":"CST_INBOUND_COST";long id=((Number)m.get(cogs?"cogs_id":"inbound_id")).longValue();
            facts.add(new Fact(((Number)m.get("id")).longValue(),aliases,(BigDecimal)m.get("amount"),type,id,date(m.get("biz_date"))));
        }
        // Internal transfers retain the book asset in transit. Only their losses reduce it.
        for(var c:db.queryForList("SELECT c.id,c.biz_date,coalesce(c.amount,x.amount) amount FROM cst_cogs c LEFT JOIN cst_cogs_completion x ON x.country_id=c.country_id AND x.cogs_id=c.id AND x.biz_date<=? WHERE c.country_id=? AND c.book_id=? AND EXISTS(SELECT 1 FROM cst_transfer_loss l WHERE l.country_id=c.country_id AND l.cogs_id=c.id) ORDER BY c.id",completionAsOf,country,book)){
            BigDecimal amount=(BigDecimal)c.get("amount");long cogs=((Number)c.get("id")).longValue();facts.add(new Fact(cogs,Set.of(key("CST_COGS",cogs)),amount==null?null:amount.negate(),"CST_COGS",cogs,date(c.get("biz_date"))));
        }
        // Draft IDs are not effect order. Valuation changes are immutable confirmation facts.
        for(var a:db.queryForList("SELECT a.id,a.biz_date,a.source_type,a.target,a.inventory_amount,a.sold_amount,min(v.id) effect_order FROM cst_cost_adjustment a JOIN cst_valuation_change v ON v.country_id=a.country_id AND v.adjustment_id=a.id WHERE a.country_id=? AND a.book_id=? AND a.status='CONFIRMED' GROUP BY a.id ORDER BY effect_order",country,book)){
            String source=String.valueOf(a.get("source_type"));BigDecimal amount;
            if(source.equals("MANUAL"))amount=(BigDecimal)a.get("inventory_amount");
            else if(source.equals("RETURN_COST")&&!"COGS".equals(a.get("target")))amount=BigDecimal.ZERO;
            else {BigDecimal sold=(BigDecimal)a.get("sold_amount");amount=sold==null?null:sold.negate();}
            long adjustment=((Number)a.get("id")).longValue();facts.add(new Fact(((Number)a.get("effect_order")).longValue(),Set.of(key("CST_ADJUSTMENT",adjustment)),amount,"CST_ADJUSTMENT",adjustment,date(a.get("biz_date"))));
        }
        for(var fee:logistics.inventoryAccountingFacts(country,book))facts.add(new Fact(fee.confirmationOrder(),Set.of(key("LGS_FEE",fee.feeId())),fee.amount(),"LGS_FEE",fee.feeId(),fee.bizDate()));
        facts.sort(Comparator.comparingLong(Fact::order));return facts;
    }
    public CostApi.AccountingDelta delta(long country,long book,String type,long id,int scale){
        guard(country,book,scale);String wanted=key(type,id);BigDecimal running=BigDecimal.ZERO;boolean complete=true;
        for(var fact:facts(country,book,LocalDate.of(9999,12,31))){
            BigDecimal before=running;if(fact.delta()==null)complete=false;else running=running.add(fact.delta());
            if(fact.sources().contains(wanted)){
                if(!complete)return new CostApi.AccountingDelta(fact.delta(),null,null,null,"PENDING_SOURCE_COST");
                BigDecimal roundedBefore=before.setScale(scale,RoundingMode.HALF_UP),roundedAfter=running.setScale(scale,RoundingMode.HALF_UP);
                return new CostApi.AccountingDelta(fact.delta(),roundedAfter.subtract(roundedBefore),roundedBefore,roundedAfter,"READY");
            }
        }
        throw new ApiException(409,"CST_COST_MISSING","来源缺少可追溯的库存金额事实");
    }
    /** Explanation only: immutable assignment order stays fixed, then the business-date cutoff is applied. */
    public Map<String,Object> precision(long country,long book,LocalDate asOf,int scale){
        guard(country,book,scale);var facts=facts(country,book,asOf);if(facts.isEmpty())return Map.of();
        BigDecimal running=BigDecimal.ZERO,total=BigDecimal.ZERO;boolean prefixComplete=true,missing=false;List<Map<String,Object>> details=new ArrayList<>();
        for(var fact:facts){
            BigDecimal before=running;if(fact.delta()==null)prefixComplete=false;else running=running.add(fact.delta());
            BigDecimal assigned=prefixComplete?running.setScale(scale,RoundingMode.HALF_UP).subtract(before.setScale(scale,RoundingMode.HALF_UP)):null;
            if(fact.bizDate().isAfter(asOf))continue;
            if(assigned==null)missing=true;else total=total.add(assigned);
            var detail=new LinkedHashMap<String,Object>();detail.put("sourceType",fact.type());detail.put("sourceId",fact.sourceId());detail.put("sourceNo",fact.type()+"-"+fact.sourceId());detail.put("bizDate",fact.bizDate());detail.put("originalAmount",fact.delta());detail.put("amount",assigned);detail.put("costMissing",assigned==null);details.add(detail);
        }
        var result=new LinkedHashMap<String,Object>();result.put("bookId",book);result.put("sourceAccountingAmount",missing?null:total);result.put("details",details);result.put("pending",missing);return result;
    }
}
