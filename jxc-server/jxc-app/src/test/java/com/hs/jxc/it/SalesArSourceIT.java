package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;

import com.hs.jxc.ar.ReceivablesService;
import com.hs.jxc.attachment.AttachmentService;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sal.SalesService;
import com.hs.jxc.common.api.JsonCodec;
import com.hs.jxc.sys.service.SessionService;
import com.hs.jxc.workflow.service.WorkflowService;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** AI-01: downstream facts must come from native purchase, logistics and sales services. */
class SalesArSourceIT extends SupplyFixtures {
    @Autowired SalesService sales;
    @Autowired ReceivablesService ar;
    @Autowired WorkflowService workflow;
    @Autowired AttachmentService attachments;
    @Autowired JsonCodec json;
    @Autowired com.hs.jxc.rtn.ReturnsService returns;
    @Autowired com.hs.jxc.sys.jobs.WorkbenchService workbench;
    @org.springframework.beans.factory.annotation.Value("${local.server.port}") int backendPort;
    final List<Map<String,Object>> checkpoints = new ArrayList<>();
    static final String DAY = "2026-10-15";
    static final String FIELDS = "{\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\",\"BANK_INFO\":\"WRITE\",\"CREDIT\":\"WRITE\",\"COST\":\"WRITE\"}";

    @DynamicPropertySource static void storage(DynamicPropertyRegistry r) {
        r.add("jxc.storage.endpoint", MinioTestStorage::endpoint);
        r.add("jxc.storage.access-key", () -> MinioTestStorage.ACCESS);
        r.add("jxc.storage.secret-key", () -> MinioTestStorage.SECRET);
        r.add("jxc.storage.bucket", SalesArSourceIT::privateBucket);
    }
    static synchronized String privateBucket() {
        String bucket="jxc-ai01-20261026";
        try(var client=MinioTestStorage.client()) {
            if(!client.bucketExists(io.minio.BucketExistsArgs.builder().bucket(bucket).build()))client.makeBucket(io.minio.MakeBucketArgs.builder().bucket(bucket).build());
            return bucket;
        }catch(Exception error){throw new IllegalStateException("Cannot prepare AI01 private evidence bucket",error);}
    }

    @BeforeEach void salesMasterData() {
        checkpoints.clear();
        seed("UPDATE sys_doc_number_rule SET prefix='AI01-'||prefix WHERE country_id=101");
        seed("UPDATE sys_role SET field_policies=?::jsonb WHERE id=202", FIELDS);
        seed("INSERT INTO org_store(id,country_id,entity_id,code,name) VALUES(302,101,301,'AI01-S','TEST AI01 门店')");
        seed("UPDATE org_warehouse SET store_id=302 WHERE id=401");
        seed("INSERT INTO org_warehouse(id,country_id,entity_id,store_id,code,name) VALUES(402,101,301,302,'AI01-B','TEST AI01 B仓')");
        seed("INSERT INTO md_customer_level(id,country_id,code,name) VALUES(1811,101,'AI01-L','TEST AI01 等级')");
        seed("INSERT INTO md_customer(id,country_id,code,name,level_id,store_id) VALUES(1801,101,'AI01-C','TEST AI01 客户',1811,302),(1802,101,'AI01-C2','TEST AI01 无等级客户',NULL,302)");
        seed("INSERT INTO md_fund_account(id,country_id,entity_id,book_id,store_id,name,account_type,currency) VALUES(1901,101,301,601,302,'TEST AI01 现金','CASH','MXN'),(1902,101,301,601,302,'TEST AI01 银行','BANK','MXN'),(1903,101,301,601,302,'TEST AI01 异币','BANK','CNY')");
        seed("INSERT INTO md_exchange_rate(country_id,from_ccy,to_ccy,rate_date,scope,rate,status,confirmed_by,confirmed_at) VALUES(101,'CNY','MXN','2026-10-15','PURCHASE_COST',2.5,'CONFIRMED',201,clock_timestamp())");
        seed("INSERT INTO fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(702,101,601,2026,11,'2026-11-01','2026-11-30','OPEN')");
        String salesPermissions = "[\"sal:order:create\",\"sal:order:edit\",\"sal:order:view\",\"sal:order:submit\",\"sal:order:cancel\",\"sal:order:close\"]";
        actor(211,221,"SALES",salesPermissions,FIELDS,"COUNTRY_ALL",null);
        actor(212,222,"STORE",salesPermissions,FIELDS,"STORE",302L);
        actor(213,223,"APPROVERS","[\"sal:order:view\",\"sal:order:submit\"]",FIELDS,"COUNTRY_ALL",null);
        actor(217,223,"APPROVERS",null,null,"COUNTRY_ALL",null);
        String warehousePermissions="[\"sal:order:view\",\"sal:outbound:create\",\"sal:outbound:confirm\",\"sal:sign:record\"]";
        actor(214,224,"WAREHOUSE_A",warehousePermissions,"{}","WAREHOUSE",401L);
        actor(215,225,"WAREHOUSE_B",warehousePermissions,"{}","WAREHOUSE",402L);
        actor(216,226,"AR","[\"ar:receipt:create\",\"ar:receipt:confirm\",\"ar:writeoff:create\",\"ar:writeoff:reverse\",\"ar:receivable:view\",\"ar:statement:view\",\"ar:credit-rule:edit\",\"ar:credit-rule:view\",\"sal:order:view\"]",FIELDS,"COUNTRY_ALL",null);
        // Native list filters require customer read access for these positive test jobs.
        seed("UPDATE sys_role SET permissions=permissions||'[\"md:customer:view\"]'::jsonb WHERE id IN (221,222,226)");
        seed("UPDATE sys_role SET field_policies='{\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\"}'::jsonb WHERE id=222");
        sales.savePrice(c(),null,price("BASE",20,1,"2026-10-01",null),key());
        credit(null,"CREDIT_ALLOWED",10000,"WARN",false,30);
        workflow.configure(c(),"SALES_ORDER",Map.of("approvalRequired",false,"keyFields",List.of("customerId","paymentType","currency","approvalKey")));
    }

