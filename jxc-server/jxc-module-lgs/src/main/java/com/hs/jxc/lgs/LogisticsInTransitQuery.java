package com.hs.jxc.lgs;

import com.hs.jxc.common.api.Inputs;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.md.api.MasterProductApi;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.AuthorizationService;
import java.math.BigDecimal;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** The board's read model, built from authorized native quantities without changing stock or shipment facts. */
@Service
// Authorization takes FOR SHARE gates; PostgreSQL read-only transactions prohibit those locks.
@Transactional
public class LogisticsInTransitQuery {
    private static final List<String> QUANTITIES = List.of("intlQty", "pendingDeliveryQty", "onHoldQty", "deliveringQty", "totalQty", "openDiscrepancyQty");
    private static final String SHIPMENT_COLUMNS = "s.country_id,s.book_id,s.entity_id,s.id shipment_id,s.doc_no,s.status,s.dest_warehouse_id source_warehouse_id,s.planned_eta,s.actual_eta,";
    private final JdbcTemplate jdbc;
    private final AuthorizationService auth;
    private final MasterProductApi products;
    private final LogisticsDelayQuery delays;

    public LogisticsInTransitQuery(JdbcTemplate jdbc, AuthorizationService auth, MasterProductApi products, LogisticsDelayQuery delays) {
        this.jdbc = jdbc; this.auth = auth; this.products = products; this.delays = delays;
    }

    public Map<String,Object> read(RequestContext context, Map<String,String> query) {
        Access access = auth.authorize(context);
        access.require("lgs:shipment:view");
        int page = positive(query.get("page"), 1, Integer.MAX_VALUE, "页码");
        int size = positive(query.get("size"), 20, 100, "每页条数");
        Long warehouse = optionalId(query.get("warehouseId")), product = optionalId(query.get("productId"));
        String view = query.getOrDefault("view", "summary");
        if (view.equals("delays")) return delayPage(access, warehouse, product, page, size);
        if (!view.equals("summary")) throw Inputs.bad("看板视图不合法");
        var groups = new TreeMap<String,Group>();
        var productCache = new HashMap<Long,MasterProductApi.Product>();
        for (var original : facts(access.requireCountry(), warehouse, product)) {
            var fact = DbRows.camel(original);
            // A destination grant cannot disclose another source shipment, or vice versa.
            if (!access.canRow(fact)) continue;
            var source = new LinkedHashMap<>(fact);
            source.put("warehouseId", fact.get("sourceWarehouseId"));
            if (!access.canRow(source)) continue;
            long productId = number(fact, "productId"), warehouseId = number(fact, "warehouseId");
            var sku = productCache.computeIfAbsent(productId, id -> products.reference(access.requireCountry(), id));
            var quantities = quantities(sku.baseUnit());
            for (String field : QUANTITIES) if (!field.equals("totalQty")) quantities.put(field, decimal(fact, field));
            quantities.put("totalQty", decimal(fact,"intlQty").add(decimal(fact,"pendingDeliveryQty")).add(decimal(fact,"onHoldQty")).add(decimal(fact,"deliveringQty")));
            if (decimal(quantities,"totalQty").add(decimal(quantities,"openDiscrepancyQty")).signum() == 0) continue;
            var group = groups.computeIfAbsent(warehouseId + ":" + productId, key -> new Group(fact, sku));
            group.add(fact, quantities);
        }
        var records = groups.values().stream().map(Group::row).sorted(Comparator
            .comparing((Map<String,Object> row) -> row.get("warehouseName").toString())
            .thenComparing(row -> row.get("productCode").toString()).thenComparing(row -> row.get("id").toString())).toList();
        var summary = new TreeMap<String,Map<String,Object>>();
        for (var row : records) add(summary.computeIfAbsent(row.get("unit").toString(), LogisticsInTransitQuery::quantities), row);
        var result = paginate(records, page, size);
        result.put("summary", new ArrayList<>(summary.values()));
        return result;
    }

    private List<Map<String,Object>> facts(long country, Long warehouse, Long product) {
        String sql = "WITH facts AS (SELECT " + SHIPMENT_COLUMNS
            + "l.product_id,s.dest_warehouse_id warehouse_id,l.intl_qty,l.pending_delivery_qty,l.on_hold_qty,0::numeric delivering_qty,"
            + "(SELECT COALESCE(sum(x.qty),0) FROM lgs_discrepancy x WHERE x.country_id=l.country_id AND x.shipment_line_id=l.id AND x.status<>'RESOLVED') open_discrepancy_qty "
            + "FROM lgs_shipment_line l JOIN lgs_shipment s ON s.country_id=l.country_id AND s.id=l.shipment_id WHERE s.country_id=? AND " + LogisticsService.departedSql("s")
            + " UNION ALL SELECT " + SHIPMENT_COLUMNS
            + "l.product_id,d.dest_warehouse_id warehouse_id,0::numeric intl_qty,0::numeric pending_delivery_qty,0::numeric on_hold_qty,l.dispatch_qty delivering_qty,0::numeric open_discrepancy_qty "
            + "FROM lgs_delivery_line l JOIN lgs_delivery d ON d.country_id=l.country_id AND d.id=l.delivery_id "
            + "JOIN lgs_shipment s ON s.country_id=d.country_id AND s.id=d.shipment_id WHERE d.country_id=? AND d.status='DISPATCHED' AND " + LogisticsService.departedSql("s")
            + ") SELECT f.*,w.name warehouse_name,COALESCE(w.timezone,ct.timezone) timezone FROM facts f "
            + "JOIN org_warehouse w ON w.country_id=f.country_id AND w.id=f.warehouse_id JOIN sys_country ct ON ct.id=f.country_id WHERE 1=1";
        var args = new ArrayList<Object>(List.of(country, country));
        if (warehouse != null) { sql += " AND f.warehouse_id=?"; args.add(warehouse); }
        if (product != null) { sql += " AND f.product_id=?"; args.add(product); }
        return jdbc.queryForList(sql, args.toArray());
    }

