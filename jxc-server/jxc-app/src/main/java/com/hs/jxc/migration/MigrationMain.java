package com.hs.jxc.migration;
import java.sql.DriverManager;
import java.util.Map;
import org.flywaydb.core.Flyway;
/** One-shot migration runner. It never creates a web application, runtime worker or business identity. */
public final class MigrationMain {
 private static String required(String key){String value=System.getenv(key);if(value==null||value.isBlank())throw new IllegalArgumentException("Required migration input missing");return value;}
 public static void main(String[] args){try{
  String url=required("JXC_DB_URL"),owner=required("JXC_MIGRATION_USER"),runtime=required("JXC_DB_USER"),expected=required("JXC_EXPECT_DATABASE"),password=required("JXC_MIGRATION_PASSWORD");
  if(!owner.matches("[a-z_][a-z0-9_]{0,62}")||!runtime.matches("[a-z_][a-z0-9_]{0,62}")||owner.equals(runtime)||url.toLowerCase().matches(".*(?:user|password|sslpassword)=.*"))throw new IllegalArgumentException("Migration identity invalid");
  try(var connection=DriverManager.getConnection(url,owner,password);var query=connection.createStatement();var row=query.executeQuery("SELECT current_database(),current_user")){if(!row.next()||!expected.equals(row.getString(1))||!owner.equals(row.getString(2)))throw new IllegalStateException("Migration database identity mismatch");}
  var result=Flyway.configure().dataSource(url,owner,password).locations("classpath:db/migration").placeholders(Map.of("runtimeRole",runtime)).cleanDisabled(true).baselineOnMigrate(false).validateMigrationNaming(true).outOfOrder(false).load().migrate();
  System.out.println("{\"status\":\"MIGRATED\",\"migrationsExecuted\":"+result.migrationsExecuted+"}");
 }catch(Exception e){System.err.println("{\"status\":\"JXC_MIGRATION_FAILED\"}");System.exit(1);}}
}
