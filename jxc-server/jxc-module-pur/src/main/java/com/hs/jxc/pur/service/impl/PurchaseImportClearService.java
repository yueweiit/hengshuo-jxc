package com.hs.jxc.pur.service.impl;

import com.hs.jxc.attachment.AttachmentAssetService;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbContext;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.sys.api.Access;
import java.util.*;
import org.springframework.stereotype.Service;

/** 原命令回执同时承载清理意图；批次锁内删未建单暂存，提交后仅清理无引用文件。 */
@Service
public class PurchaseImportClearService {
    private final PurchaseImportServiceImpl imports;
    private final AttachmentAssetService assets;
    private final IdempotencyExecutor commands;
    private final AuditWriter audit;
    private final DbContext db;
    public PurchaseImportClearService(PurchaseImportServiceImpl imports,AttachmentAssetService assets,IdempotencyExecutor commands,AuditWriter audit,DbContext db){this.imports=imports;this.assets=assets;this.commands=commands;this.audit=audit;this.db=db;}

    public Map<String,Object> clear(RequestContext ctx,UUID id,long version,String key) {
        String endpoint=PurchaseImportServiceImpl.BASE+"/"+id;
        var receipt=imports.tx.execute(s->{
            Access a=imports.access(ctx,true);
            return commands.execute(ctx,"DELETE",endpoint,key,Map.of("version",version),null,()->{
                // 清理自身也必须先锁批次，但不能被本批次既有的清理意图拒绝。
                imports.mapper.selectBatch(a.requireCountry(),id,true);
                var b=imports.batch(a,id,false);
                if(version>PurchaseImportServiceImpl.number(b,"version"))throw Inputs.conflict();
                var books=books(a.requireCountry(),b);
                var out=new LinkedHashMap<String,Object>();
                out.put("cleared",false);out.put("clearRequested",true);out.put("batchId",id.toString());out.put("version",version);out.put("requestKey",key.toLowerCase(Locale.ROOT));
                out.put("counts",emptyCounts());out.put("retained",false);out.put("cleanupState","WAITING_TASKS");
                out.put("_country",a.requireCountry());out.put("_owner",a.userId());out.put("_bookIds",books);out.put("_assetIds",List.of());
                advance(out,b);
                audit.append(ctx,"PUR_IMPORT_CLEAR","PURCHASE_IMPORT",PurchaseImportServiceImpl.number(b,"id"),Map.of("batchId",id.toString(),"version",version),Map.of("cleanupState",out.get("cleanupState"),"counts",out.get("counts")));
                return out;
            },r->authorize(a,r));
        });
        if(!Boolean.TRUE.equals(receipt.get("cleared")))receipt=progress(receipt);
        return purge(receipt);
    }
    private Set<Long> books(long country,Map<String,Object> b) {
        var result=new TreeSet<Long>();Long header=imports.bookId(imports.map(b.get("header")));if(header!=null)result.add(header);
        for(var group:imports.mapper.selectGroups(country,b.get("batch_id"))){Long book=imports.bookId(imports.map(group.get("effective_header")));if(book!=null)result.add(book);}
        return result;
    }
    private Map<String,Object> emptyCounts(){var counts=new LinkedHashMap<String,Object>();for(String field:List.of("rows","sources","images","tasks","groups","progress"))counts.put(field,0);return counts;}

