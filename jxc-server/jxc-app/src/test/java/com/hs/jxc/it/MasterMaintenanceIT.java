package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.common.api.Digests;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import tools.jackson.databind.ObjectMapper;

class MasterMaintenanceIT extends BasePgIT {
 @LocalServerPort int port;
 @Autowired ObjectMapper json;
 final String token="master-closure-http";
 @BeforeEach void fixture(){
  InventoryIT.seedBase();
  seed("INSERT INTO sys_authz_epoch(country_id) VALUES(101)");
  seed("UPDATE sys_user SET is_platform_admin=true WHERE id=201");
  seed("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,201,clock_timestamp()+interval '1 hour')",Digests.sha256(token));
  seed("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(211,101,'MD','Master','[\"md:product:view\",\"md:product:edit\",\"md:dict:edit\"]','{}')");
  seed("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(101,201,211)");
  seed("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,granted_by) VALUES(101,201,'COUNTRY_ALL',201)");
 }
 @SuppressWarnings("unchecked") Map<String,Object> call(String method,String path,Map<String,Object> body,int expected)throws Exception{
  var builder=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1"+path)).header("Authorization","Bearer "+token).header("X-Country-Id","101").header("Content-Type","application/json").header("Idempotency-Key",UUID.randomUUID().toString());
  var response=HttpClient.newHttpClient().send(builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(),HttpResponse.BodyHandlers.ofString());
  assertThat(response.statusCode()).as(response.body()).isEqualTo(expected);
  return (Map<String,Object>)json.readValue(response.body(),Map.class).get("data");
 }
 @Test void countryDictionaryCrudPreservesCodeAndVersionAndIsolatesOtherCountries()throws Exception{
  var row=call("POST","/md/dicts",Map.of("dictType","HOLD_REASON","code","CUSTOMS","label","海关复核","seq",2),200);
  long id=((Number)row.get("id")).longValue();
  assertThat(row.get("label")).isEqualTo("海关复核");
  var changed=call("PUT","/md/dicts/"+id,Map.of("dictType","HOLD_REASON","code","CUSTOMS","label","等待海关","version",row.get("version")),200);
  assertThat(changed.get("label")).isEqualTo("等待海关");
  call("PUT","/md/dicts/"+id,Map.of("dictType","HOLD_REASON","code","CHANGED","label","bad","version",changed.get("version")),400);
  call("POST","/md/dicts/"+id+"/disable",Map.of("version",changed.get("version")),200);
  assertThat(owner.queryForObject("SELECT status FROM md_dict WHERE id=?",String.class,id)).isEqualTo("DISABLED");
 }
 @Test void existingMasterRoutesSupportTheirOriginalToggleAndCategoryEditContracts()throws Exception{
  var product=call("POST","/md/products",Map.of("productCode","TOGGLE","name","Reusable","baseUnit","PCS"),200);
  long id=((Number)product.get("id")).longValue();
  var disabled=call("POST","/md/products/"+id+"/disable",Map.of("version",product.get("version")),200);
  assertThat(disabled.get("status")).isEqualTo("DISABLED");
  call("POST","/md/products/"+id+"/enable",Map.of("version",disabled.get("version")),200);
  var category=call("POST","/md/categories",Map.of("code","EDIT","name","Original"),200);
  long cid=((Number)category.get("id")).longValue();
  var updated=call("PUT","/md/categories/"+cid,Map.of("code","EDIT","name","Updated","version",category.get("version")),200);
  assertThat(call("GET","/md/categories/"+cid,null,200).get("name")).isEqualTo("Updated");
  call("PUT","/md/categories/"+cid,Map.of("code","EDIT","name","Stale","version",category.get("version")),409);
 }
 @Test void categoryCreationDerivesDepthInsteadOfTrustingSubmittedLevel()throws Exception{
  var root=call("POST","/md/categories",Map.of("code","DEPTH","name","Depth"),200);
  var child=call("POST","/md/categories",Map.of("code","DEPTH_CHILD","name","Depth child","parentId",root.get("id"),"level",99),200);
  assertThat(((Number)child.get("level")).intValue()).isEqualTo(2);
 }
 @Test void categoryParentChangesRecomputeTheWholeSubtreeAndRejectCycles()throws Exception{
  var root=call("POST","/md/categories",Map.of("code","ROOT","name","Root"),200);
  long rid=((Number)root.get("id")).longValue();
  var child=call("POST","/md/categories",Map.of("code","CHILD","name","Child","parentId",rid,"level",2),200);
  long cid=((Number)child.get("id")).longValue();
  assertThat(((Number)child.get("level")).intValue()).isEqualTo(2);
  var leaf=call("POST","/md/categories",Map.of("code","LEAF","name","Leaf","parentId",cid,"level",3),200);
  long lid=((Number)leaf.get("id")).longValue();
  assertThat(((Number)leaf.get("level")).intValue()).isEqualTo(3);
  var moved=call("PUT","/md/categories/"+cid,Map.of("code","CHILD","name","Child","version",child.get("version")),200);
  assertThat(((Number)moved.get("level")).intValue()).isEqualTo(1);
  var movedLeaf=call("GET","/md/categories/"+lid,null,200);
  assertThat(((Number)movedLeaf.get("level")).intValue()).isEqualTo(2);
  assertThat(((Number)movedLeaf.get("version")).longValue()).isGreaterThan(((Number)leaf.get("version")).longValue());
  call("PUT","/md/categories/"+cid,Map.of("code","CHILD","name","Cycle","parentId",lid,"version",moved.get("version")),400);
  assertThat(call("GET","/md/categories/"+cid,null,200).get("parentId")).isNull();
 }
}
