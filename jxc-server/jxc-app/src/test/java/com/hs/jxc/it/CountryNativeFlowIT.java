package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sal.SalesService;
import com.hs.jxc.ar.ReceivablesService;
import com.hs.jxc.rtn.ReturnsService;
import com.hs.jxc.workflow.service.WorkflowService;
import com.hs.jxc.attachment.AttachmentService;
import com.hs.jxc.cst.service.CostValuationService;
import com.hs.jxc.ap.*;
import com.hs.jxc.fin.ledger.LedgerService;
import com.hs.jxc.fin.accounting.AccountingService;
import com.hs.jxc.fin.report.ReportService;
import com.hs.jxc.fin.closing.ClosingService;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.*;
import org.springframework.test.context.*;

/** Country parameters applied to native commands; no SQL-created inventory, AR, AP or vouchers. */
class CountryNativeFlowIT extends SupplyFixtures {
    @Autowired SalesService sales;
    @Autowired ReceivablesService ar;
    @Autowired ReturnsService returns;
    @Autowired WorkflowService workflow;
    @Autowired AttachmentService attachments;
    @Autowired CostValuationService valuation;
    @Autowired com.hs.jxc.inv.service.InventoryClassification classification;
    @Autowired PayablesService ap;
    @Autowired CostPayableBasisService basis;
    @Autowired LedgerService ledger;
    @Autowired AccountingService accounting;
    @Autowired ReportService reports;
    @Autowired ClosingService closing;
    @Autowired com.hs.jxc.sys.service.CountryConfigurationService countries;
    @Autowired com.hs.jxc.sys.service.DocumentNumberService numbering;
    @Autowired com.hs.jxc.sys.imports.ImportService imports;
    @Autowired com.hs.jxc.sys.jobs.JobApi jobs;
    @Autowired JsonCodec json;
    @Value("${local.server.port}") int port;
    @DynamicPropertySource static void storage(DynamicPropertyRegistry r) {
        r.add("jxc.storage.endpoint", MinioTestStorage::endpoint);
        r.add("jxc.storage.access-key", () -> MinioTestStorage.ACCESS);
        r.add("jxc.storage.secret-key", () -> MinioTestStorage.SECRET);
        r.add("jxc.storage.bucket", () -> MinioTestStorage.BUCKET);
    }
    record Local(long country,long entity,long warehouse,long book,long period,long operator,long auditor,
                 long supplier,long carrier,long customer,long fund,String currency,String rate) {}
    final Local mx=new Local(101,301,401,601,701,201,211,801,802,1801,1901,"MXN","2.5");
    final Local cn=new Local(102,302,403,602,702,221,231,1802,1803,1804,1902,"CNY","1");
    String testCase;
    RequestContext actor(Local p){return actor(p,p.operator());}
    RequestContext actor(Local p,long user){return new RequestContext(user,p.country(),"AI08-native",com.hs.jxc.sys.service.SessionService.digest("AI08-"+user));}

