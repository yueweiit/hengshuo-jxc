package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;

/** Exercises the shared selector and native logistics writes through their real HTTP contracts. */
class ShipmentCarrierSelectionIT extends SupplyFixtures {
    @LocalServerPort int port;
    @Autowired tools.jackson.databind.ObjectMapper json;
    private static GenericContainer<?> packagedApp;

    @AfterAll static void stopPackagedApp() {
        if (packagedApp != null) packagedApp.stop();
    }

    @BeforeEach void partners() {
        seed("INSERT INTO md_supplier(id,country_id,code,name,settle_currency,status) VALUES(804,101,'BOTH','Both','CNY','ENABLED'),(805,101,'OFF-S','Disabled supplier','CNY','DISABLED'),(807,101,'OFF-B','Disabled both','CNY','DISABLED')");
        seed("INSERT INTO md_logistics_provider(id,country_id,code,name,settle_currency,status) VALUES(804,101,'BOTH','Both','CNY','ENABLED'),(806,101,'OFF-L','Disabled carrier','CNY','DISABLED'),(807,101,'OFF-B','Disabled both','CNY','DISABLED')");
        seed("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(102,'CN','Other country','CNY','Asia/Shanghai','ACTIVE')");
        seed("INSERT INTO md_logistics_provider(id,country_id,code,name,settle_currency) VALUES(808,102,'FOREIGN','Other country carrier','CNY')");
    }

    @SuppressWarnings("unchecked")
    Map<String,Object> call(String method, String path, Map<String,Object> body, int expectedStatus) throws Exception {
        String base = "http://127.0.0.1:" + port;
        String image = System.getProperty("jxc.carrier.image");
        if (image != null) {
            if (packagedApp == null) {
                packagedApp = new GenericContainer<>(DockerImageName.parse(image))
                        .withEnv("JXC_DB_URL", "jdbc:postgresql://host.docker.internal:" + PgDatabase.PG.getMappedPort(5432) + "/" + PgDatabase.PG.getDatabaseName())
                        .withEnv("JXC_DB_USER", "jxc_app").withEnv("JXC_DB_PASSWORD", PgDatabase.PASSWORD)
                        .withEnv("JXC_BIND_ADDRESS", "0.0.0.0").withExposedPorts(8080)
                        .withCreateContainerCmdModifier(command -> {
                            command.withEntrypoint("java");
                            command.getHostConfig().withMemory(384L * 1024 * 1024);
                        })
                        .withCommand("-Xmx256m", "-Dfile.encoding=UTF-8", "-jar", "/app/app.jar", "--spring.flyway.enabled=false", "--jxc.jobs.enabled=false")
                        .waitingFor(Wait.forHttp("/actuator/health").forStatusCode(200))
                        .withStartupTimeout(Duration.ofSeconds(90));
                packagedApp.start();
                String expectedHash = Objects.requireNonNull(System.getProperty("jxc.carrier.jarSha256"));
                assertThat(packagedApp.execInContainer("sha256sum", "/app/app.jar").getStdout()).startsWith(expectedHash + " ");
                System.out.println("CARRIER_DOCKER_VERIFIED image=" + image + " jarSha256=" + expectedHash);
            }
            base = "http://" + packagedApp.getHost() + ":" + packagedApp.getMappedPort(8080);
        }
        var request = HttpRequest.newBuilder(URI.create(base + "/api/v1" + path))
                .header("Authorization", "Bearer supply-fixture").header("X-Country-Id", "101")
                .header("Content-Type", "application/json").header("Idempotency-Key", key())
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
        var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(expectedStatus);
        return json.readValue(response.body(), Map.class);
    }

    @SuppressWarnings("unchecked")
    List<Map<String,Object>> records(String path) throws Exception {
        var envelope = call("GET", path, null, 200);
        assertThat(envelope).containsEntry("code", "OK");
        var data = (Map<String,Object>) envelope.get("data");
        var rows = (List<Map<String,Object>>) data.get("records");
        assertThat(((Number) data.get("total")).intValue()).isEqualTo(rows.size());
        return rows;
    }