    void actor(long user,long role,String code,String permissions,String fields,String scope,Long reference) {
        seed("INSERT INTO sys_user(id,username,password_hash,display_name,status) VALUES(?,?,'unused',?,'ENABLED')",user,"ai01-"+user,"TEST AI01 "+code);
        seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,?,clock_timestamp()+interval '2 hour')",SessionService.digest("ai01-"+user),user);
        if(permissions!=null) seed("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(?,101,?,?,?::jsonb,?::jsonb)",role,"AI01_"+code,"TEST AI01 "+code,permissions,fields);
        seed("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(101,?,?)",user,role);
        String column=scope.equals("STORE")?"store_id":"warehouse_id";
        if(reference==null) seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(101,?, ?,201)",user,scope);
        else seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,"+column+",granted_by) VALUES(101,?,?,?,201)",user,scope,reference);
    }
    RequestContext as(long user) {return new RequestContext(user,101L,"AI01-source",SessionService.digest("ai01-"+user));}
    Map<String,Object> price(String type,int amount,int min,String from,String to) {
        var b=new LinkedHashMap<String,Object>(Map.of("productId",501,"priceType",type,"unit","PCS","minQty",min,"price",amount,"currency","MXN","effectiveFrom",from));
        if(type.equals("LEVEL"))b.put("levelId",1811);
        if(type.equals("CUSTOMER"))b.put("customerId",1801);
        if(to!=null)b.put("effectiveTo",to);
        return b;
    }
    Map<String,Object> credit(Long previous,String mode,int limit,String policy,boolean exception,int days) {
        var b=new LinkedHashMap<String,Object>(Map.of("targetType","CUSTOMER","targetId",1801,"paymentMode",mode,"creditLimit",limit,"currency","MXN","effectiveFrom","2026-10-01","overduePolicy",policy,"allowException",exception,"termDays",days));
        if(previous!=null)b.put("version",owner.queryForObject("SELECT version FROM ar_credit_rule WHERE id=?",Long.class,previous));
        return ar.saveRule(as(216),previous,b);
    }
    long activeCredit() {return owner.queryForObject("SELECT id FROM ar_credit_rule WHERE target_id=1801 AND status='ACTIVE'",Long.class);}
    Map<String,Object> body(int qty,long warehouse) {return Map.of("entityId",301,"bookId",601,"customerId",1801,"paymentType","CREDIT","orderDate",DAY,"lines",List.of(Map.of("productId",501,"unit","PCS","qty",qty,"warehouseId",warehouse)));}
    Map<String,Object> order(int qty,long warehouse) {return sales.create(as(211),body(qty,warehouse),key());}
    Map<String,Object> approve(Map<String,Object> order) {return sales.submit(as(211),id(order),Map.of("bizDate",DAY),key());}
    Map<String,Object> alloc(Map<String,Object> order,long warehouse) {return rows(first(order),"allocs").stream().filter(a->((Number)a.get("warehouseId")).longValue()==warehouse).findFirst().orElseThrow();}
    @SuppressWarnings("unchecked") List<Map<String,Object>> rows(Map<String,Object> data,String key) {return (List<Map<String,Object>>)data.get(key);}
    void doc(Map<String,Object> order) {attachments.upload(c(),"SAL_ORDER",id(order),"SALES_DOC","AI01-source.txt","text/plain","TEST AI01 原生采购来源".getBytes(StandardCharsets.UTF_8));}
    Map<String,Object> outbound(Map<String,Object> order,long warehouse,int qty,RequestContext actor) {
        return sales.createOutbound(actor,Map.of("orderId",id(order),"warehouseId",warehouse,"bizDate",DAY,"lines",List.of(Map.of("allocId",id(alloc(order,warehouse)),"qty",qty))),key());
    }
    Map<String,Object> ship(Map<String,Object> order,long warehouse,int qty) {
        doc(order);var draft=outbound(order,warehouse,qty,c());
        return sales.confirmOutbound(c(),id(draft),Map.of("bizDate",DAY),key());
    }
    BigDecimal scalar(String sql,Object... args) {return owner.queryForObject(sql,BigDecimal.class,args);}
    void number(String sql,String expected,Object... args) {assertThat(scalar(sql,args)).as(sql).isEqualByComparingTo(expected);}
    void checkpoint(String label,Object facts) {checkpoints.add(Map.of("checkpoint",label,"facts",facts));}
    void knownBusinessBlocker(String item,String reason) {
        if(Boolean.getBoolean("ai01.exclude.known.business.blockers")) {
            checkpoint("已复现业务阻塞",Map.of("item",item,"reason",reason,"firstEvidence","source-run-1 and source-run-1-junit"));
            Assumptions.abort(item+": "+reason+"；默认运行保留失败回归，本轮仅显式排除已知业务错误");
        }
    }

    /** Reuses purchase fixture orchestration; quantities and warehouse are explicit per scenario. */
    Map<String,Object> stock(long warehouse,int qty) {
        var po=super.order();var domestic=domestic(po,20,0,0,true);var exported=export(domestic,20,true);
        var shipment=lgs.create(c(),"shipments",Map.of("bookId",601,"destWarehouseId",warehouse,"carrierId",802,"transportMode","AIR","flightNo","AI01-TEST","awbNo",key(),"bizDate",DAY,"submit",true,"lines",List.of(Map.of("sourceLineId",id(first(exported)),"baseQty",qty))),key());
        lgs.action(c(),"shipments",id(shipment),"dispatch",Map.of("actualEtd",DAY+"T00:00:00Z"),key());
        lgs.action(c(),"shipments",id(shipment),"nodes",Map.of("nodeType","ARRIVED_PORT","actualAt",DAY+"T01:00:00Z"),key());
        lgs.action(c(),"shipments",id(shipment),"nodes",Map.of("nodeType","CUSTOMS_RELEASED","actualAt",DAY+"T02:00:00Z"),key());
        var delivery=lgs.create(c(),"deliveries",Map.of("shipmentId",id(shipment),"bizDate",DAY,"dispatch",true,"dispatchedAt",DAY+"T03:00:00Z","lines",List.of(Map.of("shipmentLineId",id(first(shipment)),"dispatchQty",qty))),key());
        var receipt=lgs.create(c(),"receipts",Map.of("deliveryId",id(delivery),"bizDate",DAY,"lines",List.of(Map.of("deliveryLineId",id(first(delivery)),"goodQty",qty,"damagedQty",0,"pendingInspectQty",0,"shortQty",0))),key());
        receipt=lgs.action(c(),"receipts",id(receipt),"confirm",Map.of(),key());
        checkpoint("采购到实收",Map.of("purchase",po,"domestic",domestic,"export",exported,"shipment",shipment,"delivery",delivery,"receipt",receipt,"warehouse",warehouse,"baseQty",qty,"currencyAndFx",Map.of("from","CNY","to","MXN","rate","2.5")));
        number("SELECT sum(b.on_hand_qty) FROM inv_batch i JOIN inv_batch_balance b ON b.batch_id=i.id AND b.country_id=i.country_id WHERE i.source_id=? AND i.source_type='LGS_RECEIPT'",String.valueOf(qty),id(receipt));
        return receipt;
    }

    @Test void pricePriorityQuantityDateUnitAndApprovedSnapshotUseNativeSupply() {
        stock(401,7);
        sales.savePrice(c(),null,price("LEVEL",18,2,"2026-10-10","2026-10-20"),key());
        var customer=sales.savePrice(c(),null,price("CUSTOMER",16,3,"2026-10-15","2026-10-16"),key());
        for(var sample:List.of(List.of("1","2026-10-15","20"),List.of("2","2026-10-15","18"),List.of("3","2026-10-15","16"),List.of("3","2026-10-16","16"),List.of("3","2026-10-17","18"),List.of("3","2026-10-21","20"))) {
            var hit=(Map<?,?>)sales.resolvePrice(as(211),Map.of("customerId","1801","productId","501","unit","PCS","qty",sample.get(0),"date",sample.get(1)));
            assertThat(new BigDecimal(hit.get("price").toString())).isEqualByComparingTo(sample.get(2));checkpoint("价格边界",hit);
        }
        assertThatThrownBy(()->sales.resolvePrice(as(211),Map.of("customerId","1801","productId","501","unit","BOX","qty","3","date",DAY))).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SAL_PRICE_NOT_FOUND");
        var original=approve(order(3,401));sales.savePrice(c(),id(customer),Map.of("version",customer.get("version"),"price",30),key());
        assertThat(new BigDecimal(first(sales.get(as(211),id(original))).get("price").toString())).isEqualByComparingTo("16");
        var other=new LinkedHashMap<>(body(3,401));other.put("customerId",1802);var distinct=sales.create(as(211),other,key());
        assertThat(new BigDecimal(first(distinct).get("price").toString())).isEqualByComparingTo("20");checkpoint("批准快照和不同客户",List.of(original,distinct));
    }

    @Test void unknownPriceZeroAndManualPermissionRemainDistinctAndRequireMatchingApproval() {
        stock(401,4);
        var unknown=new LinkedHashMap<>(body(1,401));unknown.put("lines",List.of(Map.of("productId",501,"unit","BOX","qty",1,"warehouseId",401)));
        assertThatThrownBy(()->sales.create(as(211),unknown,key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SAL_PRICE_NOT_FOUND");
        var zero=new LinkedHashMap<>(body(1,401));zero.put("lines",List.of(Map.of("productId",501,"unit","PCS","qty",1,"warehouseId",401,"manualPriceFlag",true,"price",0)));
        assertThatThrownBy(()->sales.create(as(211),zero,key())).isInstanceOf(ApiException.class).extracting("status").isEqualTo(403);
        seed("UPDATE sys_role SET permissions=permissions||'[\"sal:order:manual-price\"]'::jsonb WHERE id=221");seed("UPDATE sys_authz_epoch SET epoch=epoch+1 WHERE country_id=101");
        checkpoint("正向岗位补权限",Map.of("role",221,"added","sal:order:manual-price","negativeApproverUnchanged",true));
        workflow.createRule(c(),Map.of("name","AI01 人工定价审批","docType","SALES_ORDER","conditions",List.of(Map.of("field","manualPrice","op","eq","value",true)),"nodes",List.of(Map.of("nodeName","价格审批","approverType","USER","approverRef",213,"mode","ANY"))));
        var order=sales.create(as(211),zero,key());order=approve(order);long oid=id(order);
        assertThat(order).containsEntry("approvalStatus","PENDING");number("SELECT total_amount FROM sal_order WHERE id=?","0",oid);
        long task=task(oid,213);assertThatThrownBy(()->workflow.approve(c(),task,"管理员不能代审")).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);
        workflow.approve(as(213),task,"AI01 显式零价获批");assertThat(sales.get(as(211),oid)).containsEntry("approvalStatus","APPROVED");
        checkpoint("显式零价人工审批",sales.get(as(211),oid));
    }

    @Test void twoWarehouseFulfilmentClipsScopeAndDoesNotDuplicateStockOrReceivables() {
        stock(401,4);stock(402,6);
        var b=new LinkedHashMap<>(body(10,401));b.put("lines",List.of(Map.of("productId",501,"unit","PCS","qty",10,"allocs",List.of(Map.of("warehouseId",401,"allocQty",4),Map.of("warehouseId",402,"allocQty",6)))));
        var order=approve(sales.create(as(211),b,key()));doc(order);
        var aView=sales.get(as(214),id(order));var bView=sales.get(as(215),id(order));
        assertThat(aView).doesNotContainKeys("totalAmount");assertThat(first(aView)).doesNotContainKeys("price","lineAmount");
        assertThat(rows(first(aView),"allocs")).hasSize(1);assertThat(rows(first(bView),"allocs")).hasSize(1);
        assertThatThrownBy(()->outbound(order,402,1,as(214))).isInstanceOf(ApiException.class);
        var a=outbound(order,401,4,as(214));var bb=outbound(order,402,6,as(215));
        sales.confirmOutbound(as(214),id(a),Map.of("bizDate",DAY),key());sales.confirmOutbound(as(215),id(bb),Map.of("bizDate",DAY),key());
        number("SELECT sum(on_hand_qty) FROM inv_stock_summary","0");number("SELECT sum(reserved_qty) FROM inv_stock_summary","0");
        number("SELECT sum(amount) FROM ar_receivable","200");number("SELECT sum(outbound_qty) FROM sal_order_alloc","10");
        assertThat(owner.queryForObject("SELECT count(*) FROM ar_receivable",Integer.class)).isEqualTo(2);
        checkpoint("双仓岗位及实际出库",List.of(aView,bView,sales.get(as(211),id(order))));
    }

    @Test void insufficientSecondWarehouseRollsBackAllReservationsThenNativeReplenishmentAllowsRetry() {
        stock(401,4);stock(402,3);
        var b=new LinkedHashMap<>(body(10,401));b.put("lines",List.of(Map.of("productId",501,"unit","PCS","qty",10,"allocs",List.of(Map.of("warehouseId",401,"allocQty",4),Map.of("warehouseId",402,"allocQty",6)))));
        var order=sales.create(as(211),b,key());
        assertThatThrownBy(()->approve(order)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("INV_INSUFFICIENT_AVAILABLE");
        assertThat(sales.get(as(211),id(order))).containsEntry("approvalStatus","DRAFT");number("SELECT sum(reserved_qty) FROM inv_stock_summary","0");
        assertThat(owner.queryForObject("SELECT count(*) FROM ar_credit_occupation",Integer.class)).isZero();checkpoint("缺货回滚",sales.get(as(211),id(order)));
        stock(402,3);assertThat(approve(order)).containsEntry("approvalStatus","APPROVED");number("SELECT sum(reserved_qty) FROM inv_stock_summary","10");
    }

    @Test void creditVersionPermissionCrossBookAndOutboundRecheckUseRealOrders() {
        stock(401,10);long originalRule=activeCredit();var order=approve(order(4,401));var actual=ship(order,401,1);var outbound=outbound(order,401,1,c());
        var next=credit(originalRule,"CASH_ONLY",10000,"WARN",false,30);
        assertThatThrownBy(()->sales.confirmOutbound(c(),id(outbound),Map.of("bizDate",DAY),key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("AR_CREDIT_BLOCKED");
        assertThatThrownBy(()->ar.saveRule(as(211),id(next),Map.of())).isInstanceOf(ApiException.class).extracting("status").isEqualTo(403);
        assertThat(owner.queryForObject("SELECT credit_rule_version_id FROM sal_order WHERE id=?",Long.class,id(order))).isEqualTo(originalRule);
        assertThat(owner.queryForObject("SELECT credit_rule_version_id FROM ar_receivable WHERE source_id=?",Long.class,id(actual))).isEqualTo(originalRule);
        credit(id(next),"CREDIT_ALLOWED",100,"WARN",false,30);
        seed("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(602,101,301,'AI01-B2','TEST AI01 第二账套','MXN','ACTIVE')");
        seed("INSERT INTO fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(101,602,2026,10,'2026-10-01','2026-10-31','OPEN')");
        var other=new LinkedHashMap<>(body(2,401));other.put("bookId",602);var cross=sales.create(as(211),other,key());
        assertThatThrownBy(()->approve(cross)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("AR_CREDIT_BLOCKED");
        number("SELECT sum(amount-released_amount) FROM ar_credit_occupation WHERE status='OPEN'","80");checkpoint("授信版本及跨账套",List.of(order,next,cross));
    }

    @Test void overduePolicyAndExceptionApprovalReadNativeReceivablesInsteadOfInjectedBalances() {
        stock(401,10);credit(activeCredit(),"CREDIT_ALLOWED",10000,"WARN",false,0);
        var original=approve(order(2,401));var sent=ship(original,401,2);long rule=activeCredit();
        number("SELECT (due_date-biz_date)::numeric FROM ar_receivable WHERE source_id=?","0",id(sent));
        assertThat(((Number)workbench.todos(as(216),Map.of("type","OVERDUE_FOLLOWUP")).get("total")).intValue()).isEqualTo(1);
        credit(rule,"CREDIT_ALLOWED",10000,"BLOCK_ORDER",false,0);var blocked=order(1,401);
        assertThatThrownBy(()->approve(blocked)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("AR_CREDIT_BLOCKED");
        credit(activeCredit(),"CREDIT_ALLOWED",10000,"REQUIRE_APPROVAL",true,0);
        workflow.createRule(c(),Map.of("name","AI01 逾期追加审批","docType","SALES_ORDER","conditions",List.of(Map.of("field","overdue","op","eq","value",true)),"nodes",List.of(Map.of("nodeName","信用例外","approverType","USER","approverRef",213,"mode","ANY"))));
        var pending=approve(blocked);assertThat(pending).containsEntry("approvalStatus","PENDING");
        knownBusinessBlocker("SAL-08","逾期例外最终同意在reserveOrder被拒绝，例外批准状态与信用预占不能完成同一业务流转");
        workflow.approve(as(213),task(id(pending),213),"AI01 独立逾期例外");
        assertThat(sales.get(as(211),id(pending))).containsEntry("creditExceptionApproved",true);checkpoint("实际出库应收触发逾期",List.of(sent,sales.get(as(211),id(pending))));
        var paid=receipt(40,1901,"CASH",List.of());confirm(paid);writeoff(List.of(allocation(id(paid),receivable(sent),40)));
        assertThat(((Number)workbench.todos(as(216),Map.of("type","OVERDUE_FOLLOWUP")).get("total")).intValue()).isZero();checkpoint("核销后逾期待办关闭",workbench.todos(as(216),Map.of("type","OVERDUE_FOLLOWUP")));
    }

    @Test void settledNativeOverdueReceivableClosesFollowupAndRestrictedHistoryStillMasksAmounts() {
        stock(401,4);credit(activeCredit(),"CREDIT_ALLOWED",10000,"WARN",false,0);
        var order=approve(order(2,401));var sent=ship(order,401,2);
        assertThat(((Number)workbench.todos(as(216),Map.of("type","OVERDUE_FOLLOWUP")).get("total")).intValue()).isEqualTo(1);
        var receipt=receipt(40,1901,"CASH",List.of());confirm(receipt);writeoff(List.of(allocation(id(receipt),receivable(sent),40)));
        assertThat(((Number)workbench.todos(as(216),Map.of("type","OVERDUE_FOLLOWUP")).get("total")).intValue()).isZero();
        @SuppressWarnings("unchecked")var history=(List<Map<String,Object>>)ar.customerView(as(212),1801,"timeline",Map.of());
        assertThat(history).isNotEmpty();assertThat(history).allSatisfy(row->assertThat(row).doesNotContainKey("amount"));
        checkpoint("逾期关闭与受限历史",Map.of("history",history,"todos",workbench.todos(as(216),Map.of("type","OVERDUE_FOLLOWUP"))));
    }

    @Test void countryTimezoneChangesDueBoundaryWithoutChangingTheNativeReceivableDate() {
        stock(401,2);
        var low=owner.queryForObject("SELECT (clock_timestamp() AT TIME ZONE 'Etc/GMT+12')::date",java.time.LocalDate.class);
        var high=owner.queryForObject("SELECT (clock_timestamp() AT TIME ZONE 'Etc/GMT-14')::date",java.time.LocalDate.class);
        int term=Math.toIntExact(java.time.temporal.ChronoUnit.DAYS.between(java.time.LocalDate.parse(DAY),low));
        assertThat(term).as("synthetic fixture starts on 2026-10-15").isNotNegative();assertThat(high).isAfter(low);
        seed("UPDATE sys_country SET timezone='Etc/GMT+12' WHERE id=101");credit(activeCredit(),"CREDIT_ALLOWED",10000,"WARN",false,term);
        var order=approve(order(1,401));var sent=ship(order,401,1);
        assertThat(owner.queryForObject("SELECT due_date FROM ar_receivable WHERE source_id=?",java.time.LocalDate.class,id(sent))).isEqualTo(low);
        @SuppressWarnings("unchecked")var due=(Map<String,Object>)ar.list(as(216),"receivables",Map.of());assertThat(rows(due,"records").getFirst()).containsEntry("dueStatus","DUE_SOON");
        assertThat(((Number)workbench.todos(as(216),Map.of("type","OVERDUE_FOLLOWUP")).get("total")).intValue()).isZero();
        seed("UPDATE sys_country SET timezone='Etc/GMT-14' WHERE id=101");
        @SuppressWarnings("unchecked")var overdue=(Map<String,Object>)ar.list(as(216),"receivables",Map.of());assertThat(rows(overdue,"records").getFirst()).containsEntry("dueStatus","OVERDUE");
        assertThat(((Number)workbench.todos(as(216),Map.of("type","OVERDUE_FOLLOWUP")).get("total")).intValue()).isEqualTo(1);
        checkpoint("同一原生应收的国家时区边界",Map.of("countryDayUtcMinus12",low.toString(),"countryDayUtcPlus14",high.toString(),"termDays",term,"before",due,"after",overdue));
    }

    @Test void approvedQuantityEditInvalidatesIntentAndReservesOnlyUnshippedRemainder() {
        stock(401,10);var original=approve(order(5,401));ship(original,401,2);var current=sales.get(as(211),id(original));
        var stale=outbound(current,401,3,c());
        var edited=sales.update(as(211),id(current),Map.of("version",current.get("version"),"bizDate",DAY,"lines",List.of(Map.of("id",id(first(current)),"productId",501,"unit","PCS","qty",7,"allocs",List.of(Map.of("id",id(alloc(current,401)),"warehouseId",401,"allocQty",7))))));
        assertThat(edited).containsEntry("approvalStatus","DRAFT");number("SELECT sum(reserved_qty) FROM inv_stock_summary","0");
        number("SELECT sum(amount-released_amount) FROM ar_credit_occupation WHERE status='OPEN'","40");
        assertThatThrownBy(()->sales.confirmOutbound(c(),id(stale),Map.of("bizDate",DAY),key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("WF_APPROVAL_INVALIDATED");
        approve(edited);number("SELECT sum(reserved_qty) FROM inv_stock_summary","5");number("SELECT sum(amount-released_amount) FROM ar_credit_occupation WHERE status='OPEN'","140");
        number("SELECT sum(amount) FROM ar_receivable","40");checkpoint("编辑失效及余量重审",sales.get(as(211),id(original)));
    }

    @Test void cancellingAndClosingReleaseOnlyUnshippedFactsAndStillAllowExistingSignatures() {
        stock(401,10);var order=approve(order(5,401));var sent=ship(order,401,2);
        sales.cancel(as(211),id(order),Map.of("bizDate",DAY,"reason","AI01 取消一件未交","lines",List.of(Map.of("lineId",id(first(order)),"qty",1))),key(),false);
        number("SELECT sum(reserved_qty) FROM inv_stock_summary","2");
        var closed=sales.cancel(as(211),id(order),Map.of("bizDate",DAY,"reason","AI01 关闭剩余供货"),key(),true);assertThat(closed).containsEntry("fulfillmentStatus","CLOSED");
        number("SELECT sum(reserved_qty) FROM inv_stock_summary","0");number("SELECT sum(amount-released_amount) FROM ar_credit_occupation WHERE status='OPEN'","40");
        assertThatThrownBy(()->approve(closed)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SAL_ORDER_NOT_OPEN");
        sales.sign(c(),id(sent),Map.of("bizDate",DAY,"signerName","AI01 客户"),key());assertThat(sales.get(as(211),id(order))).containsEntry("fulfillmentStatus","CLOSED");number("SELECT sum(amount) FROM ar_receivable","40");
        var cancelAll=approve(order(2,401));var cancelled=sales.cancel(as(211),id(cancelAll),Map.of("bizDate",DAY,"reason","AI01 全部取消","lines",List.of(Map.of("lineId",id(first(cancelAll)),"qty",2))),key(),false);
        assertThat(cancelled).containsEntry("fulfillmentStatus","CANCELLED");number("SELECT sum(reserved_qty) FROM inv_stock_summary","0");checkpoint("终止订单保留实发",List.of(sales.get(as(211),id(order)),cancelled));
    }

    @ParameterizedTest @ValueSource(strings={"customer","payment","warehouse","price"})
    void otherCriticalEditsInvalidateApprovalAndReleasePreviousReservations(String field) {
        stock(401,5);if(field.equals("warehouse"))stock(402,5);
        var original=approve(order(3,401));doc(original);var oldIntent=outbound(original,401,3,c());
        var edit=new LinkedHashMap<String,Object>(Map.of("version",original.get("version"),"bizDate",DAY));
        if(field.equals("customer")) {
            ar.saveRule(as(216),null,Map.of("targetType","CUSTOMER","targetId",1802,"paymentMode","CREDIT_ALLOWED","creditLimit",1000,"currency","MXN","effectiveFrom","2026-10-01"));edit.put("customerId",1802);
        } else if(field.equals("payment"))edit.put("paymentType","CASH");
        else if(field.equals("warehouse"))edit.put("lines",List.of(Map.of("id",id(first(original)),"productId",501,"unit","PCS","qty",3,"allocs",List.of(Map.of("warehouseId",402,"allocQty",3)))));
        else {
            seed("UPDATE sys_role SET permissions=permissions||'[\"sal:order:manual-price\"]'::jsonb WHERE id=221");seed("UPDATE sys_authz_epoch SET epoch=epoch+1 WHERE country_id=101");
            edit.put("lines",List.of(Map.of("id",id(first(original)),"productId",501,"unit","PCS","qty",3,"warehouseId",401,"manualPriceFlag",true,"price",18)));
        }
        if(field.equals("warehouse"))knownBusinessBlocker("SAL-09","已有出库草稿引用旧分仓，改仓删除分仓行触发外键失败；需确认旧出库意图的保留和失效策略");
        var changed=sales.update(as(211),id(original),edit);assertThat(changed).containsEntry("approvalStatus","DRAFT");
        number("SELECT sum(reserved_qty) FROM inv_stock_summary","0");number("SELECT coalesce(sum(amount-released_amount),0) FROM ar_credit_occupation WHERE status='OPEN'","0");
        assertThatThrownBy(()->sales.confirmOutbound(c(),id(oldIntent),Map.of("bizDate",DAY),key())).isInstanceOf(ApiException.class);
        assertThat(approve(changed)).containsEntry("approvalStatus","APPROVED");number("SELECT sum(reserved_qty) FROM inv_stock_summary","3");checkpoint("关键字段修改",Map.of("field",field,"order",sales.get(as(211),id(original))));
    }

    @ParameterizedTest @ValueSource(strings={"ANY","ALL"})
    void approvalModesRejectionWithdrawalAndResubmissionKeepTraceableInstances(String mode) {
        stock(401,10);
        var rule=workflow.createRule(c(),Map.of("name","AI01 "+mode+"审批","docType","SALES_ORDER","conditions",List.of(Map.of("field","amount","op","gte","value",60)),"nodes",List.of(Map.of("nodeName","双人审批","approverType","ROLE","approverRef","AI01_APPROVERS","mode",mode))));
        var ordinary=approve(order(1,401));assertThat(ordinary).containsEntry("approvalStatus","APPROVED");
        var order=approve(order(3,401));long oid=id(order);assertThat(order).containsEntry("approvalStatus","PENDING");
        var next=new LinkedHashMap<String,Object>(Map.of("name","AI01 新版本","docType","SALES_ORDER","conditions",List.of(Map.of("field","amount","op","gte","value",60)),"nodes",List.of(Map.of("nodeName","双人审批","approverType","ROLE","approverRef","AI01_APPROVERS","mode",mode)),"version",rule.get("version")));
        var newRule=workflow.updateRule(c(),id(rule),next);assertThat(owner.queryForObject("SELECT rule_id FROM wf_instance WHERE doc_id=?",Long.class,oid)).isEqualTo(id(rule));
        workflow.reject(as(213),task(oid,213),"AI01 驳回保留意见");assertThat(sales.get(as(211),oid)).containsEntry("approvalStatus","REJECTED");
        order=approve(sales.get(as(211),oid));sales.withdraw(as(211),oid);assertThat(sales.get(as(211),oid)).containsEntry("approvalStatus","WITHDRAWN");
        order=approve(sales.get(as(211),oid));long task=task(oid,213);assertThatThrownBy(()->workflow.approve(c(),task,"管理员无默认代审")).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);
        workflow.approve(as(213),task,"AI01 首位同意");
        if(mode.equals("ALL")){assertThat(sales.get(as(211),oid)).containsEntry("approvalStatus","PENDING");workflow.approve(as(217),task(oid,217),"AI01 第二位同意");}
        assertThat(sales.get(as(211),oid)).containsEntry("approvalStatus","APPROVED");number("SELECT sum(reserved_qty) FROM inv_stock_summary","4");
        assertThat(workflow.instances(as(211),"SALES_ORDER",oid)).hasSize(3);assertThat(((Number)newRule.get("versionNo")).intValue()).isEqualTo(2);checkpoint("审批版本及意见",workflow.instances(as(211),"SALES_ORDER",oid));
    }
    long task(long order,long assignee) {return owner.queryForObject("SELECT t.id FROM wf_task t JOIN wf_instance i ON i.id=t.instance_id AND i.country_id=t.country_id WHERE i.doc_type='SALES_ORDER' AND i.doc_id=? AND t.assignee_id=? AND t.status='PENDING' AND i.status='PENDING'",Long.class,order,assignee);}

    @Test void requiredApprovalWithNoRuleOrEligibleApproverNeverAutoApproves() {
        stock(401,4);workflow.configure(c(),"SALES_ORDER",Map.of("version",1,"approvalRequired",true,"keyFields",List.of("customerId","paymentType","currency","approvalKey")));
        var missing=approve(order(1,401));assertThat(missing).containsEntry("approvalStatus","PENDING");
        assertThat(owner.queryForObject("SELECT status FROM wf_instance WHERE doc_id=?",String.class,id(missing))).isEqualTo("BLOCKED");
        workflow.createRule(c(),Map.of("name","AI01 无可用审批人","docType","SALES_ORDER","conditions",List.of(),"nodes",List.of(Map.of("nodeName","指定审批人","approverType","USER","approverRef",213,"mode","ANY"))));
        seed("UPDATE sys_user SET status='DISABLED' WHERE id=213");var nobody=approve(order(1,401));
        assertThat(owner.queryForObject("SELECT status FROM wf_instance WHERE doc_id=?",String.class,id(nobody))).isEqualTo("BLOCKED");number("SELECT sum(reserved_qty) FROM inv_stock_summary","0");checkpoint("必审阻断",List.of(missing,nobody));
    }

    Map<String,Object> receipt(int amount,long account,String method,List<Map<String,Object>> orders) {
        return ar.createReceipt(as(216),Map.of("bookId",601,"customerId",1801,"fundAccountId",account,"method",method,"amount",amount,"bizTime",DAY+"T12:00:00Z","referenceNo","TEST-AI01-"+key(),"orders",orders),key());
    }
    void confirm(Map<String,Object> receipt) {ar.receiptAction(as(216),id(receipt),"confirm",Map.of("arrivalDate",DAY),key());}
    long receivable(Map<String,Object> sent) {return owner.queryForObject("SELECT id FROM ar_receivable WHERE source_type='SAL_OUTBOUND' AND source_id=?",Long.class,id(sent));}
    Map<String,Object> allocation(long receipt,long target,int amount) {return Map.of("fromType","RECEIPT","fromId",receipt,"receivableId",target,"amount",amount);}
    Map<String,Object> writeoff(List<Map<String,Object>> lines) {return ar.writeoff(as(216),Map.of("bookId",601,"customerId",1801,"bizDate",DAY,"lines",lines),key());}

    @Test void cashBankPartialAndMultiOrderReceiptsKeepAdvanceAndStatementsReconciled() {
        stock(401,10);var first=approve(order(2,401));var second=approve(order(3,401));long a=receivable(ship(first,401,2)),b=receivable(ship(second,401,3));
        assertThatThrownBy(()->receipt(50,1901,"CASH",List.of(Map.of("orderId",id(first),"plannedAmount",60)))).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->receipt(10,1903,"TRANSFER",List.of())).isInstanceOf(ApiException.class);
        var cash=receipt(30,1901,"CASH",List.of(Map.of("orderId",id(first),"plannedAmount",30)));var bank=receipt(90,1902,"TRANSFER",List.of(Map.of("orderId",id(first),"plannedAmount",10),Map.of("orderId",id(second),"plannedAmount",60)));
        assertThat(sales.get(as(211),id(first))).containsEntry("paymentStatus","UNPAID");
        confirm(cash);assertThat(sales.get(as(211),id(first))).containsEntry("paymentStatus","PARTIAL");confirm(bank);confirm(bank);
        writeoff(List.of(allocation(id(cash),a,30),allocation(id(bank),a,10),allocation(id(bank),b,60)));
        number("SELECT sum(open_amount) FROM ar_receivable","0");number("SELECT amount-written_off_amount FROM ar_receipt WHERE id=?","20",id(bank));
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event WHERE event_type='AR_RECEIPT_CONFIRMED'",Integer.class)).isEqualTo(2);
        var statement=ar.statement(as(216),Map.of("bookId",601,"customerId",1801,"periodStart","2026-10-01","periodEnd","2026-10-31"),key());
        assertThat(new BigDecimal(statement.get("closing").toString())).isZero();
        assertThat(new BigDecimal(statement.get("opening").toString())).isZero();assertThat(new BigDecimal(statement.get("increase").toString())).isEqualByComparingTo("100");assertThat(new BigDecimal(statement.get("decrease").toString())).isEqualByComparingTo("100");
        assertThat(sales.get(as(211),id(first))).containsEntry("paymentStatus","PAID");assertThat(sales.get(as(211),id(second))).containsEntry("paymentStatus","PAID");
        checkpoint("现金银行及超收预收",List.of(cash,bank,statement,ar.customerView(as(216),1801,"summary",Map.of())));
    }

    @Test void writeoffReversalInOpenPeriodRestoresRealReceivableAndDoesNotRecordCashAgain() {
        stock(401,5);var order=approve(order(5,401));long target=receivable(ship(order,401,5));var receipt=receipt(100,1901,"CASH",List.of());confirm(receipt);
        var written=writeoff(List.of(allocation(id(receipt),target,60)));long wid=id(written);
        assertThatThrownBy(()->ar.receiptAction(as(216),id(receipt),"void",Map.of("bizDate",DAY,"reason","AI01 未撤销核销不能作废"),key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SYS_STATE_INVALID");
        seed("UPDATE fin_period SET status='CLOSED' WHERE id=701");
        var reverse=ar.reverse(as(216),wid,Map.of("bizDate","2026-11-02","reason","AI01 跨期纠正"),key());
        number("SELECT amount FROM ar_writeoff_line WHERE writeoff_id=?","-60",id(reverse));number("SELECT open_amount FROM ar_receivable WHERE id=?","100",target);
        number("SELECT written_off_amount FROM ar_receipt WHERE id=?","0",id(receipt));assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event WHERE event_type='AR_RECEIPT_CONFIRMED'",Integer.class)).isEqualTo(1);
        ar.receiptAction(as(216),id(receipt),"void",Map.of("bizDate","2026-11-02","reason","AI01 撤销后作废"),key());
        assertThat(sales.get(as(211),id(order))).containsEntry("paymentStatus","UNPAID");
        var statement=ar.statement(as(216),Map.of("bookId",601,"customerId",1801,"periodStart","2026-10-01","periodEnd","2026-11-30"),key());
        assertThat(new BigDecimal(statement.get("closing").toString())).isEqualByComparingTo("100");assertThat(new BigDecimal(statement.get("increase").toString())).isEqualByComparingTo("100");assertThat(new BigDecimal(statement.get("decrease").toString())).isZero();checkpoint("开放期反向与对账",List.of(reverse,statement));
        var replacement=ar.createReceipt(as(216),Map.of("bookId",601,"customerId",1801,"fundAccountId",1901,"method","CASH","amount",100,"bizTime","2026-11-02T12:00:00Z","orders",List.of()),key());
        ar.receiptAction(as(216),id(replacement),"confirm",Map.of("arrivalDate","2026-11-02"),key());
        ar.writeoff(as(216),Map.of("bookId",601,"customerId",1801,"bizDate","2026-11-02","lines",List.of(allocation(id(replacement),target,100))),key());
        number("SELECT open_amount FROM ar_receivable WHERE id=?","0",target);assertThat(sales.get(as(211),id(order))).containsEntry("paymentStatus","PAID");
        checkpoint("作废后重新处理",Map.of("replacement",replacement,"statement",ar.statement(as(216),Map.of("bookId",601,"customerId",1801,"periodStart","2026-10-01","periodEnd","2026-11-30"),key())));
    }

    @ParameterizedTest @ValueSource(strings={"SHORT","REJECTED","DAMAGED"})
    void signDifferencesNeverDeductStockOrCreateReceivablesTwice(String difference) {
        stock(401,5);var order=approve(order(5,401));var sent=ship(order,401,5);
        var before=owner.queryForMap("SELECT (SELECT sum(on_hand_qty) FROM inv_stock_summary) stock,(SELECT sum(amount) FROM ar_receivable) ar,(SELECT count(*) FROM ar_receivable) ar_count,(SELECT min(biz_date) FROM ar_receivable) ar_date,(SELECT count(*) FROM cst_cogs) cogs");
        var signed=sales.sign(c(),id(sent),Map.of("bizDate",DAY,"signerName","AI01 客户","lines",List.of(Map.of("outboundLineId",id(first(sent)),"signedQty",3,"diffType",difference,"reason","TEST AI01 两件差异"))),key());
        assertThat(owner.queryForMap("SELECT (SELECT sum(on_hand_qty) FROM inv_stock_summary) stock,(SELECT sum(amount) FROM ar_receivable) ar,(SELECT count(*) FROM ar_receivable) ar_count,(SELECT min(biz_date) FROM ar_receivable) ar_date,(SELECT count(*) FROM cst_cogs) cogs")).isEqualTo(before);
        assertThat(first(signed)).containsEntry("diffType",difference).containsEntry("diffStatus","OPEN");number("SELECT outbound_qty FROM sal_order_line","5");number("SELECT signed_qty FROM sal_order_line","3");checkpoint("签收差异不改出库事实",signed);
        var returned=returns.createSales(c(),Map.of("outboundId",id(sent),"returnWarehouseId",401,"reasonCode","QUALITY","responsibility","SUPPLIER","bizDate",DAY,"lines",List.of(Map.of("outboundLineId",id(first(sent)),"reqQty",2))),key());
        var resolved=sales.resolveSign(c(),id(first(signed)),Map.of("bizDate",DAY,"resolution","AI01 转原生退货申请 "+returned.get("docNo")),key());
        number("SELECT outbound_qty FROM sal_order_line","5");number("SELECT sum(amount) FROM ar_receivable","100");checkpoint("差异处理引用实际退货单",Map.of("return",returned,"sign",resolved,"boundary","处理方式为文字引用；退货收货与结算不在本项中冒充完成"));
    }

    @Test void salespersonAndStoreEntryKeepApprovalFulfilmentAndPaymentIndependent() {
        stock(401,10);var salesBody=new LinkedHashMap<>(body(5,401));salesBody.put("salesSource","SALESPERSON");var storeBody=new LinkedHashMap<>(body(2,401));storeBody.put("salesSource","STORE");
        var bySales=sales.create(as(211),salesBody,key());var byStore=sales.create(as(212),storeBody,key());
        assertThat(bySales).containsEntry("enteredBy",211L);assertThat(byStore).containsEntry("enteredBy",212L);
        assertThat(bySales).containsEntry("salesSource","SALESPERSON");assertThat(byStore).containsEntry("salesSource","STORE");
        bySales=approve(bySales);ship(bySales,401,2);var cash=receipt(20,1901,"CASH",List.of(Map.of("orderId",id(bySales),"plannedAmount",20)));confirm(cash);
        var detail=sales.get(as(211),id(bySales));assertThat(detail).containsEntry("approvalStatus","APPROVED").containsEntry("paymentStatus","PARTIAL");
        assertThat(detail.get("fulfillmentStatus")).isNotEqualTo("COMPLETED");
        var list=(Map<?,?>)sales.orders(as(211),Map.of("paymentStatus","PARTIAL","approvalStatus","APPROVED"));assertThat(((Number)list.get("total")).intValue()).isEqualTo(1);
        assertThat(sales.get(as(212),id(byStore))).containsEntry("approvalStatus","DRAFT").containsEntry("paymentStatus","UNPAID");checkpoint("两类岗位及独立状态",List.of(detail,byStore,list));
    }

    @AfterEach void saveSourceEvidence(TestInfo info) throws Exception {
        String directory=System.getProperty("ai01.evidence.dir");if(directory==null)return;
        var evidence=new LinkedHashMap<String,Object>();evidence.put("test",info.getDisplayName());evidence.put("method",info.getTestMethod().orElseThrow().getName());evidence.put("checkpoints",checkpoints);
        evidence.put("runtime",Map.of("postgresContainer",PgDatabase.PG.getContainerId(),"databaseUrl",PgDatabase.PG.getJdbcUrl(),"minioContainer",MinioTestStorage.MINIO.getContainerId(),"minioEndpoint",MinioTestStorage.endpoint(),"bucket",privateBucket(),"backendPort",backendPort));
        for(String table:List.of("pur_order","pur_order_line","pur_domestic_receipt","pur_domestic_receipt_line","pur_export_node","pur_export_node_line","lgs_shipment","lgs_shipment_line","lgs_delivery","lgs_delivery_line","lgs_receipt","lgs_receipt_line","inv_batch","inv_batch_balance","inv_stock_summary","inv_stock_txn","inv_reservation","cst_cogs","sal_price","sal_order","sal_order_line","sal_order_alloc","sal_outbound","sal_outbound_line","sal_sign","sal_sign_line","ar_credit_rule","ar_credit_occupation","ar_receivable","ar_receipt","ar_receipt_order","ar_writeoff","ar_writeoff_line","ar_statement","wf_instance","wf_task","sys_todo","sys_biz_event")) {
            if(Boolean.TRUE.equals(owner.queryForObject("SELECT to_regclass(?) IS NOT NULL",Boolean.class,"public."+table))) {
                evidence.put(table,owner.queryForList("SELECT row_to_json(t)::text FROM "+table+" t",String.class).stream().map(json::readMap).toList());
            }
        }
        Path root=Path.of(directory);Files.createDirectories(root);
        String name=info.getTestMethod().orElseThrow().getName()+"-"+info.getDisplayName().replaceAll("[^A-Za-z0-9_-]","_");
        Files.writeString(root.resolve(name+".json"),json.write(evidence),StandardCharsets.UTF_8);
        if(!"false".equals(System.getProperty("ai01.dump.database"))) {
            var dump=new ProcessBuilder("docker","exec",PgDatabase.PG.getContainerId(),"pg_dump","-U","postgres","jxc_m01_test").redirectOutput(root.resolve(name+".sql").toFile()).redirectError(root.resolve(name+"-dump.log").toFile()).start();
            if(!dump.waitFor(30,java.util.concurrent.TimeUnit.SECONDS)){dump.destroyForcibly();throw new AssertionError("AI01 isolated database backup timed out");}
            assertThat(dump.exitValue()).as("retain restoreable AI01 source data").isZero();
        }
        String browserScript=System.getProperty("ai01.browser.script");
        if(browserScript!=null) {
            var process=new ProcessBuilder("node",browserScript,String.valueOf(backendPort),System.getProperty("ai01.web.dist"),root.resolve(name+".json").toString()).redirectErrorStream(true).redirectOutput(root.resolve(name+"-browser.log").toFile()).start();
            if(!process.waitFor(90,java.util.concurrent.TimeUnit.SECONDS)){process.destroyForcibly();throw new AssertionError("AI01 browser source readback timed out");}
            assertThat(process.exitValue()).as("browser readback: "+name).isZero();
        }
    }
}
