package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;

import com.hs.jxc.ar.ReceivablesService;
import com.hs.jxc.attachment.AttachmentService;
import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.md.CustomerMasterService;
import com.hs.jxc.org.OrgService;
import com.hs.jxc.sal.SalesService;
import com.hs.jxc.sys.service.SessionService;
import com.hs.jxc.sys.service.SystemManagementService;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.LocalDate;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** Store totals must be backed by native receipts/outbounds, not inserted balance fixtures. */
class StoreDailyNativeIT extends SupplyFixtures {
    @Autowired SalesService sales;
    @Autowired ReceivablesService ar;
    @Autowired AttachmentService attachments;
    @Autowired OrgService org;
    @Autowired CustomerMasterService customers;
    @Autowired SystemManagementService management;
    @Autowired SessionService sessions;
    @Autowired com.hs.jxc.sys.jobs.JobService jobs;
    @Autowired JsonCodec json;
    @Value("${local.server.port}") int port;

    @DynamicPropertySource static void storage(DynamicPropertyRegistry r) {
        r.add("jxc.storage.endpoint", MinioTestStorage::endpoint);
        r.add("jxc.storage.access-key", () -> MinioTestStorage.ACCESS);
        r.add("jxc.storage.secret-key", () -> MinioTestStorage.SECRET);
        r.add("jxc.storage.bucket", () -> MinioTestStorage.BUCKET);
    }

