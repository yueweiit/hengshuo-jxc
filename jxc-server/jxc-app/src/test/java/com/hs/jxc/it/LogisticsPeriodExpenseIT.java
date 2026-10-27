package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.cst.profit.ProfitService;
import com.hs.jxc.lgs.LogisticsFinancialSources;
import com.hs.jxc.sys.service.AuthorizationService;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;

/** Real logistics commands and profit reads; no duplicate expense fixture or calculation. */
class LogisticsPeriodExpenseIT extends SupplyFixtures {
    @Autowired ProfitService profits;
    @Autowired LogisticsFinancialSources financialSources;
    @Autowired AuthorizationService authorization;
    @Autowired com.hs.jxc.common.api.JsonCodec codec;
    @Autowired com.hs.jxc.fin.accounting.AccountingService accounting;
    long shipmentId;
    @BeforeEach void periodSetup() {
        seed("UPDATE sys_role SET field_policies=field_policies||'{\"PROFIT\":\"READ\"}'::jsonb WHERE id=202");
        seed("INSERT INTO fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) VALUES(702,101,601,2026,11,'2026-11-01','2026-11-30','OPEN')");
        seed("INSERT INTO md_expense_item(id,country_id,code,name,cost_treatment) VALUES(804,101,'PERIOD','期间物流经营费用','PERIOD_EXPENSE'),(805,101,'DIRECT','直接销售费用','DIRECT_SELLING'),(806,101,'OLD','原期间费用','EXPENSE')");
        var receipt=domestic(order(),20,0,0,true);
        shipmentId=id(shipment(export(receipt,20,true),10));
    }
    Map<String,Object> body(int item,int amount,String flag,String date,Long estimate,boolean confirm) {
        var b=new LinkedHashMap<String,Object>(Map.of("refType","SHIPMENT","refId",shipmentId,"carrierId",802,"expenseItemId",item,"currency","MXN","amount",amount,"estimateFlag",flag,"bizDate",date,"confirm",confirm));
        if(estimate!=null)b.put("estimateFeeId",estimate);
        return b;
    }
    Map<String,Object> fee(int item,int amount,String flag,String date,Long estimate,boolean confirm) {return lgs.create(c(),"fees",body(item,amount,flag,date,estimate,confirm),key());}
    Map<String,Object> profit(String period) {return profits.query(c(),Map.of("bookId","601","periodId",period));}
    @SuppressWarnings("unchecked") Map<String,Object> expense(Map<String,Object> p) {return ((List<Map<String,Object>>)p.get("rows")).stream().filter(r->((Number)r.get("productId")).longValue()==0).findFirst().orElseThrow();}
    void amount(Map<String,Object> r,String field,String value){assertThat(new BigDecimal(r.get(field).toString())).as(field).isEqualByComparingTo(value);}

