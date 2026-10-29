package com.hs.jxc.it;

import com.hs.jxc.pur.service.impl.PurchaseXlsxTemplateParser;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class PurchaseImportRoutingIT extends PurchaseImportFixture {
    @Test void templateRunsLocallyEvenWhenWorkerIsUnavailable() throws Exception {
        var bytes=Files.readAllBytes(Path.of("D:/downlaoad/NY-051-采购导入.xlsx"));
        var b=imports.upload(actor,"renamed.xlsx",bytes,Map.of(),null,UUID.randomUUID().toString());
        tasks.execute(101,task(b));
        assertThat(tasks.get(actor,task(b)).get("status")).isEqualTo("SUCCEEDED");
        assertThat(rows(imports.get(actor,id(b)))).hasSize(60);
        verifyNoInteractions(parser);
    }
    @Test void oneOriginalRowCanSplitIntoDistinctQuantityCellsAndShareAllImages(){
        var doc=photoDocument();var base=rows(doc).getFirst();var one=new LinkedHashMap<>(base);one.put("sourceItemKey","B2");
        var two=new LinkedHashMap<>(base);two.put("sourceItemKey","C2");doc.put("rows",List.of(one,two));
        var b=upload(UUID.randomUUID().toString());doReturn(doc).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));
        assertThat(tasks.get(actor,task(b)).get("status")).isEqualTo("SUCCEEDED");
        var result=rows(imports.get(actor,id(b)));assertThat(result).hasSize(2);
        assertThat(result).extracting(r->r.get("sourceRow")).containsOnly(2);
        for(var row:result)assertThat((List<?>)row.get("images")).hasSize(1);
    }
    @Test void sameQuantityCellCannotBeImportedTwice(){
        var doc=document();var row=new LinkedHashMap<>(rows(doc).getFirst());row.put("sourceItemKey","B2");doc.put("rows",List.of(row,row));
        var b=upload(UUID.randomUUID().toString());doReturn(doc).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());tasks.execute(101,task(b));
        assertThat(tasks.get(actor,task(b)).get("status")).isEqualTo("FAILED");assertThat(rows(imports.get(actor,id(b)))).isEmpty();
    }
    @Test void fieldReviewRetriesOriginalTaskWithRestrictedOverridesWithoutAnotherSource(){
        var b=upload(UUID.randomUUID().toString());var mapping=Map.<String,Object>of("format","SupplierMappingV1");
        doThrow(new com.hs.jxc.common.api.ApiException(422,"SOURCE_MAPPING_REVIEW_REQUIRED","规格待核实",Map.of("mapping",mapping))).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task(b));assertThat(tasks.get(actor,task(b)).get("result")).isEqualTo(Map.of("mapping",mapping));
        var overrides=Map.<String,Object>of("mapping",mapping,"specLabels",Map.of("B","S"),"confirm",true);
        tasks.retry(actor,task(b),UUID.randomUUID().toString(),null,overrides);
        var corrected=document();var correctedRow=new LinkedHashMap<>(rows(corrected).getFirst());corrected.put("rows",List.of(correctedRow));correctedRow.put("sourceItemKey","B2");correctedRow.put("sourceCells",Map.of("purchaseQty","B2","manualSpecLabel","S"));
        doReturn(corrected).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull(),eq(overrides));
        tasks.execute(101,task(b));assertThat(tasks.get(actor,task(b)).get("status")).isEqualTo("SUCCEEDED");
        assertThat(rows(imports.get(actor,id(b)))).hasSize(1);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_source",Integer.class)).isEqualTo(1);
        assertThat(owner.queryForObject("SELECT field_origins->>'productSpec' FROM pur_order_import",String.class)).isEqualTo("MANUAL");
    }
    @Test void legacyPopulatedSourcesMigrateUnderTheRealRestrictedOwnerWithoutUpdatingBusinessValues() throws Exception {
        var b=upload(UUID.randomUUID().toString());parse(b);
        try(var connection=java.sql.DriverManager.getConnection(PgDatabase.PG.getJdbcUrl(),"postgres",PgDatabase.PASSWORD)){
            connection.setAutoCommit(false);
            try(var statement=connection.createStatement()){
                statement.execute("DROP INDEX pur_import_source_item_uq; ALTER TABLE pur_order_import DROP COLUMN source_item_key; CREATE UNIQUE INDEX pur_import_source_row_uq ON pur_order_import(country_id,source_id,source_sheet,source_row)");
                statement.execute("SET LOCAL ROLE jxc_owner");
                try(var input=new org.springframework.core.io.ClassPathResource("db/migration/V013_21__purchase_import_source_items.sql").getInputStream()){
                    statement.execute(new String(input.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));
                }
                statement.execute("RESET ROLE");
                try(var result=statement.executeQuery("SELECT purchase_qty,purchase_unit_price FROM pur_order_import")){
                    assertThat(result.next()).isTrue();assertThat(result.getBigDecimal(1)).isEqualByComparingTo("10");assertThat(result.getBigDecimal(2)).isEqualByComparingTo("53.1234567890");
                }
            }finally{connection.rollback();}
        }
    }
}
