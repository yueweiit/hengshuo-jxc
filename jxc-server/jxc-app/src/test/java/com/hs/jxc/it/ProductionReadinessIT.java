package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import java.net.URI;
import java.net.http.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.test.context.TestPropertySource;
/** Process liveness must not masquerade as deployable financial/storage capability. */
@TestPropertySource(properties={"jxc.production.enabled=true","management.endpoint.health.probes.enabled=true","management.endpoint.health.group.readiness.include=readinessState,db,productionCapabilities","jxc.bank-encryption-key=","jxc.storage.endpoint="})
class ProductionReadinessIT extends BasePgIT {
 @Value("${local.server.port}") int port;
 @Test void configuredPrivateStorageAndBankKeyCanBecomeReadyWithoutAnOwnerCredential(){
  var store=new com.hs.jxc.attachment.AttachmentObjectStore(MinioTestStorage.endpoint(),MinioTestStorage.ACCESS,MinioTestStorage.SECRET,MinioTestStorage.BUCKET);
  var cipher=new com.hs.jxc.md.BankAccountCipher(java.util.Base64.getEncoder().encodeToString(new byte[32]));
  var ready=new com.hs.jxc.ops.ProductionCapabilitiesHealthIndicator(jdbc,store,cipher,true,"101:201");
  assertThat(ready.health().getStatus().getCode()).isEqualTo("UP");
  var absent=new com.hs.jxc.attachment.AttachmentObjectStore(MinioTestStorage.endpoint(),MinioTestStorage.ACCESS,MinioTestStorage.SECRET,"missing-production-probe-bucket");
  assertThat(new com.hs.jxc.ops.ProductionCapabilitiesHealthIndicator(jdbc,absent,cipher,true,"101:201").health().getStatus().getCode()).isEqualTo("OUT_OF_SERVICE");
 }
 @Test void missingStorageAndBankKeyBlockReadinessWhileProcessRemainsLive()throws Exception{
  var client=HttpClient.newHttpClient();
  var live=client.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/actuator/health/liveness")).GET().build(),HttpResponse.BodyHandlers.ofString());
  assertThat(live.statusCode()).as(live.body()).isEqualTo(200);
  var ready=client.send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/actuator/health/readiness")).GET().build(),HttpResponse.BodyHandlers.ofString());
  assertThat(ready.statusCode()).as(ready.body()).isEqualTo(503);
  assertThat(ready.body()).doesNotContain("password","secretKey","accessKey");
 }
}
