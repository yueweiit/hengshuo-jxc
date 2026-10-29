package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.util.*;
import javax.net.ssl.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.testcontainers.containers.*;
import org.testcontainers.utility.*;

/** 使用本次已构建制品验证真实容器；不连接线上数据库、工作流或模型。 */
@EnabledIfSystemProperty(named="jxc.integrations.test.app-image",matches=".+")
class ExternalServiceContainerIT extends PurchaseImportFixture {
    @Test void builtImagesServeSettingsAndPersistOnlyEncryptedSecrets()throws Exception{
        owner.update("UPDATE sys_user SET is_platform_admin=true WHERE id=201");
        String certs=System.getProperty("jxc.integrations.test.certs");
        var network=Network.newNetwork();
        var app=featureContainer(System.getProperty("jxc.integrations.test.app-image"),false).withNetwork(network).withNetworkAliases("application")
            .withEnv("JXC_INTEGRATIONS_MASTER_KEY","AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
        var web=new GenericContainer<>(DockerImageName.parse(System.getProperty("jxc.integrations.test.web-image"))).withNetwork(network)
            .withCopyFileToContainer(MountableFile.forHostPath(Path.of(certs,"certificate.pem")),"/run/secrets/tls_certificate")
            .withCopyFileToContainer(MountableFile.forHostPath(Path.of(certs,"key.pem")),"/run/secrets/tls_key")
            .withExposedPorts(8443).waitingFor(org.testcontainers.containers.wait.strategy.Wait.forListeningPort());
        var gateway=new Gateway(network,app,web);
        var ssl=SSLContext.getInstance("TLS");ssl.init(null,new TrustManager[]{new X509TrustManager(){public java.security.cert.X509Certificate[] getAcceptedIssuers(){return new java.security.cert.X509Certificate[0];}public void checkClientTrusted(java.security.cert.X509Certificate[] c,String a){}public void checkServerTrusted(java.security.cert.X509Certificate[] c,String a){}}},new java.security.SecureRandom());
        var client=HttpClient.newBuilder().sslContext(ssl).connectTimeout(java.time.Duration.ofSeconds(5)).build();
        try{
            app.start();web.start();String base=gateway.base();
            var page=client.send(HttpRequest.newBuilder(URI.create(base+"/settings/external-services")).GET().build(),HttpResponse.BodyHandlers.ofString());
            assertThat(page.statusCode()).isEqualTo(200);assertThat(page.body()).contains("<html","/assets/");
            String asset;
            try(var files=Files.list(Path.of(System.getProperty("jxc.integrations.test.dist"),"assets"))){asset=files.map(p->p.getFileName().toString()).filter(name->name.startsWith("ExternalServiceSettings-")&&name.endsWith(".js")).findFirst().orElseThrow();}
            var script=client.send(HttpRequest.newBuilder(URI.create(base+"/assets/"+asset)).GET().build(),HttpResponse.BodyHandlers.ofString());
            assertThat(script.statusCode()).isEqualTo(200);assertThat(script.body()).contains("/sys/external-services","DeepSeek");
            var unauthenticated=client.send(HttpRequest.newBuilder(URI.create(base+"/api/v1/sys/external-services")).GET().build(),HttpResponse.BodyHandlers.ofString());assertThat(unauthenticated.statusCode()).isEqualTo(401);
            var initial=send(client,base,"GET",null);assertThat(initial).containsEntry("version",0).containsEntry("keyReady",true);
            var saved=send(client,base,"PUT",Map.of("version",0,"enabled",false,"url","https://api.deepseek.com","model","deepseek-flash","key","container-synthetic-key","timeoutSeconds",180));
            assertThat(saved).containsEntry("version",1);assertThat(codec.write(saved)).doesNotContain("container-synthetic-key");
            assertThat(owner.queryForObject("SELECT config::text FROM sys_external_service_revision WHERE version=1",String.class)).doesNotContain("container-synthetic-key");
            assertThat(codec.write(send(client,base,"GET",null))).contains("keyConfigured").doesNotContain("container-synthetic-key");
        }finally{gateway.close();}
    }
    @SuppressWarnings("unchecked") Map<String,Object> send(HttpClient client,String base,String method,Object body)throws Exception{
        var builder=HttpRequest.newBuilder(URI.create(base+"/api/v1/sys/external-services"+(body==null?"":"/deepseek"))).timeout(java.time.Duration.ofSeconds(20))
            .header("Authorization","Bearer purchase-import-source-test").header("X-Country-Id","101").header("Content-Type","application/json");
        var response=client.send(builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(codec.write(body))).build(),HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);return (Map<String,Object>)codec.readMap(response.body()).get("data");
    }
}
