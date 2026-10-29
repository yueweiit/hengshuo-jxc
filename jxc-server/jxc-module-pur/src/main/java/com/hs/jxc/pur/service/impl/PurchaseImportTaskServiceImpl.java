package com.hs.jxc.pur.service.impl;
import com.hs.jxc.pur.service.*;

import com.hs.jxc.pur.mapper.*;

import static com.hs.jxc.pur.service.impl.PurchaseImportServiceImpl.*;
import com.hs.jxc.attachment.*;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbContext;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.sys.api.Access;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;

import org.springframework.stereotype.Service;

/** 持久租约只围绕短事务；网络、原图写入均发生在事务外。 */
@Service
public class PurchaseImportTaskServiceImpl implements PurchaseImportTaskService {
    private static final org.slf4j.Logger LOG=org.slf4j.LoggerFactory.getLogger(PurchaseImportTaskServiceImpl.class);
    private final PurchaseImportServiceImpl imports;private final PurchaseImportRecognitionClient parser;
    private final org.springframework.beans.factory.ObjectProvider<PurchaseImportTaskHandler> handlers;
    private final PurchaseImportProgressService progress;
    private final PurchaseImportBatchExecutor batches;
    private final AttachmentAssetService assets;private final PurchaseImportTaskMapper mapper;private final DbContext db;private final IdempotencyExecutor commands;
    record Lease(UUID id,long country,UUID batch,long source,int revision,UUID owner,RequestContext actor,String token,String sha,String sheet,String kind,Map<String,Object> input){}
    public PurchaseImportTaskServiceImpl(PurchaseImportServiceImpl imports,PurchaseImportRecognitionClient parser,AttachmentAssetService assets,PurchaseImportTaskMapper mapper,DbContext db,IdempotencyExecutor commands,org.springframework.beans.factory.ObjectProvider<PurchaseImportTaskHandler> handlers,PurchaseImportProgressService progress,PurchaseImportBatchExecutor batches){this.batches=batches;this.progress=progress;this.handlers=handlers;this.imports=imports;this.parser=parser;this.assets=assets;this.mapper=mapper;this.db=db;this.commands=commands;}
    private void gates(long country){db.apply(null);imports.auth.gate(0,false);db.apply(country);imports.auth.gate(country,false);}
    RequestContext actor(Map<String,Object> t){var basis=imports.map(t.get("authorization_basis"));return new RequestContext(number(t,"requested_by"),number(t,"country_id"),"purchase-task-"+t.get("id"),basis.get("tokenHash").toString());}
    Lease claim(long country,UUID id){return imports.tx.execute(s->{
        gates(country);var found=mapper.selectClaimableTask(country,id);if(found.isEmpty())return null;
        // 领取、完成、编辑和重试统一先锁批次，再锁任务，避免恢复竞争时逆序锁定。
        mapper.lockBatch(country,found.getFirst().get("batch_id"));
        if(imports.mapper.countPendingClear(country,(UUID)found.getFirst().get("batch_id"))>0)return null;
        found=mapper.selectClaimableTaskForUpdate(country,id);if(found.isEmpty())return null;var task=found.getFirst();var ctx=actor(task);Access a;
        try{a=imports.access(ctx,true);imports.batch(a,(UUID)task.get("batch_id"),false);}catch(ApiException e){mapper.markNeedsReauth(e.getCode(),"请求者授权已失效，请重新登录后重试",country,id);return null;}
        UUID batch=(UUID)task.get("batch_id");var b=imports.batch(a,batch,true);if("PARSE".equals(task.get("kind"))&&number(b,"version")!=number(task,"input_revision")){mapper.markStale(country,id);return null;}
        String token=country+":"+UUID.randomUUID()+UUID.randomUUID().toString();UUID lease=UUID.randomUUID();
        mapper.claimTask(lease,hash(token),country,id);
        if("PARSE".equals(task.get("kind"))){mapper.markSourceParsing(country,task.get("source_id"));progress.start(country,id,lease,((Number)task.get("attempt_count")).intValue()+1);}
        var options=imports.map(PurchaseRows.one(mapper.selectParseOptions(country,task.get("source_id"))) .get("parse_options"));
        return new Lease(id,country,batch,number(task,"source_id"),(int)number(task,"input_revision"),lease,ctx,token,task.get("input_hash").toString(),(String)options.get("sheet"),task.get("kind").toString(),"PARSE".equals(task.get("kind"))?options:imports.map(task.get("input_data")));
    });}
    public void execute(long country,UUID taskId){
        Lease lease=claim(country,taskId);if(lease==null)return;
        try{
            if(!"PARSE".equals(lease.kind)){handler(lease.kind).execute(lease,this);return;}
            var source=imports.content(lease.actor,lease.batch,lease.source,false);
            if(!AttachmentObjectStore.sha256(source.bytes()).equals(lease.sha))throw Inputs.bad("原文件哈希已变化");
            var local=new PurchaseXlsxTemplateParser().parse(source.bytes(),source.fileName(),lease.sheet,event->progress.publish(lease.actor,lease.id,lease.owner,event));
            var result=local.orElseGet(()->lease.input.containsKey("mappingOverrides")?parser.parse(taskId,lease.token,lease.source,lease.sha,lease.sheet,imports.map(lease.input.get("mappingOverrides"))):parser.parse(taskId,lease.token,lease.source,lease.sha,lease.sheet));validate(result,lease);
            int totalRows=list(result.get("rows")).size(),totalImages=list(result.get("images")).size();
            publish(lease,"PREPARING_IMAGES",totalRows,totalRows,0,totalImages,null,null);
            var prepared=new LinkedHashMap<String,AttachmentAssetService.Prepared>();
            for(var image:list(result.get("images"))){byte[] content;try{content=Base64.getDecoder().decode(Inputs.required(image,"contentBase64"));}catch(IllegalArgumentException e){throw Inputs.bad("解析图片编码无效");}
                String sha=Inputs.required(image,"sha256"),mime=Inputs.required(image,"mimeType");if(!Set.of("image/png","image/jpeg","image/webp","image/gif").contains(mime)||!sha.equals(AttachmentObjectStore.sha256(content))||content.length!=number(image,"bytes"))throw Inputs.bad("原图哈希、格式或大小不一致");
                if(prepared.put(Inputs.required(image,"imageId"),assets.prepare(lease.actor,AttachmentAssetService.Policy.PURCHASE_IMAGE,sha+".image",mime,content))!=null)throw Inputs.bad("原图编号重复");
                if(tick(prepared.size(),totalImages))publish(lease,"PREPARING_IMAGES",totalRows,totalRows,prepared.size(),totalImages,null,null);
            }
            imports.tx.execute(s->{Access a=imports.access(lease.actor,true);var b=imports.batch(a,lease.batch,true);var task=active(lease);
                if(number(b,"version")!=lease.revision)throw new ApiException(409,"INPUT_CHANGED","批次内容已变化，解析结果未写入");
                int next=(int)number(b,"next_row_no");var h=imports.map(b.get("header"));var rowIds=new HashMap<String,List<Long>>();var imageIds=new HashMap<String,Long>();int savedRows=0;
                publish(lease,"SAVING",0,totalRows,totalImages,totalImages,null,null);
                for(var image:list(result.get("images"))){String imageKey=Inputs.required(image,"imageId");long asset=assets.register(lease.actor,prepared.get(imageKey));long id=PurchaseRows.one(mapper.insertImage(country,lease.source,asset,image.get("sha256"),image.get("mediaPart"),image.get("mimeType"),Inputs.id(image.get("width")),Inputs.id(image.get("height"))));imageIds.put(imageKey,id);}
                for(var row:list(result.get("rows"))){var values=values(imports.map(row.get("normalizedValues")));var args=new ArrayList<Object>(Arrays.asList(country,lease.batch,next++,h.get("bookId"),h.get("supplierId"),h.get("currency"),h.get("orderDate")));args.add(h.get("expectedDate"));args.add(h.get("paymentTerms"));args.add(h.get("prepayRatio"));args.add(h.get("termDays"));FIELDS.forEach(k->args.add(values.get(k)));args.add(lease.actor.userId());args.add(lease.source);args.add(row.get("sourceSheet"));args.add(Inputs.id(row.get("sourceRow")));args.add(imports.json.write(imports.map(row.get("originalValues"))));args.add(imports.json.write(Map.of("formulas",imports.map(row.get("formulas")),"rawNumericTexts",imports.map(row.get("rawNumericTexts")),"cachedValues",imports.map(row.get("cachedValues")),"valuesRecalculated",false,"sourceCells",row.containsKey("sourceCells")?imports.map(row.get("sourceCells")):Map.of())));var origins=new LinkedHashMap<String,Object>();FIELDS.forEach(k->origins.put(k,"FILE"));if(row.get("sourceCells") instanceof Map<?,?> cells&&cells.containsKey("manualSpecLabel"))origins.put("productSpec","MANUAL");args.add(imports.json.write(origins));args.add(sourceKey(row));
                    long id=PurchaseRows.one(mapper.insertSourceRow(args.get(0),args.get(1),args.get(2),args.get(3),args.get(4),args.get(5),args.get(6),args.get(7),args.get(8),args.get(9),args.get(10),args.get(11),args.get(12),args.get(13),args.get(14),args.get(15),args.get(16),args.get(17),args.get(18),args.get(19),args.get(20),args.get(21),args.get(22),args.get(23),args.get(24),args.get(25),args.get(26),args.get(27),args.get(28),args.get(29)));rowIds.computeIfAbsent(row.get("sourceSheet")+":"+row.get("sourceRow"),k->new ArrayList<>()).add(id);
                    savedRows++;if(tick(savedRows,totalRows))publish(lease,"SAVING",savedRows,totalRows,totalImages,totalImages,row.get("sourceSheet").toString(),(int)Inputs.id(row.get("sourceRow")));
                }
                publish(lease,"LINKING",totalRows,totalRows,totalImages,totalImages,null,null);
                for(var assoc:list(result.get("associations"))){var sourceRows=rowIds.getOrDefault(assoc.get("sourceSheet")+":"+assoc.get("sourceRow"),List.of());Long image=imageIds.get(assoc.get("imageId"));if(image==null)throw Inputs.bad("图片锚点引用不存在的图片");for(Long row:sourceRows)mapper.upsertRowImage(country,row,image,imports.json.write(Map.of("anchors",List.of(assoc.get("anchor")))));}
                mapper.completeSource(imports.map(result.get("source")).get("parserVersion"),imports.json.write(result.get("sheets")),imports.json.write(result.get("warnings")),imports.json.write(result.get("associations")),country,lease.source);
                mapper.completeBatch(next,country,lease.batch);
                long reviewRows=list(result.get("rows")).stream().filter(r->{var v=imports.map(r.get("normalizedValues"));return List.of("sourceOrderNo","productSpec","purchaseQty","purchaseUnitPrice").stream().anyMatch(k->v.get(k)==null);}).count();long unstaged=list(result.get("warnings")).stream().filter(w->"ROW_NOT_STAGED".equals(w.get("code"))).count();mapper.completeParseTask(imports.json.write(Map.of("sourceId",lease.source,"rows",list(result.get("rows")).size(),"images",imageIds.size(),"reviewRows",reviewRows,"unstagedCandidates",unstaged)),country,taskId);return null;
            });
        }catch(RuntimeException error){fail(lease,error);}
    }
    void fail(Lease lease,RuntimeException error){
        if(!(error instanceof ApiException)){Throwable root=error;while(root.getCause()!=null)root=root.getCause();String diagnostic=root instanceof org.postgresql.util.PSQLException pg&&pg.getServerErrorMessage()!=null?pg.getServerErrorMessage().getMessage():root.getClass().getName();LOG.warn("Purchase import task {} kind {} failed: {}; frames={}",lease.id,lease.kind,diagnostic,java.util.Arrays.stream(root.getStackTrace()).filter(frame->frame.getClassName().startsWith("com.hs.")).limit(8).toList());}String code=error instanceof ApiException api?api.getCode():lease.kind.equals("PARSE")?"PARSE_FAILED":"TASK_FAILED";String message=error instanceof ApiException api?api.getMessage():"任务执行或保存失败，请检查服务后重试";
            imports.tx.execute(s->{gates(lease.country);String state=code.equals("INPUT_CHANGED")?"STALE":code.startsWith("AUTH_")||code.equals("SYS_FORBIDDEN")?"NEEDS_REAUTH":"FAILED";Object details=error instanceof ApiException api?api.getData():null;
                int changed=mapper.failOwnedTask(state,code,message,details==null?null:imports.json.write(details),lease.country,lease.id,lease.owner);
                if(changed==1&&"PARSE".equals(lease.kind)){mapper.failSource(state.equals("STALE")?"STALE":"FAILED",code,message,lease.country,lease.source);mapper.failBatch(lease.country,lease.batch);}return null;
            });
    }
    Map<String,Object> active(Lease lease){var a=imports.access(lease.actor,true);imports.batch(a,lease.batch,true);var found=mapper.selectActiveTaskForUpdate(lease.country,lease.id,lease.owner);if(found.size()!=1)throw new ApiException(409,"TASK_LEASE_LOST","任务租约已失效，旧结果未写入");mapper.renewOwnedLease(lease.country,lease.id,lease.owner);return found.getFirst();}
    private String sourceKey(Map<String,Object> row){
        long number=Inputs.id(row.get("sourceRow"));if(!row.containsKey("sourceItemKey"))return "ROW:"+number;
        String key=Inputs.required(row,"sourceItemKey");if(!key.equals("ROW:"+number)&&!key.matches("[A-Z]{1,3}"+number))throw Inputs.bad("数量单元格与原行不一致");return key;
    }
    private void validate(Map<String,Object> result,Lease lease){if(!"SourceDocumentV1".equals(result.get("format"))||!lease.sha.equals(imports.map(result.get("source")).get("fileSha256")))throw Inputs.bad("解析来源合同或文件哈希不一致");Inputs.required(imports.map(result.get("source")),"parserVersion");if(!list(result.get("errors")).isEmpty())throw Inputs.bad("解析来源含错误，未保存采购明细");var rows=list(result.get("rows"));if(rows.isEmpty()||rows.size()>10000)throw Inputs.bad("采购明细为空或超过10000行");var selected=list(result.get("sheets")).stream().filter(s->"PURCHASE".equals(s.get("role"))).toList();if(selected.size()!=1)throw Inputs.bad("必须选择唯一采购工作表");var event=PurchaseImportProgressService.event("VALIDATING",0,rows.size(),0,null,null,null);event.put("sourceTotalRows",imports.map(result.get("source")).get("fileRows"));progress.publish(lease.actor,lease.id,lease.owner,event);Set<String> positions=new HashSet<>();for(var row:rows){if(!Objects.equals(row.get("sourceSheet"),selected.getFirst().get("name"))||!positions.add(row.get("sourceSheet")+":"+sourceKey(row)))throw Inputs.bad("采购行来源重复或混入其他工作表");values(imports.map(row.get("normalizedValues")));for(String field:List.of("originalValues","formulas","rawNumericTexts","cachedValues"))imports.map(row.get(field));if(tick(positions.size(),rows.size()))publish(lease,"VALIDATING",positions.size(),rows.size(),0,null,row.get("sourceSheet").toString(),(int)Inputs.id(row.get("sourceRow")));}list(result.get("images"));list(result.get("associations"));list(result.get("warnings"));}
    private boolean tick(int count,int total){return count==1||count%25==0||count==total;}
    private void publish(Lease lease,String phase,int rows,Integer total,int images,Integer totalImages,String sheet,Integer row){progress.publish(lease.actor,lease.id,lease.owner,PurchaseImportProgressService.event(phase,rows,total,images,totalImages,sheet,row));}
    public Map<String,Object> get(RequestContext ctx,UUID id){return imports.tx.execute(s->{Access a=imports.access(ctx,false);var rows=mapper.selectTask(a.requireCountry(),id);if(rows.size()!=1)throw ApiException.notFound();imports.batch(a,(UUID)rows.getFirst().get("batch_id"),false);return imports.taskDto(rows.getFirst());});}
    public Map<String,Object> retry(RequestContext ctx,UUID id,String key,String sheet){return retry(ctx,id,key,sheet,null);}
    public Map<String,Object> retry(RequestContext ctx,UUID id,String key,String sheet,Map<String,Object> overrides){if(overrides!=null&&(imports.json.write(overrides).length()>4*1024*1024||!overrides.keySet().equals(Set.of("mapping","specLabels","confirm"))||!Boolean.TRUE.equals(overrides.get("confirm"))))throw Inputs.bad("字段修正仅接受原单元格映射、规格标签和明确确认");return imports.tx.execute(s->{Access a=imports.access(ctx,true);var rows=mapper.selectTask(a.requireCountry(),id);if(rows.size()!=1)throw ApiException.notFound();var task=rows.getFirst();var b=imports.batch(a,(UUID)task.get("batch_id"),true);var lockedTask=PurchaseRows.one(mapper.selectTaskForUpdate(a.requireCountry(),id));var request=new LinkedHashMap<String,Object>();request.put("sheet",sheet);if(overrides!=null)request.put("mappingOverrides",overrides);return commands.execute(ctx,"POST",BASE+"/tasks/"+id+"/retry",key,request,imports.bookId(imports.map(b.get("header"))),()->{if(!Set.of("FAILED","NEEDS_REAUTH","STALE").contains(lockedTask.get("status")))throw Inputs.conflict();boolean parse="PARSE".equals(lockedTask.get("kind"));if(!parse){if(sheet!=null||overrides!=null)throw Inputs.bad("照片或图库任务不接受字段修正");handler(lockedTask.get("kind").toString()).retry(ctx,lockedTask);}mapper.requeueTask((parse?b.get("version"):lockedTask.get("input_revision")),imports.json.write(Map.of("userId",ctx.userId(),"tokenHash",ctx.tokenHash())),ctx.userId(),a.requireCountry(),id);if(parse){progress.clear(a.requireCountry(),id);var options=new LinkedHashMap<String,Object>();if(sheet!=null)options.put("sheet",sheet);if(overrides!=null)options.put("mappingOverrides",overrides);mapper.requeueSource(imports.json.write(options),a.requireCountry(),task.get("source_id"));mapper.markBatchQueued(a.requireCountry(),task.get("batch_id"));}return Map.of("id",id.toString(),"status","QUEUED");},r->imports.batch(a,(UUID)task.get("batch_id"),false));});}
    public int recover(long country,int limit){
        var queued=imports.tx.execute(s->{gates(country);return mapper.selectRecoverableTasks(country,limit);});
        var grouped=new LinkedHashMap<UUID,List<UUID>>();
        for(var task:queued){if("MATCH".equals(task.get("kind")))grouped.computeIfAbsent((UUID)task.get("batch_id"),k->new ArrayList<>()).add((UUID)task.get("id"));else execute(country,(UUID)task.get("id"));}
        var work=new ArrayList<Runnable>();
        for(var ids:grouped.values())for(int start=0;start<ids.size();start+=PurchaseImportReviewBatch.ROWS){var group=List.copyOf(ids.subList(start,Math.min(start+PurchaseImportReviewBatch.ROWS,ids.size())));work.add(()->executeBatch(country,group));}
        batches.run(work);return queued.size();
    }
    private void executeBatch(long country,List<UUID> ids){
        handler("MATCH").executeBatch(country,ids,this);
    }
    record Scope(RequestContext actor,Map<String,Object> task){}
    Scope scoped(UUID taskId,String token,boolean completedCallback){
        return scoped(taskId,token,completedCallback,true);
    }
    private Scope scoped(UUID taskId,String token,boolean completedCallback,boolean renew){
        long country;try{country=Long.parseLong(token.substring(0,token.indexOf(':')));if(country<=0)throw new IllegalArgumentException();}catch(RuntimeException invalid){throw ApiException.forbidden();}
        return imports.tx.execute(s->{gates(country);var rows=mapper.selectUnexpiredTask(country,taskId);if(rows.size()!=1)throw ApiException.forbidden();var task=rows.getFirst();boolean running="RUNNING".equals(task.get("status"))&&Boolean.TRUE.equals(PurchaseRows.one(mapper.selectLeaseValid(country,taskId)));String digest=running?Objects.toString(task.get("credential_hash"),""):completedCallback&&task.get("callback_hash")!=null?Objects.toString(task.get("callback_credential_hash"),""):"";if(digest.isEmpty()||!java.security.MessageDigest.isEqual(hash(token).getBytes(StandardCharsets.US_ASCII),digest.getBytes(StandardCharsets.US_ASCII)))throw ApiException.forbidden();var ctx=actor(task);var a=imports.access(ctx,false);imports.batch(a,(UUID)task.get("batch_id"),false);if(running&&renew)mapper.renewCredentialLease(country,taskId,digest);return new Scope(ctx,task);});
    }
    public void reportProgress(UUID taskId,String token,Map<String,Object> input){var scope=scoped(taskId,token,false,false);var task=scope.task();if(!"PARSE".equals(task.get("kind"))||Inputs.id(input.get("sourceId"))!=number(task,"source_id"))throw ApiException.forbidden();String phase=Inputs.required(input,"phase");if(!PurchaseImportProgressService.PHASES.subList(0,4).contains(phase))throw Inputs.bad("解析桥不能报告业务保存或完成");var event=new LinkedHashMap<>(input);event.remove("sourceId");progress.publish(scope.actor(),taskId,(UUID)task.get("lease_owner"),event);}
    public AttachmentService.Download taskAsset(UUID taskId,long sourceId,String token){var scoped=scoped(taskId,token,false);var task=scoped.task();var ctx=scoped.actor();if("PARSE".equals(task.get("kind"))){if(number(task,"source_id")!=sourceId)throw ApiException.forbidden();return imports.content(ctx,(UUID)task.get("batch_id"),sourceId,false);}return handler(task.get("kind").toString()).asset(ctx,task,sourceId);}
    private PurchaseImportTaskHandler handler(String kind){var found=handlers.orderedStream().filter(h->h.kinds().contains(kind)).toList();if(found.size()!=1)throw new ApiException(503,"TASK_HANDLER_UNAVAILABLE","任务处理器未配置或存在重复注册");return found.getFirst();}
    void complete(Lease lease,Map<String,Object> result){imports.tx.execute(s->{var a=imports.access(lease.actor,true);imports.batch(a,lease.batch,true);active(lease);mapper.completeTask(imports.json.write(result),lease.country,lease.id);return null;});}

    private static String hash(String value){return AttachmentObjectStore.sha256(value.getBytes(StandardCharsets.UTF_8));}
}
