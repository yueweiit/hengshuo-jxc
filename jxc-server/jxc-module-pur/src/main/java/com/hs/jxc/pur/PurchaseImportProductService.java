package com.hs.jxc.pur;

import static com.hs.jxc.pur.PurchaseImportService.*;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.md.api.*;
import com.hs.jxc.sys.api.Access;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.springframework.stereotype.Service;

/** 人工决定是唯一READY入口；模型候选和图片不具有确认权限。 */
@Service
public class PurchaseImportProductService {
    private final PurchaseImportService imports;private final MasterProductMaintenanceApi master;private final MasterProductApi products;private final com.hs.jxc.common.audit.AuditWriter audit;
    public PurchaseImportProductService(PurchaseImportService imports,MasterProductMaintenanceApi master,MasterProductApi products,com.hs.jxc.common.audit.AuditWriter audit){this.imports=imports;this.master=master;this.products=products;this.audit=audit;}
    public Map<String,Object> decide(RequestContext ctx,UUID batch,long rowId,Map<String,Object> body){return imports.tx.execute(s->{
        Access a=imports.access(ctx,true);var b=imports.batch(a,batch,true);var row=imports.row(a,batch,rowId);if(number(row,"version")!=Inputs.version(body))throw Inputs.conflict();String decision=Inputs.required(body,"decision");
        if(Set.of("UNRESOLVED","DEFERRED").contains(decision)){imports.jdbc.update("UPDATE pur_order_import SET decision=?,readiness='UNRESOLVED',product_snapshot=NULL,confirmed_by=NULL,confirmed_at=NULL,setup_reasons='[]',version=version+1 WHERE country_id=? AND id=?",decision,a.requireCountry(),rowId);}
        else if("EXISTING".equals(decision)){long product=Inputs.id(body.get("productId"));String unit=Inputs.required(body,"unit");saveDecision(ctx,a,rowId,product,unit,"EXISTING");}
        else throw Inputs.bad("请选择已有商品、暂缓或待确认；新增商品须明确提交新品请求");
        imports.touch(a,batch);var out=result(a,batch,rowId);audit.append(ctx,"PUR_IMPORT_PRODUCT_DECISION","PURCHASE_IMPORT",rowId,Map.of("version",row.get("version")),Map.of("version",out.get("version"),"decision",out.get("decision"),"readiness",out.get("readiness")));return out;
    });}
    private Map<String,Object> saveDecision(RequestContext ctx,Access a,long rowId,long product,String unit,String decision){
        var snapshot=master.inspect(ctx,product);var reasons=new ArrayList<String>();
        if(!"ENABLED".equals(snapshot.get("status")))reasons.add("全局商品已停用");
        Object sku=snapshot.get("countrySku");if(!(sku instanceof Map<?,?> m)||!"ENABLED".equals(m.get("status")))reasons.add("商品尚未在本国启用");
        if(list(snapshot.get("units")).stream().noneMatch(u->unit.equals(u.get("unit"))))reasons.add("商品未配置所选单位换算");
        if(reasons.isEmpty())products.requireEnabled(a.requireCountry(),product,unit);
        boolean ready=reasons.isEmpty();imports.jdbc.update("UPDATE pur_order_import SET matched_product_id=?,purchase_unit=?,decision=?,readiness=?,product_snapshot=?::jsonb,setup_reasons=?::jsonb,confirmed_by=?,confirmed_at=CASE WHEN ? THEN clock_timestamp() ELSE NULL END,version=version+1 WHERE country_id=? AND id=?",product,unit,decision,ready?"READY":"NEEDS_SETUP",imports.json.write(snapshot),imports.json.write(reasons),ready?a.userId():null,ready,a.requireCountry(),rowId);return snapshot;
    }
    private Map<String,Object> result(Access a,UUID batch,long rowId){var out=imports.rowDto(imports.row(a,batch,rowId));out.put("batchVersion",imports.jdbc.queryForObject("SELECT version FROM pur_order_import_batch WHERE country_id=? AND batch_id=?",Integer.class,a.requireCountry(),batch));return out;}
    private String child(String key,String step){return UUID.nameUUIDFromBytes((key+":"+step).getBytes(StandardCharsets.UTF_8)).toString();}
    public Map<String,Object> createProduct(RequestContext ctx,UUID batch,long rowId,Map<String,Object> body,String key){
        if(!Boolean.TRUE.equals(body.get("confirmNew")))throw Inputs.bad("新增商品前必须明确确认");
        if(key==null||!key.matches("[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"))throw Inputs.bad("请提供UUID格式的新品请求编号");
        String command=key.toLowerCase(Locale.ROOT),requestHash=Digests.sha256(imports.json.write(IdempotencyExecutor.canonical(body)));
        var phase=imports.tx.execute(s->{
            // 原商品维护要获取全局写门禁，必须在任何共享授权读取之前取得。
            imports.auth.authorizeCoordinatedWrite(ctx);Access a=imports.access(ctx,true);imports.batch(a,batch,true);var row=imports.row(a,batch,rowId);
            if(row.get("product_operation")!=null){var operation=imports.map(row.get("product_operation"));if(!command.equals(operation.get("key"))||!requestHash.equals(operation.get("requestHash")))throw new ApiException(409,"PUR_IMPORT_PRODUCT_INTENT_CONFLICT","已有新品操作，请恢复原请求或选用已创建的商品");return operation;}
            if(number(row,"version")!=Inputs.version(body))throw Inputs.conflict();a.require("md:product:edit");if(!a.platformAdmin())throw ApiException.forbidden();
            var input=imports.map(body.get("product"));String code=Inputs.required(input,"productCode");String unit=Inputs.required(body,"unit");
            if(imports.jdbc.queryForObject("SELECT count(*) FROM md_product WHERE lower(btrim(product_code))=lower(?)",Integer.class,code)>0)throw new ApiException(409,"PUR_IMPORT_PRODUCT_EXISTS","此编码商品已存在，请从真实目录选择");
            if(imports.jdbc.queryForObject("SELECT count(*) FROM pur_order_import WHERE country_id=? AND batch_id=? AND id<>? AND lower(btrim(supplied_product_code))=lower(?) AND decision='NEW_REQUESTED'",Integer.class,a.requireCountry(),batch,rowId,code)>0)throw new ApiException(409,"PUR_IMPORT_BATCH_PRODUCT_EXISTS","本批次已有相同新品编码，请先核对");
            var product=master.saveProduct(ctx,null,input,child(command,"global-product"));long productId=Inputs.id(product.get("id"));
            var operation=new LinkedHashMap<String,Object>();operation.put("key",command);operation.put("requestHash",requestHash);operation.put("request",body);operation.put("productId",productId);operation.put("unit",unit);operation.put("status","GLOBAL_DONE");operation.put("globalKey",child(command,"global-product"));operation.put("countryKey",child(command,"country-sku"));operation.put("rowVersion",number(row,"version")+1);
            imports.jdbc.update("UPDATE pur_order_import SET matched_product_id=?,purchase_unit=?,supplied_product_code=?,supplied_product_name=?,decision='NEW_REQUESTED',readiness='NEEDS_SETUP',product_snapshot=?::jsonb,product_operation=?::jsonb,setup_reasons='[\"全局商品已保存，等待本国启用\"]',confirmed_by=NULL,confirmed_at=NULL,version=version+1 WHERE country_id=? AND id=?",productId,unit,product.get("productCode"),product.get("name"),imports.json.write(product),imports.json.write(operation),a.requireCountry(),rowId);imports.touch(a,batch);return operation;
        });
        try{return imports.tx.execute(s->{
            Access a=imports.access(ctx,true);imports.batch(a,batch,true);var row=imports.row(a,batch,rowId);var operation=imports.map(row.get("product_operation"));if("READY".equals(operation.get("status")))return result(a,batch,rowId);
            if(number(row,"version")!=((Number)operation.get("rowVersion")).longValue())throw new ApiException(409,"PUR_IMPORT_PRODUCT_INPUT_CHANGED","来源行已修改；已创建商品保留，请重新人工核对");
            long productId=Inputs.id(operation.get("productId"));var product=master.inspect(ctx,productId);var skuBody=new LinkedHashMap<String,Object>();skuBody.put("enabled",true);if(product.get("countrySku") instanceof Map<?,?> sku){skuBody.put("version",sku.get("version"));skuBody.put("localName",sku.get("localName"));skuBody.put("taxCategory",sku.get("taxCategory"));}
            if(!Boolean.TRUE.equals(operation.get("countryDone"))){master.saveSku(ctx,productId,skuBody,operation.get("countryKey").toString());operation.put("countryDone",true);}saveDecision(ctx,a,rowId,productId,operation.get("unit").toString(),"NEW_REQUESTED");
            var saved=imports.row(a,batch,rowId);operation.put("status","READY".equals(saved.get("readiness"))?"READY":"GLOBAL_DONE");operation.put("rowVersion",number(saved,"version"));imports.jdbc.update("UPDATE pur_order_import SET product_operation=?::jsonb WHERE country_id=? AND id=?",imports.json.write(operation),a.requireCountry(),rowId);imports.touch(a,batch);audit.append(ctx,"PUR_IMPORT_NEW_PRODUCT_RESULT","PURCHASE_IMPORT",rowId,null,Map.of("productId",productId,"readiness",saved.get("readiness")));return result(a,batch,rowId);
        });}catch(ApiException failure){throw new ApiException(failure.getStatus(),failure.getCode(),failure.getMessage(),Map.of("partialResult",Map.of("productId",phase.get("productId"),"rowId",rowId,"rowVersion",phase.get("rowVersion"),"completedSteps",List.of("GLOBAL_PRODUCT"),"readiness","NEEDS_SETUP","reason",failure.getMessage(),"requestId",command)));}
    }
}
