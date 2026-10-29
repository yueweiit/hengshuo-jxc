package com.hs.jxc.pur.service.impl;
import com.hs.jxc.pur.service.*;

import com.hs.jxc.pur.mapper.*;

import static com.hs.jxc.pur.service.impl.PurchaseImportServiceImpl.*;
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
public class PurchaseImportProductServiceImpl implements PurchaseImportProductService {
    private final PurchaseImportProductMapper mapper;private final ProductImageApi images;
    private final PurchaseImportServiceImpl imports;private final MasterProductMaintenanceApi master;private final MasterProductApi products;private final com.hs.jxc.common.audit.AuditWriter audit;
    public PurchaseImportProductServiceImpl(PurchaseImportServiceImpl imports,MasterProductMaintenanceApi master,MasterProductApi products,com.hs.jxc.common.audit.AuditWriter audit,PurchaseImportProductMapper mapper,ProductImageApi images){this.images=images;this.mapper=mapper;this.imports=imports;this.master=master;this.products=products;this.audit=audit;}
    public Map<String,Object> decide(RequestContext ctx,UUID batch,long rowId,Map<String,Object> body){return imports.tx.execute(s->{
        Access a=imports.access(ctx,true);var b=imports.batch(a,batch,true);var row=imports.row(a,batch,rowId);imports.requireEditable(row);if(number(row,"version")!=Inputs.version(body))throw Inputs.conflict();String decision=Inputs.required(body,"decision");
        if(Set.of("UNRESOLVED","DEFERRED").contains(decision)){mapper.resetDecision(decision,a.requireCountry(),rowId);}
        else if("EXISTING".equals(decision)){long product=Inputs.id(body.get("productId"));if(body.get("runId")!=null){if(row.get("match_result")==null)throw Inputs.conflict();var matched=imports.map(row.get("match_result"));if(!Objects.equals(Objects.toString(row.get("match_task_id"),null),body.get("runId"))||!Objects.equals(matched.get("runId"),body.get("runId"))||Inputs.id(matched.get("inputRevision"))!=number(row,"version")||list(matched.get("candidates")).stream().noneMatch(c->Inputs.id(c.get("productId"))==product))throw new ApiException(409,"MATCH_CANDIDATE_STALE","候选不存在或版本已变化，请重新核对");var task=mapper.selectTaskResult(a.requireCountry(),UUID.fromString(body.get("runId").toString()));if(task.size()!=1)throw Inputs.conflict();var snapshots=imports.map(imports.map(task.getFirst().get("result")).get("snapshots"));if(!PurchaseImportPhotoCache.sameSnapshot(imports.json,snapshots.get(Long.toString(product)),master.inspect(ctx,product)))throw new ApiException(409,"MATCH_CANDIDATE_STALE","候选主数据已变化，请重新核对");
                var ranking=PurchaseImportCandidateRanking.rank(PurchaseImportCandidateRanking.sourceInput(row),list(matched.get("candidates")),!Boolean.TRUE.equals(matched.get("photoGroupIncomplete")));
                if(!Boolean.TRUE.equals(body.get("confirmCandidate"))&&(matched.get("ranking")==null||((List<?>)ranking.get("recommendedIds")).stream().noneMatch(id->Inputs.id(id)==product)))throw new ApiException(409,"MATCH_MANUAL_CONFIRM_REQUIRED","此缓存候选未通过推荐门槛，请明确人工核对后再确认");
                if(!Boolean.TRUE.equals(body.get("confirmCandidate"))){
                    var gallery=images.gallery(ctx);
                    if(!Set.of("READY","PARTIAL").contains(gallery.get("status"))||gallery.get("manifest")==null||!Objects.equals(imports.map(gallery.get("manifest")).get("generation"),imports.map(matched.get("image")).get("generation")))throw new ApiException(409,"MATCH_CANDIDATE_STALE","图库已变化，请重新核对候选");
                    var selected=list(matched.get("candidates")).stream().filter(c->Inputs.id(c.get("productId"))==product).findFirst().orElseThrow(Inputs::conflict);
                    var hits=list(selected.get("visualEvidence"));if(hits.isEmpty())throw new ApiException(409,"MATCH_CANDIDATE_STALE","候选照片依据缺失，请重新核对");
                    if(!PurchaseImportPhotoCache.matches(images,ctx,matched))throw new ApiException(409,"MATCH_CANDIDATE_STALE","照片关联的候选集合已变化，请重新核对");
                    for(Object id:(List<?>)ranking.get("highestPhotoIds"))if(Inputs.id(id)!=product&&!PurchaseImportPhotoCache.sameSnapshot(imports.json,snapshots.get(Long.toString(Inputs.id(id))),master.inspect(ctx,Inputs.id(id))))throw new ApiException(409,"MATCH_CANDIDATE_STALE","同照片候选的商品资料已变化，请重新核对");
                }}String unit=Inputs.required(body,"unit");saveDecision(ctx,a,rowId,product,unit,"EXISTING");}
        else throw Inputs.bad("请选择已有商品、暂缓或待确认；新增商品须明确提交新品请求");
        imports.touch(a,batch);var out=result(a,batch,rowId);var details=new LinkedHashMap<String,Object>();for(String field:List.of("version","decision","readiness"))details.put(field,out.get(field));
        if(body.get("runId")!=null){details.put("runId",body.get("runId"));details.put("manualCandidate",Boolean.TRUE.equals(body.get("confirmCandidate")));}
        audit.append(ctx,"PUR_IMPORT_PRODUCT_DECISION","PURCHASE_IMPORT",rowId,Map.of("version",row.get("version")),details);return out;
    });}
    private Map<String,Object> saveDecision(RequestContext ctx,Access a,long rowId,long product,String unit,String decision){
        var snapshot=master.inspect(ctx,product);var reasons=new ArrayList<String>();
        if(!"ENABLED".equals(snapshot.get("status")))reasons.add("全局商品已停用");
        Object sku=snapshot.get("countrySku");if(!(sku instanceof Map<?,?> m)||!"ENABLED".equals(m.get("status")))reasons.add("商品尚未在本国启用");
        if(list(snapshot.get("units")).stream().noneMatch(u->unit.equals(u.get("unit"))))reasons.add("商品未配置所选单位换算");
        if(reasons.isEmpty())products.requireEnabled(a.requireCountry(),product,unit);
        boolean ready=reasons.isEmpty();mapper.saveDecision(product,unit,decision,ready?"READY":"NEEDS_SETUP",imports.json.write(snapshot),imports.json.write(reasons),ready?a.userId():null,ready,a.requireCountry(),rowId);return snapshot;
    }
    private Map<String,Object> result(Access a,UUID batch,long rowId){var out=imports.rowDto(imports.row(a,batch,rowId));out.put("batchVersion",PurchaseRows.one(imports.mapper.selectBatchVersion(a.requireCountry(),batch)));return out;}
    private String child(String key,String step){return UUID.nameUUIDFromBytes((key+":"+step).getBytes(StandardCharsets.UTF_8)).toString();}
    public Map<String,Object> createProduct(RequestContext ctx,UUID batch,long rowId,Map<String,Object> body,String key){
        if(!Boolean.TRUE.equals(body.get("confirmNew")))throw Inputs.bad("新增商品前必须明确确认");
        if(key==null||!key.matches("[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"))throw Inputs.bad("请提供UUID格式的新品请求编号");
        String command=key.toLowerCase(Locale.ROOT),requestHash=Digests.sha256(imports.json.write(IdempotencyExecutor.canonical(body)));
        var phase=imports.tx.execute(s->{
            // 原商品维护要获取全局写门禁，必须在任何共享授权读取之前取得。
            imports.auth.authorizeCoordinatedWrite(ctx);Access a=imports.access(ctx,true);imports.batch(a,batch,true);var row=imports.row(a,batch,rowId);imports.requireEditable(row);
            if(row.get("product_operation")!=null){var operation=imports.map(row.get("product_operation"));if(!command.equals(operation.get("key"))||!requestHash.equals(operation.get("requestHash")))throw new ApiException(409,"PUR_IMPORT_PRODUCT_INTENT_CONFLICT","已有新品操作，请恢复原请求或选用已创建的商品");return operation;}
            if(number(row,"version")!=Inputs.version(body))throw Inputs.conflict();a.require("md:product:edit");if(!a.platformAdmin())throw ApiException.forbidden();
            var input=imports.map(body.get("product"));String code=Inputs.required(input,"productCode");String unit=Inputs.required(body,"unit");
            if(PurchaseRows.one(mapper.countProductCode(code))>0)throw new ApiException(409,"PUR_IMPORT_PRODUCT_EXISTS","此编码商品已存在，请从真实目录选择");
            if(PurchaseRows.one(mapper.countRequestedCode(a.requireCountry(),batch,rowId,code))>0)throw new ApiException(409,"PUR_IMPORT_BATCH_PRODUCT_EXISTS","本批次已有相同新品编码，请先核对");
            var product=master.saveProduct(ctx,null,input,child(command,"global-product"));long productId=Inputs.id(product.get("id"));
            var operation=new LinkedHashMap<String,Object>();operation.put("key",command);operation.put("requestHash",requestHash);operation.put("request",body);operation.put("productId",productId);operation.put("unit",unit);operation.put("status","GLOBAL_DONE");operation.put("globalKey",child(command,"global-product"));operation.put("countryKey",child(command,"country-sku"));operation.put("rowVersion",number(row,"version")+1);
            mapper.saveCreatedProduct(productId,unit,product.get("productCode"),product.get("name"),imports.json.write(product),imports.json.write(operation),a.requireCountry(),rowId);imports.touch(a,batch);return operation;
        });
        try{return imports.tx.execute(s->{
            Access a=imports.access(ctx,true);imports.batch(a,batch,true);var row=imports.row(a,batch,rowId);imports.requireEditable(row);var operation=imports.map(row.get("product_operation"));if("READY".equals(operation.get("status")))return result(a,batch,rowId);
            if(number(row,"version")!=((Number)operation.get("rowVersion")).longValue())throw new ApiException(409,"PUR_IMPORT_PRODUCT_INPUT_CHANGED","来源行已修改；已创建商品保留，请重新人工核对");
            long productId=Inputs.id(operation.get("productId"));var product=master.inspect(ctx,productId);var skuBody=new LinkedHashMap<String,Object>();skuBody.put("enabled",true);if(product.get("countrySku") instanceof Map<?,?> sku){skuBody.put("version",sku.get("version"));skuBody.put("localName",sku.get("localName"));skuBody.put("taxCategory",sku.get("taxCategory"));}
            if(!Boolean.TRUE.equals(operation.get("countryDone"))){master.saveSku(ctx,productId,skuBody,operation.get("countryKey").toString());operation.put("countryDone",true);}saveDecision(ctx,a,rowId,productId,operation.get("unit").toString(),"NEW_REQUESTED");
            var saved=imports.row(a,batch,rowId);operation.put("status","READY".equals(saved.get("readiness"))?"READY":"GLOBAL_DONE");operation.put("rowVersion",number(saved,"version"));mapper.saveProductOperation(imports.json.write(operation),a.requireCountry(),rowId);imports.touch(a,batch);audit.append(ctx,"PUR_IMPORT_NEW_PRODUCT_RESULT","PURCHASE_IMPORT",rowId,null,Map.of("productId",productId,"readiness",saved.get("readiness")));return result(a,batch,rowId);
        });}catch(ApiException failure){throw new ApiException(failure.getStatus(),failure.getCode(),failure.getMessage(),Map.of("partialResult",Map.of("productId",phase.get("productId"),"rowId",rowId,"rowVersion",phase.get("rowVersion"),"completedSteps",List.of("GLOBAL_PRODUCT"),"readiness","NEEDS_SETUP","reason",failure.getMessage(),"requestId",command)));}
    }
}
