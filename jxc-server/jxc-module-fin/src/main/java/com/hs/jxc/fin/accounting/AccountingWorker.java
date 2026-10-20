package com.hs.jxc.fin.accounting;

import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.*;

/** Explicit service subjects only. No identity, permission or scope is created by enabling this worker. */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name="jxc.accounting.worker.enabled",havingValue="true")
public class AccountingWorker {
    private static final Logger log=LoggerFactory.getLogger(AccountingWorker.class);
    private final AccountingService accounting;private final List<long[]> assignments;
    public AccountingWorker(AccountingService accounting,@Value("${jxc.accounting.worker.assignments:}")String configured){this.accounting=accounting;var result=new ArrayList<long[]>();for(String assignment:configured.split(",")){if(assignment.isBlank())continue;if(!assignment.trim().matches("[1-9][0-9]*:[1-9][0-9]*"))throw new IllegalArgumentException("Accounting worker assignments must be countryId:userId");var ids=assignment.trim().split(":");result.add(new long[]{Long.parseLong(ids[0]),Long.parseLong(ids[1])});}assignments=List.copyOf(result);if(assignments.isEmpty())throw new IllegalArgumentException("Accounting worker requires explicit countryId:userId assignments");}
    @Scheduled(fixedDelayString="${jxc.accounting.worker.delay-ms:30000}")
    public void poll(){for(var assignment:assignments)try{for(long event:accounting.workerCandidates(assignment[0],assignment[1],100))accounting.consumeWorker(assignment[0],assignment[1],event);}catch(RuntimeException e){log.warn("Accounting worker assignment unavailable for country {} subject {}",assignment[0],assignment[1]);}}
}
