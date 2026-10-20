package com.hs.jxc.bootstrap;

import java.nio.file.Path;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Profile;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

@Component
@Profile("bootstrap")
@Order(Ordered.LOWEST_PRECEDENCE)
public class BootstrapCommand implements ApplicationRunner {
    private final BootstrapService service;private final ConfigurableApplicationContext context;private final String file;
    public BootstrapCommand(BootstrapService service,ConfigurableApplicationContext context,@Value("${JXC_BOOTSTRAP_CONFIG_FILE:}")String file){this.service=service;this.context=context;this.file=file;}
    @Override public void run(ApplicationArguments args) {
        try {
            if(file.isBlank()||args.getSourceArgs().length!=0||!"none".equalsIgnoreCase(context.getEnvironment().getProperty("spring.main.web-application-type","")))throw new IllegalArgumentException("BOOTSTRAP_EXPLICIT_FILE_REQUIRED");
            service.bootstrap(BootstrapService.readConfiguration(Path.of(file)));
            System.out.println("BOOTSTRAP_OK: explicit foundation configuration committed; no business facts or opening balances created.");
            context.close();
        }catch(Exception ignored){System.err.println("BOOTSTRAP_FAILED: no secret values printed; verify the explicit target, empty database and owned 0600 JSON configuration.");context.close();System.exit(1);}
    }
}