    @BeforeEach void localConfiguration(TestInfo info) {
        testCase=info.getDisplayName().replaceAll("[^a-zA-Z0-9-]","_");
        // Only identities, permissions and explicitly declared local master/configuration data are seeded.
        seed("insert into sys_country(id,code,name,default_currency,timezone,status) values(102,'CN','AI08 China','CNY','Asia/Shanghai','ACTIVE')");
        seed("insert into sys_authz_epoch(country_id) values(102)");
        seed("insert into org_entity(id,country_id,code,name) values(302,102,'AI08-E','AI08 China entity')");
        seed("insert into org_warehouse(id,country_id,entity_id,code,name) values(403,102,302,'AI08-W','AI08 China warehouse')");
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,102,302,'AI08-B','AI08 China book','CNY','ACTIVE')");
        seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(702,102,602,2026,10,'2026-10-01','2026-10-31','OPEN')");
        seed("insert into md_country_sku(country_id,product_id) values(102,501)");
        seed("insert into md_supplier(id,country_id,code,name,settle_currency) values(1802,102,'AI08-S','AI08 China supplier','CNY')");
        seed("insert into md_logistics_provider(id,country_id,code,name,settle_currency) values(1803,102,'AI08-L','AI08 China carrier','CNY')");
        seed("insert into cst_method_config(country_id,book_id,method,effective_from) values(102,602,'FIFO','2026-10-01')");
        seed("insert into wf_doc_type_config(country_id,doc_type,approval_required,key_fields) values(102,'PURCHASE_ORDER',false,'[]')");
        NumberFixtures.seed(102,"AP_BILL","FIN_VOUCHER","PURCHASE_ORDER","DOMESTIC_RECEIPT","EXPORT_NODE","SHIPMENT","DELIVERY","LGS_RECEIPT","DISCREPANCY","SALES_ORDER","SAL_OUTBOUND","AR_RECEIVABLE","AR_RECEIPT","AR_WRITEOFF","AR_CREDIT_NOTE","RTN_SALES","RTN_REFUND");
        var permissions=new TreeSet<String>();
        for(var module:com.hs.jxc.sys.service.PermissionCatalog.tree())for(Object child:(List<?>)module.get("children")){
            String code=String.valueOf(((Map<?,?>)child).get("code"));
            if(List.of("pur:","lgs:","sal:","ar:","rtn:","fin:","cst:","md:","wf:","sys:attachment:").stream().anyMatch(code::startsWith))permissions.add(code);
        }
        permissions.addAll(List.of("sys:import:customer","sys:import:confirm","ai:analysis:use","ap:bill:view","ap:bill:create","ap:bill:confirm","inv:classify:config"));
        for(Local p:List.of(mx,cn)) {
            long role=p.country()+7000;
            seed("insert into sys_role(id,country_id,code,name,permissions,field_policies) values(?,?,'AI08-BUSINESS','AI08 local business',?::jsonb,?::jsonb)",role,p.country(),json.write(permissions),json.write(Map.of("COST","WRITE","CUSTOMER_PRICE","WRITE","ORDER_TOTAL","WRITE","BANK_INFO","WRITE","CREDIT","WRITE","PROFIT","WRITE")));
            for(long user:List.of(p.operator(),p.auditor())) {
                if(user!=201)seed("insert into sys_user(id,username,password_hash,display_name) values(?,?,'unused',?)",user,"AI08-"+user,"AI08 local "+user);
                seed("insert into sys_session(token_hash,user_id,expires_at) values(?,?,clock_timestamp()+interval '1 hour')",com.hs.jxc.sys.service.SessionService.digest("AI08-"+user),user);
                seed("insert into sys_user_role(country_id,user_id,role_id) values(?,?,?)",p.country(),user,role);
                if(user!=201)seed("insert into sys_user_data_scope(country_id,user_id,scope_type,granted_by) values(?,?,'COUNTRY_ALL',?)",p.country(),user,p.operator());
            }
            seed("insert into md_customer(id,country_id,code,name) values(?,?,'AI08-C','AI08 local customer')",p.customer(),p.country());
            seed("insert into md_fund_account(id,country_id,entity_id,book_id,name,account_type,currency) values(?,?,?,?,'AI08 local cash','CASH',?)",p.fund(),p.country(),p.entity(),p.book(),p.currency());
            seed("insert into ar_credit_rule(country_id,target_type,target_id,payment_mode,credit_limit,currency,effective_from) values(?,'CUSTOMER',?,'CREDIT_ALLOWED',1000,?,'2026-01-01')",p.country(),p.customer(),p.currency());
            seed("insert into sal_price(country_id,product_id,price_type,unit,min_qty,price,currency,effective_from) values(?,501,'BASE','PCS',1,20,?,'2026-01-01')",p.country(),p.currency());
            seed("insert into wf_doc_type_config(country_id,doc_type,approval_required,key_fields) values(?,'SALES_ORDER',false,'[]')",p.country());
            if(p==mx)for(String scope:List.of("PURCHASE_COST","SETTLEMENT"))seed("insert into md_exchange_rate(country_id,from_ccy,to_ccy,rate_date,scope,rate,status,confirmed_by,confirmed_at) values(101,'CNY','MXN','2026-10-15',?,2.5,'CONFIRMED',201,clock_timestamp())",scope);
        }
        // Remove the old positive fixture wildcard; negative tests keep all country boundaries enabled.
        seed("delete from sys_user_role where country_id=101 and user_id=201 and role_id=202");
    }

    Map<String,Object> receive(Local p)throws Exception {
        var c=actor(p);
        var po=pur.create(c,"orders",Map.of("bookId",p.book(),"entityId",p.entity(),"supplierId",p.supplier(),"currency","CNY","orderDate","2026-10-15","submit",true,"lines",List.of(Map.of("productId",501,"unit","BOX","qty",10,"unitPrice",10))),key());
        var dr=pur.create(c,"domestic-receipts",Map.of("orderId",id(po),"receiptDate","2026-10-15","confirm",true,"lines",List.of(Map.of("orderLineId",id(first(po)),"qualifiedQty",20))),key());
        var ex=pur.create(c,"export-nodes",Map.of("exportDate","2026-10-15","confirm",true,"declarationNo","AI08-TEST","lines",List.of(Map.of("receiptLineId",id(first(dr)),"qty",20))),key());
        assertThat(owner.queryForObject("select count(*) from inv_stock_txn where country_id=?",Integer.class,p.country())).as("domestic/export nodes do not create destination inventory").isZero();
        var sh=lgs.create(c,"shipments",Map.of("bookId",p.book(),"destWarehouseId",p.warehouse(),"carrierId",p.carrier(),"transportMode","AIR","flightNo","AI08","awbNo","AI08-TEST","bizDate","2026-10-15","submit",true,"lines",List.of(Map.of("sourceLineId",id(first(ex)),"baseQty",10))),key());
        lgs.action(c,"shipments",id(sh),"dispatch",Map.of("actualEtd","2026-10-15T00:00:00Z"),key());
        for(String node:List.of("ARRIVED_PORT","CUSTOMS_RELEASED"))lgs.action(c,"shipments",id(sh),"nodes",Map.of("nodeType",node,"actualAt","2026-10-15T02:00:00Z"),key());
        var delivery=lgs.create(c,"deliveries",Map.of("shipmentId",id(sh),"bizDate","2026-10-15","dispatch",true,"lines",List.of(Map.of("shipmentLineId",id(first(sh)),"dispatchQty",10))),key());
        var receipt=lgs.create(c,"receipts",Map.of("deliveryId",id(delivery),"bizDate","2026-10-15","lines",List.of(Map.of("deliveryLineId",id(first(delivery)),"goodQty",7,"damagedQty",1,"pendingInspectQty",1,"shortQty",1))),key());
        var source=new LinkedHashMap<String,Object>();
        source.put("purchaseOrder",po);source.put("domesticReceipt",dr);source.put("export",ex);source.put("shipment",sh);source.put("delivery",delivery);source.put("receipt",receipt);
        evidence("receipt-draft-"+testCase+"-"+p.country(),source);
        assertThat(owner.queryForObject("select count(*) from inv_stock_txn where country_id=?",Integer.class,p.country())).as("dispatch and delivery do not create destination inventory").isZero();
        String confirmKey=key();
        lgs.action(c,"receipts",id(receipt),"confirm",Map.of(),confirmKey);
        lgs.action(c,"receipts",id(receipt),"confirm",Map.of(),confirmKey);
        source.put("batch",owner.queryForMap("select * from inv_batch where country_id=? order by id desc limit 1",p.country()));
        assertThat(owner.queryForObject("select on_hand_qty from inv_stock_summary where country_id=?",BigDecimal.class,p.country())).isEqualByComparingTo("9");
        assertThat(owner.queryForObject("select source_line_id from inv_batch where country_id=?",Long.class,p.country())).isEqualTo(id(first(receipt)));
        assertThat(owner.queryForObject("select count(*) from inv_batch where country_id=?",Integer.class,p.country())).isEqualTo(1);
        evidence("receipt-confirmed-"+testCase+"-"+p.country(),source);
        return source;
    }

    @ParameterizedTest @ValueSource(longs={101,102})
    void nativeSourceThroughRefundAndPostedVoucherUsesLocalParametersWithoutChangingOtherCountry(long country)throws Exception {
        nativeFlow(country,"parameterized");
    }
    Map<String,Object> nativeFlow(long country,String scenario)throws Exception {
        Local p=country==101?mx:cn,other=country==101?cn:mx;
        receive(other);String before=fingerprint(other.country());
        var source=receive(p);var c=actor(p);
        var order=sales.create(c,Map.of("bookId",p.book(),"entityId",p.entity(),"customerId",p.customer(),"orderDate","2026-10-15","paymentType","CREDIT","lines",List.of(Map.of("productId",501,"unit","PCS","qty",3,"allocs",List.of(Map.of("warehouseId",p.warehouse(),"allocQty",3))))),key());
        order=sales.submit(c,id(order),Map.of("bizDate","2026-10-15"),key());
        assertThat(creditOccupation(country)).isEqualByComparingTo("60");
        assertThat(owner.queryForObject("select count(*) from ar_receivable where country_id=?",Integer.class,country)).isZero();
        long alloc=((Number)((Map<?,?>)((List<?>)first(order).get("allocs")).getFirst()).get("id")).longValue();
        var out=sales.createOutbound(c,Map.of("orderId",id(order),"warehouseId",p.warehouse(),"bizDate","2026-10-15","lines",List.of(Map.of("allocId",alloc,"qty",2))),key());
        long outboundId=id(out);
        assertThatThrownBy(()->sales.confirmOutbound(c,outboundId,Map.of("bizDate","2026-10-15"),key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SAL_ATTACHMENT_MISSING");
        assertThat(owner.queryForObject("select count(*) from ar_receivable where country_id=?",Integer.class,country)).isZero();
        attachments.upload(c,"SAL_ORDER",id(order),"SALES_DOC","AI08-sale.txt","text/plain","AI08 native sale".getBytes(StandardCharsets.UTF_8));
        out=sales.confirmOutbound(c,id(out),Map.of("bizDate","2026-10-15"),key());long receivable=((Number)out.get("receivableId")).longValue();
        assertThat(creditOccupation(country)).as("partial outbound converts reservation into AR without double counting").isEqualByComparingTo("60");
        assertThat(owner.queryForObject("select source_id from ar_receivable where id=?",Long.class,receivable)).isEqualTo(id(out));
        assertThat(owner.queryForMap("select approval_qty,consumed_qty,released_qty from inv_reservation where country_id=?",country)).containsEntry("approval_qty",new BigDecimal("3.0000")).containsEntry("consumed_qty",new BigDecimal("2.0000")).containsEntry("released_qty",new BigDecimal("0.0000"));
        sales.cancel(c,id(order),Map.of("bizDate","2026-10-15","reason","AI08 close remaining one unit after partial shipment"),key(),true);
        assertThat(owner.queryForObject("select released_qty from inv_reservation where country_id=?",BigDecimal.class,country)).isEqualByComparingTo("1");
        assertThat(creditOccupation(country)).isEqualByComparingTo("40");
        var receipt=ar.createReceipt(c,Map.of("customerId",p.customer(),"fundAccountId",p.fund(),"method","CASH","amount",50,"bizTime","2026-10-15T12:00:00Z","orders",List.of(Map.of("orderId",id(order),"plannedAmount",50))),key());
        ar.receiptAction(c,id(receipt),"confirm",Map.of("arrivalDate","2026-10-15"),key());
        ar.writeoff(c,Map.of("customerId",p.customer(),"bizDate","2026-10-15","lines",List.of(Map.of("fromType","RECEIPT","fromId",id(receipt),"receivableId",receivable,"amount",40))),key());
        assertThat(creditOccupation(country)).isZero();
        for(String type:List.of("SALES_RETURN","REFUND"))workflow.createRule(c,Map.of("docType",type,"name","AI08 "+type,"conditions",List.of(),"nodes",List.of(Map.of("nodeName","Local auditor","approverType","USER","approverRef",p.auditor(),"mode","ANY"))));
        var returned=returns.createSales(c,Map.of("outboundId",id(out),"returnWarehouseId",p.warehouse(),"reasonCode","QUALITY","responsibility","SUPPLIER","bizDate","2026-10-15","submit",true,"lines",List.of(Map.of("outboundLineId",id(first(out)),"reqQty",1))),key());
        approve(p,"SALES_RETURN",id(returned));returned=returns.get(c,"sales",id(returned));long line=id(first(returned));
        returns.receive(c,id(returned),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("id",line,"receivedQty",1))),key());
        returns.inspect(c,id(returned),Map.of("bizDate","2026-10-15","lines",List.of(Map.of("id",line,"goodQty",1,"frozenQty",0))),key());
        returns.settleSales(c,id(returned),Map.of("bizDate","2026-10-15"),key());
        var refund=returns.createRefund(c,Map.of("bookId",p.book(),"customerId",p.customer(),"amount",20,"currency",p.currency(),"fundAccountId",p.fund(),"method","CASH","payeeInfo",Map.of("name","AI08 TEST customer"),"bizDate","2026-10-15"),key());
        approve(p,"REFUND",id(refund));attachments.upload(c,"REFUND",id(refund),"REFUND_PROOF","AI08-refund.txt","text/plain","AI08 synthetic refund proof".getBytes(StandardCharsets.UTF_8));
        String paidKey=key();var paidBody=Map.<String,Object>of("paidAt","2026-10-15","referenceNo","AI08-TEST-"+country);
        returns.payRefund(c,id(refund),paidBody,paidKey);returns.payRefund(c,id(refund),paidBody,paidKey);
        assertThat(owner.queryForObject("select count(*) from sys_biz_event where country_id=? and event_type='RTN_REFUND_PAID'",Integer.class,country)).isEqualTo(1);
        assertThat(owner.queryForMap("select on_hand_qty,reserved_qty,frozen_qty from inv_stock_summary where country_id=?",country)).containsEntry("on_hand_qty",new BigDecimal("8.0000")).containsEntry("reserved_qty",new BigDecimal("0.0000")).containsEntry("frozen_qty",new BigDecimal("2.0000"));
        assertThat(owner.queryForMap("select amount,open_amount,currency from ar_receivable where id=?",receivable)).containsEntry("amount",new BigDecimal("40.0000")).containsEntry("open_amount",new BigDecimal("0.0000")).containsEntry("currency",p.currency());
        assertThat(owner.queryForObject("select used_amount from ar_credit_note where country_id=? and refundable_flag",BigDecimal.class,country)).isEqualByComparingTo("20");
        long cost=owner.queryForObject("select id from cst_inbound_cost where country_id=? and source_type='LGS_RECEIPT'",Long.class,country);valuation.confirm(c,cost,Map.of("bizDate","2026-10-15"),key());
        var po=(Map<String,Object>)source.get("purchaseOrder");
        var bill=ap.createBill(c,Map.of("billDate","2026-10-15","sources",List.of(Map.of("sourceType","PUR_ORDER_LINE","sourceId",id(first(po)),"qty",new BigDecimal("4.5")))),key());
        bill=ap.confirmBill(c,id(bill),Map.of("version",bill.get("version")),key());
        basis.save(c,cost,Map.of("version",0,"lines",List.of(Map.of("billLineId",id(first(bill)),"baseQty",9))),key());
        assertThat(new BigDecimal(bill.get("baseAmount").toString())).isEqualByComparingTo(new BigDecimal("45").multiply(new BigDecimal(p.rate())));
        assertThat(owner.queryForObject("select sum(amount) from cst_cogs where country_id=?",BigDecimal.class,country)).isEqualByComparingTo(new BigDecimal("5").multiply(new BigDecimal(p.rate())));
        postSale(p,id(out));
        var cashOrder=sales.create(c,Map.of("bookId",p.book(),"entityId",p.entity(),"customerId",p.customer(),"orderDate","2026-10-15","paymentType","CASH","lines",List.of(Map.of("productId",501,"unit","PCS","qty",1,"allocs",List.of(Map.of("warehouseId",p.warehouse(),"allocQty",1))))),key());
        cashOrder=sales.submit(c,id(cashOrder),Map.of("bizDate","2026-10-15"),key());
        attachments.upload(c,"SAL_ORDER",id(cashOrder),"SALES_DOC","AI08-cash.txt","text/plain","AI08 native cash sale".getBytes(StandardCharsets.UTF_8));
        long cashAlloc=((Number)((Map<?,?>)((List<?>)first(cashOrder).get("allocs")).getFirst()).get("id")).longValue();
        var cashDraft=sales.createOutbound(c,Map.of("orderId",id(cashOrder),"warehouseId",p.warehouse(),"bizDate","2026-10-15","lines",List.of(Map.of("allocId",cashAlloc,"qty",1))),key());
        assertThatThrownBy(()->sales.confirmOutbound(c,id(cashDraft),Map.of("bizDate","2026-10-15"),key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SAL_PAYMENT_NOT_CONFIRMED");
        var cashReceipt=ar.createReceipt(c,Map.of("bookId",p.book(),"customerId",p.customer(),"fundAccountId",p.fund(),"method","CASH","amount",20,"bizTime","2026-10-15T12:00:00Z","orders",List.of(Map.of("orderId",id(cashOrder),"plannedAmount",20))),key());
        ar.receiptAction(c,id(cashReceipt),"confirm",Map.of("arrivalDate","2026-10-15"),key());
        var cashOut=sales.confirmOutbound(c,id(cashDraft),Map.of("bizDate","2026-10-15"),key());
        assertThat(owner.queryForObject("select open_amount from ar_receivable where id=?",BigDecimal.class,((Number)cashOut.get("receivableId")).longValue())).isZero();
        assertThat(owner.queryForObject("select on_hand_qty from inv_stock_summary where country_id=?",BigDecimal.class,country)).isEqualByComparingTo("7");
        var oldPrice=owner.queryForMap("select id,version from sal_price where country_id=? and status='ACTIVE'",country);
        var nextPrice=sales.savePrice(c,((Number)oldPrice.get("id")).longValue(),Map.of("version",oldPrice.get("version"),"price",23),key());
        assertThat(new BigDecimal(first(sales.get(c,id(order))).get("price").toString())).as("approved historical line keeps its original price after a local price version change").isEqualByComparingTo("20");
        for(String type:List.of("BALANCE_SHEET","INCOME")) {
            var template=reports.save(c,p.book(),null,Map.of("bookId",p.book(),"reportType",type,"name","AI08 native "+type,"rule","CATEGORY_V1"),key());
            reports.review(actor(p,p.auditor()),p.book(),id(template),Map.of("bookId",p.book(),"version",template.get("version")),key());
        }
        var income=reports.report(c,p.book(),p.period(),"INCOME");
        assertThat(income).containsEntry("currency",p.currency()).containsEntry("available",true).containsEntry("source","LIVE");
        assertThat((List<Map<String,Object>>)income.get("lines")).anySatisfy(row->{assertThat(row.get("code")).isEqualTo("REVENUE");assertThat(new BigDecimal(row.get("amount").toString())).isEqualByComparingTo("40");});
        // Only the first sale is posted here: remaining native events must block current-period close.
        var closeCheck=closing.check(c,p.period(),Map.of("bookId",p.book()),key());
        assertThat(closeCheck.get("canClose")).isEqualTo(false);
        assertThat((List<Map<String,Object>>)closeCheck.get("checks")).anySatisfy(row->assertThat(row).containsEntry("checkCode","EVENTS_OPEN").containsEntry("result","FAIL"));
        assertThatThrownBy(()->closing.close(c,p.period(),Map.of("bookId",p.book()),key())).isInstanceOf(ApiException.class).extracting("code").isEqualTo("FIN_CLOSE_BLOCKED");
        source.put("order",sales.get(c,id(order)));source.put("outbound",out);source.put("receivableId",receivable);source.put("customerReceipt",receipt);source.put("returnId",id(returned));source.put("refund",refund);source.put("bill",bill);
        source.put("postedLedgerIncome",income);source.put("currentPeriodCloseCheck",closeCheck);
        source.put("cashOrder",cashOrder);source.put("cashReceipt",cashReceipt);source.put("cashOutbound",cashOut);
        source.put("newLocalPriceVersion",nextPrice);
        source.put("testRole",owner.queryForList("select id,country_id,role_type,permissions,field_policies from sys_role where country_id=? and code='AI08-BUSINESS'",country));
        source.put("testScopes",owner.queryForList("select user_id,scope_type,book_id,warehouse_id,store_id from sys_user_data_scope where country_id=? order by user_id,id",country));
        source.put("events",owner.queryForList("select id,event_type,source_type,source_id,biz_date,payload from sys_biz_event where country_id=? order by id",country));
        source.put("stock",owner.queryForMap("select * from inv_stock_summary where country_id=?",country));
        source.put("vouchers",owner.queryForList("select * from fin_voucher where country_id=? order by id",country));
        source.put("otherCountryBefore",before);source.put("otherCountryAfter",fingerprint(other.country()));
        evidence("native-"+country+"-"+scenario,source);
        assertThat(fingerprint(other.country())).as("other country's populated facts, balances, classification and periods").isEqualTo(before);
        assertThat(owner.queryForObject("select count(*) from sys_user where is_platform_admin",Integer.class)).isZero();
        if("parameterized".equals(scenario))pageCheck("native-"+country+"-"+scenario,country,p.operator());
        return source;
    }

    void approve(Local p,String type,long doc) {
        long task=owner.queryForObject("select t.id from wf_task t join wf_instance i on i.country_id=t.country_id and i.id=t.instance_id where i.country_id=? and i.doc_type=? and i.doc_id=? and t.status='PENDING'",Long.class,p.country(),type,doc);
        workflow.approve(actor(p,p.auditor()),task,"AI08 local independent review");
    }
    void postSale(Local p,long outbound) {
        long debit=id(ledger.configure(actor(p),p.book(),"accounts",null,"POST",Map.of("code","1122","name","AI08 AR","category","ASSET","direction","DEBIT"),key()));
        long credit=id(ledger.configure(actor(p),p.book(),"accounts",null,"POST",Map.of("code","5001","name","AI08 Revenue","category","INCOME","direction","CREDIT"),key()));
        var lines=List.of(Map.of("direction","DEBIT","accountRule",Map.of("type","FIXED","accountId",debit),"amountExpr","amountExclTax"),Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","accountId",credit),"amountExpr","amountExclTax"));
        var mapping=accounting.saveMapping(actor(p),null,Map.of("bookId",p.book(),"eventType","SAL_OUTBOUND_CONFIRMED","lines",lines),key());
        accounting.review(actor(p,p.auditor()),id(mapping),Map.of("version",mapping.get("version")),key());
        long event=owner.queryForObject("select id from sys_biz_event where country_id=? and event_type='SAL_OUTBOUND_CONFIRMED' and source_id=?",Long.class,p.country(),outbound);
        String generateKey=key();var generated=accounting.generate(actor(p),event,generateKey);long voucher=((Number)generated.get("voucherId")).longValue();
        assertThat(accounting.generate(actor(p),event,generateKey).get("voucherId")).isEqualTo(generated.get("voucherId"));
        assertThat(owner.queryForObject("select count(*) from fin_voucher where country_id=? and source_event_id=?",Integer.class,p.country(),event)).isEqualTo(1);
        var v=ledger.voucherGet(actor(p),p.book(),voucher);v=ledger.action(actor(p,p.auditor()),p.book(),voucher,"audit",Map.of("version",v.get("version")),key());
        ledger.action(actor(p),p.book(),voucher,"post",Map.of("version",v.get("version")),key());
        assertThat(owner.queryForObject("select status from fin_voucher where id=?",String.class,voucher)).isEqualTo("POSTED");
        assertThat(owner.queryForObject("select total_debit from fin_voucher where id=?",BigDecimal.class,voucher)).isEqualByComparingTo("40");
        assertThat(owner.queryForObject("select total_credit from fin_voucher where id=?",BigDecimal.class,voucher)).isEqualByComparingTo("40");
        var posted=owner.queryForMap("select * from fin_voucher where id=?",voucher);
        var postedLines=owner.queryForList("select * from fin_voucher_line where voucher_id=? order by id",voucher);
        var next=accounting.saveMapping(actor(p),null,Map.of("bookId",p.book(),"eventType","SAL_OUTBOUND_CONFIRMED","lines",lines),key());
        accounting.review(actor(p,p.auditor()),id(next),Map.of("version",next.get("version")),key());
        assertThat(owner.queryForMap("select * from fin_voucher where id=?",voucher)).isEqualTo(posted);
        assertThat(owner.queryForList("select * from fin_voucher_line where voucher_id=? order by id",voucher)).isEqualTo(postedLines);
    }

    @Test void knownOtherCountryIdsHeadersAttachmentsAndReportsCannotExposeBusinessFacts()throws Exception {
        var target=receive(cn);var po=(Map<String,Object>)target.get("purchaseOrder");
        var attachment=attachments.upload(actor(cn),"PURCHASE_ORDER",id(po),"PURCHASE_DOC","AI08-secret.txt","text/plain","AI08 CN private fact 137.29".getBytes(StandardCharsets.UTF_8));
        String download=attachments.url(actor(cn),id(attachment)).get("url");
        assertThat(download).startsWith("/api/v1/");
        var imported=imports.create(actor(cn),Map.of("importType","CUSTOMER","rows",List.of(Map.of("code","AI08-IMPORT","name","AI08 China private import"))));
        assertThat(imported.get("status")).isEqualTo("VALIDATED");
        var export=jobs.enqueue(actor(cn),"FIN_LEDGER_EXPORT",602,Map.of("periodId",702,"type","general"),key());
        jobs.run(102,id(export));
        assertThat(owner.queryForObject("select count(*) from sys_job_result where country_id=102 and job_id=?",Integer.class,id(export))).isEqualTo(1);
        var results=new ArrayList<Map<String,Object>>();
        for(String path:List.of("/pur/orders/"+id(po),"/sys/attachments/"+id(attachment)+"/url",download.substring("/api/v1".length()),"/fin/reports/INCOME?bookId=602&periodId=702","/sys/imports/"+id(imported),"/sys/imports/"+id(imported)+"/errors","/sys/jobs/"+id(export),"/sys/jobs/"+id(export)+"/download")){
            var r=call(mx,"GET",path,null);assertThat(r.statusCode()).as(path+" "+r.body()).isIn(403,404);assertThat(r.body()).doesNotContain("137.29","AI08 CN private fact","totalAmount");results.add(Map.of("path",path,"status",r.statusCode(),"body",r.body()));
        }
        var cross=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1/pur/orders/"+id(po))).header("Authorization","Bearer AI08-201").header("X-Country-Id","102").GET().build();
        var denied=HttpClient.newHttpClient().send(cross,HttpResponse.BodyHandlers.ofString());assertThat(denied.statusCode()).isEqualTo(403);
        var list=call(mx,"GET","/pur/orders?keyword="+po.get("docNo"),null);assertThat(list.statusCode()).isEqualTo(200);assertThat(list.body()).doesNotContain(po.get("docNo").toString());
        assertThat(inCountry(101,()->jdbc.queryForObject("select count(*) from pur_order where id=?",Integer.class,id(po)))).isZero();
        var forged=new LinkedHashMap<String,Object>(Map.of("bookId",602,"entityId",302,"supplierId",1802,"orderDate","2026-10-15","lines",List.of(Map.of("productId",501,"unit","PCS","qty",1,"unitPrice",1))));
        assertThat(call(mx,"POST","/pur/orders",forged).statusCode()).isIn(403,404);
        var ai=call(mx,"POST","/ai/analysis",Map.of("bookId",602,"periodId",702));
        assertThat(ai.statusCode()).as(ai.body()).isIn(403,404);
        assertThat(ai.body()).doesNotContain("grossProfit","contributionProfit","137.29");
        evidence("country-denials",Map.of("responses",results,"changedHeaderStatus",denied.statusCode(),"nativeSource",target,"importBatchId",id(imported),"exportJobId",id(export),"aiStatus",ai.statusCode(),"aiBody",ai.body()));
    }

    @Test void cloneOfPopulatedSourceExcludesFactsAndRequiresLocalAdministratorReview()throws Exception {
        var nativeSource=nativeFlow(101,"clone-source");String before=fingerprint(101);
        seed("insert into sys_user(id,username,password_hash,display_name,is_platform_admin) values(900,'AI08-platform','unused','AI08 platform',true)");
        seed("insert into sys_session(token_hash,user_id,expires_at) values(?,900,clock_timestamp()+interval '1 hour')",com.hs.jxc.sys.service.SessionService.digest("AI08-900"));
        var platform=new RequestContext(900,null,"AI08-template",com.hs.jxc.sys.service.SessionService.digest("AI08-900"));
        var template=countries.createTemplate(platform,Map.of("sourceCountryId",101,"changeNote","AI08 populated source configuration snapshot"));
        countries.publish(platform,id(template));
        var job=countries.createClone(platform,Map.of("templateId",id(template),"targetCode","CO","targetName","AI08 clone test","isTest",true));
        long target=id((Map<String,Object>)job.get("targetCountry")),jobId=id(job);
        assertThatThrownBy(()->countries.createClone(actor(mx),Map.of("templateId",id(template),"targetCode","BR","targetName","AI08 forbidden"))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(403);
        var targetCountry=(Map<String,Object>)job.get("targetCountry");
        countries.params(platform,target,Map.of("version",targetCountry.get("version"),"name","AI08 clone test","defaultCurrency","CNY","timezone","Asia/Shanghai","locale","zh-CN","enabledModules",List.of("sys","org"),"isTest",true));
        countries.cloneOrg(platform,jobId,Map.of("entity",Map.of("code","AI08-CO-E","name","AI08 local entity"),"warehouse",Map.of("code","AI08-CO-W","name","AI08 local warehouse"),"book",Map.of("code","AI08-CO-B","name","AI08 local book")));
        var preview=countries.preview(platform,jobId);
        assertThat(preview.get("excluded").toString()).contains("operational-data","people-banks");
        assertThat(owner.queryForObject("select count(*) from sys_user_role where country_id=?",Integer.class,target)).isZero();
        countries.cloneAdmin(platform,jobId,Map.of("userIds",List.of(221)));
        countries.apply(platform,jobId);
        assertThatThrownBy(()->countries.activate(platform,target)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SYS_CONFIG_MISSING");
        var local=new RequestContext(221,target,"AI08-local-review",com.hs.jxc.sys.service.SessionService.digest("AI08-221"));
        assertThatThrownBy(()->countries.createClone(local,Map.of("templateId",id(template),"targetCode","BR","targetName","AI08 forbidden country administrator"))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(403);
        // Country review does not replace the original local finance mapping/report review commands.
        long targetBook=owner.queryForObject("select id from fin_book where country_id=?",Long.class,target);
        for(var mapping:owner.queryForList("select id,version from fin_mapping_template where country_id=? and status='NEED_REVIEW'",target))
            accounting.review(local,((Number)mapping.get("id")).longValue(),Map.of("version",mapping.get("version")),key());
        for(var report:owner.queryForList("select id,version from fin_report_template where country_id=? and status='NEED_REVIEW'",target))
            reports.review(local,targetBook,((Number)report.get("id")).longValue(),Map.of("bookId",targetBook,"version",report.get("version")),key());
        // Review cloned master configuration through its original commands, preserving disabled status.
        for(var sku:owner.queryForList("select product_id,version,tax_category from md_country_sku where country_id=?",target)) {
            var body=new LinkedHashMap<String,Object>();body.put("version",sku.get("version"));body.put("enabled",false);
            body.put("localName","AI08 local clone SKU");
            // Explicitly unclassified synthetic tax configuration; this clone runs no taxable transactions.
            body.put("taxCategory",sku.get("tax_category")==null?"":sku.get("tax_category"));
            var reviewed=callAs(target,221,"PUT","/md/country-skus/"+sku.get("product_id"),body);
            assertThat(reviewed.statusCode()).as(reviewed.body()).isEqualTo(200);
        }
        for(var expense:owner.queryForList("select * from md_expense_item where country_id=?",target)) {
            var body=new LinkedHashMap<String,Object>();body.put("version",expense.get("version"));body.put("code",expense.get("code"));
            body.put("name",expense.get("name"));body.put("costTreatment",expense.get("cost_treatment"));body.put("bookId",targetBook);
            body.put("accountId",expense.get("account_id"));body.put("feeCategory",expense.get("fee_category")==null?"":expense.get("fee_category"));
            var reviewed=callAs(target,221,"PUT","/md/expense-items/"+expense.get("id"),body);
            assertThat(reviewed.statusCode()).as(reviewed.body()).isEqualTo(200);
        }
        // Source approver identities are excluded: explicitly select the assigned local administrator.
        for(var draft:owner.queryForList("select id from wf_rule where country_id=? and status='DRAFT'",target)) {
            long ruleId=((Number)draft.get("id")).longValue();
            var existing=workflow.getRule(local,ruleId);
            var body=new LinkedHashMap<String,Object>();
            for(String field:List.of("name","docType","priority","version","conditions"))body.put(field,existing.get(field));
            body.put("effectiveFrom","2026-10-01"); // Explicit target-local date; do not pass JDBC timestamps back as command input.
            body.put("nodes",List.of(Map.of("nodeName","AI08 local clone reviewer","approverType","USER","approverRef",221,"mode","ANY")));
            var reviewed=workflow.updateRule(local,ruleId,body);
            assertThat(workflow.toggleRule(local,id(reviewed),true).get("status")).isEqualTo("ACTIVE");
        }
        for(var review:countries.reviews(local,target))countries.review(local,target,id(review),Map.of("comment","AI08 actual target administrator reviewed synthetic local configuration"));
        countries.activate(platform,target);
        for(String table:List.of("pur_order","lgs_receipt","inv_batch","cst_inbound_cost","ar_receivable","ap_bill","fin_voucher","fin_snapshot","md_fund_account","fin_period","md_customer","md_supplier","md_logistics_provider"))
            assertThat(owner.queryForObject("select count(*) from "+table+" where country_id=?",Integer.class,target)).as(table+" must not be cloned").isZero();
        assertThat(owner.queryForList("select user_id from sys_user_role where country_id=?",Long.class,target)).containsExactly(221L);
        assertThat(owner.queryForObject("select count(*) from sys_role where country_id=? and role_type<>'COUNTRY_ADMIN' and status<>'DISABLED'",Integer.class,target)).isZero();
        assertThat(owner.queryForObject("select base_currency from fin_book where country_id=?",String.class,target)).isEqualTo("CNY");
        assertThat(fingerprint(101)).isEqualTo(before);
        var sourcePlatform=new RequestContext(900,101L,"AI08-template-upgrade",com.hs.jxc.sys.service.SessionService.digest("AI08-900"));
        numbering.save(sourcePlatform,"AI08_UPGRADE",Map.of("prefix","AI08V2","datePattern","yyyyMMdd","sequenceWidth",6,"resetPeriod","NONE"));
        var next=countries.createTemplate(platform,Map.of("sourceCountryId",101,"changeNote","AI08 explicit source numbering v2"));countries.publish(platform,id(next));
        assertThat(owner.queryForObject("select count(*) from sys_doc_number_rule where country_id=? and doc_type='AI08_UPGRADE'",Integer.class,target)).isZero();
        var upgrade=countries.previewUpgrade(local,Map.of("countryId",target,"toTemplateId",id(next)));
        assertThat(upgrade.get("diffs").toString()).contains("doc-number-rules");
        countries.confirmUpgrade(local,id(upgrade));
        assertThat(owner.queryForObject("select count(*) from sys_doc_number_rule where country_id=? and doc_type='AI08_UPGRADE'",Integer.class,target)).as("upgrade still waits for local item review").isZero();
        for(var review:countries.reviews(local,target))if("NEED_REVIEW".equals(review.get("status")))countries.review(local,target,id(review),Map.of("comment","AI08 target administrator confirms explicit upgrade difference"));
        assertThat(owner.queryForObject("select prefix from sys_doc_number_rule where country_id=? and doc_type='AI08_UPGRADE'",String.class,target)).isEqualTo("AI08V2");
        evidence("populated-clone",Map.of("nativeSource",nativeSource,"template",template,"jobId",jobId,"targetId",target,"preview",preview,"upgrade",upgrade,"target",countries.get(local,target),"sourceBefore",before,"sourceAfter",fingerprint(101)));
        pageCheck("populated-clone",target,221);
    }

    @ParameterizedTest @ValueSource(longs={101,102})
    void localReportVersionsAndClosedSnapshotRemainIndependent(long country)throws Exception {
        Local p=country==101?mx:cn,other=country==101?cn:mx;
        var localRules=new HashMap<Long,Map<String,Object>>();
        for(Local x:List.of(mx,cn))for(String type:List.of("BALANCE_SHEET","INCOME")){
            var t=reports.save(actor(x),x.book(),null,Map.of("bookId",x.book(),"reportType",type,"name","AI08 local "+type,"rule","CATEGORY_V1"),key());
            reports.review(actor(x,x.auditor()),x.book(),id(t),Map.of("bookId",x.book(),"version",t.get("version")),key());
        }
        for(Local x:List.of(mx,cn))localRules.put(x.country(),(Map<String,Object>)classification.save(actor(x),null,classificationBody(0)));
        // An explicitly empty native prior period tests close isolation without fabricating ledger facts.
        long period=country+8000;
        seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(?,?,?,2026,9,'2026-09-01','2026-09-30','OPEN')",period,country,p.book());
        String otherBefore=fingerprint(other.country());
        closing.close(actor(p),period,Map.of("bookId",p.book()),key());
        String snapshot=owner.queryForObject("select md5(string_agg(content::text,'' order by id)) from fin_snapshot where country_id=? and period_id=?",String.class,country,period);
        var second=reports.save(actor(p),p.book(),null,Map.of("bookId",p.book(),"reportType","INCOME","name","AI08 explicit local v2","rule","CATEGORY_V1"),key());
        reports.review(actor(p,p.auditor()),p.book(),id(second),Map.of("bookId",p.book(),"version",second.get("version")),key());
        var ruleBody=new LinkedHashMap<>(classificationBody(1));ruleBody.put("versionNo",localRules.get(country).get("versionNo"));
        var ruleV2=(Map<String,Object>)classification.save(actor(p),id(localRules.get(country)),ruleBody);
        assertThat(((Number)ruleV2.get("versionNo")).intValue()).isEqualTo(2);
        assertThat(owner.queryForObject("select version_no from inv_classify_rule where country_id=? and status='ACTIVE'",Integer.class,other.country())).isEqualTo(1);
        assertThat(owner.queryForObject("select md5(string_agg(content::text,'' order by id)) from fin_snapshot where country_id=? and period_id=?",String.class,country,period)).isEqualTo(snapshot);
        assertThat(owner.queryForObject("select count(*) from fin_snapshot where country_id=? and period_id=?",Integer.class,country,period)).isEqualTo(3);
        assertThat(owner.queryForObject("select version_no from fin_report_template where country_id=? and report_type='INCOME' and status='ACTIVE'",Integer.class,other.country())).isEqualTo(1);
        assertThat(fingerprint(other.country())).isEqualTo(otherBefore);
        evidence("closed-version-"+country,Map.of("country",country,"periodId",period,"newTemplate",second,"inventoryRuleV2",ruleV2,"frozenSnapshotHash",snapshot,"otherBefore",otherBefore,"otherAfter",fingerprint(other.country()),"closedReport",reports.report(actor(p),p.book(),period,"INCOME")));
    }
    Map<String,Object> classificationBody(int threshold){return Map.of("name","AI08 local inventory version","dimType","WAREHOUSE","periodType","CALENDAR_MONTH","effectiveFrom","2026-09-01","conditions",List.of(Map.of("label","HOT_CANDIDATE","priority",1,"stockOp","GTE","stockValue",threshold,"orderOp","GTE","orderValue",0)));}

    @Test void missingLocalCostMethodStopsNativeReceiptWithoutUsingMexicoConfiguration()throws Exception {
        seed("delete from cst_method_config where country_id=102");
        assertThatThrownBy(()->receive(cn)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("CST_METHOD_REQUIRED");
        assertThat(owner.queryForObject("select count(*) from inv_batch where country_id=102",Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from cst_inbound_cost where country_id=102",Integer.class)).isZero();
        assertThat(owner.queryForObject("select count(*) from lgs_receipt where country_id=102 and status='DRAFT'",Integer.class)).isEqualTo(1);
        evidence("missing-local-method",Map.of("source",owner.queryForList("select id,doc_no,status from pur_order where country_id=102"),"receipt",owner.queryForList("select id,doc_no,status from lgs_receipt where country_id=102"),"expectedError","CST_METHOD_REQUIRED","sourceCountryStillConfigured",owner.queryForObject("select count(*) from cst_method_config where country_id=101",Integer.class)));
    }

    String fingerprint(long country) {
        var result=new LinkedHashMap<String,Object>();
        for(String table:List.of("pur_order","pur_order_line","lgs_receipt","sal_order","sal_order_line","sal_price","rtn_sales_return","rtn_refund","sys_biz_event","inv_stock_summary","inv_batch","inv_batch_balance","inv_reservation","cst_method_config","cst_inbound_cost","cst_cogs","cst_valuation_pool","ar_credit_occupation","ar_receivable","ar_receipt","ar_credit_note","ap_bill","fin_voucher","fin_voucher_line","fin_report_template","fin_period","fin_snapshot","inv_classify_rule","inv_classify_result"))
            result.put(table,owner.queryForList("select t.* from "+table+" t where country_id=? order by to_jsonb(t)::text",country));
        return Digests.sha256(json.write(result));
    }
    BigDecimal creditOccupation(long country){return owner.queryForObject("select coalesce(sum(amount-released_amount),0) from ar_credit_occupation where country_id=?",BigDecimal.class,country);}
    HttpResponse<String> call(Local p,String method,String path,Object body)throws Exception {
        return callAs(p.country(),p.operator(),method,path,body);
    }
    HttpResponse<String> callAs(long country,long user,String method,String path,Object body)throws Exception {
        var b=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1"+path)).header("Authorization","Bearer AI08-"+user).header("X-Country-Id",String.valueOf(country)).header("Content-Type","application/json").header("Idempotency-Key",key());
        return HttpClient.newHttpClient().send(b.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.write(body))).build(),HttpResponse.BodyHandlers.ofString());
    }
    void evidence(String name,Object data)throws Exception {
        String dir=System.getProperty("ai08.evidenceDir");
        if(dir!=null){
            Files.createDirectories(Path.of(dir));Files.writeString(Path.of(dir,name+".json"),json.write(data),StandardCharsets.UTF_8);
            Files.writeString(Path.of(dir,"runtime.json"),json.write(Map.of("taskId","AI-08","postgresContainer",PgDatabase.PG.getContainerId(),
                "jdbcUrl",PgDatabase.PG.getJdbcUrl(),"runtimeRole",jdbc.queryForObject("select current_user",String.class),"httpPort",port,
                "minioContainer",MinioTestStorage.MINIO.getContainerId(),"minioEndpoint",MinioTestStorage.endpoint(),"bucket",MinioTestStorage.BUCKET)),StandardCharsets.UTF_8);
        }
    }
    void pageCheck(String name,long country,long operator)throws Exception {
        String script=System.getProperty("ai08.browserScript");
        if(script==null)return; // Optional browser layer; the native service and PG assertions always execute.
        String dir=Objects.requireNonNull(System.getProperty("ai08.evidenceDir"),"Browser checks require an evidence directory");
        var process=new ProcessBuilder("node",script,Path.of(dir,name+".json").toString(),String.valueOf(port),
            Objects.requireNonNull(System.getProperty("ai08.frontendDir")),Objects.requireNonNull(System.getProperty("ai08.playwrightModule")),String.valueOf(country),String.valueOf(operator))
            .redirectErrorStream(true).redirectOutput(Path.of(dir,name+"-browser.log").toFile()).start();
        try {
            assertThat(process.waitFor(150,java.util.concurrent.TimeUnit.SECONDS)).as("AI08 isolated page check timeout").isTrue();
            assertThat(process.exitValue()).as("See "+name+"-browser.log").isZero();
        } finally {
            if(process.isAlive()){process.descendants().forEach(ProcessHandle::destroyForcibly);process.destroyForcibly();}
        }
    }
}
