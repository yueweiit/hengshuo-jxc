package com.hs.jxc.it;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.pur.*;
import com.hs.jxc.sys.service.SessionService;
import java.util.*;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/** 采购导入各模块共用隔离数据库、MinIO及来源夹具；不包含测试用例。 */
abstract class PurchaseImportFixture extends BasePgIT {
    @Autowired PurchaseImportService imports;
    @Autowired PurchaseImportTaskService tasks;
    @Autowired com.hs.jxc.common.api.JsonCodec codec;
    @org.springframework.beans.factory.annotation.Value("${local.server.port}") int port;
    @MockitoBean PurchaseImportRecognitionClient parser;
    final String tokenHash=SessionService.digest("purchase-import-source-test");
    final RequestContext actor=new RequestContext(201,101L,"source-test",tokenHash);
    final byte[] file="PK-test-source".getBytes(StandardCharsets.UTF_8);
    @DynamicPropertySource static void storage(DynamicPropertyRegistry r) {
        r.add("jxc.purchase-import.worker-enabled",()->true);
        r.add("jxc.storage.endpoint",MinioTestStorage::endpoint);
        r.add("jxc.storage.access-key",()->MinioTestStorage.ACCESS);
        r.add("jxc.storage.secret-key",()->MinioTestStorage.SECRET);
        r.add("jxc.storage.bucket",()->MinioTestStorage.BUCKET);
    }
    @BeforeEach void fixture() {
        InventoryIT.seedBase();
        owner.update("INSERT INTO sys_authz_epoch(country_id) VALUES(101)");
        owner.update("INSERT INTO sys_session(token_hash,user_id,expires_at) VALUES(?,201,clock_timestamp()+interval '1 hour')",tokenHash);
        owner.update("INSERT INTO sys_role(id,country_id,code,name,permissions,field_policies) VALUES(801,101,'IMPORT','Import','[\"pur:order:*\"]','{\"COST\":\"WRITE\",\"CUSTOMER_PRICE\":\"WRITE\",\"ORDER_TOTAL\":\"WRITE\"}')");
        owner.update("INSERT INTO sys_user_role(country_id,user_id,role_id) VALUES(101,201,801)");
        owner.update("INSERT INTO sys_user_data_scope(country_id,user_id,scope_type,book_id,granted_by) VALUES(101,201,'BOOK',601,201)");
        owner.update("INSERT INTO md_currency(code,name) VALUES('USD','美元')");
        owner.update("INSERT INTO md_supplier(id,country_id,code,name,settle_currency) VALUES(901,101,'S','Supplier','USD')");
    }
    Map<String,Object> header(){var h=new LinkedHashMap<String,Object>();h.put("bookId",601);h.put("supplierId",901);h.put("currency","USD");h.put("orderDate","2026-10-28");h.put("expectedDate",null);h.put("paymentTerms","");h.put("prepayRatio","0");h.put("termDays",null);return h;}
    Map<String,Object> values(){var v=new LinkedHashMap<String,Object>();for(String k:List.of("sourceOrderNo","photo","productSpec","purchaseQty","saleUnitPrice","saleTotal","purchaseUnitPrice","freight","landedUnitCost","usdUnitCost","usdTotal"))v.put(k,null);v.put("sourceOrderNo","PO-1");v.put("productSpec","S");v.put("purchaseQty","10");v.put("purchaseUnitPrice","53.1234567890");return v;}
    @SuppressWarnings("unchecked") List<Map<String,Object>> rows(Map<String,Object> b){return (List<Map<String,Object>>)b.get("rows");}
    UUID id(Map<String,Object>b){return UUID.fromString(b.get("batchId").toString());}
    UUID task(Map<String,Object>b){return UUID.fromString(b.get("taskId").toString());}
    Map<String,Object> upload(String key){return imports.upload(actor,"采购.xlsx",file,header(),null,key);}
    Map<String,Object> document(){
        var source=Map.of("fileSha256",com.hs.jxc.attachment.AttachmentObjectStore.sha256(file),"parserVersion","fixture-v1");
        return new LinkedHashMap<>(Map.of("format","SourceDocumentV1","source",source,"sheets",List.of(Map.of("name","采购","role","PURCHASE")),"rows",List.of(Map.of("sourceSheet","采购","sourceRow",2,"originalValues",Map.of("G","53.1234567890"),"rawNumericTexts",Map.of("G","53.1234567890"),"formulas",Map.of(),"cachedValues",Map.of(),"normalizedValues",values())),"images",List.of(),"associations",List.of(),"warnings",List.of(),"errors",List.of()));
    }
    void parse(Map<String,Object>b){
        doReturn(document()).when(parser).parse(any(),anyString(),anyLong(),anyString(),isNull());
        tasks.execute(101,task(b));
    }
}