    private void advance(Map<String,Object> receipt,Map<String,Object> b) {
        long country=((Number)receipt.get("_country")).longValue();UUID id=UUID.fromString(receipt.get("batchId").toString());
        if(PurchaseImportServiceImpl.number(b,"created_by")!=((Number)receipt.get("_owner")).longValue()||!new HashSet<>(((Collection<?>)receipt.get("_bookIds")).stream().map(n->((Number)n).longValue()).toList()).containsAll(books(country,b)))
            throw new ApiException(409,"PUR_IMPORT_CLEAR_SCOPE_CHANGED","待清理批次的授权范围已变化，请核实原清理请求");
        imports.mapper.cancelClearTasks(country,id);
        if(imports.mapper.selectClearTasks(country,id).stream().anyMatch(task->"RUNNING".equals(task.get("status")))){receipt.put("cleanupState","WAITING_TASKS");return;}
        var groups=imports.mapper.selectGroups(country,id);var rows=imports.mapper.selectRows(country,id);
        if(groups.stream().anyMatch(group->unresolved(country,((Number)receipt.get("_owner")).longValue(),group))){
            receipt.put("cleanupState","WAITING_RESULT");return;
        }
        boolean retained=groups.stream().anyMatch(group->group.get("target_order_id")!=null)||rows.stream().anyMatch(row->row.get("target_order_line_id")!=null);
        if("COMPLETED".equals(b.get("status"))&&!retained){receipt.put("cleanupState","WAITING_RESULT");return;}
        var ids=imports.mapper.selectClearAssets(country,id);var counts=emptyCounts();
        counts.put("rows",imports.mapper.clearRows(country,id));counts.put("progress",imports.mapper.clearProgress(country,id));counts.put("tasks",imports.mapper.clearTasks(country,id));
        counts.put("groups",imports.mapper.clearGroups(country,id));counts.put("images",imports.mapper.clearImages(country,id));counts.put("sources",imports.mapper.clearSources(country,id));
        if(!retained){
            if(imports.mapper.clearBatch(country,id)!=1)throw Inputs.conflict();
            imports.mapper.redactClearedSnapshots(country,((Number)receipt.get("_owner")).longValue(),id.toString(),PurchaseImportServiceImpl.BASE+"/"+id);
        }
        receipt.put("_assetIds",assets.retireUnreferenced(country,ids));receipt.put("counts",counts);receipt.put("cleared",true);receipt.put("retained",retained);receipt.put("cleanupState","DONE");
    }
    private boolean unresolved(long country,long owner,Map<String,Object> group){
        if(group.get("target_order_id")!=null)return false;
        if("CREATED".equals(group.get("create_status")))return true;
        if(!Set.of("CREATING","UNKNOWN").contains(group.get("create_status")))return false;
        // 原生建单、来源回写和两层命令回执在同一个事务/批次锁内提交。
        // 持锁后，两层回执都不存在且保存意图完整，才能确认原请求已回滚；不重发建单请求。
        return group.get("outer_key")==null||group.get("create_request")==null||group.get("request_hash")==null
            ||imports.mapper.countCreationReceipts(country,owner,group.get("create_key"),group.get("outer_key"))!=0;
    }
    /** 只推进已受权并提交的原命令，不接受后台扫描出的任意业务批次。 */
    private Map<String,Object> progress(Map<String,Object> original) {
        return imports.tx.execute(s->{
            long country=((Number)original.get("_country")).longValue();db.apply(null);imports.auth.gate(0,false);db.apply(country);imports.auth.gate(country,false);
            UUID id=UUID.fromString(original.get("batchId").toString());
            var found=imports.mapper.selectBatch(country,id,true);
            // 同批次不同确认请求串行推进，读取最新原回执，避免覆盖其他恢复器的完成结果。
            var receipts=imports.mapper.selectClearReceipt(country,((Number)original.get("_owner")).longValue(),PurchaseImportServiceImpl.BASE+"/"+id);
            Map<String,Object> receipt=new LinkedHashMap<>(original);
            if(!receipts.isEmpty()){
                var latest=imports.map(receipts.getFirst().get("response"));
                if(Objects.equals(latest.get("requestKey"),original.get("requestKey")))receipt=new LinkedHashMap<>(latest);
            }
            if(Boolean.TRUE.equals(receipt.get("cleared")))return receipt;
            if(found.isEmpty()){receipt.put("cleared",true);receipt.put("cleanupState","DONE");}
            else advance(receipt,found.getFirst());
            if(imports.mapper.updateClearReceipt(country,((Number)receipt.get("_owner")).longValue(),id,receipt.get("requestKey").toString(),imports.json.write(receipt))!=1)throw Inputs.conflict();
            return receipt;
        });
    }
    private Map<String,Object> purge(Map<String,Object> receipt){
        try{assets.purgeRetired(((Number)receipt.get("_country")).longValue(),ids(receipt));}
        catch(RuntimeException error){var pending=new ApiException(503,"PUR_IMPORT_FILES_PENDING","暂存数据已清理，文件清理尚未完成；请按原请求重试："+(error instanceof ApiException api?api.getMessage():"请检查后台日志"),view(receipt,true));pending.initCause(error);throw pending;}
        return view(receipt,false);
    }
    public Map<String,Object> status(RequestContext ctx,UUID id) {
        var receipt=imports.tx.execute(s->{var a=imports.access(ctx,true);var rows=imports.mapper.selectClearReceipt(a.requireCountry(),a.userId(),PurchaseImportServiceImpl.BASE+"/"+id);if(rows.size()!=1)throw ApiException.notFound();var r=imports.map(rows.getFirst().get("response"));authorize(a,r);return r;});
        return view(receipt,false);
    }
    private void authorize(Access a,Map<String,Object> receipt) {
        if(!(Boolean.TRUE.equals(receipt.get("cleared"))||Boolean.TRUE.equals(receipt.get("clearRequested")))||((Number)receipt.get("_country")).longValue()!=a.requireCountry()||((Number)receipt.get("_owner")).longValue()!=a.userId())throw ApiException.notFound();
        for(Object book:(Collection<?>)receipt.get("_bookIds"))if(!a.canBook(((Number)book).longValue()))throw ApiException.notFound();
    }
    private List<Long> ids(Map<String,Object> r){return ((Collection<?>)r.get("_assetIds")).stream().map(n->((Number)n).longValue()).toList();}
    private Map<String,Object> view(Map<String,Object> receipt,boolean failed) {
        int files=assets.pendingRetired(((Number)receipt.get("_country")).longValue(),ids(receipt));boolean pending=failed||files>0||!Boolean.TRUE.equals(receipt.get("cleared"));var out=new LinkedHashMap<String,Object>();
        for(String field:List.of("cleared","batchId","version","requestKey","counts"))out.put(field,receipt.get(field));
        out.put("clearRequested",true);out.put("retained",Boolean.TRUE.equals(receipt.get("retained")));out.put("cleanupPending",pending);out.put("pendingFiles",files);out.put("cleanupState",failed||files>0?"FILES_PENDING":pending?receipt.get("cleanupState"):"DONE");return out;
    }
    public int recover(long country,int limit) {
        var receipts=imports.tx.execute(s->{db.apply(country);return imports.mapper.selectPendingClearReceipts(country,limit).stream().map(row->imports.map(row.get("response"))).toList();});
        for(var receipt:receipts){if(!Boolean.TRUE.equals(receipt.get("cleared")))receipt=progress(receipt);assets.purgeRetired(country,ids(receipt));}
        return receipts.size();
    }
}