    @Test void nativeStoreDailySeparatesStoresAndRechecksTheSameSessionAfterRevocation() throws Exception {
        // Only identity/configuration is seeded. All business facts below use their native writers.
        seed("update sys_user set is_platform_admin=true where id=201");
        seed("update sys_role set field_policies=field_policies||'{\"CUSTOMER_PRICE\":\"WRITE\",\"CREDIT\":\"WRITE\"}'::jsonb where id=202");
        seed("insert into wf_doc_type_config(country_id,doc_type,approval_required,key_fields) values(101,'SALES_ORDER',false,'[]')");
        seed("insert into md_exchange_rate(country_id,from_ccy,to_ccy,rate_date,scope,rate,status,confirmed_by,confirmed_at) values(101,'CNY','MXN','2026-10-15','PURCHASE_COST',2.5,'CONFIRMED',201,clock_timestamp())");
        var storeA = store("AI07-A");
        var storeB = store("AI07-B");
        // Keep the transport destination WAREHOUSE; the native default store warehouse remains STORE.
        org.update(c(), "warehouses", 401, Map.of("version", 1, "storeId", id(storeA)));
        var inbound = receipt(delivery());
        lgs.action(c(), "receipts", id(inbound), "confirm", Map.of(), key());
        var customerA = customer("AI07-A", id(storeA));
        var customerB = customer("AI07-B", id(storeB));
        sales.savePrice(c(), null, Map.of("productId",501,"priceType","BASE","unit","PCS","price",20,"currency","MXN","effectiveFrom","2026-10-01"), key());
        ar.saveRule(c(), null, Map.of("targetType","CUSTOMER","targetId",id(customerA),"paymentMode","CREDIT_ALLOWED","creditLimit",1000,"currency","MXN","effectiveFrom","2026-10-01"));
        ar.saveRule(c(), null, Map.of("targetType","CUSTOMER","targetId",id(customerB),"paymentMode","CREDIT_ALLOWED","creditLimit",1000,"currency","MXN","effectiveFrom","2026-10-01"));
        var orderA = sales.create(c(), orderBody(id(storeA),id(customerA),401,2), key());
        orderA = sales.submit(c(), id(orderA), Map.of("bizDate","2026-10-15"), key());
        byte[] original = "AI07 native sale evidence 中文".getBytes(StandardCharsets.UTF_8);
        var attachment = attachments.upload(c(), "SAL_ORDER", id(orderA), "SALES_DOC", "AI07-sale.txt", "text/plain", original);
        long allocation = ((Number)((Map<?,?>)((List<?>)first(orderA).get("allocs")).getFirst()).get("id")).longValue();
        var outbound = sales.createOutbound(c(), Map.of("orderId",id(orderA),"warehouseId",401,"bizDate","2026-10-15","lines",List.of(Map.of("allocId",allocation,"qty",2))), key());
        outbound = sales.confirmOutbound(c(), id(outbound), Map.of("bizDate","2026-10-15"), key());
        var orderB = sales.create(c(), orderBody(id(storeB),id(customerB),((Number)storeB.get("defaultWarehouseId")).longValue(),1), key());
        var cash = collection(id(storeA),id(customerA),"CASH",50,true);
        var pending = collection(id(storeA),id(customerA),"TRANSFER",7,false);
        var otherCash = collection(id(storeB),id(customerB),"CASH",11,true);
        var daily = (Map<String,Object>)sales.storeDaily(c(),id(storeA),LocalDate.of(2026,10,15));
        amount(daily,"orderAmount","40"); amount(daily,"outboundQty","2"); amount(daily,"outboundAmount","40");
        amount(daily,"cash","50"); amount(daily,"transfer","7"); amount(daily,"pendingConfirm","7");
        assertThat(((Number)daily.get("orderCount")).longValue()).isEqualTo(1);
        amount((Map<String,Object>)sales.storeDaily(c(),id(storeB),LocalDate.of(2026,10,15)),"cash","11");
        assertThat(owner.queryForObject("select amount from ar_receivable where source_id=?",BigDecimal.class,id(outbound))).isEqualByComparingTo("40");
        assertThat(owner.queryForObject("select count(*) from sys_biz_event where event_type='SAL_OUTBOUND_CONFIRMED' and source_id=?",Integer.class,id(outbound))).isEqualTo(1);
        var statement = ar.statement(c(),Map.of("bookId",601,"customerId",id(customerA),"periodStart","2026-10-01","periodEnd","2026-10-31"),key());
        amount(statement,"increase","40"); amount(statement,"closing","40");
        String exportIntent = key();
        var export = ar.exportStatements(c(),Map.of("bookId",601,"statementId",id(statement)),exportIntent,jobs);
        assertThat(id(ar.exportStatements(c(),Map.of("bookId",601,"statementId",id(statement)),exportIntent,jobs))).isEqualTo(id(export));
        jobs.run(101,id(export)); jobs.run(101,id(export));
        var exported = jobs.download(c(),id(export));
        assertThat(exported.get("content").toString()).contains("MXN","40");
        assertThat(owner.queryForObject("select count(*) from sys_job_result where job_id=?",Integer.class,id(export))).isEqualTo(1);

        String password = Objects.requireNonNullElseGet(System.getenv("JXC_AI07_TEST_PASSWORD"), () -> UUID.randomUUID().toString());
        var user = management.createUser(c(),Map.of("username","AI07-store-reader","displayName","AI07门店A只读","password",password));
        String token = sessions.login("AI07-store-reader",password).get("token").toString();
        var viewer = new RequestContext(id(user),101L,"AI07-native-store",SessionService.digest(token));
        long orderId = id(orderA);
        assertThatThrownBy(() -> sales.get(viewer,orderId)).extracting("status").isEqualTo(403);
        var role = management.createRole(c(),Map.of("code","AI07-STORE-READ","name","AI07门店只读","permissions",List.of("sal:order:view","ar:receipt:view"),"fieldPolicies",Map.of("ORDER_TOTAL","READ","CUSTOMER_PRICE","READ")));
        var granted = management.setGrants(c(),id(user),101L,List.of(id(role)),List.of(Map.of("scopeType","STORE","scopeRefId",id(storeA))),((Number)user.get("version")).longValue());
        assertThat(sales.get(viewer,orderId).get("id")).isEqualTo(orderId);
        var attachmentSpec = new AttachmentService.EvidenceSpec(id(attachment),"SAL_ORDER",orderId,"SALES_DOC",1,
            owner.queryForObject("select sha256 from sys_attachment where id=?",String.class,id(attachment)));
        assertThat(attachments.download(viewer,attachmentSpec).bytes()).containsExactly(original);
        assertThatThrownBy(() -> sales.get(viewer,id(orderB))).extracting("status").isEqualTo(404);
        assertThatThrownBy(() -> sales.storeDaily(viewer,id(storeB),LocalDate.of(2026,10,15))).extracting("status").isEqualTo(404);
        amount((Map<String,Object>)sales.storeDaily(viewer,null,LocalDate.of(2026,10,15)),"cash","50");
        var evidence = new LinkedHashMap<String,Object>();
        evidence.put("database",Map.of("jdbcUrl",PgDatabase.PG.getJdbcUrl(),"containerId",PgDatabase.PG.getContainerId(),
            "runtimeIdentity",inCountry(101,()->jdbc.queryForMap("select current_database() database,current_user runtime_role,(select rolbypassrls from pg_roles where rolname=current_user) bypass_rls"))));
        evidence.put("objectStorage",Map.of("endpoint",MinioTestStorage.endpoint(),"bucket",MinioTestStorage.BUCKET,"containerId",MinioTestStorage.MINIO.getContainerId()));
        evidence.put("apiPort",port); evidence.put("countryId",101); evidence.put("storeA",storeA); evidence.put("storeB",storeB);
        evidence.put("inbound",inbound); evidence.put("orderA",orderA); evidence.put("orderB",orderB); evidence.put("outbound",outbound);
        evidence.put("cashReceipt",cash); evidence.put("pendingTransfer",pending); evidence.put("otherStoreCash",otherCash); evidence.put("daily",daily);
        evidence.put("attachment",attachment); evidence.put("userId",id(user)); evidence.put("roleId",id(role));
        evidence.put("statement",statement); evidence.put("exportJob",export); evidence.put("exportArtifact",exported);
        evidence.put("nativeSources",owner.queryForList("select id,source_no,source_type,source_id,source_line_id,on_hand_change,frozen_change from inv_stock_txn order by id"));
        evidence.put("events",owner.queryForList("select id,event_type,source_type,source_id,biz_date from sys_biz_event order by id"));
        var lineage = new LinkedHashMap<String,Object>();
        for(String table:List.of("pur_order","pur_order_line","pur_domestic_receipt","pur_domestic_receipt_line",
            "pur_export_node","pur_export_node_line","lgs_shipment","lgs_shipment_line","lgs_delivery",
            "lgs_delivery_line","lgs_receipt","lgs_receipt_line","ar_receivable","cst_inbound_cost","cst_cogs")) {
            lineage.put(table,owner.queryForList("select * from "+table+" order by id"));
        }
        evidence.put("lineage",lineage);
        publishAndOptionallyWait(evidence);
        management.setGrants(c(),id(user),101L,List.of(id(role)),List.of(),((Number)granted.get("version")).longValue());
        assertThatThrownBy(() -> sales.get(viewer,orderId)).extracting("status").isEqualTo(404);
        assertThatThrownBy(() -> attachments.download(viewer,attachmentSpec)).extracting("status").isEqualTo(404);
        assertThatThrownBy(() -> sales.storeDaily(viewer,id(storeA),LocalDate.of(2026,10,15))).extracting("status").isEqualTo(404);
        evidence.put("sameSessionRevocation","original detail and explicit store daily both rejected with 404");
        saveEvidence(evidence);
        if(Integer.getInteger("jxc.ai07.browser.waitSeconds",0)>0) {
            Path directory = Path.of(System.getProperty("jxc.ai07.evidence.dir"));
            Files.writeString(directory.resolve("browser-revoked.json"),"{}",StandardCharsets.UTF_8);
            waitForMarker(directory.resolve("browser-revocation-done.json"));
        }
    }

