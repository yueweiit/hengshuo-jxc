package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import com.hs.jxc.pur.*;
import com.hs.jxc.common.api.*;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** 真实源文件的技术链条验收；商品/单位/税率是隔离夹具，不是实单业务判断。 */
class PurchaseImportAcceptanceIT extends PurchaseImportFixture {
    @Autowired PurchaseImportProductService review;
    @Autowired PurchaseImportDraftService drafts;
    @Autowired PurchaseImportMatchService matches;
    @DynamicPropertySource static void enabled(DynamicPropertyRegistry r){r.add("jxc.purchase-import.recognition.enabled",()->true);r.add("jxc.purchase-import.draft-creation.enabled",()->true);}
    @SuppressWarnings("unchecked") Map<String,Object> map(Object value){return (Map<String,Object>)value;}

    @Test void explicitRealWorkbookTraversesTheCompleteIsolatedManualDraftAndTraceFlow()throws Exception{
        String python=System.getProperty("jxc.test.purchase-python"),sample=System.getProperty("jxc.test.purchase-source");
        Assumptions.assumeTrue(python!=null&&sample!=null,"真实样本/解释器须显式指定；不静默换成演示业务资料");
        byte[] bytes=Files.readAllBytes(Path.of(sample));String hash=com.hs.jxc.attachment.AttachmentObjectStore.sha256(bytes);
        assertThat(hash).isEqualTo("736d04418821c5c9304c65522e262ea2da6c20fdd1b8c27190de549fe2bf0f86");
        owner.update("UPDATE sys_role SET permissions=permissions||'[\"md:product:view\"]'::jsonb WHERE id=801");
        try(var bridge=startBridge(python)){
            doAnswer(call->bridge.client().parse(call.getArgument(0),call.getArgument(1),call.getArgument(2),call.getArgument(3),call.getArgument(4))).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
            var b=imports.upload(actor,"NY-051-采购导入.xlsx",bytes,header(),null,UUID.randomUUID().toString());tasks.execute(101,task(b));
            assertThat(tasks.get(actor,task(b))).as(tasks.get(actor,task(b)).toString()).containsEntry("status","SUCCEEDED");
            var saved=imports.get(actor,id(b));assertThat(rows(saved)).hasSize(60);
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_image",Integer.class)).isEqualTo(20);
            assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_import_row_image WHERE association_status='UNCONFIRMED'",Integer.class)).isEqualTo(60);
            // 每行明确选择独立的隔离商品，不能借未确认图片或相同规格自动合并SKU。
            for(int n=0;n<rows(saved).size();n++){var row=rows(saved).get(n);long product=12000+n;owner.update("INSERT INTO md_product(id,product_code,name,base_unit,spec) VALUES(?,?,?,'PCS',?)",product,"IT-REAL-"+(n+1),"隔离验收夹具行"+(n+1),Objects.toString(row.get("productSpec"),""));owner.update("INSERT INTO md_product_unit(product_id,unit,factor_to_base) VALUES(?,'PCS',1)",product);owner.update("INSERT INTO md_country_sku(country_id,product_id,status) VALUES(101,?,'ENABLED')",product);}
            var first=rows(saved).getFirst();long firstId=((Number)first.get("id")).longValue();var original=new LinkedHashMap<String,Object>();for(String field:values().keySet())original.put(field,first.get(field));
            imports.saveRow(actor,id(b),firstId,Map.of("version",first.get("version"),"values",original,"matchInputs",Map.of("suppliedProductCode","IT-REAL-1","suppliedProductName","","supplierProductCode","")));
            doThrow(new ApiException(503,"N8N_UNAVAILABLE","隔离合同明确模拟解释工作流不可用")).when(parser).recognize(any(),anyString(),anyMap());
            saved=imports.get(actor,id(b));var queued=matches.start(actor,id(b),Map.of("batchVersion",saved.get("version"),"rowIds",List.of(firstId),"topK",5),UUID.randomUUID().toString());UUID match=UUID.fromString(((List<?>)queued.get("taskIds")).getFirst().toString());tasks.execute(101,match);
            saved=imports.get(actor,id(b));first=rows(saved).getFirst();assertThat(first).containsEntry("readiness","UNRESOLVED");assertThat(map(first.get("matchResult")).get("explanation")).asString().contains("UNAVAILABLE");
            for(int n=0;n<rows(saved).size();n++){var row=rows(saved).get(n);var decision=new LinkedHashMap<String,Object>(Map.of("version",row.get("version"),"decision","EXISTING","productId",12000+n,"unit","PCS"));if(n==0)decision.put("runId",match.toString());review.decide(actor,id(b),((Number)row.get("id")).longValue(),decision);}
            saved=imports.get(actor,id(b));assertThat(rows(saved)).allMatch(row->"READY".equals(row.get("readiness")));var grouped=drafts.previews(actor,id(b),Map.of("batchVersion",saved.get("version")));assertThat(groups(grouped)).hasSize(1);var g=groups(grouped).getFirst();var h=header();h.put("termDays",0);h.put("taxRate","0");h.put("priceTaxBasis","EXCLUSIVE");long gid=((Number)g.get("id")).longValue();drafts.saveGroup(actor,id(b),gid,Map.of("groupVersion",g.get("version"),"header",h));g=groups(drafts.previews(actor,id(b),Map.of("batchVersion",imports.get(actor,id(b)).get("version")))).getFirst();assertThat(g).as(g.toString()).containsEntry("createStatus","READY");assertThat(map(g.get("preview")).get("lines")).asList().hasSize(60);
            String command=UUID.randomUUID().toString();var confirmation=Map.<String,Object>of("groupVersion",g.get("version"),"previewToken",g.get("previewToken"),"confirm",true);var created=drafts.create(actor,id(b),gid,confirmation,command);var replay=drafts.create(actor,id(b),gid,confirmation,command);assertThat(created).containsEntry("createStatus","CREATED").containsEntry("verifyStatus","VERIFIED");assertThat(replay.get("orderId")).isEqualTo(created.get("orderId"));assertThat(owner.queryForObject("SELECT count(*) FROM pur_order",Integer.class)).isEqualTo(1);assertThat(owner.queryForObject("SELECT status FROM pur_order",String.class)).isEqualTo("DRAFT");assertThat(owner.queryForObject("SELECT count(*) FROM pur_order_line",Integer.class)).isEqualTo(60);assertThat(owner.queryForObject("SELECT sum(qty) FROM pur_order_line",java.math.BigDecimal.class)).isEqualByComparingTo("480");assertThat(owner.queryForObject("SELECT count(DISTINCT target_order_line_id) FROM pur_order_import",Integer.class)).isEqualTo(60);
            var todos=(List<?>)created.get("feeTodos");assertThat(todos).hasSize(1);assertThat(map(todos.getFirst())).containsEntry("amount",null).containsEntry("currency",null).containsEntry("status","PENDING").containsEntry("targetOrderId",created.get("orderId"));assertThat(created.get("sourceEvidence")).asList().hasSize(60);
            for(String table:List.of("pur_domestic_receipt","ap_bill","inv_stock_summary","lgs_fee","cst_inbound_cost","md_product_image","image_feature"))assertThat(owner.queryForObject("SELECT count(*) FROM "+table,Integer.class)).as(table).isZero();
            assertThat(com.hs.jxc.attachment.AttachmentObjectStore.sha256(Files.readAllBytes(Path.of(sample)))).isEqualTo(hash);
            verify(parser,never()).embed(any(),anyString(),anyLong(),anyString());verify(parser,never()).search(any(),anyString(),anyMap());
        }
    }
}
