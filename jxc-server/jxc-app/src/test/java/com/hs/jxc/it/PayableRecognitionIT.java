package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.sys.jobs.CountryWorkProvider;
import com.hs.jxc.common.api.JsonCodec;
import java.net.*;import java.net.http.*;import java.util.*;
import org.junit.jupiter.api.Test;import org.springframework.beans.factory.annotation.Autowired;import org.springframework.boot.test.web.server.LocalServerPort;
class PayableRecognitionIT extends SupplyFixtures {
 @LocalServerPort int port;@Autowired JsonCodec json;@Autowired List<CountryWorkProvider> workers;
 Map<String,Object> request(String method,Map<String,Object>body)throws Exception{return request(method,body,key());}
 Map<String,Object> request(String method,Map<String,Object>body,String intent)throws Exception{return requestAt("/ap/recognition-rules/PURCHASE",method,body,intent);}
 Map<String,Object> requestAt(String path,String method,Map<String,Object>body,String intent)throws Exception{var builder=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1"+path)).header("Authorization","Bearer supply-fixture").header("X-Country-Id","101").header("Idempotency-Key",intent).header("Content-Type","application/json");var response=HttpClient.newHttpClient().send(builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.write(body))).build(),HttpResponse.BodyHandlers.ofString());var out=json.readMap(response.body());out.put("httpStatus",response.statusCode());return out;}
 @Test void receiptRecognitionNeedsAnExplicitCurrentSubjectAndOnlyCreatesTheExistingDraft()throws Exception{
  assertThat(request("GET",null).toString()).contains("BILL_CONFIRMED");
  var d=delivery();var receipt=receipt(d);lgs.action(c(),"receipts",id(receipt),"confirm",Map.of(),key());
  // The owning PURCHASE receipt event is emitted before logistics; use the original received purchase source.
  assertThat(request("PUT",Map.of("mode","RECEIPT_CONFIRMED")).get("httpStatus")).isEqualTo(400);
  String intent=key();var body=Map.<String,Object>of("mode","RECEIPT_CONFIRMED","executionSubjectUserId",201);var configured=request("PUT",body,intent);assertThat(configured.get("httpStatus")).isEqualTo(200);assertThat(request("PUT",body,intent).get("data")).isEqualTo(configured.get("data"));
  var worker=workers.stream().filter(w->w.kind().equals("AP_RECOGNITION")).findFirst().orElseThrow();worker.recover(101,100);worker.recover(101,100);
  assertThat(owner.queryForObject("SELECT count(*) FROM ap_bill",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("SELECT status FROM ap_bill",String.class)).isEqualTo("DRAFT");
  assertThat(owner.queryForObject("SELECT count(*) FROM sys_biz_event WHERE event_type='AP_BILL_CONFIRMED'",Integer.class)).isZero();assertThat(owner.queryForObject("SELECT count(*) FROM fin_voucher",Integer.class)).isZero();
  seed("UPDATE sys_role SET permissions='[\"ap:recognition:edit\"]' WHERE id=202");assertThat(request("PUT",Map.of("mode","RECEIPT_CONFIRMED","executionSubjectUserId",201)).get("httpStatus")).isEqualTo(403);
 }
 @Test void automaticRuleReadinessAndActivationRecheckTheConfiguredSubjectsCurrentAuthority()throws Exception{
  assertThat(request("PUT",Map.of("mode","RECEIPT_CONFIRMED","executionSubjectUserId",201)).get("httpStatus")).isEqualTo(200);
  seed("UPDATE sys_user SET is_platform_admin=true WHERE id=201");
  var before=requestAt("/sys/countries/101","GET",null,key());assertThat(before.get("httpStatus")).isEqualTo(200);
  seed("UPDATE sys_role SET permissions='[\"sys:country:view\"]' WHERE id=202");
  var readiness=requestAt("/sys/countries/101/readiness?action=ACTIVATE","GET",null,key());assertThat(readiness.get("httpStatus")).isEqualTo(200);assertThat(readiness.get("data").toString()).contains("AP_RECOGNITION_SUBJECT_INVALID","BLOCK");
  var page=requestAt("/sys/countries/101","GET",null,key());assertThat(((Number)((Map<?,?>)page.get("data")).get("blockCount")).intValue()).isEqualTo(((Number)((Map<?,?>)before.get("data")).get("blockCount")).intValue()+1);
  var activate=requestAt("/sys/countries/101/activate","POST",Map.of(),key());assertThat(activate.get("httpStatus")).isEqualTo(409);assertThat(activate.toString()).contains("AP_RECOGNITION_SUBJECT_INVALID");
 }

}
