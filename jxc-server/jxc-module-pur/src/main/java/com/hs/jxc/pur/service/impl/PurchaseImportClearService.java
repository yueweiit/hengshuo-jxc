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

/** 批次锁内删除暂存；提交后清理文件，复用命令回执和既有后台恢复入口。 */
@Service
public class PurchaseImportClearService {
    private final PurchaseImportServiceImpl imports;private final AttachmentAssetService assets;private final IdempotencyExecutor commands;private final AuditWriter audit;private final DbContext db;
    public PurchaseImportClearService(PurchaseImportServiceImpl imports,AttachmentAssetService assets,IdempotencyExecutor commands,AuditWriter audit,DbContext db){this.imports=imports;this.assets=assets;this.commands=commands;this.audit=audit;this.db=db;}
    public Map<String,Object> clear(RequestContext ctx,UUID id,long version,String key) {
        String endpoint=PurchaseImportServiceImpl.BASE+"/"+id;
        var receipt=imports.tx.execute(s->{Access a=imports.access(ctx,true);
            return commands.execute(ctx,"DELETE",endpoint,key,Map.of("version",version),null,()->{
                var b=imports.batch(a,id,true);
                if(PurchaseImportServiceImpl.number(b,"version")!=version)throw Inputs.conflict();
                var tasks=imports.mapper.selectClearTasks(a.requireCountry(),id);
                if(tasks.stream().anyMatch(t->Set.of("QUEUED","RUNNING").contains(t.get("status"))))throw new ApiException(409,"PUR_IMPORT_CLEAR_BUSY","当前批次正在处理，请等待任务结束后清空");
                var groups=imports.mapper.selectGroups(a.requireCountry(),id);var rows=imports.mapper.selectRows(a.requireCountry(),id);
                if("COMPLETED".equals(b.get("status"))||groups.stream().anyMatch(g->g.get("target_order_id")!=null||Set.of("CREATED","CREATING","UNKNOWN").contains(g.get("create_status")))||rows.stream().anyMatch(r->r.get("target_order_line_id")!=null))throw new ApiException(409,"PUR_IMPORT_CLEAR_LINKED","当前批次已关联采购草稿或创建结果尚未核实，不能清空");
                var books=new TreeSet<Long>();Long book=imports.bookId(imports.map(b.get("header")));if(book!=null)books.add(book);for(var g:groups){Long groupBook=imports.bookId(imports.map(g.get("effective_header")));if(groupBook!=null)books.add(groupBook);}
                long country=a.requireCountry();var ids=imports.mapper.selectClearAssets(country,id);var counts=new LinkedHashMap<String,Object>();
                counts.put("rows",imports.mapper.clearRows(country,id));counts.put("progress",imports.mapper.clearProgress(country,id));counts.put("tasks",imports.mapper.clearTasks(country,id));counts.put("groups",imports.mapper.clearGroups(country,id));counts.put("images",imports.mapper.clearImages(country,id));counts.put("sources",imports.mapper.clearSources(country,id));
                if(imports.mapper.clearBatch(country,id)!=1)throw Inputs.conflict();
                var retired=assets.retireUnreferenced(country,ids);
                imports.mapper.redactClearedSnapshots(country,a.userId(),id.toString(),endpoint);
                audit.append(ctx,"PUR_IMPORT_CLEAR","PURCHASE_IMPORT",PurchaseImportServiceImpl.number(b,"id"),Map.of("batchId",id.toString(),"version",version),Map.of("cleared",true,"counts",counts));
                var out=new LinkedHashMap<String,Object>();out.put("cleared",true);out.put("batchId",id.toString());out.put("version",version);out.put("requestKey",key.toLowerCase(Locale.ROOT));out.put("counts",counts);out.put("_country",country);out.put("_owner",a.userId());out.put("_bookIds",books);out.put("_assetIds",retired);return out;
            },r->authorize(a,r));
        });
        try{assets.purgeRetired(ctx.countryId(),ids(receipt));}
        catch(RuntimeException e){var pending=new ApiException(503,"PUR_IMPORT_FILES_PENDING","暂存数据已清空，文件清理尚未完成"+(e instanceof ApiException api?"："+api.getMessage():"，请检查后台日志")+"；请点击重试清空",view(receipt,true));pending.initCause(e);throw pending;}
        return view(receipt,false);
    }
    public Map<String,Object> status(RequestContext ctx,UUID id) {
        var receipt=imports.tx.execute(s->{var a=imports.access(ctx,true);var rows=imports.mapper.selectClearReceipt(a.requireCountry(),a.userId(),PurchaseImportServiceImpl.BASE+"/"+id);if(rows.size()!=1)throw ApiException.notFound();var r=imports.map(rows.getFirst().get("response"));authorize(a,r);return r;});
        return view(receipt,false);
    }
    private void authorize(Access a,Map<String,Object> receipt) {
        if(!Boolean.TRUE.equals(receipt.get("cleared"))||((Number)receipt.get("_country")).longValue()!=a.requireCountry()||((Number)receipt.get("_owner")).longValue()!=a.userId())throw ApiException.notFound();
        for(Object book:(Collection<?>)receipt.get("_bookIds"))if(!a.canBook(((Number)book).longValue()))throw ApiException.notFound();
    }
    private List<Long> ids(Map<String,Object> r){return ((Collection<?>)r.get("_assetIds")).stream().map(n->((Number)n).longValue()).toList();}
    private Map<String,Object> view(Map<String,Object> receipt,boolean failed) {
        int pending=assets.pendingRetired(((Number)receipt.get("_country")).longValue(),ids(receipt));var out=new LinkedHashMap<String,Object>();
        for(String field:List.of("cleared","batchId","version","requestKey","counts"))out.put(field,receipt.get(field));out.put("cleanupPending",failed||pending>0);out.put("pendingFiles",pending);return out;
    }
    public int recover(long country,int limit) {
        var receipts=imports.tx.execute(s->{db.apply(country);return imports.mapper.selectPendingClearReceipts(country,limit).stream().map(row->imports.map(row.get("response"))).toList();});
        for(var receipt:receipts)assets.purgeRetired(country,ids(receipt));
        return receipts.size();
    }
}
