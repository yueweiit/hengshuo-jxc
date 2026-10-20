package com.hs.jxc.it;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbContext;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.AuthorizationService;
import com.hs.jxc.sys.service.DocumentAccessService;
import com.hs.jxc.sys.service.FieldPolicyService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import java.util.Map;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class AuthorizationIT extends BasePgIT {
    @Autowired AuthorizationService authorization;
    @Autowired com.hs.jxc.sys.service.SystemManagementService management;
    @Autowired FieldPolicyService fields;
    @Autowired DocumentAccessService documents;
    @org.springframework.beans.factory.annotation.Value("${local.server.port}") int port;
    static final String HASH = com.hs.jxc.sys.service.SessionService.digest("fixture-bearer");

    @Test void nativeCommandsAreDiscoverableWithoutExpandingExistingRolePermissions(){
        String before=owner.queryForObject("SELECT permissions::text FROM sys_role WHERE id=71201",String.class);
        var codes=new java.util.HashSet<String>();
        for(var module:com.hs.jxc.sys.service.PermissionCatalog.tree())for(Object child:(List<?>)module.get("children"))codes.add(String.valueOf(((Map<?,?>)child).get("code")));
        assertTrue(codes.containsAll(List.of("ap:bill:create","ap:bill:confirm","ap:bill:void","ap:settlement:reverse","ap:adjustment:create","ap:adjustment:confirm","ar:receipt:view","ar:writeoff:view","ar:writeoff:reverse","fin:event:view","lgs:receipt:create","rtn:claim:resolve","rtn:purchase:ship","rtn:refund:view","rtn:sales:view","rtn:sales:submit","rtn:sales:confirm","rtn:sales:inspect","rtn:sales:receive","sal:order:edit","sal:order:cancel","sal:order:close")));
        assertEquals(before,owner.queryForObject("SELECT permissions::text FROM sys_role WHERE id=71201",String.class));
    }

    @BeforeEach void seedAuthorization() {
        resetFixtures();
        owner.execute("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES (71001,'AUTH1','授权测试一','CNY','Asia/Shanghai','ACTIVE'),(71002,'AUTH2','授权测试二','MXN','America/Mexico_City','ACTIVE') ON CONFLICT DO NOTHING");
        owner.execute("INSERT INTO sys_authz_epoch(country_id) VALUES(71001),(71002) ON CONFLICT DO NOTHING");
        owner.execute("INSERT INTO sys_user(id,username,password_hash,display_name,status,is_platform_admin,created_country_id,locale) VALUES(71101,'auth-user','unused','Auth User','ENABLED',false,71001,'zh-CN') ON CONFLICT(id) DO UPDATE SET status='ENABLED',is_platform_admin=false");
        owner.execute("DELETE FROM sys_session WHERE user_id=71101");
        owner.execute("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES('"+HASH+"',71101,clock_timestamp()+interval '1 hour')");
        owner.execute("INSERT INTO sys_role(id,country_id,code,name,role_type,status,permissions,field_policies) VALUES(71201,71001,'AUTH_ROLE','授权测试','BUSINESS','ENABLED','[\"*\"]','{\"COST\":\"HIDDEN\",\"ORDER_TOTAL\":\"READ\"}') ON CONFLICT(id) DO UPDATE SET status='ENABLED',permissions=excluded.permissions,field_policies=excluded.field_policies");
        owner.execute("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(71001,71101,71201) ON CONFLICT DO NOTHING");
        owner.execute("DELETE FROM sys_user_data_scope WHERE user_id=71101");
        owner.execute("INSERT INTO org_entity(id,country_id,code,name,status) VALUES(71301,71001,'AUTH_ENTITY','测试主体','ENABLED') ON CONFLICT DO NOTHING");
        owner.execute("INSERT INTO org_store(id,country_id,entity_id,code,name,status) VALUES(71401,71001,71301,'AUTH_STORE','测试门店','ENABLED') ON CONFLICT DO NOTHING");
        owner.execute("INSERT INTO org_warehouse(id,country_id,entity_id,store_id,code,name,status,type) VALUES(71501,71001,71301,71401,'AUTH_WH','测试仓','ENABLED','STORE') ON CONFLICT DO NOTHING");
    }
    private RequestContext ctx() { return new RequestContext(71101L,71001L,"auth-test",HASH); }
    private Access access() { return tx.execute(s -> { dbContext.apply(71001L); return authorization.authorize(ctx()); }); }

    @Test void functionWildcardNeverGrantsDataScope() {
        Access a=access();
        a.require("fin:voucher:post");
        assertFalse(a.canRow(Map.of("countryId",71001L,"entityId",71301L)));
        assertFalse(a.canBook(1));
    }
    @Test void expiredScopesAreDeniedByDatabaseTime() {
        owner.execute("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,entity_id,effective_from,effective_to,granted_by) VALUES(71001,71101,'ENTITY',71301,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 second',71101)");
        assertFalse(access().canRow(Map.of("countryId",71001L,"entityId",71301L)));
    }
    @Test void entityGrantExpandsForwardToItsStoreAndWarehouse() {
        owner.execute("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,entity_id,granted_by) VALUES(71001,71101,'ENTITY',71301,71101)");
        Access a=access();
        assertTrue(a.canRow(Map.of("countryId",71001L,"storeId",71401L)));
        assertTrue(a.canRow(Map.of("countryId",71001L,"warehouseId",71501L)));
        assertFalse(a.canRow(Map.of("countryId",71002L,"entityId",71301L)));
    }
    @Test void warehouseGrantDoesNotGrantParentEntity() {
        owner.execute("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,warehouse_id,granted_by) VALUES(71001,71101,'WAREHOUSE',71501,71101)");
        Access a=access();
        assertTrue(a.canRow(Map.of("countryId",71001L,"warehouseId",71501L)));
        assertFalse(a.canRow(Map.of("countryId",71001L,"entityId",71301L)));
    }
    @Test void revokedSessionAndDisabledUserAreDeniedInsideAuthorizationGate() {
        owner.execute("UPDATE sys_session SET revoked_at=clock_timestamp() WHERE user_id=71101");
        assertEquals(401,assertThrows(ApiException.class,this::access).getStatus());
    }
    @Test void aHeaderCannotAuthorizeAnotherCountry() {
        assertEquals(403,assertThrows(ApiException.class,()->tx.execute(s->{dbContext.apply(71002L);return authorization.authorize(new RequestContext(71101L,71002L,"test",HASH));})).getStatus());
    }
    @Test void explicitFieldRegistryMasksNestedCostAndRejectsWriteForReadOnlyAmounts() {
        Map<String,Object> result=fields.mask(access(),Map.of("id",1,"unitCost",12,"lines",java.util.List.of(Map.of("costAmount",20,"amount",30))),"ORDER_TOTAL");
        assertFalse(result.containsKey("unitCost"));
        assertFalse(((Map<?,?>)((java.util.List<?>)result.get("lines")).getFirst()).containsKey("costAmount"));
        assertEquals(403,assertThrows(ApiException.class,()->fields.requireWrite(access(),Map.of("amount",10),"ORDER_TOTAL")).getStatus());
    }
    @Test void unknownDocumentTypeFailsClosedEvenWithWildcardAndCountryAll() {
        owner.execute("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(71001,71101,'COUNTRY_ALL',71101)");
        assertEquals(404,assertThrows(ApiException.class,()->tx.execute(s->{dbContext.apply(71001L);return documents.requireDocumentAccess(authorization.authorize(ctx()),"UNREGISTERED_M2",1L,false);})).getStatus());
    }
    @Test void loginPersistsOnlyTokenDigestAndLogoutRevokesSession() throws Exception {
        String hash=new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder().encode("fixture-long-password");
        owner.update("UPDATE sys_user SET password_hash=? WHERE id=71101",hash);
        java.net.http.HttpClient http=java.net.http.HttpClient.newHttpClient();
        var response=http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://localhost:"+port+"/api/v1/auth/login"))
            .header("Content-Type","application/json").POST(java.net.http.HttpRequest.BodyPublishers.ofString("{\"username\":\"auth-user\",\"password\":\"fixture-long-password\"}")).build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertEquals(200,response.statusCode(),response.body());
        var json=tools.jackson.databind.json.JsonMapper.builder().build().readTree(response.body());
        String token=json.get("data").get("token").asString();
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM sys_session WHERE token_hash=?",Integer.class,token));
        var logout=http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://localhost:"+port+"/api/v1/auth/logout"))
            .header("Authorization","Bearer "+token).POST(java.net.http.HttpRequest.BodyPublishers.noBody()).build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertEquals(200,logout.statusCode(),logout.body());
        var me=http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://localhost:"+port+"/api/v1/auth/me"))
            .header("Authorization","Bearer "+token).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertEquals(401,me.statusCode(),me.body());
    }

    @Test void countryAdministratorCannotGrantCountryAllWithoutAnOwnDataGrant() throws Exception {
        var response=java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://localhost:"+port+"/api/v1/sys/users/71101/data-scopes"))
            .header("Authorization","Bearer fixture-bearer").header("X-Country-Id","71001").header("Content-Type","application/json")
            .PUT(java.net.http.HttpRequest.BodyPublishers.ofString("{\"version\":1,\"dataScopes\":[{\"scopeType\":\"COUNTRY_ALL\"}]}"))
            .build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertEquals(403,response.statusCode(),response.body());
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM sys_user_data_scope WHERE user_id=71101",Integer.class));
    }

    @Test void authorizationWaitsForRevocationThenReadsCurrentPermissions() throws Exception {
        try(var connection=owner.getDataSource().getConnection()) {
            connection.setAutoCommit(false);
            try(var statement=connection.createStatement()) {
                statement.execute("SELECT epoch FROM sys_authz_epoch WHERE country_id=0 FOR SHARE");
                statement.execute("SELECT epoch FROM sys_authz_epoch WHERE country_id=71001 FOR UPDATE");
                statement.execute("UPDATE sys_role SET permissions='[]'::jsonb WHERE id=71201");
                var started=new java.util.concurrent.CountDownLatch(1);
                var pending=java.util.concurrent.CompletableFuture.supplyAsync(()->{started.countDown();return access();});
                assertTrue(started.await(2,java.util.concurrent.TimeUnit.SECONDS));
                assertThrows(java.util.concurrent.TimeoutException.class,()->pending.get(150,java.util.concurrent.TimeUnit.MILLISECONDS));
                connection.commit();
                assertFalse(pending.get(5,java.util.concurrent.TimeUnit.SECONDS).has("fin:voucher:post"));
            }
        }
    }
    @Test void authorizationExpiryBeforeCommitRollsBackTheWholeTransaction() {
        owner.execute("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,effective_from,effective_to,granted_by) VALUES(71001,71101,'COUNTRY_ALL',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 second',71101)");
        assertEquals(403,assertThrows(ApiException.class,()->tx.execute(s->{
            dbContext.apply(71001L);authorization.authorize(ctx());
            jdbc.update("UPDATE org_entity SET name='must rollback' WHERE id=71301");
            jdbc.execute("SELECT pg_sleep(1.2)");return null;
        })).getStatus());
        assertEquals("测试主体",owner.queryForObject("SELECT name FROM org_entity WHERE id=71301",String.class));
    }
    @Test void trustedDocumentResolverLoadsRealOwnership() {
        owner.execute("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,entity_id,granted_by) VALUES(71001,71101,'ENTITY',71301,71101)");
        var row=tx.execute(s->{dbContext.apply(71001L);return documents.requireDocumentAccess(authorization.authorize(ctx()),"ORG_WAREHOUSE",71501L,false);});
        assertEquals(71501L,((Number)row.get("warehouseId")).longValue());
        assertEquals(71001L,((Number)row.get("countryId")).longValue());
    }

    @Test void sharedAuthorizationCannotBeUpgradedToPolicyWriteInTheSameTransaction() {
        assertThrows(IllegalStateException.class,()->tx.execute(s->{authorization.authorize(ctx());authorization.authorizePolicyWrite(ctx(),false);return null;}));
    }
    @Test void openingStoreGrantsAppendOnceAndUseTheScopeExpiryInsteadOfSessionExpiry() {
        owner.execute("INSERT INTO sys_user(id,username,password_hash,display_name,created_country_id) VALUES(71102,'store-user','unused','New store user',71001)");
        owner.execute("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,entity_id,effective_from,effective_to,granted_by) VALUES(71001,71101,'ENTITY',71301,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '2 hours',71101)");
        management.grantNewStoreUsers(ctx(),71401L,java.util.List.of(71102L));
        management.grantNewStoreUsers(ctx(),71401L,java.util.List.of(71102L));
        assertEquals(1,owner.queryForObject("SELECT count(*) FROM sys_user_data_scope WHERE user_id=71102 AND store_id=71401",Integer.class));
        var scopeEnd=owner.queryForObject("SELECT effective_to FROM sys_user_data_scope WHERE user_id=71102 AND store_id=71401",java.sql.Timestamp.class).toInstant();
        var sessionEnd=owner.queryForObject("SELECT expires_at FROM sys_session WHERE token_hash=?",java.sql.Timestamp.class,HASH).toInstant();
        assertTrue(scopeEnd.isAfter(sessionEnd.plusSeconds(3500)));
    }

    @Test void oneGrantCommandCommitsRolesScopesAndVersionAtomically() throws Exception {
        owner.execute("INSERT INTO sys_user(id,username,password_hash,display_name,created_country_id) VALUES(71102,'atomic-grant-user','unused','Atomic grant user',71001)");
        owner.execute("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(71001,71101,'COUNTRY_ALL',71101)");
        var http=java.net.http.HttpClient.newHttpClient();
        var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://localhost:"+port+"/api/v1/sys/users/71102/grants"))
            .header("Authorization","Bearer fixture-bearer").header("X-Country-Id","71001").header("Content-Type","application/json");
        var denied=http.send(request.PUT(java.net.http.HttpRequest.BodyPublishers.ofString("{\"version\":1,\"roleIds\":[71201],\"dataScopes\":[{\"scopeType\":\"WAREHOUSE\",\"scopeRefId\":999999}]}" )).build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertEquals(400,denied.statusCode(),denied.body());
        assertEquals(1,owner.queryForObject("SELECT version FROM sys_user WHERE id=71102",Integer.class));
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM sys_user_role WHERE user_id=71102",Integer.class));
        var accepted=http.send(request.PUT(java.net.http.HttpRequest.BodyPublishers.ofString("{\"version\":1,\"roleIds\":[71201],\"dataScopes\":[{\"scopeType\":\"WAREHOUSE\",\"scopeRefId\":71501}]}" )).build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertEquals(200,accepted.statusCode(),accepted.body());
        assertEquals(2,owner.queryForObject("SELECT version FROM sys_user WHERE id=71102",Integer.class));
        assertEquals(1,owner.queryForObject("SELECT count(*) FROM sys_user_role WHERE user_id=71102",Integer.class));
        assertEquals(1,owner.queryForObject("SELECT count(*) FROM sys_user_data_scope WHERE user_id=71102 AND warehouse_id=71501",Integer.class));
        var stale=http.send(request.PUT(java.net.http.HttpRequest.BodyPublishers.ofString("{\"version\":1,\"roleIds\":[],\"dataScopes\":[]}" )).build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertEquals(409,stale.statusCode(),stale.body());
        assertEquals(1,owner.queryForObject("SELECT count(*) FROM sys_user_role WHERE user_id=71102",Integer.class));
    }

    @Test void countryGrantReplacementUsesTheReturnedUserVersion() {
        owner.execute("INSERT INTO sys_user(id,username,password_hash,display_name,created_country_id) VALUES(71102,'grant-user','unused','Grant user',71001)");
        var first=management.setRoles(ctx(),71102L,null,List.of(71201L),1L);
        assertEquals(2L,((Number)first.get("version")).longValue());
        assertEquals(409,assertThrows(ApiException.class,()->management.setScopes(ctx(),71102L,null,List.of(),1L)).getStatus());
        assertEquals(3L,((Number)management.setScopes(ctx(),71102L,null,List.of(),2L).get("version")).longValue());
    }

    @Test void disabledCountryKeepsHistoricalUserReadsButCannotMutateGlobalAccounts() {
        owner.execute("UPDATE sys_country SET status='DRAFT' WHERE id=71001");
        var created=management.createUser(ctx(),Map.of("username","lifecycle-target","displayName","Draft user","password","fixture-password-123"));
        long target=((Number)created.get("id")).longValue();
        management.updateUser(ctx(),target,Map.of("displayName","Draft configured","version",created.get("version")));
        owner.execute("UPDATE sys_country SET status='ACTIVE' WHERE id=71001");
        management.updateUser(ctx(),target,Map.of("displayName","Historical user","version",2));
        owner.update("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(repeat('b',64),?,clock_timestamp()+interval '1 hour')",target);
        var before=owner.queryForMap("SELECT display_name,status,password_hash,version FROM sys_user WHERE id=?",target);
        int accounts=owner.queryForObject("SELECT count(*) FROM sys_user",Integer.class);
        owner.execute("UPDATE sys_country SET status='DISABLED' WHERE id=71001");
        assertEquals("Historical user",management.user(ctx(),target).get("displayName"));
        assertAll(
            ()->assertEquals("SYS_COUNTRY_DISABLED",assertThrows(ApiException.class,()->management.createUser(ctx(),Map.of("username","disabled-new-user","displayName","Blocked","password","fixture-password-123"))).getCode()),
            ()->assertEquals("SYS_COUNTRY_DISABLED",assertThrows(ApiException.class,()->management.updateUser(ctx(),target,Map.of("displayName","Blocked","version",3))).getCode()),
            ()->assertEquals("SYS_COUNTRY_DISABLED",assertThrows(ApiException.class,()->management.toggleUser(ctx(),target,false)).getCode()),
            ()->assertEquals("SYS_COUNTRY_DISABLED",assertThrows(ApiException.class,()->management.toggleUser(ctx(),target,true)).getCode()),
            ()->assertEquals("SYS_COUNTRY_DISABLED",assertThrows(ApiException.class,()->management.resetPassword(ctx(),target)).getCode())
        );
        assertEquals(before,owner.queryForMap("SELECT display_name,status,password_hash,version FROM sys_user WHERE id=?",target));
        assertEquals(accounts,owner.queryForObject("SELECT count(*) FROM sys_user",Integer.class));
        assertNull(owner.queryForObject("SELECT revoked_at FROM sys_session WHERE user_id=?",java.sql.Timestamp.class,target));
        assertEquals("Historical user",management.user(ctx(),target).get("displayName"));
    }

}
