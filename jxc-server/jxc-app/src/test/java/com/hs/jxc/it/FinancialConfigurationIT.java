package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.fin.api.FinancialReferenceProvider;
import com.hs.jxc.sys.service.AuthorizationService;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import tools.jackson.databind.json.JsonMapper;

/** Existing MD configuration paths must feed the existing FIN account rules. */
class FinancialConfigurationIT extends PayablesFixtures {
    @Value("${local.server.port}") int port;
    @Autowired AuthorizationService authorization;
    @Autowired List<FinancialReferenceProvider> references;
    final HttpClient http=HttpClient.newHttpClient();final JsonMapper json=JsonMapper.builder().build();
    @BeforeEach void accounts(){
        seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(602,101,301,'B2','Other book','MXN','ACTIVE')");
        seed("insert into fin_account(id,country_id,book_id,code,name,category,direction,is_bank,is_cash,is_leaf) values(1101,101,601,'1002','Bank GL','ASSET','DEBIT',true,false,true),(1102,101,601,'6601','Expense GL','EXPENSE','DEBIT',false,false,true),(1103,101,601,'10','Group GL','ASSET','DEBIT',false,false,false),(1104,101,601,'1001','Cash GL','ASSET','DEBIT',false,true,true),(1201,101,602,'1002','Other GL','ASSET','DEBIT',true,false,true)");
    }
    @Test void draftBookActivationReplaysOneConfigurationChangeWithoutInventingFinancialFacts()throws Exception{
        draftBook();String intent=key();var body=Map.<String,Object>of("version",1);
        var active=data(ok("POST","/fin/books/603/activate",body,intent));
        assertThat(active).containsEntry("status","ACTIVE").containsEntry("version",2);
        assertThat(data(ok("POST","/fin/books/603/activate",body,intent))).containsEntry("version",2);
        assertThat(send("POST","/fin/books/603/activate",body,key()).statusCode()).isEqualTo(409);
        assertThat(owner.queryForObject("select count(*) from sys_audit_log where resource_type='book' and resource_id=603",Integer.class)).isEqualTo(1);
        for(String table:List.of("fin_period","fin_account","fin_opening_balance","fin_account_balance","fin_voucher","fin_snapshot"))
            assertThat(owner.queryForObject("select count(*) from "+table+" where book_id=603",Integer.class)).as(table).isZero();
    }
    @Test void bookNameUsesVersionAndRejectsOwnershipCurrencyAndStatusOverposting()throws Exception{
        var renamed=data(ok("PUT","/fin/books/601",Map.of("name","Renamed book","version",1),key()));
        assertThat(renamed).containsEntry("name","Renamed book").containsEntry("version",2);
        assertThat(send("PUT","/fin/books/601",Map.of("name","Stale","version",1),key()).statusCode()).isEqualTo(409);
        for(String field:List.of("baseCurrency","entityId","status")){
            Object value=field.equals("baseCurrency")?"CNY":field.equals("entityId")?302:"DISABLED";
            assertThat(send("PUT","/fin/books/601",Map.of("name","Not applied","version",2,field,value),key()).statusCode()).isEqualTo(400);
        }
        assertThat(owner.queryForMap("select name,base_currency,entity_id,status,version from fin_book where id=601"))
            .containsEntry("name","Renamed book").containsEntry("base_currency","MXN").containsEntry("entity_id",301L).containsEntry("status","ACTIVE").containsEntry("version",2);
    }
    @Test void bookActivationRequiresCurrentPermissionScopeAndWritableCountry()throws Exception{
        draftBook();var body=Map.<String,Object>of("version",1);String deniedIntent=key();
        assertThat(send("POST","/fin/books/999999/activate",body,key()).statusCode()).isEqualTo(404);
        assertThat(send("PUT","/fin/books/999999",Map.of("name","Missing","version",1),key()).statusCode()).isEqualTo(404);
        seed("update sys_role set permissions='[\"fin:report:view\"]' where id=202");
        assertThat(send("POST","/fin/books/603/activate",body,deniedIntent).statusCode()).isEqualTo(403);
        seed("update sys_role set permissions='[\"fin:book:config\"]' where id=202");
        seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,201,'BOOK',601,201)");
        assertThat(send("POST","/fin/books/603/activate",body,deniedIntent).statusCode()).isEqualTo(404);
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,201,'BOOK',603,201)");
        var active=data(ok("POST","/fin/books/603/activate",body,deniedIntent));
        seed("update sys_role set permissions='[\"fin:report:view\"]' where id=202");
        assertThat(send("POST","/fin/books/603/activate",body,deniedIntent).statusCode()).isEqualTo(403);
        seed("update sys_role set permissions='[\"fin:book:config\"]' where id=202");
        seed("delete from sys_user_data_scope where user_id=201 and book_id=603");
        assertThat(send("POST","/fin/books/603/activate",body,deniedIntent).statusCode()).isEqualTo(404);
        seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,201,'BOOK',603,201)");
        seed("update sys_country set status='DISABLED' where id=101");
        assertThat(send("POST","/fin/books/603/activate",body,deniedIntent).statusCode()).isEqualTo(409);
        assertThat(send("PUT","/fin/books/603",Map.of("name","Denied","version",active.get("version")),key()).statusCode()).isEqualTo(409);
        assertThat(owner.queryForObject("select name from fin_book where id=603",String.class)).isEqualTo("Draft book");
    }
    @Test void concurrentBookActivationUsesOneVersionAndRejectsMissingCurrencyOrDisabledEntity()throws Exception{
        draftBook();seed("update md_currency set status='DISABLED' where code='MXN'");
        assertThat(send("POST","/fin/books/603/activate",Map.of("version",1),key()).statusCode()).isEqualTo(400);
        seed("update md_currency set status='ENABLED' where code='MXN'");seed("update org_entity set status='DISABLED' where id=301");
        assertThat(send("POST","/fin/books/603/activate",Map.of("version",1),key()).statusCode()).isEqualTo(400);
        seed("update org_entity set status='ENABLED' where id=301");
        var executor=Executors.newFixedThreadPool(2);var start=new CountDownLatch(1);
        try{
            var jobs=List.of(executor.submit(()->{start.await();return send("POST","/fin/books/603/activate",Map.of("version",1),key()).statusCode();}),executor.submit(()->{start.await();return send("POST","/fin/books/603/activate",Map.of("version",1),key()).statusCode();}));
            start.countDown();assertThat(List.of(jobs.get(0).get(20,TimeUnit.SECONDS),jobs.get(1).get(20,TimeUnit.SECONDS))).containsExactlyInAnyOrder(200,409);
        }finally{executor.shutdownNow();}
        assertThat(owner.queryForObject("select version from fin_book where id=603",Integer.class)).isEqualTo(2);
    }
    @Test void aFinalAuditFailureRollsBackBookActivationVersionAndIdempotency()throws Exception{
        draftBook();String intent=key();var body=Map.<String,Object>of("version",1);
        owner.execute("CREATE FUNCTION book_activation_audit_fail_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_type='book' AND NEW.resource_id=603 THEN RAISE EXCEPTION 'SYNTHETIC_BOOK_AUDIT_FAILURE';END IF;RETURN NEW;END $$");
        owner.execute("CREATE TRIGGER book_activation_audit_fail_test BEFORE INSERT ON sys_audit_log FOR EACH ROW EXECUTE FUNCTION book_activation_audit_fail_test()");
        try{
            assertThat(send("POST","/fin/books/603/activate",body,intent).statusCode()).isEqualTo(500);
            assertThat(owner.queryForMap("select status,version from fin_book where id=603")).containsEntry("status","DRAFT").containsEntry("version",1);
            assertThat(owner.queryForObject("select count(*) from sys_idempotency where key=?",Integer.class,intent)).isZero();
        }finally{owner.execute("DROP TRIGGER book_activation_audit_fail_test ON sys_audit_log");owner.execute("DROP FUNCTION book_activation_audit_fail_test()");}
        assertThat(data(ok("POST","/fin/books/603/activate",body,intent))).containsEntry("status","ACTIVE").containsEntry("version",2);
    }
    void draftBook(){seed("insert into fin_book(id,country_id,entity_id,code,name,base_currency,status) values(603,101,301,'DRAFT','Draft book','MXN','DRAFT')");}
    @Test void fundOriginalPathPersistsTypedGlBindingAndReplaysCreateAndUpdate()throws Exception{
        var body=fund("New bank",1101);String key=key();var saved=data(ok("POST","/md/fund-accounts",body,key));long id=id(saved);assertThat(saved).containsEntry("glAccountId",1101);
        assertThat(id(data(ok("POST","/md/fund-accounts",body,key)))).isEqualTo(id);
        assertThat(data(ok("GET","/md/fund-accounts/"+id,null,key()))).containsEntry("bookId",601);
        var edit=new LinkedHashMap<String,Object>(body);edit.put("name","Changed bank");edit.put("version",saved.get("version"));String updateKey=key();var updated=data(ok("PUT","/md/fund-accounts/"+id,edit,updateKey));assertThat(updated).containsEntry("name","Changed bank");
        assertThat(data(ok("PUT","/md/fund-accounts/"+id,edit,updateKey)).get("version")).isEqualTo(updated.get("version"));assertThat(send("PUT","/md/fund-accounts/"+id,edit,key()).statusCode()).isEqualTo(409);
        seed("update sys_role set field_policies='{\"BANK_INFO\":\"READ\"}' where id=202");assertThat(send("POST","/md/fund-accounts",body,key).statusCode()).isEqualTo(403);
        assertThat(owner.queryForObject("select count(*) from md_fund_account where name='Changed bank'",Integer.class)).isEqualTo(1);
    }
    @Test void fundBindingRejectsWrongBookTypeNonleafAndUnauthorizedScope()throws Exception{
        assertThat(send("POST","/md/fund-accounts",fund("Cash mismatch",1104),key()).statusCode()).isEqualTo(400);
        assertThat(send("POST","/md/fund-accounts",fund("Other book",1201),key()).statusCode()).isIn(400,404);
        assertThat(send("POST","/md/fund-accounts",fund("Nonleaf",1103),key()).statusCode()).isEqualTo(400);
        seed("delete from sys_user_data_scope where user_id=201");seed("insert into sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) values(101,201,'BOOK',602,201)");
        assertThat(send("GET","/md/fund-accounts/901",null,key()).statusCode()).isEqualTo(404);
        assertThat(send("PUT","/md/fund-accounts/901",Map.of("version",1,"glAccountId",1101),key()).statusCode()).isEqualTo(404);
    }
    @Test void expenseOriginalPathPersistsAccountAndPutReplaysWithoutASecondVersion()throws Exception{
        var body=Map.<String,Object>of("code","NEW-F","name","Configured fee","costTreatment","EXPENSE","bookId",601,"accountId",1102);var expense=data(ok("POST","/md/expense-items",body,key()));long id=id(expense);
        assertThat(expense).containsEntry("accountId",1102);
        var edit=new LinkedHashMap<String,Object>(body);edit.put("name","Updated fee");edit.put("version",expense.get("version"));String key=key();var updated=data(ok("PUT","/md/expense-items/"+id,edit,key));assertThat(data(ok("PUT","/md/expense-items/"+id,edit,key)).get("version")).isEqualTo(updated.get("version"));
        var wrong=new LinkedHashMap<>(edit);wrong.put("version",updated.get("version"));wrong.put("accountId",1201);assertThat(send("PUT","/md/expense-items/"+id,wrong,key()).statusCode()).isIn(400,404);
        assertThat(owner.queryForObject("select account_id from md_expense_item where id=?",Long.class,id)).isEqualTo(1102);
    }
    @Test void existingFundAndExpenseRulesResolveThroughCanonicalAliases(){
        seed("update md_fund_account set gl_account_id=1101 where id=901");seed("update md_expense_item set account_id=1102 where id=803");
        for(String rule:List.of("FUND_ACCOUNT","EXPENSE_ITEM")){
            var provider=references.stream().filter(p->p.supports(rule)).findFirst().orElseThrow(()->new AssertionError("Missing financial rule alias: "+rule));
            Long actual=inCountry(101,()->provider.accountId(authorization.authorize(c()),601,rule,rule.equals("FUND_ACCOUNT")?901:803));assertThat(actual).isEqualTo(rule.equals("FUND_ACCOUNT")?1101L:1102L);
        }
    }
    @Test void anUnboundFundMayBeAssignedOnlyBeforeAnyFinancialSourceReferencesIt()throws Exception{
        seed("insert into md_fund_account(id,country_id,entity_id,name,account_type,currency) values(902,101,301,'Unused fund','BANK','MXN'),(903,101,301,'Used fund','BANK','MXN')");
        var binding=new LinkedHashMap<String,Object>(fund("Unused fund",1101));binding.put("version",1);assertThat(data(ok("PUT","/md/fund-accounts/902",binding,key()))).containsEntry("bookId",601);
        ap.createFunding(c(),"payments",Map.of("fundAccountId",903,"bookId",601,"partnerId",801,"partnerType","SUPPLIER","currency","MXN","amount",5,"payDate","2026-10-15"),key());
        var used=new LinkedHashMap<String,Object>(fund("Used fund",1101));used.put("version",1);assertThat(send("PUT","/md/fund-accounts/903",used,key()).statusCode()).isEqualTo(400);assertThat(owner.queryForObject("select book_id from md_fund_account where id=903",Long.class)).isNull();
    }
    @Test void storeFundExtensionUsesExistingMdBindingAndRollsBackStoreOnDeniedBankWrite() throws Exception {
        var store=new LinkedHashMap<String,Object>();store.put("entityId",301);store.put("code","STORE-FUND");store.put("name","Store fund");store.put("fundAccount",fund("Store bank",1101));
        seed("update sys_role set field_policies='{\"BANK_INFO\":\"READ\"}' where id=202");
        assertThat(send("POST","/org/stores",store,key()).statusCode()).isEqualTo(403);
        assertThat(owner.queryForObject("select count(*) from org_store where code='STORE-FUND'",Integer.class)).isZero();
        seed("update sys_role set field_policies='{\"BANK_INFO\":\"WRITE\",\"COST\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\"}' where id=202");
        var wrong=new LinkedHashMap<String,Object>(fund("Store bank",1201));store.put("fundAccount",wrong);
        assertThat(send("POST","/org/stores",store,key()).statusCode()).isIn(400,404);
        assertThat(owner.queryForObject("select count(*) from org_store where code='STORE-FUND'",Integer.class)).isZero();
        store.put("fundAccount",fund("Store bank",1101));var created=data(ok("POST","/org/stores",store,key()));
        var account=owner.queryForMap("select book_id,gl_account_id,store_id from md_fund_account where name='Store bank'");
        assertThat(((Number)account.get("book_id")).longValue()).isEqualTo(601);assertThat(((Number)account.get("gl_account_id")).longValue()).isEqualTo(1101);assertThat(((Number)account.get("store_id")).longValue()).isEqualTo(id(created));
    }
    Map<String,Object> fund(String name,long account){return Map.of("name",name,"accountType","BANK","entityId",301,"bookId",601,"currency","MXN","glAccountId",account);}
    @SuppressWarnings("unchecked") Map<String,Object> data(HttpResponse<String> r){return (Map<String,Object>)json.readValue(r.body(),Map.class).get("data");}
    HttpResponse<String> ok(String method,String path,Map<String,Object>body,String key)throws Exception{var r=send(method,path,body,key);assertThat(r.statusCode()).withFailMessage(r.body()).isEqualTo(200);return r;}
    HttpResponse<String> send(String method,String path,Map<String,Object>body,String key)throws Exception{var b=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/v1"+path)).header("Authorization","Bearer ap-rtn-fixture").header("X-Country-Id","101").header("Content-Type","application/json");if(!method.equals("GET"))b.header("Idempotency-Key",key);return http.send(b.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(),HttpResponse.BodyHandlers.ofString());}
}