    private Map<String,Object> delayPage(Access access, Long warehouse, Long product, int page, int size) {
        var selected = delays.read(access);
        Set<Long> productShipments = product == null ? Set.of() : new HashSet<>(jdbc.queryForList(
            "SELECT DISTINCT shipment_id FROM lgs_shipment_line WHERE country_id=? AND product_id=?", Long.class, access.requireCountry(), product));
        var records = new ArrayList<Map<String,Object>>();
        for (var source : selected.records()) {
            if (warehouse != null && number(source,"warehouseId") != warehouse) continue;
            if (product != null && !productShipments.contains(number(source,"id"))) continue;
            var row = new LinkedHashMap<String,Object>();
            for (String field : List.of("id","docNo","status","delayStage","delayHours","plannedAt","destWarehouseName","timezone","carrierName")) row.put(field, source.get(field));
            records.add(row);
        }
        var result = paginate(records, page, size);
        result.put("rule", selected.rule());
        return result;
    }

    private static Map<String,Object> quantities(String unit) {
        var row = new LinkedHashMap<String,Object>();
        row.put("unit", unit);
        // This zero is the known empty sum of a newly created, authorized quantity group.
        QUANTITIES.forEach(key -> row.put(key, BigDecimal.ZERO));
        return row;
    }
    private static void add(Map<String,Object> total, Map<String,Object> row) {
        QUANTITIES.forEach(key -> total.put(key, decimal(total,key).add(decimal(row,key))));
    }
    private static BigDecimal decimal(Map<String,Object> row, String key) {
        if (!(row.get(key) instanceof BigDecimal value)) throw new IllegalStateException("Missing native quantity: " + key);
        return value;
    }
    private static long number(Map<String,Object> row, String key) { return ((Number)row.get(key)).longValue(); }
    private static Long optionalId(String value) {
        if (value == null) return null;
        try { if (value.matches("[0-9]+")) return Inputs.id(Long.parseLong(value)); }
        catch (NumberFormatException ignored) { /* Keep malformed or overflowing IDs as explicit request errors. */ }
        throw Inputs.bad("筛选ID必须是安全整数");
    }
    private static int positive(String text, int fallback, int max, String label) {
        if (text == null) return fallback;
        try { int value = Integer.parseInt(text); if (value > 0 && value <= max && text.matches("[0-9]+")) return value; }
        catch (NumberFormatException ignored) { /* Returned below as a validation error, never as an empty page. */ }
        throw Inputs.bad(label + "不合法");
    }
    private static Map<String,Object> paginate(List<Map<String,Object>> records, int requested, int size) {
        int total = records.size(), page = Math.min(requested, Math.max(1, (int)Math.ceil(total / (double)size)));
        int start = (page - 1) * size;
        return new LinkedHashMap<>(Map.of("records", records.subList(start, Math.min(start + size,total)), "total", total, "page", page, "size", size));
    }

    private static final class Group {
        private final Map<String,Object> value;
        private final Map<Long,Map<String,Object>> shipments = new TreeMap<>();
        Group(Map<String,Object> fact, MasterProductApi.Product sku) {
            value = quantities(sku.baseUnit());
            value.put("id", fact.get("warehouseId") + ":" + sku.id());
            for (String field : List.of("warehouseId","warehouseName","timezone")) value.put(field, fact.get(field));
            value.put("productId", sku.id()); value.put("productCode", sku.code()); value.put("productName", sku.name());
        }
        void add(Map<String,Object> fact, Map<String,Object> quantity) {
            LogisticsInTransitQuery.add(value, quantity);
            var shipment = shipments.computeIfAbsent(number(fact,"shipmentId"), id -> {
                var row = quantities(value.get("unit").toString());
                row.put("id", id);
                for (String field : List.of("docNo","status","plannedEta","actualEta","timezone")) row.put(field, fact.get(field));
                return row;
            });
            LogisticsInTransitQuery.add(shipment, quantity);
        }
        Map<String,Object> row() { value.put("shipments", new ArrayList<>(shipments.values())); return value; }
    }
}