    List<Long> ids(List<Map<String,Object>> rows) {
        return rows.stream().map(row -> ((Number) row.get("id")).longValue()).toList();
    }

    @Test void logisticsOptionsExcludeSupplierOnlyDisabledAndForeignPartners() throws Exception {
        var rows = records("/md/partners?partnerType=LOGISTICS&status=ENABLED");
        assertThat(ids(rows)).containsExactlyInAnyOrder(802L, 804L);
        assertThat(rows).allSatisfy(row -> assertThat(row.get("partnerType")).isIn("LOGISTICS", "BOTH"));
    }

    @Test void supplierOptionsIncludeBothRolesButExcludeLogisticsOnlyPartners() throws Exception {
        assertThat(ids(records("/md/partners?partnerType=SUPPLIER&status=ENABLED")))
                .containsExactlyInAnyOrder(801L, 804L);
    }

    @Test void unfilteredListPreservesDisabledPartnersAndDeduplicatesBothRoles() throws Exception {
        var rows = records("/md/partners");
        assertThat(ids(rows)).containsExactlyInAnyOrder(801L, 802L, 804L, 805L, 806L, 807L);
        assertThat(rows.stream().filter(row -> ((Number) row.get("id")).longValue() == 804).findFirst().orElseThrow())
                .containsEntry("partnerType", "BOTH");
    }