    @Test void periodThirtyCanSaveEditConfirmAndFeedsProfitAndPayableFromOneSource() {
        var f=fee(804,20,"ACTUAL","2026-10-15",null,false);
        assertThat(f).containsEntry("status","DRAFT").containsEntry("costTreatment","PERIOD_EXPENSE");
        var changes=body(804,30,"ACTUAL","2026-10-15",null,false);changes.put("version",f.get("version"));
        lgs.update(c(),"fees",id(f),changes);
        var confirmed=lgs.action(c(),"fees",id(f),"confirm",Map.of(),key());
        assertThat(confirmed).containsEntry("status","CONFIRMED").containsEntry("costTreatment","PERIOD_EXPENSE");
        var p=profit("701");amount(expense(p),"periodExpense","30");amount(p,"contributionProfit","-30");
        assertThat(expense(p).get("sources").toString()).contains("LGS_FEE",f.get("docNo").toString());
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_expense_record",Integer.class)).isZero();
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_valuation_change",Integer.class)).isZero();
        assertThat(inCountry(101,()->lgs.lockPayableSource(authorization.authorize(c()),"LGS_FEE",id(f))).totalAmount()).isEqualByComparingTo("30");
        var fact=inCountry(101,()->financialSources.accountingFact(authorization.authorize(c()),"LGS_FEE_CONFIRMED","LGS_FEE",id(f),1,java.time.LocalDate.of(2026,10,15),Map.of()));
        assertThat(fact.get("payload").toString()).contains("apAmount=30", "allocationRequired=false");
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event WHERE event_type='CST_EXPENSE_RECORDED'",Integer.class)).isZero();
        assertThat(profit("701").get("sourceHash")).isEqualTo(p.get("sourceHash"));
    }
    @Test void legacyExpenseWritesCanonicalTreatmentAndOldRowsRemainReadable() {
        var f=fee(806,30,"ACTUAL","2026-10-15",null,true);
        assertThat(f).containsEntry("costTreatment","PERIOD_EXPENSE");
        seed("UPDATE lgs_fee SET cost_treatment='EXPENSE' WHERE id=?",id(f));
        amount(expense(profit("701")),"periodExpense","30");
    }
    @Test void invalidDirectDisabledAndUnavailableItemsReturnActionableBusinessErrorsAtomically() {
        assertThatThrownBy(()->fee(805,30,"ACTUAL","2026-10-15",null,true)).isInstanceOfSatisfying(ApiException.class,e->{assertThat(e.getCode()).isEqualTo("LGS_FEE_TREATMENT_UNSUPPORTED");assertThat(e.getMessage()).contains("费用登记","直接销售");});
        seed("UPDATE md_expense_item SET status='DISABLED' WHERE id=804");
        assertThatThrownBy(()->fee(804,30,"ACTUAL","2026-10-15",null,true)).isInstanceOfSatisfying(ApiException.class,e->assertThat(e.getCode()).isEqualTo("LGS_FEE_ITEM_DISABLED"));
        assertThatThrownBy(()->fee(999,30,"ACTUAL","2026-10-15",null,true)).isInstanceOfSatisfying(ApiException.class,e->assertThat(e.getCode()).isEqualTo("LGS_FEE_ITEM_UNAVAILABLE"));
        assertThat(owner.queryForObject("SELECT count(*) FROM lgs_fee",Integer.class)).isZero();
    }
    @ParameterizedTest @ValueSource(ints={30,45,20})
    void actualReplacementCountsOnlyTheFrozenDifferenceAndRetryDoesNotDuplicate(int actual) {
        var est=fee(804,30,"ESTIMATE","2026-10-15",null,true);
        var act=fee(804,actual,"ACTUAL","2026-10-16",id(est),true);
        lgs.action(c(),"fees",id(act),"confirm",Map.of(),key());
        amount(expense(profit("701")),"periodExpense",String.valueOf(actual));
        assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event WHERE event_type='LGS_FEE_CONFIRMED'",Integer.class)).isEqualTo(2);
    }
    @Test void replacementAcrossPeriodsKeepsEstimateInOriginalPeriodAndOnlyDifferenceInNext() {
        var est=fee(804,30,"ESTIMATE","2026-10-15",null,true);
        fee(804,45,"ACTUAL","2026-11-01",id(est),true);
        amount(expense(profit("701")),"periodExpense","30");amount(expense(profit("702")),"periodExpense","15");
    }
    @Test void missingRateIsInsufficientAndLaterRecoveryDoesNotRewriteClosedCutoff() {
        var b=body(804,30,"ACTUAL","2026-10-15",null,true);b.put("currency","CNY");
        var f=lgs.create(c(),"fees",b,key());
        var before=profit("701");
        assertThat(expense(before)).containsEntry("periodExpense",null).containsEntry("contributionProfit",null).containsEntry("completeness","INSUFFICIENT");
        var cutoff=owner.queryForObject("SELECT clock_timestamp()",OffsetDateTime.class);
        seed("INSERT INTO md_exchange_rate(country_id,from_ccy,to_ccy,scope,rate_date,rate,status) VALUES(101,'CNY','MXN','PURCHASE_COST','2026-10-15',2,'CONFIRMED')");
        lgs.action(c(),"fees",id(f),"confirm",Map.of(),key());amount(expense(profit("701")),"periodExpense","60");
        seed("UPDATE fin_period SET status='CLOSED',closed_at=? WHERE id=701",cutoff);
        assertThat(expense(profit("701"))).containsEntry("periodExpense",null).containsEntry("completeness","INSUFFICIENT");
    }
    @Test void draftExistingAtCutoffButConfirmedLaterIsExcludedAndProfitOnlyPermissionWorks() {
        var f=fee(804,30,"ACTUAL","2026-10-15",null,false);
        var cutoff=owner.queryForObject("SELECT clock_timestamp()",OffsetDateTime.class);
        lgs.action(c(),"fees",id(f),"confirm",Map.of(),key());
        seed("UPDATE fin_period SET status='CLOSED',closed_at=? WHERE id=701",cutoff);
        assertThat(profit("701").get("rows")).asList().isEmpty();
        seed("UPDATE fin_period SET status='OPEN',closed_at=null WHERE id=701");
        seed("UPDATE sys_role SET permissions='[\"cst:profit:view\"]' WHERE id=202");
        amount(expense(profit("701")),"periodExpense","30");
        seed("DELETE FROM sys_user_data_scope WHERE user_id=201");
        assertThatThrownBy(()->profit("701")).isInstanceOf(ApiException.class);
    }

