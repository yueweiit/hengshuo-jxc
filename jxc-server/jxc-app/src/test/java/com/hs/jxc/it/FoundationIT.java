package com.hs.jxc.it;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.org.OrgService;
import com.hs.jxc.fin.service.*;
import com.hs.jxc.sys.service.AuthorizationService;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import static org.assertj.core.api.Assertions.*;
import java.util.*;
import java.util.concurrent.*;

class FoundationIT extends BasePgIT {
    @Autowired OrgService org;
    @Autowired BookService books;
    @Autowired BookResolver resolver;
    @Autowired AuthorizationService auth;
    @org.springframework.boot.test.web.server.LocalServerPort int port;
    @Autowired tools.jackson.databind.ObjectMapper json;
    RequestContext ctx;
    Object storeBooksApi(String path,int expected)throws Exception{
        var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+port+"/api/v1"+path)).header("Authorization","Bearer store-books-http").header("X-Country-Id","101").GET().build();
        var response=java.net.http.HttpClient.newHttpClient().send(request,java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).as(response.body()).isEqualTo(expected);return json.readValue(response.body(),Map.class).get("data");
    }
    @BeforeEach void fixtures(){
        resetFixtures();
        seed("insert into md_currency(id,code,name) values(91,'MXN','Peso')");
        seed("insert into sys_country(id,code,name,default_currency,timezone,status) values(101,'MX','Fixture','MXN','America/Mexico_City','ACTIVE'),(102,'ES','Other','EUR','Europe/Madrid','ACTIVE')");
        seed("insert into sys_authz_epoch(country_id) values(101),(102)");
        seed("insert into sys_user(id,username,password_hash,display_name,created_country_id) values(201,'fixture','no-login','Fixture',101)");
        seed("insert into sys_session(token_hash,user_id,expires_at) values(repeat('a',64),201,clock_timestamp()+interval '1 hour')");
        seed("insert into sys_role(id,country_id,code,name,permissions,field_policies) values(211,101,'ADMIN','Admin','[\"org:entity:edit\",\"org:store:edit\",\"org:warehouse:edit\",\"sys:user:edit\",\"fin:book:config\",\"md:fund-account:edit\"]','{\"BANK_INFO\":\"WRITE\"}')");
        seed("insert into sys_user_role(country_id,user_id,role_id) values(101,201,211)");
        seed("insert into org_entity(id,country_id,code,name) values(301,101,'E1','Entity'),(302,101,'E2','Hidden'),(303,102,'OTHER','Other')");
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,entity_id,granted_by) values(101,201,'ENTITY',301,201)");
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(601,101,301,'B1','Book','MXN','ACTIVE')");
        ctx=new RequestContext(201,101L,"foundation", "a".repeat(64));
    }
    @Test void listCountAndDetailUseTheSameScopeAndUnknownWritesAreRejected(){
        assertThat(org.list(ctx,"entities",Map.of())).containsEntry("total",1);
        assertThatThrownBy(()->org.get(ctx,"entities",302)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);
        assertThatThrownBy(()->org.create(ctx,"arbitrary-table",Map.of(),null)).isInstanceOf(ApiException.class);
    }
    @Test void updatesRequireVersionAndRejectStaleVersionsAndForgedOwnership(){
        assertThatThrownBy(()->org.update(ctx,"entities",301,Map.of("name","Missing"))).isInstanceOf(ApiException.class).extracting("code").isEqualTo("SYS_VERSION_REQUIRED");
        var after=org.update(ctx,"entities",301,Map.of("name","New","version",1));
        assertThat(after).containsEntry("name","New").containsEntry("version",2);
        assertThatThrownBy(()->org.update(ctx,"entities",301,Map.of("name","Stale","version",1))).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);
        assertThatThrownBy(()->org.update(ctx,"entities",301,Map.of("countryId",102,"version",2))).isInstanceOf(ApiException.class);
    }
    @Test void storeCreationIsAtomicAndSameIntentReplaysWithoutMoreWarehouses(){
        Map<String,Object> body=Map.of("entityId",301,"code","S1","name","Store","fundAccount",Map.of("name","Till","accountType","CASH","bookId",601,"currency","MXN"));
        String key=UUID.randomUUID().toString();var first=org.create(ctx,"stores",body,key);var again=org.create(ctx,"stores",body,key);
        assertThat(((Number)first.get("id")).longValue()).isEqualTo(((Number)again.get("id")).longValue());
        assertThat(first.get("defaultWarehouseId")).isNotNull();
        assertThat(owner.queryForObject("select count(*) from org_store",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from org_warehouse",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("select count(*) from md_fund_account",Integer.class)).isEqualTo(1);
        assertThatThrownBy(()->org.create(ctx,"stores",Map.of("entityId",301,"code","S2","name","Bad","warehouseCode","S1-WH"),null)).isInstanceOf(Exception.class);
        assertThat(owner.queryForObject("select count(*) from org_store",Integer.class)).isEqualTo(1);
    }
    @Test void replayRechecksCurrentScopeAndChangedContentConflicts(){
        var body=Map.<String,Object>of("entityId",301,"code","S1","name","Store");String key=UUID.randomUUID().toString();org.create(ctx,"stores",body,key);
        assertThatThrownBy(()->org.create(ctx,"stores",Map.of("entityId",301,"code","S2","name","Store"),key)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(409);
        seed("delete from sys_user_data_scope where user_id=201");
        assertThatThrownBy(()->org.create(ctx,"stores",body,key)).isInstanceOf(ApiException.class);
        assertThat(owner.queryForObject("select count(*) from org_store",Integer.class)).isEqualTo(1);
    }
    @Test void bookResolutionRequiresUniqueAuthorizedConfiguredBook(){
        assertThat(inCountry(101,()->resolver.resolve(auth.authorize(ctx),null,301L))).isEqualTo(601L);
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,301,'B2','Second','MXN','ACTIVE')");
        assertThatThrownBy(()->inCountry(101,()->resolver.resolve(auth.authorize(ctx),null,301L))).isInstanceOf(ApiException.class).extracting("code").isEqualTo("FIN_BOOK_AMBIGUOUS");
        assertThatThrownBy(()->inCountry(101,()->resolver.resolve(auth.authorize(ctx),601L,302L))).isInstanceOf(ApiException.class);
    }
    @Test @SuppressWarnings("unchecked") void warehouseBookCandidatesDoNotGrantStoreUsersWholeBookAccess()throws Exception{
        seed("insert into sys_user(id,username,password_hash,display_name,created_country_id) values(202,'store-books','no-login','Store user',101)");
        seed("insert into sys_session(token_hash,user_id,expires_at) values(?,202,clock_timestamp()+interval '1 hour')",Digests.sha256("store-books-http"));
        seed("insert into sys_role(id,country_id,code,name,permissions,field_policies) values(212,101,'STORE_SALES','Store sales','[\"sal:order:create\",\"fin:ledger:view\"]','{}')");
        seed("insert into sys_user_role(country_id,user_id,role_id) values(101,202,212)");
        seed("insert into org_store(id,country_id,entity_id,code,name) values(401,101,301,'S1','Visible'),(402,101,301,'S2','Hidden')");
        seed("insert into org_warehouse(id,country_id,entity_id,store_id,code,name,type) values(501,101,301,401,'W1','Visible warehouse','STORE'),(502,101,301,402,'W2','Hidden warehouse','STORE'),(503,101,302,null,'W3','Hidden without book','WAREHOUSE')");
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,store_id,granted_by) values(101,202,'STORE',401,201)");
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,301,'B2','Second','MXN','ACTIVE'),(603,101,301,'B3','Disabled','MXN','DISABLED')");
        seed("insert into fin_period(id,country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(701,101,601,2026,10,'2026-10-01','2026-10-31','OPEN')");
        assertThat((List<?>)storeBooksApi("/org/books",200)).isEmpty();
        var candidates=(List<Map<String,Object>>)storeBooksApi("/org/books?warehouseId=501",200);
        assertThat(candidates).extracting(r->((Number)r.get("id")).longValue()).containsExactly(601L,602L);
        assertThat(candidates.getFirst().keySet()).containsExactlyInAnyOrder("id","code","name","baseCurrency","entityId","status");
        storeBooksApi("/org/books?warehouseId=502",404);storeBooksApi("/org/books?warehouseId=503",404);
        assertThat((List<?>)storeBooksApi("/fin/books",200)).isEmpty();storeBooksApi("/fin/ledgers/general?bookId=601&periodId=701",404);
        var actor=new RequestContext(202,101L,"store-books",Digests.sha256("store-books-http"));
        assertThatThrownBy(()->inCountry(101,()->resolver.resolveForWarehouse(auth.authorize(actor),null,501))).isInstanceOf(ApiException.class).extracting("code").isEqualTo("FIN_BOOK_AMBIGUOUS");
        assertThat(inCountry(101,()->resolver.resolveForWarehouse(auth.authorize(actor),601L,501))).isEqualTo(601L);
        assertThat(inCountry(101,()->auth.authorize(actor).scope().books())).isEmpty();
    }
    @Test void periodGenerationPreservesClosedMonthsAndNeverCreatesOverlap(){
        seed("insert into fin_period(country_id,book_id,fiscal_year,period_no,start_date,end_date,status) values(101,601,2026,10,'2026-10-01','2026-10-31','CLOSED')");
        var result=books.generatePeriods(ctx,601L,Map.of("fiscalYear",2026),UUID.randomUUID().toString());
        assertThat(result).containsEntry("created",11);
        assertThat(owner.queryForObject("select count(*) from fin_period",Integer.class)).isEqualTo(12);
        assertThat(owner.queryForObject("select status from fin_period where period_no=10",String.class)).isEqualTo("CLOSED");
        assertThat(books.generatePeriods(ctx,601L,Map.of("fiscalYear",2026),null)).containsEntry("created",0);
    }
    @Test void generationRechecksBookStatusAfterWaitingForExclusiveGate()throws Exception{
        var pool=Executors.newSingleThreadExecutor();
        try(var connection=owner.getDataSource().getConnection()){
            connection.setAutoCommit(false);
            try(var stmt=connection.prepareStatement("SELECT id FROM fin_book WHERE id=601 FOR UPDATE")){stmt.executeQuery().close();}
            var future=pool.submit(()->books.generatePeriods(ctx,601L,Map.of("fiscalYear",2026),null));
            try{
                long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);boolean waiting=false;
                while(System.nanoTime()<deadline){waiting=owner.queryForObject("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='jxc_app' AND wait_event_type='Lock' AND query LIKE '%fin_book%FOR UPDATE%')",Boolean.class);if(waiting)break;Thread.sleep(20);}
                assertThat(waiting).as("writer reached its exclusive book gate").isTrue();
                try(var stmt=connection.prepareStatement("UPDATE fin_book SET status='DISABLED' WHERE id=601")){stmt.executeUpdate();}connection.commit();
                assertThatThrownBy(()->future.get(8,TimeUnit.SECONDS)).hasRootCauseInstanceOf(ApiException.class);
                assertThat(owner.queryForObject("SELECT count(*) FROM fin_period",Integer.class)).isZero();
            }finally{connection.rollback();future.cancel(true);}
        }finally{pool.shutdownNow();}
    }
    @Test void reparentWaitsForAuthorityReadersAndNextRequestLosesWarehouseAccess()throws Exception{
        seed("insert into sys_user(id,username,password_hash,display_name,created_country_id) values(202,'store-reader','no-login','Store user',101)");
        seed("insert into sys_session(token_hash,user_id,expires_at) values(repeat('b',64),202,clock_timestamp()+interval '1 hour')");
        seed("insert into sys_user_role(country_id,user_id,role_id) values(101,202,211)");
        seed("insert into org_store(id,country_id,entity_id,code,name) values(401,101,301,'S1','Visible'),(402,101,301,'S2','Hidden')");
        seed("insert into org_warehouse(id,country_id,entity_id,store_id,code,name,type) values(501,101,301,401,'W1','Warehouse','STORE')");
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,store_id,granted_by) values(101,202,'STORE',401,201)");
        var actor=new RequestContext(202,101L,"scope-race","b".repeat(64));
        var ready=new CountDownLatch(1);var release=new CountDownLatch(1);var pool=Executors.newFixedThreadPool(2);
        try{
            var reader=pool.submit(()->inCountry(101,()->{var a=auth.authorize(actor);assertThat(a.scope().warehouses()).contains(501L);ready.countDown();try{if(!release.await(8,TimeUnit.SECONDS))throw new IllegalStateException("reader release");}catch(InterruptedException e){throw new RuntimeException(e);}return null;}));
            assertThat(ready.await(8,TimeUnit.SECONDS)).isTrue();
            var mover=pool.submit(()->org.update(ctx,"warehouses",501,Map.of("storeId",402,"version",1)));
            assertThatThrownBy(()->mover.get(150,TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            release.countDown();reader.get(8,TimeUnit.SECONDS);mover.get(8,TimeUnit.SECONDS);
            assertThatThrownBy(()->org.get(actor,"warehouses",501)).isInstanceOf(ApiException.class).extracting("status").isEqualTo(404);
        }finally{release.countDown();pool.shutdownNow();}
    }
}
