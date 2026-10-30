package com.hs.jxc.lgs;

import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** One native delay selector for work items and the in-transit board; joins the caller's transaction. */
@Component
public class LogisticsDelayQuery {
    public record Rule(String status, Integer toleranceHours, String message) {}
    public record Result(Rule rule, List<Map<String,Object>> records) {}
    private final JdbcTemplate jdbc;

    public LogisticsDelayQuery(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public Result read(Access access) {
        String value = jdbc.queryForObject("SELECT config->>'lgs.delay.toleranceHours' FROM sys_country WHERE id=?", String.class, access.requireCountry());
        if (value == null) return new Result(new Rule("MISSING", null, "尚未配置物流延误容忍时长"), List.of());
        if (!value.matches("[0-9]{1,6}")) return new Result(new Rule("INVALID", null, "物流延误容忍时长配置无效"), List.of());
        int tolerance = Integer.parseInt(value);
        var records = new ArrayList<Map<String,Object>>();
        // This is the former LogisticsWorkItems selector, including opening-source departure evidence.
        String sql = "SELECT sh.*,sh.dest_warehouse_id warehouse_id,w.name dest_warehouse_name,"
            + "COALESCE(w.timezone,ct.timezone) timezone,p.name carrier_name,clock_timestamp() observed_at "
            + "FROM lgs_shipment sh JOIN sys_country ct ON ct.id=sh.country_id "
            + "JOIN org_warehouse w ON w.country_id=sh.country_id AND w.id=sh.dest_warehouse_id "
            + "JOIN md_logistics_provider p ON p.country_id=sh.country_id AND p.id=sh.carrier_id WHERE sh.country_id=? "
            + "AND sh.status NOT IN ('DRAFT','CANCELLED','VOIDED','COMPLETED','CLOSED') "
            + "AND ((sh.planned_etd IS NOT NULL AND NOT " + LogisticsService.departedSql("sh")
            + " AND sh.planned_etd+make_interval(hours=>?)<clock_timestamp()) "
            + "OR (sh.planned_eta IS NOT NULL AND sh.actual_eta IS NULL "
            + "AND sh.planned_eta+make_interval(hours=>?)<clock_timestamp())) ORDER BY sh.id";
        for (var original : jdbc.queryForList(sql, access.requireCountry(), tolerance, tolerance)) {
            var row = DbRows.camel(original);
            if (!access.canRow(row)) continue;
            Instant now = Instant.parse(row.get("observedAt").toString());
            boolean departed = row.get("actualEtd") != null || row.get("openingRef") != null && row.get("openingSourceDate") != null;
            boolean departureDelay = !departed && row.get("plannedEtd") != null
                && Instant.parse(row.get("plannedEtd").toString()).plus(tolerance, ChronoUnit.HOURS).isBefore(now);
            Object planned = row.get(departureDelay ? "plannedEtd" : "plannedEta");
            row.put("delayStage", departureDelay ? "发运" : "到港");
            row.put("plannedAt", planned);
            row.put("delayHours", Duration.between(Instant.parse(planned.toString()), now).toHours());
            row.remove("observedAt");
            records.add(row);
        }
        return new Result(new Rule("ACTIVE", tolerance, ""), records);
    }
}
