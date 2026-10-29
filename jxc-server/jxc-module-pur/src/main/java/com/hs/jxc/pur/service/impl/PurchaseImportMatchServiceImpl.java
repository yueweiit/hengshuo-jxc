package com.hs.jxc.pur.service.impl;
import com.hs.jxc.pur.service.*;

import com.hs.jxc.pur.mapper.*;

import static com.hs.jxc.pur.service.impl.PurchaseImportServiceImpl.*;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.attachment.AttachmentService;
import com.hs.jxc.md.api.*;
import com.hs.jxc.sys.api.Access;
import static com.hs.jxc.pur.service.impl.PurchaseImportCandidateRanking.normalized;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/** 真实目录/图库证据先固定，模型只解释；不调用商品、采购或费用写入口。 */
@Service
public class PurchaseImportMatchServiceImpl implements PurchaseImportTaskHandler,PurchaseImportMatchService {
    private final PurchaseImportMatchMapper mapper;
    private final PurchaseImportServiceImpl imports;private final PurchaseImportTaskServiceImpl tasks;private final PurchaseImportRecognitionClient client;private final MasterProductMaintenanceApi products;private final ProductImageApi images;private final IdempotencyExecutor commands;private final com.hs.jxc.common.audit.AuditWriter audit;
    @Value("${jxc.purchase-import.recognition.enabled:false}") private boolean enabled;
    public PurchaseImportMatchServiceImpl(PurchaseImportServiceImpl imports,PurchaseImportTaskServiceImpl tasks,PurchaseImportRecognitionClient client,MasterProductMaintenanceApi products,ProductImageApi images,IdempotencyExecutor commands,com.hs.jxc.common.audit.AuditWriter audit,PurchaseImportMatchMapper mapper){this.mapper=mapper;this.imports=imports;this.tasks=tasks;this.client=client;this.products=products;this.images=images;this.commands=commands;this.audit=audit;}
    public Set<String> kinds(){return Set.of("MATCH","EXPLAIN");}
    private String canonical(Object value){return imports.json.write(IdempotencyExecutor.canonical(value));}
    private String hash(Object value){return Digests.sha256(canonical(value));}
    private String text(Object value){return value==null?null:value.toString().trim();}
    private Access access(RequestContext ctx){var a=imports.access(ctx,true);a.require("md:product:view");return a;}
    private Map<String,Object> raw(Access a,UUID task,boolean lock){var rows=mapper.selectTask(a.requireCountry(),task,lock);if(rows.size()!=1)throw ApiException.notFound();return rows.getFirst();}
    private Map<String,Object> source(Access a,Map<String,Object> task){var input=imports.map(task.get("input_data"));try{return imports.row(a,(UUID)task.get("batch_id"),Inputs.id(input.get("rowId")));}catch(ApiException missing){if(missing.getStatus()!=404)throw missing;throw new ApiException(409,"INPUT_CHANGED","原采购行已移除，请重新核对");}}
    public void validate(RequestContext ctx,Map<String,Object> task){var a=access(ctx);imports.batch(a,(UUID)task.get("batch_id"),false);var row=source(a,task);var input=imports.map(task.get("input_data"));if(number(row,"version")!=number(task,"input_revision")||row.get("target_order_line_id")!=null)throw new ApiException(409,"INPUT_CHANGED","采购行已变化，旧识别结果不再应用");if("MATCH".equals(task.get("kind"))&&!Objects.equals(row.get("match_task_id"),task.get("id")))throw new ApiException(409,"INPUT_CHANGED","已有更新的识别任务，旧结果不再应用");if("EXPLAIN".equals(task.get("kind"))&&(row.get("match_result")==null||!Objects.equals(imports.map(row.get("match_result")).get("runId"),input.get("parentRunId"))))throw new ApiException(409,"INPUT_CHANGED","原候选已变化，请重新识别");}
    public Map<String,Object> start(RequestContext ctx,UUID batch,Map<String,Object> body,String key){if(!enabled)throw new ApiException(503,"RECOGNITION_DISABLED","当前环境尚未启用候选识别，可继续人工确认");return imports.tx.execute(s->{var a=access(ctx);var b=imports.batch(a,batch,true);if(number(b,"version")!=Inputs.id(body.get("batchVersion")))throw Inputs.conflict();if(!(body.get("rowIds") instanceof List<?> ids)||ids.isEmpty()||ids.size()>10000||new HashSet<>(ids).size()!=ids.size())throw Inputs.bad("请选择不重复的采购行");int top=Math.toIntExact(Inputs.id(body.get("topK")));if(top>20)throw Inputs.bad("候选数量须为1至20");return commands.execute(ctx,"POST",BASE+"/"+batch+"/matches",key,body,imports.bookId(imports.map(b.get("header"))),()->{var created=new ArrayList<String>();for(Object id:ids){var row=imports.row(a,batch,Inputs.id(id));imports.requireEditable(row);if(row.get("source_id")==null)throw new ApiException(409,"SOURCE_UNAVAILABLE","旧行缺少可核实来源，请重新导入原文件");UUID task=enqueue(ctx,batch,row,"MATCH",Map.of("rowId",row.get("id"),"topK",top));mapper.assignMatchTask(task,a.requireCountry(),row.get("id"));created.add(task.toString());}var out=imports.snapshot(a,batch);out.put("taskIds",created);return out;},r->imports.batch(a,batch,false));});}
    public Map<String,Object> explain(RequestContext ctx,UUID batch,long rowId,Map<String,Object> body,String key){if(!enabled)throw new ApiException(503,"RECOGNITION_DISABLED","当前环境尚未启用AI解释");return imports.tx.execute(s->{var a=access(ctx);var b=imports.batch(a,batch,true);var row=imports.row(a,batch,rowId);imports.requireEditable(row);if(number(row,"version")!=Inputs.version(body)||row.get("match_result")==null)throw Inputs.conflict();var parent=imports.map(row.get("match_result"));if(Inputs.id(parent.get("inputRevision"))!=number(row,"version"))throw new ApiException(409,"INPUT_CHANGED","原候选版本已变化，请重新识别后再解释");return commands.execute(ctx,"POST",BASE+"/"+batch+"/rows/"+rowId+"/explanations",key,body,imports.bookId(imports.map(b.get("header"))),()->Map.of("id",enqueue(ctx,batch,row,"EXPLAIN",Map.of("rowId",rowId,"topK",20,"parentRunId",parent.get("runId"))).toString(),"status","QUEUED"),r->imports.batch(a,batch,false));});}
    public void retry(RequestContext ctx,Map<String,Object> task){validate(ctx,task);if("MATCH".equals(task.get("kind"))&&task.get("callback_hash")!=null)throw new ApiException(409,"MATCH_NEW_RUN_REQUIRED","原始候选已固定，请重新识别本行；原证据保留供追溯");}
    private UUID enqueue(RequestContext ctx,UUID batch,Map<String,Object> row,String kind,Map<String,Object> input){UUID task=UUID.randomUUID();mapper.insertTask(task,ctx.countryId(),batch,row.get("source_id"),kind,row.get("version"),hash(input),ctx.userId(),imports.json.write(Map.of("userId",ctx.userId(),"tokenHash",ctx.tokenHash())),imports.json.write(input),imports.json.write(Map.of("public",Map.of("rowId",row.get("id"),"runId",task.toString()))));audit.append(ctx,"PUR_IMPORT_MATCH_REQUEST","PURCHASE_IMPORT",number(row,"id"),null,Map.of("runId",task.toString(),"kind",kind,"inputRevision",row.get("version")));return task;}
    private Map<String,Object> locked(PurchaseImportTaskServiceImpl.Scope scope,boolean complete){var a=access(scope.actor());imports.batch(a,(UUID)scope.task().get("batch_id"),true);var current=raw(a,(UUID)scope.task().get("id"),true);boolean sameRunning="RUNNING".equals(current.get("status"))&&Objects.equals(current.get("credential_hash"),scope.task().get("credential_hash"))&&current.get("credential_hash")!=null;boolean replay=complete&&current.get("callback_hash")!=null&&Objects.equals(current.get("callback_credential_hash"),scope.task().get("callback_credential_hash"));if(!sameRunning&&!replay)throw ApiException.forbidden();return current;}
    private Map<String,Object> route(String status,String reason){return new LinkedHashMap<>(Map.of("status",status,"reason",reason));}
    public Map<String,Object> catalogSearch(UUID taskId,String credential,Map<String,Object> body){
        var scope=tasks.scoped(taskId,credential,false);String operation=Inputs.required(body,"operation");
        if(!body.keySet().equals(operation.equals("RESOLVE")?Set.of("operation","imageResults"):Set.of("operation")))throw Inputs.bad("工具不接受任意查询、身份或SQL字段");
        if(operation.equals("REVIEW")){
            var task=imports.tx.execute(s->{var current=locked(scope,false);validate(scope.actor(),current);return current;});
            return reviewImages(scope,task);
        }
        return imports.tx.execute(s->{var task=locked(scope,false);validate(scope.actor(),task);return switch(operation){case "TEXT"->catalog(scope.actor(),task);case "RESOLVE"->resolve(scope.actor(),task,body);default->throw Inputs.bad("只允许受限文字查询、真实候选回查和固定候选读图");};});
    }
    private Map<String,Object> catalog(RequestContext ctx,Map<String,Object> task){var result=imports.map(task.get("result"));if(result.get("catalog")!=null)return imports.map(result.get("catalog"));var a=access(ctx);var row=source(a,task);var input=imports.map(task.get("input_data"));var out=new LinkedHashMap<String,Object>();out.put("runId",task.get("id").toString());out.put("rowId",row.get("id"));out.put("inputRevision",task.get("input_revision"));out.put("mode",task.get("kind"));var snapshots=new LinkedHashMap<String,Object>();var textIds=new ArrayList<Long>();Map<String,Object> textRoute;
        if("EXPLAIN".equals(task.get("kind"))){var parentTask=raw(a,UUID.fromString(input.get("parentRunId").toString()),false);var parent=imports.map(parentTask.get("result"));if(parent.get("evidence")==null)throw Inputs.bad("原候选证据不完整");out.put("parentEvidence",parent.get("evidence"));snapshots.putAll(imports.map(parent.get("snapshots")));textRoute=imports.map(imports.map(parent.get("evidence")).get("text"));out.put("imagePlan",Map.of("state","NO_INPUT","reason","只重试原证据解释，不重复图片检索","requests",List.of()));}
        else{String code=text(row.get("supplied_product_code")),name=text(row.get("supplied_product_name")),supplier=text(row.get("supplier_product_code"));String keyword=code!=null&&!code.isBlank()?code:name;
            if(keyword==null||keyword.isBlank())textRoute=route(supplier!=null&&!supplier.isBlank()?"UNAVAILABLE":"NO_INPUT",supplier!=null&&!supplier.isBlank()?"供应商编码尚无系统对照，请补系统编码或名称":"未提供系统商品编码或名称，规格本身不能代替名称");
            else{var queried=products.queryProductCandidates(ctx,keyword,code!=null&&!code.isBlank(),50);for(var product:list(queried.get("records"))){if(code!=null&&!code.isBlank()&&!normalized(code).equals(normalized(product.get("productCode"))))continue;long id=Inputs.id(product.get("id"));textIds.add(id);snapshots.put(Long.toString(id),products.inspect(ctx,id));}textRoute=route(textIds.isEmpty()?"NOT_FOUND":"FOUND",textIds.isEmpty()?"本次真实目录查询没有匹配商品":"来自当前真实商品目录"+(((Number)queried.get("total")).longValue()>50?"；仅展示前50条，请补充更准确名称":""));}out.put("imagePlan",imagePlan(ctx,a,task,row,input));}
        if(!"EXPLAIN".equals(task.get("kind")))textRoute.put("candidateIds",textIds);out.put("text",textRoute);out.put("textMatchField",row.get("supplied_product_code")!=null?"suppliedProductCode":"suppliedProductName");result.put("catalog",out);result.put("snapshots",snapshots);mapper.saveTextResult(imports.json.write(result),a.requireCountry(),task.get("id"));return out;
    }
    private Map<String,Object> imagePlan(RequestContext ctx,Access a,Map<String,Object> task,Map<String,Object> row,Map<String,Object> input){var selected=mapper.selectConfirmedImages(a.requireCountry(),row.get("id"),task.get("batch_id"));if(selected.isEmpty())return Map.of("state","NO_INPUT","reason","没有归属已确认的本行原图","requests",List.of());var gallery=images.gallery(ctx);if(!Set.of("READY","PARTIAL").contains(gallery.get("status"))||gallery.get("manifest")==null)return Map.of("state","UNAVAILABLE","reason","正式图库状态："+gallery.get("status")+(gallery.get("lastError")==null?"":"；"+gallery.get("lastError")),"requests",List.of());var manifest=imports.map(gallery.get("manifest"));String generation=Inputs.required(manifest,"generation");var index=images.indexReference(ctx,generation);var requests=new ArrayList<Map<String,Object>>();var allowed=new ArrayList<Map<String,Object>>();allowed.add(Map.of("id",index.get("assetId"),"kind","INDEX","generation",generation));for(var image:selected){requests.add(Map.of("queryAssetId",image.get("id"),"querySha256",image.get("image_sha256"),"indexAssetId",index.get("assetId"),"manifest",manifest,"topK",20));allowed.add(Map.of("id",image.get("id"),"kind","IMAGE"));}input.put("allowedAssets",allowed);mapper.saveInput(imports.json.write(input),a.requireCountry(),task.get("id"));return Map.of("state","READY","reason",gallery.get("status").equals("PARTIAL")?"正式图库仅部分覆盖，未命中不证明没有商品":"使用已发布正式图库","requests",requests,"manifest",manifest,"coverage",gallery.get("coverage"));}
    private Map<String,Object> reviewImages(PurchaseImportTaskServiceImpl.Scope scope,Map<String,Object> task){
        var ctx=scope.actor();var data=imports.map(task.get("result"));if(data.get("evidence")==null)throw Inputs.bad("请先固定真实候选证据，再读取复核图片");
        var evidence=imports.map(data.get("evidence"));verifyCatalog(ctx,imports.map(data.get("snapshots")));
        var payloads=new LinkedHashMap<String,Map<String,Object>>();var pairs=new ArrayList<Map<String,Object>>();var errors=new ArrayList<Map<String,Object>>();
        int totalBytes=0;
        for(var candidate:list(evidence.get("candidates"))){
            long product=Inputs.id(candidate.get("productId"));var best=list(candidate.get("visualEvidence")).stream().max(Comparator.comparingDouble(v->((Number)v.get("score")).doubleValue()));
            if(best.isEmpty()){errors.add(Map.of("productId",product,"reason","此候选没有真实图像命中，尚未核对照片"));continue;}
            var hit=best.get();long query=Inputs.id(hit.get("queryAssetId")),image=Inputs.id(hit.get("imageId"));String sourceKey="SOURCE:"+query,candidateKey="CANDIDATE:"+image;
            try{
                verifyReviewPhoto(images,ctx,evidence,product,hit);
                for(String key:List.of(sourceKey,candidateKey)){
                    if(payloads.containsKey(key))continue;
                    var file=key.equals(sourceKey)?imports.content(ctx,(UUID)task.get("batch_id"),query,true):images.content(ctx,image);
                    if(!Set.of("image/png","image/jpeg","image/gif","image/webp").contains(file.contentType()))throw new ApiException(422,"IMAGE_REVIEW_FORMAT","照片格式不支持模型复核");
                    if(file.bytes().length>10*1024*1024||totalBytes+file.bytes().length>24*1024*1024)throw new ApiException(422,"IMAGE_REVIEW_LIMIT","本行复核图片超过允许大小，请减少或更换原图");
                    totalBytes+=file.bytes().length;payloads.put(key,Map.of("key",key,"sha256",com.hs.jxc.attachment.AttachmentObjectStore.sha256(file.bytes()),"dataUrl","data:"+file.contentType()+";base64,"+Base64.getEncoder().encodeToString(file.bytes())));
                }
                pairs.add(Map.of("productId",product,"sourceKey",sourceKey,"candidateKey",candidateKey));
            }catch(ApiException failure){if(Set.of("AUTH_REQUIRED","SYS_FORBIDDEN","INPUT_CHANGED").contains(failure.getCode())||failure.getStatus()==401||failure.getStatus()==403)throw failure;errors.add(Map.of("productId",product,"reason",failure.getCode()+"："+failure.getMessage()));}
        }
        var used=new HashSet<String>();pairs.forEach(pair->{used.add(pair.get("sourceKey").toString());used.add(pair.get("candidateKey").toString());});
        var pictures=payloads.values().stream().filter(v->used.contains(v.get("key"))).toList();
        var basis=Map.of("evidenceHash",evidence.get("evidenceHash"),"pairs",pairs,"errors",errors,"images",pictures.stream().map(v->Map.of("key",v.get("key"),"sha256",v.get("sha256"))).toList());
        imports.tx.execute(s->{var current=locked(scope,false);validate(ctx,current);var saved=imports.map(current.get("result"));
            if(!Objects.equals(imports.map(saved.get("evidence")).get("evidenceHash"),evidence.get("evidenceHash")))throw new ApiException(409,"INPUT_CHANGED","复核期间候选证据已变化");
            verifyCatalog(ctx,imports.map(saved.get("snapshots")));saved.put("reviewBasis",basis);mapper.saveEvidence(imports.json.write(saved),ctx.countryId(),task.get("id"));return null;});
        return Map.of("format","ImageReviewInputV1","evidenceHash",evidence.get("evidenceHash"),"images",pictures,"pairs",pairs,"errors",errors);
    }
    @SuppressWarnings("unchecked") static void verifyReviewPhoto(ProductImageApi images,RequestContext ctx,Map<String,Object> evidence,long product,Map<String,Object> hit){
        String generation=Inputs.required((Map<String,Object>)evidence.get("image"),"generation");
        var current=images.resolveHits(ctx,generation,List.of(Map.of("featureId",hit.get("featureId"),"score",hit.get("score"))));
        if(current.stream().noneMatch(v->Inputs.id(v.get("productId"))==product&&Inputs.id(v.get("imageId"))==Inputs.id(hit.get("imageId"))))throw new ApiException(409,"INPUT_CHANGED","候选照片归属已变化，请重新识别");
    }
    private void verifyCatalog(RequestContext ctx,Map<String,Object> snapshots){for(var entry:snapshots.entrySet())if(!PurchaseImportPhotoCache.sameSnapshot(imports.json,entry.getValue(),products.inspect(ctx,Long.parseLong(entry.getKey()))))throw new ApiException(409,"INPUT_CHANGED","商品或本国配置已变化，请重新识别");}
    /** 新任务保留行版本保护；只有照片和图库依据未变才复用旧的照片候选。 */
    private Map<String,Object> reusePhotos(RequestContext ctx,Map<String,Object> task){
        if(!"MATCH".equals(task.get("kind")))return null;
        var a=access(ctx);var row=source(a,task);
        if(row.get("match_result")==null)return null;
        var previous=imports.map(row.get("match_result"));
        if(previous.get("runId")==null||previous.get("runId").equals(task.get("id").toString()))return null;
        var original=raw(a,UUID.fromString(previous.get("runId").toString()),false);
        var saved=imports.map(original.get("result"));
        if(original.get("callback_hash")==null||saved.get("catalog")==null||saved.get("evidence")==null)return null;
        var evidence=imports.map(saved.get("evidence"));var image=imports.map(evidence.get("image"));
        if(!Set.of("FOUND","NOT_FOUND").contains(image.get("status"))||!list(image.get("errors")).isEmpty())return null;
        // 空照片缓存不能掩盖新补充编码/名称后的真实目录查询。
        if(list(evidence.get("candidates")).stream().noneMatch(candidate->!list(candidate.get("visualEvidence")).isEmpty()))return null;
        var originalCatalog=imports.map(saved.get("catalog"));var plan=imports.map(originalCatalog.get("imagePlan"));
        if(!"READY".equals(plan.get("state")))return null;
        var requests=list(plan.get("requests"));var selected=mapper.selectConfirmedImages(a.requireCountry(),row.get("id"),task.get("batch_id"));
        if(requests.isEmpty()||requests.size()!=selected.size()||requests.stream().anyMatch(request->selected.stream().noneMatch(photo->Inputs.id(photo.get("id"))==Inputs.id(request.get("queryAssetId"))&&Objects.equals(photo.get("image_sha256"),request.get("querySha256")))))return null;
        var gallery=images.gallery(ctx);
        if(!Set.of("READY","PARTIAL").contains(gallery.get("status"))||gallery.get("manifest")==null||!Objects.equals(imports.map(gallery.get("manifest")).get("generation"),image.get("generation")))return null;
        if(!PurchaseImportPhotoCache.matches(images,ctx,evidence))return null;
        var candidates=new ArrayList<Map<String,Object>>();var snapshots=new LinkedHashMap<String,Object>();
        for(var old:list(evidence.get("candidates"))){
            long product=Inputs.id(old.get("productId"));
            var snapshot=products.inspect(ctx,product);snapshots.put(Long.toString(product),snapshot);
            var refreshed=candidate(row,snapshot);
            for(String field:List.of("visualScore","visualEvidence","textEvidence"))refreshed.put(field,old.get(field));
            candidates.add(refreshed);
        }
        var reused=new LinkedHashMap<String,Object>(evidence);reused.remove("evidenceHash");
        reused.put("runId",task.get("id").toString());reused.put("inputRevision",task.get("input_revision"));
        reused.put("sourceInput",PurchaseImportCandidateRanking.sourceInput(row));reused.put("candidates",candidates);
        reused.put("cacheReused",true);reused.put("cachedFromRunId",previous.get("runId"));
        reused.put("text",route("NO_INPUT","已复用照片候选并按本行当前商品文字重新评分，未重复文字目录检索"));
        reused.put("evidenceHash",hash(reused));
        var catalog=new LinkedHashMap<String,Object>(originalCatalog);catalog.put("runId",task.get("id").toString());catalog.put("inputRevision",task.get("input_revision"));
        var data=imports.map(task.get("result"));data.put("catalog",catalog);data.put("evidence",reused);data.put("snapshots",snapshots);
        mapper.saveEvidence(imports.json.write(data),a.requireCountry(),task.get("id"));
        return reused;
    }
    private List<Map<String,Object>> retainPhotoTies(List<Map<String,Object>> sorted,int top){
        int size=Math.min(top,sorted.size());
        if(size>0&&sorted.getFirst().get("visualScore") instanceof Number highest){
            while(size<sorted.size()&&sorted.get(size).get("visualScore") instanceof Number next&&Double.compare(highest.doubleValue(),next.doubleValue())==0)size++;
        }
        return sorted.subList(0,size);
    }
    private boolean photoGroupIncomplete(Map<String,Object> plan,List<Map<String,Object>> replies,List<Map<String,Object>> candidates){
        if(candidates.isEmpty()||!(candidates.getFirst().get("visualScore") instanceof Number highest))return false;
        Object indexed=imports.map(plan.get("manifest")).get("featureIds");
        if(!(indexed instanceof List<?> features))return true;
        for(var reply:replies){
            var hits=list(reply.get("hits"));
            var request=list(plan.get("requests")).stream().filter(r->Inputs.id(r.get("queryAssetId"))==Inputs.id(reply.get("queryAssetId"))).findFirst();
            if(request.isPresent()&&features.size()>hits.size()&&hits.size()>=Inputs.id(request.get().get("topK"))&&hits.stream().allMatch(hit->Double.compare(((Number)hit.get("score")).doubleValue(),highest.doubleValue())==0))return true;
        }
        return false;
    }
    private Map<String,Object> candidate(Map<String,Object> row,Map<String,Object> product){var item=new LinkedHashMap<String,Object>();long id=Inputs.id(product.get("id"));item.put("productId",id);var view=new LinkedHashMap<String,Object>();for(String field:List.of("id","productCode","name","spec","baseUnit","status","units"))view.put(field,product.get(field));item.put("product",view);item.put("textEvidence",new ArrayList<>());item.put("visualEvidence",new ArrayList<>());item.put("visualScore",null);var conflicts=new ArrayList<String>();String spec=normalized(row.get("product_spec")),actual=normalized(product.get("spec"));if(spec.isEmpty()||actual.isEmpty())conflicts.add("规格仍待核实");else if(!spec.equals(actual))conflicts.add("原行规格与候选商品规格不同");Object sku=product.get("countrySku");if(sku==null||!"ENABLED".equals(imports.map(sku).get("status")))conflicts.add("候选商品尚未在本国启用");if(row.get("purchase_unit")==null)conflicts.add("采购单位尚未人工确认");else if(list(product.get("units")).stream().noneMatch(unit->Objects.equals(unit.get("unit"),row.get("purchase_unit"))))conflicts.add("当前采购单位未配置");item.put("conflicts",conflicts);return item;}
    @SuppressWarnings("unchecked") private Map<String,Object> resolve(RequestContext ctx,Map<String,Object> task,Map<String,Object> body){var a=access(ctx);var row=source(a,task);var result=imports.map(task.get("result"));if(result.get("catalog")==null)throw Inputs.bad("请先读取本任务受限目录证据");var catalog=imports.map(result.get("catalog"));var snapshots=imports.map(result.get("snapshots"));verifyCatalog(ctx,snapshots);String requestHash=hash(body);if(result.get("resolutionHash")!=null){if(!Objects.equals(result.get("resolutionHash"),requestHash))throw new ApiException(409,"MATCH_RESOLUTION_CONFLICT","同一任务不能替换已固定的检索结果");return imports.map(result.get("evidence"));}
        var evidence=new LinkedHashMap<String,Object>();evidence.put("format","CandidateEvidenceV1");evidence.put("runId",task.get("id").toString());evidence.put("rowId",row.get("id"));evidence.put("inputRevision",task.get("input_revision"));
        if("EXPLAIN".equals(task.get("kind"))){var parent=imports.map(catalog.get("parentEvidence"));for(String field:List.of("text","image","candidates","sourceInput","status","photoGroupIncomplete","cacheReused","photoBindings"))evidence.put(field,parent.get(field));evidence.put("parentRunId",imports.map(task.get("input_data")).get("parentRunId"));}
        else{var textRoute=imports.map(catalog.get("text"));var combined=new LinkedHashMap<Long,Map<String,Object>>();for(Object id:(List<?>)textRoute.get("candidateIds")){long product=Inputs.id(id);var candidate=candidate(row,imports.map(snapshots.get(Long.toString(product))));((List<Object>)candidate.get("textEvidence")).add(Map.of("field",catalog.get("textMatchField"),"reason","当前真实目录文字命中"));combined.put(product,candidate);}var plan=imports.map(catalog.get("imagePlan"));Map<String,Object> imageRoute;
            var received=list(body.get("imageResults"));if(!"READY".equals(plan.get("state"))){if(!received.isEmpty())throw Inputs.bad("本任务没有允许检索的原图");imageRoute=route(plan.get("state").toString(),plan.get("reason").toString());}
            else{var expected=list(plan.get("requests"));if(received.size()!=expected.size())throw Inputs.bad("图片检索结果数量不完整");var seen=new HashSet<Long>();var errors=new ArrayList<Object>();boolean found=false;for(var reply:received){long asset=Inputs.id(reply.get("queryAssetId"));if(!seen.add(asset)||expected.stream().noneMatch(request->Inputs.id(request.get("queryAssetId"))==asset))throw Inputs.bad("图片结果引用了任务范围外的原图");String status=Inputs.required(reply,"status");var hits=list(reply.get("hits"));if(!Set.of("FOUND","NOT_FOUND","FAILED","UNAVAILABLE").contains(status)||status.equals("FOUND")==hits.isEmpty())throw Inputs.bad("图片状态与特征结果不一致");if(status.equals("FAILED")||status.equals("UNAVAILABLE")){errors.add(Map.of("queryAssetId",asset,"status",status,"reason",Inputs.required(reply,"reason")));continue;}var manifest=imports.map(plan.get("manifest"));for(var hit:images.resolveHits(ctx,Inputs.required(manifest,"generation"),hits)){long id=Inputs.id(hit.get("productId"));Map<String,Object> snapshot;if(snapshots.containsKey(Long.toString(id)))snapshot=imports.map(snapshots.get(Long.toString(id)));else{snapshot=products.inspect(ctx,id);snapshots.put(Long.toString(id),snapshot);}var candidate=combined.computeIfAbsent(id,k->candidate(row,snapshot));double score=((Number)hit.get("visualScore")).doubleValue();if(candidate.get("visualScore")==null||score>((Number)candidate.get("visualScore")).doubleValue())candidate.put("visualScore",score);((List<Object>)candidate.get("visualEvidence")).add(Map.of("queryAssetId",asset,"imageId",hit.get("imageId"),"featureId",hit.get("featureId"),"score",score));found=true;}}
                imageRoute=route(found?"FOUND":errors.isEmpty()?"NOT_FOUND":"FAILED",found?"来自正式图库的外观排序，仍须核对规格":errors.isEmpty()?"当前可见正式照片没有匹配；不代表商品不存在":"图片提取、索引或连接失败");imageRoute.put("errors",errors);imageRoute.put("coverage",plan.get("coverage"));imageRoute.put("generation",imports.map(plan.get("manifest")).get("generation"));}
            evidence.put("photoBindings",PurchaseImportPhotoCache.bindings(new ArrayList<>(combined.values())));
            var candidates=retainPhotoTies(combined.values().stream().sorted(Comparator.<Map<String,Object>>comparingInt(c->c.get("visualScore")==null?0:1).reversed().thenComparing(Comparator.comparingDouble((Map<String,Object> c)->c.get("visualScore")==null?-2:((Number)c.get("visualScore")).doubleValue()).reversed()).thenComparing(Comparator.<Map<String,Object>>comparingInt(c->((List<?>)c.get("textEvidence")).isEmpty()?0:1).reversed()).thenComparingLong(c->Inputs.id(c.get("productId")))).toList(),Math.toIntExact(Inputs.id(imports.map(task.get("input_data")).get("topK"))));boolean textFailure=Set.of("FAILED","UNAVAILABLE").contains(textRoute.get("status")),imageFailure=Set.of("FAILED","UNAVAILABLE").contains(imageRoute.get("status"))||imageRoute.get("errors") instanceof List<?> errors&&!errors.isEmpty();String overall=textFailure||imageFailure?candidates.isEmpty()?"FAILED":"PARTIAL":"OK";evidence.put("text",textRoute);evidence.put("image",imageRoute);evidence.put("candidates",candidates);evidence.put("photoGroupIncomplete",photoGroupIncomplete(plan,received,candidates));evidence.put("status",overall);evidence.put("sourceInput",PurchaseImportCandidateRanking.sourceInput(row));
        }
        evidence.put("evidenceHash",hash(evidence));result.put("evidence",evidence);result.put("snapshots",snapshots);result.put("resolutionHash",requestHash);mapper.saveEvidence(imports.json.write(result),a.requireCountry(),task.get("id"));return evidence;
    }
    private Map<String,Object> explanation(Map<String,Object> input,Set<Long> allowed){if(!Set.of("status","message","candidateIds","candidateNotes","candidateChecks").containsAll(input.keySet()))throw Inputs.bad("模型解释包含未经允许的写入或结果字段");String status=Inputs.required(input,"status"),message=Inputs.required(input,"message");if(!Set.of("READY","UNAVAILABLE","FAILED","NOT_REQUESTED").contains(status)||message.length()>8000)throw Inputs.bad("解释状态或长度无效");if(!(input.get("candidateIds") instanceof List<?> ids)||ids.stream().anyMatch(id->!allowed.contains(Inputs.id(id))))throw Inputs.bad("模型解释引用了真实候选之外的商品");var out=new LinkedHashMap<String,Object>();out.put("status",status);out.put("message",message);out.put("candidateIds",ids);if(input.containsKey("candidateNotes")){var notes=list(input.get("candidateNotes"));for(var note:notes)if(!Set.of("productId","message").containsAll(note.keySet())||!allowed.contains(Inputs.id(note.get("productId")))||Inputs.required(note,"message").length()>4000)throw Inputs.bad("候选说明的商品或字段无效");out.put("candidateNotes",notes);}return out;}
    private void validateChecks(RequestContext ctx,Map<String,Object> input,Map<String,Object> output,Map<String,Object> evidence,Map<String,Object> data){
        if(!input.containsKey("candidateChecks"))return; // 兼容已保存的旧解释；前端不会把旧解释显示为图文通过。
        if(!Set.of("READY","NOT_REQUESTED").contains(input.get("status"))||data.get("reviewBasis")==null)throw Inputs.bad("图文核对必须先取得本任务固定图片输入");
        var basis=imports.map(data.get("reviewBasis"));if(!Objects.equals(basis.get("evidenceHash"),evidence.get("evidenceHash")))throw Inputs.bad("图文核对依据已变化");
        var candidates=list(evidence.get("candidates"));var checks=list(input.get("candidateChecks"));var seen=new HashSet<Long>();
        if(checks.size()!=candidates.size())throw Inputs.bad("每个真实候选必须有一项图文核对结果");
        for(var check:checks){
            if(!check.keySet().equals(Set.of("productId","imageMatch","imageReason","specMatch","specReason")))throw Inputs.bad("图文核对包含未经允许的字段");
            long product=Inputs.id(check.get("productId"));var found=candidates.stream().filter(c->Inputs.id(c.get("productId"))==product).findFirst();
            if(found.isEmpty()||!seen.add(product))throw Inputs.bad("图文核对候选越界或重复");
            String image=Inputs.required(check,"imageMatch"),spec=Inputs.required(check,"specMatch");
            if(!Set.of("SAME","DIFFERENT","UNCERTAIN","NO_INPUT").contains(image)||!Set.of("MATCH","CONFLICT","MISSING","NOT_CHECKED").contains(spec)||Inputs.required(check,"imageReason").length()>2000||Inputs.required(check,"specReason").length()>2000)throw Inputs.bad("图文核对状态或说明无效");
            boolean hasPair=list(basis.get("pairs")).stream().anyMatch(pair->Inputs.id(pair.get("productId"))==product);
            if(!hasPair&&!image.equals("NO_INPUT")||hasPair&&image.equals("NO_INPUT")||!image.equals("SAME")&&!spec.equals("NOT_CHECKED")||image.equals("SAME")&&spec.equals("NOT_CHECKED"))throw Inputs.bad("必须先有真实图片并确认同款，才能核对规格");
            if(hasPair){
                var hit=list(found.get().get("visualEvidence")).stream().max(Comparator.comparingDouble(v->((Number)v.get("score")).doubleValue())).orElseThrow(()->Inputs.bad("复核缺少真实命中图"));
                verifyReviewPhoto(images,ctx,evidence,product,hit);
            }
            boolean missing=normalized(imports.map(evidence.get("sourceInput")).get("productSpec")).isEmpty()||normalized(imports.map(found.get().get("product")).get("spec")).isEmpty();
            if(image.equals("SAME")&&(missing!=spec.equals("MISSING")))throw Inputs.bad("缺少规格时必须保留待补，不能推断一致");
            if(((List<?>)input.get("candidateIds")).stream().anyMatch(id->Inputs.id(id)==product)&&!(image.equals("SAME")&&spec.equals("MATCH")))throw Inputs.bad("只允许推荐照片同款且规格一致的候选");
        }
        output.put("candidateChecks",checks);
    }
    public Map<String,Object> result(UUID taskId,String credential,Map<String,Object> body){var scope=tasks.scoped(taskId,credential,true);String callbackHash=hash(body);var saved=imports.tx.execute(s->{var task=locked(scope,true);var a=access(scope.actor());var data=imports.map(task.get("result"));if(task.get("callback_hash")!=null){if(!Objects.equals(task.get("callback_hash"),callbackHash))throw new ApiException(409,"SYS_IDEMPOTENCY_CONFLICT","同一回调不能改变已保存内容");return imports.map(data.get("public"));}
        try{validate(scope.actor(),task);}catch(ApiException stale){if(!stale.getCode().equals("INPUT_CHANGED"))throw stale;mapper.markInputStale(stale.getMessage(),a.requireCountry(),taskId);return Map.<String,Object>of("stale",true,"message",stale.getMessage());}
        if(!body.keySet().equals(Set.of("format","runId","rowId","inputRevision","evidenceHash","explanation"))||!"MatchResultV1".equals(body.get("format"))||!taskId.toString().equals(body.get("runId")))throw Inputs.bad("识别回调合同或任务编号无效");if(data.get("evidence")==null)throw Inputs.bad("服务端尚未固定真实候选证据");var evidence=imports.map(data.get("evidence"));if(Inputs.id(body.get("rowId"))!=Inputs.id(evidence.get("rowId"))||Inputs.id(body.get("inputRevision"))!=number(task,"input_revision")||!Objects.equals(body.get("evidenceHash"),evidence.get("evidenceHash")))throw Inputs.bad("回调来源版本或证据hash不一致");verifyCatalog(scope.actor(),imports.map(data.get("snapshots")));var candidates=list(evidence.get("candidates"));Set<Long> allowed=new HashSet<>();candidates.forEach(c->allowed.add(Inputs.id(c.get("productId"))));var explanation=explanation(imports.map(body.get("explanation")),allowed);validateChecks(scope.actor(),imports.map(body.get("explanation")),explanation,evidence,data);var complete=new LinkedHashMap<String,Object>(evidence);complete.put("format","MatchRunV1");complete.put("explanation",explanation);complete.put("ranking",PurchaseImportCandidateRanking.rank(imports.map(evidence.get("sourceInput")),candidates,!Boolean.TRUE.equals(evidence.get("photoGroupIncomplete"))));long rowId=Inputs.id(evidence.get("rowId"));
        if("MATCH".equals(task.get("kind"))){for(var candidate:candidates)mapper.insertCandidate(a.requireCountry(),rowId,taskId,candidate.get("productId"),imports.json.write(candidate));mapper.saveMatchResult(imports.json.write(complete),a.requireCountry(),rowId);}
        else{var row=source(a,task);var parent=imports.map(row.get("match_result"));parent.put("explanation",explanation);parent.put("explanationTaskId",taskId.toString());mapper.saveMatchResult(imports.json.write(parent),a.requireCountry(),rowId);}
        data.put("public",complete);boolean failed="FAILED".equals(evidence.get("status"))||"EXPLAIN".equals(task.get("kind"))&&!"READY".equals(explanation.get("status"));mapper.completeCallback(failed?"FAILED":"SUCCEEDED",imports.json.write(data),callbackHash,failed?"MATCH_COMPONENT_FAILED":null,failed?"候选或解释存在明确失败，请查看分路原因":null,a.requireCountry(),taskId);audit.append(scope.actor(),"PUR_IMPORT_MATCH_RESULT","PURCHASE_IMPORT",rowId,null,Map.of("runId",taskId.toString(),"candidateCount",candidates.size(),"status",evidence.get("status"),"explanationStatus",explanation.get("status")));return complete;
    });if(Boolean.TRUE.equals(saved.get("stale")))throw new ApiException(409,"INPUT_CHANGED",saved.get("message").toString());return saved;}
    public AttachmentService.Download asset(RequestContext ctx,Map<String,Object> task,long asset){returnAssetCheck(ctx,task);var input=imports.map(task.get("input_data"));var allowed=input.get("allowedAssets")==null?List.<Map<String,Object>>of():list(input.get("allowedAssets"));var found=allowed.stream().filter(item->Inputs.id(item.get("id"))==asset).findFirst();if(found.isEmpty())throw ApiException.forbidden();if("IMAGE".equals(found.get().get("kind")))return imports.content(ctx,(UUID)task.get("batch_id"),asset,true);return images.indexContent(ctx,Inputs.required(found.get(),"generation"));}
    private void returnAssetCheck(RequestContext ctx,Map<String,Object> task){imports.tx.execute(s->{validate(ctx,task);return null;});}
    public void execute(PurchaseImportTaskServiceImpl.Lease lease,PurchaseImportTaskServiceImpl runtime){imports.tx.execute(s->{var task=runtime.active(lease);validate(lease.actor(),task);return null;});
        var cached=imports.tx.execute(s->{var task=runtime.active(lease);validate(lease.actor(),task);return reusePhotos(lease.actor(),task);});
        if(cached!=null){result(lease.id(),lease.token(),Map.of("format","MatchResultV1","runId",lease.id().toString(),"rowId",cached.get("rowId"),"inputRevision",cached.get("inputRevision"),"evidenceHash",cached.get("evidenceHash"),"explanation",Map.of("status","NOT_REQUESTED","message","已复用原照片候选缓存并重算文字分，未重复调用图片检索或模型","candidateIds",List.of())));return;}
        try{client.recognize(lease.id(),lease.token(),Map.of("format","MatchTaskV1","mode",lease.kind(),"rowId",lease.input().get("rowId"),"inputRevision",lease.revision(),"sourceId",lease.source()));var state=imports.tx.execute(s->raw(access(lease.actor()),lease.id(),false));if(state.get("callback_hash")!=null||!"RUNNING".equals(state.get("status")))return;throw new ApiException(502,"N8N_RESULT_MISSING","工作流响应但未保存受限回调结果");}
        catch(ApiException unavailable){var state=imports.tx.execute(s->raw(access(lease.actor()),lease.id(),false));if(state.get("callback_hash")!=null||!"RUNNING".equals(state.get("status")))return;if(Set.of("AUTH_REQUIRED","SYS_FORBIDDEN","INPUT_CHANGED","PARSER_INTERRUPTED").contains(unavailable.getCode()))throw unavailable;
            if("EXPLAIN".equals(lease.kind()))throw unavailable;var catalog=catalogSearch(lease.id(),lease.token(),Map.of("operation","TEXT"));var plan=imports.map(catalog.get("imagePlan"));var replies=new ArrayList<Map<String,Object>>();for(var request:list(plan.get("requests"))){var query=new LinkedHashMap<String,Object>(request);try{var searched=client.search(lease.id(),lease.token(),query);var hits=list(searched.get("hits"));replies.add(Map.of("queryAssetId",request.get("queryAssetId"),"status",hits.isEmpty()?"NOT_FOUND":"FOUND","reason","受限Python图片检索","hits",hits));}catch(ApiException imageFailure){replies.add(Map.of("queryAssetId",request.get("queryAssetId"),"status","FAILED","reason",imageFailure.getCode()+"："+imageFailure.getMessage(),"hits",List.of()));}}
            var previous=imports.map(state.get("result"));var evidence=previous.get("evidence")!=null?imports.map(previous.get("evidence")):catalogSearch(lease.id(),lease.token(),Map.of("operation","RESOLVE","imageResults",replies));boolean noEvidence=list(evidence.get("candidates")).isEmpty();var explanation=Map.of("status",noEvidence?"NOT_REQUESTED":"UNAVAILABLE","message",noEvidence?"当前没有可供解释的真实候选，未调用模型":unavailable.getCode()+"："+unavailable.getMessage(),"candidateIds",List.of());result(lease.id(),lease.token(),Map.of("format","MatchResultV1","runId",lease.id().toString(),"rowId",evidence.get("rowId"),"inputRevision",evidence.get("inputRevision"),"evidenceHash",evidence.get("evidenceHash"),"explanation",explanation));
        }
    }
}
