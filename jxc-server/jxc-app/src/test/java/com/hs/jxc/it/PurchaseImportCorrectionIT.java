package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import com.hs.jxc.common.api.ApiException;
import java.util.*;
import org.junit.jupiter.api.Test;

class PurchaseImportCorrectionIT extends PurchaseImportFixture {
    Map<String,Object> ready(){var b=upload(UUID.randomUUID().toString());parse(b);owner.update("UPDATE pur_order_import_source SET parser_version='docling-n8n-supplier-v1'");owner.update("UPDATE pur_order_import SET formula_provenance='{\"sourceCells\":{\"sourceOrderNo\":\"A1\",\"purchaseQty\":\"B2\",\"purchaseUnitPrice\":\"G2\"}}'::jsonb,original_values='{\"B\":\"10\",\"C\":\"4\",\"G\":\"53.1234567890\"}'::jsonb");return imports.get(actor,id(b));}
    long source(Map<String,Object>b){return owner.queryForObject("SELECT id FROM pur_order_import_source WHERE batch_id=?",Long.class,id(b));}
    @SuppressWarnings("unchecked") Map<String,Object> request(Map<String,Object>b){var preview=imports.sourceMapping(actor,id(b),source(b));return Map.of("batchVersion",b.get("version"),"mappingOverrides",Map.of("mapping",preview.get("mapping"),"specLabels",Map.of(),"confirm",true));}
    @Test void correctionReusesSourceParsingAndKeepsOriginalBatchWithIdempotentNewBatch(){
        var b=ready();var before=imports.get(actor,id(b));var preview=imports.sourceMapping(actor,id(b),source(b));assertThat(preview).containsKeys("mapping","sourceCells","batchVersion");
        var body=request(b);String key=UUID.randomUUID().toString();var created=imports.correctSource(actor,id(b),source(b),body,key);assertThat(created.get("batchId")).isNotEqualTo(b.get("batchId"));assertThat(rows(created)).isEmpty();assertThat(created).containsEntry("status","PARSING");
        assertThat(imports.correctSource(actor,id(b),source(b),body,key).get("batchId")).isEqualTo(created.get("batchId"));assertThat(imports.get(actor,id(b))).isEqualTo(before);
        doReturn(document()).when(parser).parse(any(),anyString(),anyLong(),anyString(),eq("采购"),anyMap());tasks.execute(101,task(created));assertThat(rows(imports.get(actor,id(created)))).hasSize(1);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_batch",Integer.class)).isEqualTo(2);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isZero();
    }
    @Test void staleOrUnconfirmedOrWrongHashCannotCreateCorrection(){
        var b=ready();var body=new LinkedHashMap<>(request(b));body.put("batchVersion",1);assertThatThrownBy(()->imports.correctSource(actor,id(b),source(b),body,UUID.randomUUID().toString())).isInstanceOf(ApiException.class);
        var input=new LinkedHashMap<>((Map<String,Object>)request(b).get("mappingOverrides"));input.put("confirm",false);assertThatThrownBy(()->imports.correctSource(actor,id(b),source(b),Map.of("batchVersion",b.get("version"),"mappingOverrides",input),UUID.randomUUID().toString())).isInstanceOf(ApiException.class);
        input.put("confirm",true);var mapping=new LinkedHashMap<>((Map<String,Object>)input.get("mapping"));mapping.put("fileSha256","0".repeat(64));input.put("mapping",mapping);assertThatThrownBy(()->imports.correctSource(actor,id(b),source(b),Map.of("batchVersion",b.get("version"),"mappingOverrides",input),UUID.randomUUID().toString())).isInstanceOf(ApiException.class);assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_batch",Integer.class)).isEqualTo(1);
    }
    @Test void missingProvenanceOrForeignSourceIsAnExplicitError(){var b=ready();assertThatThrownBy(()->imports.sourceMapping(actor,id(b),source(b)+100)).isInstanceOf(ApiException.class);owner.update("UPDATE pur_order_import SET formula_provenance='{}'");assertThatThrownBy(()->imports.sourceMapping(actor,id(b),source(b))).isInstanceOf(ApiException.class);}
}
