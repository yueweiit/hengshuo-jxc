package com.hs.jxc.it;

import io.minio.*;
import java.util.UUID;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;

/** Existing pinned image is isolated test infrastructure, not a production image choice. */
public final class MinioTestStorage {
    public static final String ACCESS = "jxc-evidence-test";
    public static final String SECRET = UUID.randomUUID().toString();
    public static final String BUCKET = "jxc-m1-evidence";
    // Explicit opt-in for offline/local validation; keep the pinned default and record the chosen image in the run evidence.
    public static final GenericContainer<?> MINIO = new GenericContainer<>(DockerImageName.parse(System.getProperty("jxc.test.minio.image",
        "minio/minio:RELEASE.2024-10-13T13-34-11Z@sha256:9535594ad4122b7a78c6632788a989b96d9199b483d3bd71a5ceae73a922cdfa")))
        .withEnv("MINIO_ROOT_USER", ACCESS).withEnv("MINIO_ROOT_PASSWORD", SECRET)
        .withExposedPorts(9000).withCommand("server", "/data")
        .waitingFor(Wait.forHttp("/minio/health/ready").forPort(9000));
    static {
        MINIO.start();
        try (var client = client()) { client.makeBucket(MakeBucketArgs.builder().bucket(BUCKET).build()); }
        catch (Exception e) { throw new IllegalStateException("Cannot prepare isolated attachment test bucket",e); }
    }
    private MinioTestStorage() {}
    public static String endpoint() { return "http://"+MINIO.getHost()+":"+MINIO.getMappedPort(9000); }
    public static MinioClient client() { return MinioClient.builder().endpoint(endpoint()).credentials(ACCESS,SECRET).build(); }
}