    @Test void confirmationRechecksItemAndReplacementCannotSwitchItsAccountingTreatment() {
        var draft=fee(804,30,"ACTUAL","2026-10-15",null,false);
        seed("UPDATE md_expense_item SET cost_treatment='CAPITALIZE' WHERE id=804");
        assertThatThrownBy(()->lgs.action(c(),"fees",id(draft),"confirm",Map.of(),key())).isInstanceOfSatisfying(ApiException.class,e->assertThat(e.getCode()).isEqualTo("LGS_FEE_ITEM_CHANGED"));
        seed("UPDATE md_expense_item SET cost_treatment='PERIOD_EXPENSE' WHERE id=804");
        var est=fee(803,30,"ESTIMATE","2026-10-15",null,true);
        assertThatThrownBy(()->fee(804,30,"ACTUAL","2026-10-16",id(est),true)).isInstanceOfSatisfying(ApiException.class,e->assertThat(e.getCode()).isEqualTo("LGS_FEE_ESTIMATE_TREATMENT_MISMATCH"));
        assertThat(owner.queryForObject("SELECT count(*) FROM lgs_fee",Integer.class)).isEqualTo(2);
    }

    @Test void originalFeeEventUsesExpenseMappingAndOneBalancedVoucherWithoutDuplicatingExpense() {
        var f=fee(804,30,"ACTUAL","2026-10-15",null,true);
        long event=owner.queryForObject("SELECT id FROM sys_biz_event WHERE source_type='LGS_FEE' AND source_id=? AND event_type='LGS_FEE_CONFIRMED'",Long.class,id(f));
        assertThatThrownBy(()->accounting.generate(c(),event,key())).isInstanceOfSatisfying(ApiException.class,e->assertThat(e.getCode()).isEqualTo("FIN_MAPPING_MISSING"));
        seed("INSERT INTO fin_account(id,country_id,book_id,code,name,category,direction) VALUES(1101,101,601,'6601','物流期间费用','EXPENSE','DEBIT'),(1102,101,601,'2202','应付物流商','LIABILITY','CREDIT')");
        seed("UPDATE md_expense_item SET account_id=1101 WHERE id=804");
        var mapping=accounting.saveMapping(c(),null,Map.of("bookId",601,"eventType","LGS_FEE_CONFIRMED","lines",List.of(
            Map.of("direction","DEBIT","accountRule",Map.of("type","EXPENSE_ITEM"),"amountExpr","amount","auxMapping",Map.of()),
            Map.of("direction","CREDIT","accountRule",Map.of("type","FIXED","code","2202"),"amountExpr","apAmount","auxMapping",Map.of()))),key());
        accounting.review(c(),id(mapping),Map.of("version",mapping.get("version")),key());
        assertThat(accounting.generate(c(),event,key())).containsEntry("status","GENERATED");
        accounting.generate(c(),event,key());
        assertThat(owner.queryForObject("SELECT count(*) FROM fin_voucher",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT sum(debit) FROM fin_voucher_line",BigDecimal.class)).isEqualByComparingTo("30");
        assertThat(owner.queryForObject("SELECT sum(credit) FROM fin_voucher_line",BigDecimal.class)).isEqualByComparingTo("30");
        assertThat(owner.queryForObject("SELECT count(*) FROM cst_expense_record",Integer.class)).isZero();
    }

    @Test void packagedFrontendAndApplicationRegisterPeriodExpenseOverTheRealHttpProxy() throws Exception {
        String image=System.getProperty("jxc.fee.image");
        Assumptions.assumeTrue(image!=null,"Set jxc.fee.image after building the verified feature images");
        String nginx="server { listen 8080; location /api/ { proxy_pass http://application:8080; } location / { root /usr/share/nginx/html; try_files $uri /index.html; } }";
        try(var network=org.testcontainers.containers.Network.newNetwork();
            var app=new org.testcontainers.containers.GenericContainer<>(org.testcontainers.utility.DockerImageName.parse(image))
                .withNetwork(network).withNetworkAliases("application").withExposedPorts(8080)
                .withCreateContainerCmdModifier(cmd->cmd.withEntrypoint("java","-Xmx384m","-jar","/app/app.jar"))
                .withCommand("--spring.flyway.enabled=false","--jxc.jobs.enabled=false")
                .withEnv("JXC_BIND_ADDRESS","0.0.0.0").withEnv("JXC_DB_URL",PgDatabase.PG.getJdbcUrl().replace("localhost","host.docker.internal").replace("127.0.0.1","host.docker.internal"))
                .withEnv("JXC_DB_USER","jxc_app").withEnv("JXC_DB_PASSWORD",PgDatabase.PASSWORD)
                .withEnv("JXC_BANK_ENCRYPTION_KEY",Base64.getEncoder().encodeToString(new java.security.SecureRandom().generateSeed(32)))
                .waitingFor(org.testcontainers.containers.wait.strategy.Wait.forHttp("/actuator/health").forStatusCode(200));
            var web=new org.testcontainers.containers.GenericContainer<>(org.testcontainers.utility.DockerImageName.parse(System.getProperty("jxc.fee.webImage","hengshuo-jxc-web:feature-page-logistics-fees")))
                .withNetwork(network).withExposedPorts(8080)
                .withCopyToContainer(org.testcontainers.images.builder.Transferable.of(nginx),"/etc/nginx/conf.d/default.conf")
                .waitingFor(org.testcontainers.containers.wait.strategy.Wait.forHttp("/login").forStatusCode(200))) {
            app.start();web.start();
            String origin="http://"+web.getHost()+":"+web.getMappedPort(8080);
            var client=java.net.http.HttpClient.newHttpClient();
            for(String path:List.of("/logistics/fees","/logistics/shipments/"+shipmentId)){
                var page=client.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(origin+path)).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());
                assertThat(page.statusCode()).isEqualTo(200);assertThat(page.body()).contains("/assets/");
            }
            var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(origin+"/api/v1/lgs/fees"))
                .header("Authorization","Bearer supply-fixture").header("X-Country-Id","101").header("Idempotency-Key",key()).header("Content-Type","application/json")
                .POST(java.net.http.HttpRequest.BodyPublishers.ofString(codec.write(body(804,30,"ACTUAL","2026-10-15",null,true)))).build();
            var response=client.send(request,java.net.http.HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
            assertThat(codec.readMap(response.body()).get("data").toString()).contains("costTreatment=PERIOD_EXPENSE","status=CONFIRMED");
            amount(expense(profit("701")),"periodExpense","30");
            System.out.println("LOGISTICS_FEE_DOCKER_VERIFIED image="+image+" amount=30 MXN source=LGS_FEE");
        }
    }
}
