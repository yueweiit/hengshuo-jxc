package com.hs.jxc.it;

import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** 仅用于本组原页面验证；复用正式 Dockerfile 的已验证制品目标，不发布镜像。 */
final class InventoryDockerPageRuntime implements AutoCloseable {
    private final Path evidence;
    private final String container="jxc-ai03-inventory-"+UUID.randomUUID();
    private Path secret;
    private boolean started;

    private InventoryDockerPageRuntime(Path evidence) { this.evidence=evidence; }

    static InventoryDockerPageRuntime start(Path repository,Path evidence) throws Exception {
        var runtime=new InventoryDockerPageRuntime(evidence);
        try { runtime.prepare(repository);return runtime; }
        catch(Exception | AssertionError failure) {
            try { runtime.close(); } catch(Exception cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            throw failure;
        }
    }

    private void prepare(Path repository) throws Exception {
        var artifacts=evidence.resolve("verified-artifacts");Files.createDirectories(artifacts);
        var jar=repository.resolve("jxc-server/jxc-app/target/jxc-app-0.1.0-SNAPSHOT.jar");
        Files.copy(jar,artifacts.resolve("app.jar"),StandardCopyOption.REPLACE_EXISTING);
        command("docker-build",List.of("docker","build","--target","application-verified","--build-context","release-artifacts="+artifacts,
            "-f",repository.resolve("deploy/production/Dockerfile").toString(),"-t","hengshuo-jxc:feature-page-test-inventory",repository.toString()),240);
        secret=Files.createTempFile("jxc-ai03-inventory-", ".env");
        var configuration=List.of("JXC_DB_URL=jdbc:postgresql://host.docker.internal:"+PgDatabase.PG.getMappedPort(5432)+"/"+PgDatabase.PG.getDatabaseName(),
            "JXC_DB_USER=jxc_app","JXC_DB_PASSWORD="+PgDatabase.PASSWORD,"JXC_BIND_ADDRESS=0.0.0.0","JXC_PORT=8080");
        Files.write(secret,configuration,StandardCharsets.UTF_8);
        // 显式测试入口：隔离库已由本轮 Flyway 迁移；不是生产启动/部署验收。
        command("docker-start",List.of("docker","run","-d","--name",container,"--label","jxc.test.task=AI-03","--memory","384m",
            "--env-file",secret.toString(),"-p","127.0.0.1:18303:8080","--entrypoint","java","hengshuo-jxc:feature-page-test-inventory",
            "-Xmx256m","-Dfile.encoding=UTF-8","-jar","/app/app.jar","--spring.flyway.enabled=false","--jxc.jobs.enabled=false"),30);
        started=true;
        Files.delete(secret);secret=null;
        var client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build();
        String last="not contacted";
        for(int attempt=0;attempt<90;attempt++) {
            try {
                var response=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:18303/actuator/health")).timeout(Duration.ofSeconds(1)).GET().build(),HttpResponse.BodyHandlers.ofString());
                last=response.statusCode()+" "+response.body();
                if(response.statusCode()==200&&response.body().contains("\"UP\"")) {
                    Files.writeString(evidence.resolve("docker-health.json"),response.body(),StandardCharsets.UTF_8);
                    command("docker-image-id",List.of("docker","image","inspect","--format","{{.Id}}","hengshuo-jxc:feature-page-test-inventory"),15);
                    var expected=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(jar)));
                    command("docker-container-jar-sha256",List.of("docker","exec",container,"sha256sum","/app/app.jar"),15);
                    var actual=Files.readString(evidence.resolve("docker-container-jar-sha256.log"),StandardCharsets.UTF_8).strip().split("\\s+")[0];
                    if(!expected.equals(actual))throw new AssertionError("容器内JAR与本轮Maven制品指纹不一致");
                    Files.writeString(evidence.resolve("docker-jar-sha256.txt"),expected,StandardCharsets.UTF_8);
                    return;
                }
            } catch(java.io.IOException error) { last=error.getClass().getSimpleName()+": "+error.getMessage(); }
            Thread.sleep(500);
        }
        throw new AssertionError("本组Docker健康检查失败："+last);
    }

    private void command(String label,List<String> command,int seconds) throws Exception {
        var log=evidence.resolve(label+".log");
        var process=new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile()).start();
        try {
            if(!process.waitFor(seconds,TimeUnit.SECONDS))throw new AssertionError(label+" timed out; inspect "+log);
            if(process.exitValue()!=0)throw new AssertionError(label+" failed; inspect "+log);
        } finally { if(process.isAlive())process.destroyForcibly().waitFor(); }
    }

    @Override public void close() throws Exception {
        if(secret!=null)Files.deleteIfExists(secret);
        if(!started)return;
        // 只操作本实例随机命名的容器，保留镜像与全部测试证据。
        try {
            command("docker-runtime",List.of("docker","logs",container),15);
            var log=evidence.resolve("docker-runtime.log");
            Files.writeString(log,Files.readString(log,StandardCharsets.UTF_8).replace(PgDatabase.PASSWORD,"[REDACTED]"),StandardCharsets.UTF_8);
        } finally { command("docker-stop",List.of("docker","rm","-f",container),30); }
    }
}