    private Map<String,Object> store(String code) {
        return org.create(c(),"stores",Map.of("entityId",301,"code",code,"name",code,"fundAccount",Map.of("name",code+"-cash","accountType","CASH","bookId",601,"currency","MXN")),key());
    }
    private Map<String,Object> customer(String code,long store) {
        return inCountry(101,() -> customers.save(c(),"customers",null,Map.of("code",code,"name",code,"storeId",store),key()));
    }
    private Map<String,Object> orderBody(long store,long customer,long warehouse,int qty) {
        return Map.of("entityId",301,"bookId",601,"storeId",store,"customerId",customer,"orderDate","2026-10-15","paymentType","CREDIT","lines",List.of(Map.of("productId",501,"unit","PCS","qty",qty,"warehouseId",warehouse)));
    }
    private Map<String,Object> collection(long store,long customer,String method,int amount,boolean confirm) {
        long fund = owner.queryForObject("select id from md_fund_account where store_id=?",Long.class,store);
        var result = ar.createReceipt(c(),Map.of("customerId",customer,"fundAccountId",fund,"method",method,"amount",amount,"bizTime","2026-10-15T12:00:00Z"),key());
        return confirm ? ar.receiptAction(c(),id(result),"confirm",Map.of("arrivalDate","2026-10-15"),key()) : result;
    }
    private static void amount(Map<String,Object> row,String field,String expected) {
        assertThat(new BigDecimal(row.get(field).toString())).as(field).isEqualByComparingTo(expected);
    }
    private void saveEvidence(Map<String,Object> evidence) throws Exception {
        String directory = System.getProperty("jxc.ai07.evidence.dir");
        if(directory!=null) { Files.createDirectories(Path.of(directory)); Files.writeString(Path.of(directory,"native-store-source.json"),json.write(evidence),StandardCharsets.UTF_8); }
    }
    private void publishAndOptionallyWait(Map<String,Object> evidence) throws Exception {
        saveEvidence(evidence);
        int seconds = Integer.getInteger("jxc.ai07.browser.waitSeconds",0);
        if(seconds<=0) return;
        seed("update sys_user set password_hash=? where id=201",sessions.encodePassword(System.getenv("JXC_AI07_TEST_PASSWORD")));
        Path directory = Path.of(Objects.requireNonNull(System.getProperty("jxc.ai07.evidence.dir")));
        Files.writeString(directory.resolve("browser-ready.json"),json.write(Map.of("apiPort",port,"user","AI07-store-reader","adminUser","supply","countryId",101)),StandardCharsets.UTF_8);
        waitForMarker(directory.resolve("browser-done.json"));
    }
    private void waitForMarker(Path marker) throws Exception {
        long deadline = System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(Integer.getInteger("jxc.ai07.browser.waitSeconds",0));
        while(!Files.exists(marker)) {
            if(System.nanoTime()>deadline) throw new AssertionError("AI07 browser stage did not finish within its explicit timeout");
            Thread.sleep(250);
        }
    }
}
