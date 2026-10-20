package com.hs.jxc.sys.jobs;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.ObjectProvider;
import org.slf4j.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.*;

/** Poll only submitted technical jobs; never generates accounting or a service identity. */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name="jxc.jobs.enabled",havingValue="true",matchIfMissing=true)
public class JobRecoveryWorker {
    private static final Logger log=LoggerFactory.getLogger(JobRecoveryWorker.class);
    private final JobService jobs;private final JdbcTemplate jdbc;private final WorkerRuntime runtime;private final ObjectProvider<CountryWorkProvider> providers;
    public JobRecoveryWorker(JobService jobs,JdbcTemplate jdbc,WorkerRuntime runtime,ObjectProvider<CountryWorkProvider> providers){this.jobs=jobs;this.jdbc=jdbc;this.runtime=runtime;this.providers=providers;}
    @Scheduled(initialDelayString="${jxc.jobs.recovery.delay-ms:30000}",fixedDelayString="${jxc.jobs.recovery.delay-ms:30000}")
    public void poll(){
        List<Map<String,Object>> countries=jdbc.queryForList("SELECT id,status FROM sys_country ORDER BY id");
        for(var row:countries){long country=((Number)row.get("id")).longValue();try{runtime.run(country,"SYS_EXPORT",()->jobs.recoverCountry(country,runtime.limit()),()->{});if("ACTIVE".equals(row.get("status")))providers.orderedStream().forEach(provider->runtime.run(country,provider.kind(),()->provider.recover(country,runtime.limit()),()->provider.daily(country)));}catch(RuntimeException e){log.warn("Worker recovery unavailable for country {}",country);}}
    }
}
