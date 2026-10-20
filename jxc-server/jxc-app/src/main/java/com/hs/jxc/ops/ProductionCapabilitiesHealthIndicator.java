package com.hs.jxc.ops;
import com.hs.jxc.attachment.AttachmentObjectStore;
import com.hs.jxc.md.BankAccountCipher;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.health.contributor.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
/** Separate process liveness from the production capabilities required for bank and attachment commands. */
@Component("productionCapabilities")
@ConditionalOnProperty(name="jxc.production.enabled",havingValue="true")
public class ProductionCapabilitiesHealthIndicator extends AbstractHealthIndicator {
 private final JdbcTemplate db;private final AttachmentObjectStore objects;private final BankAccountCipher cipher;private final boolean jobs;private final String assignments;
 public ProductionCapabilitiesHealthIndicator(JdbcTemplate db,AttachmentObjectStore objects,BankAccountCipher cipher,@Value("${jxc.jobs.enabled:true}")boolean jobs,@Value("${jxc.workbench.worker.assignments:}")String assignments){this.db=db;this.objects=objects;this.cipher=cipher;this.jobs=jobs;this.assignments=assignments;}
 @Override protected void doHealthCheck(Health.Builder builder){
  boolean connected=Integer.valueOf(1).equals(db.queryForObject("SELECT 1",Integer.class));
  if(connected&&objects.ready()&&cipher.configured()&&jobs&&!assignments.isBlank())builder.up();else builder.outOfService();
 }
}
