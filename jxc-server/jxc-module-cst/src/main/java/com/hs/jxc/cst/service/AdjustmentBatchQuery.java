package com.hs.jxc.cst.service;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.AuthorizationService;
import com.hs.jxc.sys.service.FieldPolicyService;
import java.math.BigDecimal;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Adds selection metadata; effective cost still comes from the existing valuation reader. */
@Service
public class AdjustmentBatchQuery {
    private final JdbcTemplate jdbc;
    private final AuthorizationService authorization;
    private final FieldPolicyService fields;
    private final CostValuationService valuation;
    private final TransactionTemplate tx;

    public AdjustmentBatchQuery(JdbcTemplate jdbc, AuthorizationService authorization, FieldPolicyService fields,
                                CostValuationService valuation, PlatformTransactionManager manager) {
        this.jdbc = jdbc; this.authorization = authorization; this.fields = fields; this.valuation = valuation;
        tx = new TransactionTemplate(manager);
    }

    public Map<String, Object> list(RequestContext context, Map<String, String> filters) {
        return tx.execute(status -> {
            var access = authorization.authorize(context);
            access.require("cst:adjustment:create");
            if (FieldPolicyService.rank(access.fieldGroups().get("COST")) < 1)
                throw new ApiException(403, "SYS_FORBIDDEN", "需要COST字段查看权限");
            String target = filters.getOrDefault("target", "INVENTORY");
            if (!Set.of("INVENTORY", "COGS").contains(target)) throw Inputs.bad("调整对象不合法");
            int page = positive(filters.get("page"), 1, 1_000_000), size = positive(filters.get("size"), 20, 200);
            List<Object> args = new ArrayList<>(List.of(access.requireCountry()));
            String from = """
                 FROM cst_inbound_cost i
                 JOIN inv_batch b ON b.country_id=i.country_id AND b.id=i.batch_id
                 JOIN md_product p ON p.id=i.product_id
                 JOIN fin_book bk ON bk.country_id=i.country_id AND bk.id=i.book_id
                 JOIN org_warehouse w ON w.country_id=i.country_id AND w.id=i.warehouse_id
                 WHERE i.country_id=? AND
                """ + scope(access, "i.book_id", "i.warehouse_id", args);
            // Selecting a batch affects every warehouse. Do not expose totals from an inaccessible warehouse.
            from += " AND NOT EXISTS (SELECT 1 FROM inv_batch_balance bb WHERE bb.country_id=i.country_id"
                + " AND bb.batch_id=i.batch_id AND bb.on_hand_qty>0 AND NOT ("
                + scope(access, "i.book_id", "bb.warehouse_id", args) + "))";
            var dimensions = jdbc.queryForList("SELECT DISTINCT i.book_id,bk.name book_name,i.warehouse_id,w.name warehouse_name" + from
                + " ORDER BY bk.name,w.name", args.toArray());
            if (filters.containsKey("bookId")) { from += " AND i.book_id=?"; args.add(identifier(filters.get("bookId"))); }
            if (filters.containsKey("warehouseId")) { from += " AND i.warehouse_id=?"; args.add(identifier(filters.get("warehouseId"))); }
            String keyword = filters.getOrDefault("keyword", "").trim();
            if (!keyword.isEmpty()) {
                from += " AND strpos(lower(concat_ws(' ',b.batch_no,p.product_code,p.name)),lower(?))>0";
                args.add(keyword);
            }
            long total = jdbc.queryForObject("SELECT count(*)" + from, Long.class, args.toArray());
            args.add(size); args.add((long) (page - 1) * size);
            var candidates = jdbc.queryForList("""
                SELECT i.id,i.batch_id,b.batch_no,p.product_code,p.name product_name,p.spec,p.base_unit,
                       i.book_id,bk.name book_name,i.warehouse_id,w.name warehouse_name,i.biz_date,
                       (SELECT coalesce(sum(v.qty),0) FROM cst_batch_value v
                        WHERE v.country_id=i.country_id AND v.book_id=i.book_id AND v.batch_id=i.batch_id) on_hand_qty,
                       (SELECT string_agg(cw.name,'、' ORDER BY cw.name) FROM cst_batch_value v
                        JOIN org_warehouse cw ON cw.country_id=v.country_id AND cw.id=v.warehouse_id
                        WHERE v.country_id=i.country_id AND v.book_id=i.book_id AND v.batch_id=i.batch_id AND v.qty>0) current_warehouses,
                       EXISTS(SELECT 1 FROM cst_batch_value v JOIN cst_valuation_pool pool
                        ON pool.country_id=v.country_id AND pool.book_id=v.book_id AND pool.warehouse_id=v.warehouse_id AND pool.product_id=v.product_id
                        WHERE v.country_id=i.country_id AND v.book_id=i.book_id AND v.batch_id=i.batch_id
                        AND v.qty>0 AND (v.amount IS NULL OR pool.amount IS NULL)) inventory_cost_missing
                """ + from + " ORDER BY i.id DESC LIMIT ? OFFSET ?", args.toArray());
            List<Map<String, Object>> records = new ArrayList<>();
            for (var candidate : candidates) {
                var row = DbRows.camel(candidate);
                var cost = valuation.inbound(access, ((Number) row.get("id")).longValue(), false);
                row.put("unitCost", cost.get("unitCost")); row.put("baseCurrency", cost.get("baseCurrency")); row.put("costStatus", cost.get("status"));
                String reason = null;
                if (cost.get("unitCost") == null) reason = "批次成本尚未完整，请先补齐成本或汇率";
                else if (target.equals("INVENTORY") && ((BigDecimal) row.get("onHandQty")).signum() == 0) reason = "此批次已无库存，不能调整库存成本";
                else if (target.equals("INVENTORY") && Boolean.TRUE.equals(row.get("inventoryCostMissing"))) reason = "库存成本尚未完整，请先补齐成本";
                row.remove("inventoryCostMissing"); row.put("selectable", reason == null); row.put("unavailableReason", reason);
                records.add(fields.mask(access, row, "COST"));
            }
            return Map.of("records", records, "total", total, "page", page, "size", size,
                "books", dimensions.stream().map(r -> Map.of("id", r.get("book_id"), "name", r.get("book_name"))).distinct().toList(),
                "warehouses", dimensions.stream().map(r -> Map.of("id", r.get("warehouse_id"), "name", r.get("warehouse_name"))).distinct().toList());
        });
    }

    private String scope(Access access, String bookColumn, String warehouseColumn, List<Object> args) {
        if (access.scope().all()) return "TRUE";
        List<String> alternatives = new ArrayList<>();
        for (var entry : List.of(Map.entry(bookColumn, access.scope().books()), Map.entry(warehouseColumn, access.scope().warehouses()))) {
            if (entry.getValue().isEmpty()) continue;
            alternatives.add(entry.getKey() + " IN (" + String.join(",", Collections.nCopies(entry.getValue().size(), "?")) + ")");
            args.addAll(entry.getValue());
        }
        return alternatives.isEmpty() ? "FALSE" : "(" + String.join(" OR ", alternatives) + ")";
    }

    private long identifier(String input) {
        try { return Inputs.id(Long.valueOf(input)); }
        catch (NumberFormatException invalid) { throw Inputs.bad("筛选编号必须是安全整数"); }
    }

    private int positive(String input, int fallback, int max) {
        if (input == null) return fallback;
        try {
            int value = Integer.parseInt(input);
            if (value > 0 && value <= max) return value;
        } catch (NumberFormatException ignored) { /* Invalid input is reported below, not treated as an empty result. */ }
        throw Inputs.bad("分页参数不合法");
    }
}
