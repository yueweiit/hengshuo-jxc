package com.hs.jxc.fin.report;

import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import java.math.BigDecimal;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Reconstructs dimensions from authoritative facts, independently of the balance projection. */
@Component
class ReportFacts {
    private final JdbcTemplate db;
    ReportFacts(JdbcTemplate db){this.db=db;}
    List<Map<String,Object>> balances(Access a,long book,Map<String,Object> period){
        String start=period.get("startDate").toString(),end=period.get("endDate").toString();
        return db.queryForList("""
            WITH facts AS (
              SELECT l.account_id,l.aux_key,l.currency,
                CASE WHEN v.voucher_date<?::date THEN l.debit-l.credit ELSE 0 END opening_net,
                CASE WHEN v.voucher_date>=?::date THEN l.debit ELSE 0 END period_debit,
                CASE WHEN v.voucher_date>=?::date THEN l.credit ELSE 0 END period_credit,l.debit-l.credit closing_net
              FROM fin_voucher_line l JOIN fin_voucher v ON v.country_id=l.country_id AND v.book_id=l.book_id AND v.id=l.voucher_id
              WHERE l.country_id=? AND l.book_id=? AND v.status IN('POSTED','REVERSED') AND v.voucher_date<=?::date
              UNION ALL
              SELECT account_id,aux_key,currency,CASE WHEN direction='DEBIT' THEN base_amount ELSE -base_amount END,0,0,
                CASE WHEN direction='DEBIT' THEN base_amount ELSE -base_amount END
              FROM fin_opening_balance WHERE country_id=? AND book_id=? AND status='CONFIRMED' AND cutoff_date<?::date
            )
            SELECT a.id account_id,a.code,a.name,a.category,f.aux_key,f.currency,
              COALESCE(sum(f.opening_net),0) opening_net,COALESCE(sum(f.period_debit),0) period_debit,
              COALESCE(sum(f.period_credit),0) period_credit,COALESCE(sum(f.closing_net),0) closing_net
            FROM fin_account a LEFT JOIN facts f ON f.account_id=a.id
            WHERE a.country_id=? AND a.book_id=? GROUP BY a.id,a.code,a.name,a.category,f.aux_key,f.currency ORDER BY a.code,f.aux_key,f.currency
            """,start,start,start,a.requireCountry(),book,end,a.requireCountry(),book,start,a.requireCountry(),book).stream().map(DbRows::camel).map(row->{
                BigDecimal opening=decimal(row,"openingNet"),closing=decimal(row,"closingNet");
                row.put("openingDebit",opening.max(BigDecimal.ZERO));row.put("openingCredit",opening.negate().max(BigDecimal.ZERO));row.put("closingDebit",closing.max(BigDecimal.ZERO));row.put("closingCredit",closing.negate().max(BigDecimal.ZERO));return row;
            }).toList();
    }
    List<Map<String,Object>> cashflows(Access a,long book,long period){return db.queryForList("""
        SELECT f.id cashflow_item_id,f.code,f.name,f.category,sum(l.debit-l.credit) amount,
          array_agg(DISTINCT a.id::bigint ORDER BY a.id::bigint) account_ids
        FROM fin_voucher_line l JOIN fin_voucher v ON v.country_id=l.country_id AND v.book_id=l.book_id AND v.id=l.voucher_id
        JOIN fin_account a ON a.country_id=l.country_id AND a.book_id=l.book_id AND a.id=l.account_id
        JOIN fin_cashflow_item f ON f.country_id=l.country_id AND f.book_id=l.book_id AND f.id=l.cashflow_item_id
        WHERE l.country_id=? AND l.book_id=? AND v.period_id=? AND v.status IN('POSTED','REVERSED') AND (a.is_cash OR a.is_bank)
        GROUP BY f.id,f.code,f.name,f.category ORDER BY f.code
        """,a.requireCountry(),book,period).stream().map(DbRows::camel).map(row->{
            Object value=row.get("accountIds");try{if(value instanceof java.sql.Array array)row.put("accountIds",Arrays.asList((Object[])array.getArray()));}catch(java.sql.SQLException e){throw new IllegalStateException(e);}return row;
        }).toList();}
    int missingCashflow(Access a,long book,long period){return db.queryForObject("""
        SELECT count(*) FROM fin_voucher_line l JOIN fin_voucher v ON v.country_id=l.country_id AND v.id=l.voucher_id
        JOIN fin_account a ON a.country_id=l.country_id AND a.id=l.account_id
        WHERE l.country_id=? AND l.book_id=? AND v.period_id=? AND v.status IN('POSTED','REVERSED') AND (a.is_cash OR a.is_bank) AND l.cashflow_item_id IS NULL
        """,Integer.class,a.requireCountry(),book,period);}
    static BigDecimal decimal(Map<String,Object> row,String field){Object value=row.get(field);return value==null?BigDecimal.ZERO:new BigDecimal(value.toString());}
    static BigDecimal sum(List<Map<String,Object>> rows,String field){return rows.stream().map(row->decimal(row,field)).reduce(BigDecimal.ZERO,BigDecimal::add);}
    static Map<String,Object> trial(List<Map<String,Object>> facts){var trial=new LinkedHashMap<String,Object>();for(String key:List.of("openingDebit","openingCredit","periodDebit","periodCredit","closingDebit","closingCredit"))trial.put(key,sum(facts,key));trial.put("debit",sum(facts,"closingDebit"));trial.put("credit",sum(facts,"closingCredit"));trial.put("balanced",sum(facts,"openingDebit").compareTo(sum(facts,"openingCredit"))==0&&sum(facts,"periodDebit").compareTo(sum(facts,"periodCredit"))==0&&sum(facts,"closingDebit").compareTo(sum(facts,"closingCredit"))==0);return trial;}
}