    @Test void bothRoleAndDisabledFiltersApplyTogether() throws Exception {
        assertThat(ids(records("/md/partners?partnerType=BOTH&status=DISABLED"))).containsExactly(807L);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void roleFilterUsesTheStatusOfTheRequestedRole(boolean supplierDisabled) throws Exception {
        seed("UPDATE " + (supplierDisabled ? "md_supplier" : "md_logistics_provider") + " SET status='DISABLED' WHERE id=804");
        assertThat(ids(records("/md/partners?partnerType=LOGISTICS&status=ENABLED")))
                .containsExactlyInAnyOrderElementsOf(supplierDisabled ? List.of(802L, 804L) : List.of(802L));
        assertThat(ids(records("/md/partners?partnerType=SUPPLIER&status=ENABLED")))
                .containsExactlyInAnyOrderElementsOf(supplierDisabled ? List.of(801L) : List.of(801L, 804L));
    }

    @ParameterizedTest
    @CsvSource({"suppliers,801,804", "logistics-providers,802,804"})
    void specializedPartnerRoutesAlsoHonorEnabledStatus(String kind, long first, long second) throws Exception {
        assertThat(ids(records("/md/" + kind + "?status=ENABLED"))).containsExactlyInAnyOrder(first, second);
    }

    @ParameterizedTest
    @ValueSource(strings = {"partnerType=UNKNOWN", "status=UNKNOWN"})
    void invalidFiltersReturnAnExplicitParameterError(String filter) throws Exception {
        assertThat(call("GET", "/md/partners?" + filter, null, 400)).containsEntry("code", "SYS_BAD_REQUEST");
    }

    Map<String,Object> shipmentBody(long carrier) {
        var exported = export(domestic(order(), 20, 0, 0, true), 20, true);
        return Map.of("bookId", 601, "destWarehouseId", 401, "carrierId", carrier,
                "transportMode", "AIR", "flightNo", "F1", "awbNo", "AWB", "bizDate", "2026-10-15",
                "lines", List.of(Map.of("sourceLineId", id(first(exported)), "baseQty", 2)));
    }

    Map<String,Object> counts() {
        return owner.queryForMap("SELECT (SELECT count(*) FROM lgs_shipment) shipments,(SELECT count(*) FROM lgs_shipment_line) lines,(SELECT count(*) FROM lgs_container) containers,(SELECT count(*) FROM lgs_fee) fees,(SELECT count(*) FROM sys_audit_log) audits,(SELECT count(*) FROM sys_idempotency) intents");
    }

    @ParameterizedTest
    @CsvSource({
        "801,LGS_CARRIER_TYPE_MISMATCH,所选单位是供应商，不能作为物流商，请重新选择",
        "99999,LGS_CARRIER_UNAVAILABLE,所选物流商不存在或不属于当前国家，请重新选择",
        "808,LGS_CARRIER_UNAVAILABLE,所选物流商不存在或不属于当前国家，请重新选择",
        "806,LGS_CARRIER_DISABLED,所选物流商已停用，请重新选择"
    })
    void invalidCarrierReturnsAnActionableErrorWithoutSavingFacts(long carrier, String code, String message) throws Exception {
        var body = shipmentBody(carrier);
        var before = counts();
        assertThat(call("POST", "/lgs/shipments", body, 400))
                .containsEntry("code", code).containsEntry("message", message);
        assertThat(counts()).isEqualTo(before);
    }

    @ParameterizedTest
    @ValueSource(longs = {802, 804})
    @SuppressWarnings("unchecked")
    void enabledCarrierOrBothRolePartnerCanCreateAShipment(long carrier) throws Exception {
        var envelope = call("POST", "/lgs/shipments", shipmentBody(carrier), 200);
        assertThat(envelope).containsEntry("code", "OK");
        var saved = (Map<String,Object>) envelope.get("data");
        assertThat(saved).containsEntry("status", "DRAFT");
        assertThat(((Number) saved.get("carrierId")).longValue()).isEqualTo(carrier);
        assertThat(owner.queryForObject("SELECT count(*) FROM lgs_shipment_line", Integer.class)).isEqualTo(1);
    }

    @Test void shipmentEditExplainsSupplierMisuseAndRollsBackTheOriginalDraft() throws Exception {
        var saved = lgs.create(c(), "shipments", shipmentBody(802), key());
        var before = counts();
        var original = owner.queryForMap("SELECT * FROM lgs_shipment WHERE id=?", id(saved));
        assertThat(call("PUT", "/lgs/shipments/" + id(saved),
                Map.of("version", saved.get("version"), "carrierId", 801), 400))
                .containsEntry("code", "LGS_CARRIER_TYPE_MISMATCH")
                .containsEntry("message", "所选单位是供应商，不能作为物流商，请重新选择");
        assertThat(counts()).isEqualTo(before);
        assertThat(owner.queryForMap("SELECT * FROM lgs_shipment WHERE id=?", id(saved))).isEqualTo(original);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void feeCreationAndEditingUseTheSameCarrierValidation(boolean editing) throws Exception {
        var shipment = lgs.create(c(), "shipments", shipmentBody(802), key());
        var body = new LinkedHashMap<String,Object>(Map.of("refType", "SHIPMENT", "refId", id(shipment),
                "carrierId", 802, "expenseItemId", 803, "currency", "CNY", "amount", 100,
                "estimateFlag", "ACTUAL", "bizDate", "2026-10-15"));
        String path = "/lgs/fees";
        Map<String,Object> original = null;
        if (editing) {
            var fee = lgs.create(c(), "fees", body, key());
            path += "/" + id(fee);
            body.put("version", fee.get("version"));
            original = owner.queryForMap("SELECT * FROM lgs_fee WHERE id=?", id(fee));
        }
        body.put("carrierId", 801);
        var before = counts();
        assertThat(call(editing ? "PUT" : "POST", path, body, 400))
                .containsEntry("code", "LGS_CARRIER_TYPE_MISMATCH")
                .containsEntry("message", "所选单位是供应商，不能作为物流商，请重新选择");
        assertThat(counts()).isEqualTo(before);
        if (editing) assertThat(owner.queryForMap("SELECT * FROM lgs_fee")).isEqualTo(original);
    }
}
