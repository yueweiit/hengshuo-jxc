package com.hs.jxc.pur;

import static com.hs.jxc.pur.PurchaseImportService.*;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.springframework.stereotype.Service;

/** 费用待办只保存人工核对及来源，不调用正式费用、运输、售价或成本写入口。 */
@Service
public class PurchaseImportTraceService {
    private final PurchaseImportService imports;
    private final AuditWriter audit;
    public PurchaseImportTraceService(PurchaseImportService imports,AuditWriter audit){this.imports=imports;this.audit=audit;}

    private static List<Map<String,Object>> rows(PurchaseImportService i,Map<String,Object> g){
        return i.jdbc.queryForList("SELECT r.*,s.file_name,s.file_sha256 FROM pur_order_import r LEFT JOIN pur_order_import_source s ON s.country_id=r.country_id AND s.id=r.source_id WHERE r.country_id=? AND r.batch_id=? AND r.group_id=? ORDER BY r.row_no",g.get("country_id"),g.get("batch_id"),g.get("id"));
    }
    private static String basis(PurchaseImportService i,Map<String,Object> g,List<Map<String,Object>> rows){
        var sources=rows.stream().map(row->{var source=new LinkedHashMap<String,Object>();for(String key:List.of("id","version","source_id","source_sheet","source_row","file_sha256"))source.put(key,row.get(key));source.put("values",valueDto(row));return source;}).toList();
        var input=new LinkedHashMap<String,Object>();input.put("sources",sources);input.put("header",i.map(g.get("effective_header")));
        return Digests.sha256(i.json.write(IdempotencyExecutor.canonical(input)));
    }
    private static Map<String,Object> reference(Map<String,Object> row){
        var out=new LinkedHashMap<String,Object>();out.put("rowId",row.get("id"));out.put("rowNo",row.get("row_no"));out.put("sourceId",row.get("source_id"));out.put("sourceSheet",row.get("source_sheet"));out.put("sourceRow",row.get("source_row"));out.put("fileName",row.get("file_name"));out.put("fileSha256",row.get("file_sha256"));out.put("sourceStatus",row.get("file_sha256")==null?"SOURCE_UNAVAILABLE":"AVAILABLE");return out;
    }
    private static Map<String,Object> pending(Map<String,Object> g,List<Map<String,Object>> rows,String hash){
        var out=new LinkedHashMap<String,Object>();out.put("format","FeeTodoV1");out.put("todoId",UUID.nameUUIDFromBytes((g.get("id")+":"+rows.stream().map(r->r.get("id").toString()).toList()).getBytes(StandardCharsets.UTF_8)).toString());out.put("sourceRowIds",rows.stream().map(r->r.get("id")).toList());out.put("sourceRows",rows.stream().map(PurchaseImportTraceService::reference).toList());out.put("scope",null);out.put("amount",null);out.put("currency",null);out.put("reason","运费归属、金额和币种待核实；重复源值不自动求和，空值不代表没有费用");out.put("reviewStatus","UNRESOLVED");out.put("sourceBasisHash",hash);return out;
    }
    /** 由已授权的原groupDto调用，避免另造批次读取和来源下载流程。 */
    static Map<String,Object> view(PurchaseImportService i,Map<String,Object> g){
        var rows=rows(i,g);String hash=basis(i,g,rows);var saved=list(i.json.read(g.get("fee_todos").toString(),List.class));var todos=new ArrayList<Map<String,Object>>();var covered=new HashSet<Long>();
        for(var old:saved){var item=new LinkedHashMap<>(old);var ids=(List<?>)item.get("sourceRowIds");ids.forEach(id->covered.add(Inputs.id(id)));if(!Objects.equals(hash,item.get("sourceBasisHash")))item.put("reviewStatus","STALE");todos.add(item);}
        var missing=rows.stream().filter(row->!covered.contains(number(row,"id"))).toList();if(!missing.isEmpty())todos.add(pending(g,missing,hash));
        Map<String,Object> order=null;String targetState="NOT_CREATED";
        if(g.get("target_order_id")!=null){var found=i.jdbc.queryForList("SELECT id,doc_no FROM pur_order WHERE country_id=? AND id=? AND book_id=?",g.get("country_id"),g.get("target_order_id"),i.map(g.get("effective_header")).get("bookId"));targetState="UNAVAILABLE";if(found.size()==1){var lines=i.jdbc.queryForList("SELECT id FROM pur_order_line WHERE country_id=? AND order_id=?",g.get("country_id"),g.get("target_order_id")).stream().map(row->number(row,"id")).collect(java.util.stream.Collectors.toSet());if(rows.stream().allMatch(row->row.get("target_order_line_id")!=null&&lines.contains(number(row,"target_order_line_id")))){order=found.getFirst();targetState="LINKED";}}}
        for(var item:todos){item.put("status","PENDING");item.put("registeredReference",null);item.put("targetOrderId",order==null?null:order.get("id"));item.put("targetDocNo",order==null?null:order.get("doc_no"));item.put("targetReferenceStatus",targetState);}
        var evidence=new ArrayList<Map<String,Object>>();for(var row:rows){var item=reference(row);item.put("currentValues",valueDto(row));item.put("originalValues",row.get("original_values")==null?null:i.map(row.get("original_values")));item.put("formulaProvenance",row.get("formula_provenance")==null?null:i.map(row.get("formula_provenance")));item.put("fieldOrigins",i.map(row.get("field_origins")));item.put("targetOrderLineId",order==null?null:row.get("target_order_line_id"));evidence.add(item);}
        return Map.of("feeTodos",todos,"feeTodosVersion",g.get("fee_todos_version"),"sourceEvidence",evidence,"sourceBasisHash",hash);
    }
    public Map<String,Object> save(RequestContext ctx,UUID batch,long groupId,Map<String,Object> body){return imports.tx.execute(s->{
        var a=imports.access(ctx,true);imports.batch(a,batch,true);
        var found=imports.jdbc.queryForList("SELECT * FROM pur_order_import_group WHERE country_id=? AND batch_id=? AND id=? FOR UPDATE",a.requireCountry(),batch,groupId);if(found.size()!=1)throw ApiException.notFound();var g=found.getFirst();if(!a.canBook(Inputs.id(imports.map(g.get("effective_header")).get("bookId"))))throw ApiException.notFound();
        if(!body.keySet().equals(Set.of("version","items","sourceBasisHash")))throw Inputs.bad("只允许保存费用核对清单");if(number(g,"fee_todos_version")!=Inputs.version(body))throw Inputs.conflict();var supplied=list(body.get("items"));var rows=rows(imports,g);if(supplied.size()>rows.size())throw Inputs.bad("费用来源数量超出本采购组");String hash=basis(imports,g,rows);if(!hash.equals(Inputs.required(body,"sourceBasisHash")))throw new ApiException(409,"PUR_IMPORT_SOURCE_CHANGED","费用来源已变化，请读取最新值后重新核对");var byId=new HashMap<Long,Map<String,Object>>();rows.forEach(row->byId.put(number(row,"id"),row));var covered=new HashSet<Long>();var todos=new ArrayList<Map<String,Object>>();
        for(var item:supplied){
            if(!item.keySet().equals(Set.of("sourceRowIds","scope","amount","currency","reason","confirm"))||!(item.get("sourceRowIds") instanceof List<?> ids)||ids.isEmpty()||!(item.get("confirm") instanceof Boolean))throw Inputs.bad("费用核对字段不完整或包含正式登记字段");
            var selected=new ArrayList<Map<String,Object>>();for(Object id:ids){long row=Inputs.id(id);if(!byId.containsKey(row)||!covered.add(row))throw Inputs.bad("来源行超出本采购组或被重复计入费用");selected.add(byId.get(row));}selected.sort(Comparator.comparingLong(row->number(row,"id")));
            String scope=Inputs.text(item,"scope",null),currency=Inputs.text(item,"currency",null),reason=Inputs.required(item,"reason");if(reason.length()>1000||scope!=null&&!Set.of("ORDER","LINE").contains(scope)||"LINE".equals(scope)&&selected.size()!=1)throw Inputs.bad("请核对整单/单行归属和原因");
            BigDecimal amount=decimal(item.get("amount"),10,20,false);if(currency!=null&&(!currency.matches("[A-Z]{3}")||imports.jdbc.queryForObject("SELECT count(*) FROM md_currency WHERE code=? AND status='ENABLED'",Integer.class,currency)!=1))throw Inputs.bad("费用原币种不存在或未启用");boolean confirm=Boolean.TRUE.equals(item.get("confirm"));if(confirm&&(scope==null||amount==null||currency==null))throw Inputs.bad("归属、金额和原币种仍未知，不能标为已核对");
            var todo=pending(g,selected,hash);todo.put("scope",scope);todo.put("amount",amount==null?null:amount.toPlainString());todo.put("currency",currency);todo.put("reason",reason);todo.put("reviewStatus",confirm?"CONFIRMED":"UNRESOLVED");todo.put("reviewedBy",confirm?a.userId():null);todos.add(todo);
        }
        var missing=rows.stream().filter(row->!covered.contains(number(row,"id"))).toList();if(!missing.isEmpty())todos.add(pending(g,missing,hash));
        imports.jdbc.update("UPDATE pur_order_import_group SET fee_todos=?::jsonb,fee_todos_version=fee_todos_version+1 WHERE country_id=? AND id=?",imports.json.write(todos),a.requireCountry(),groupId);audit.append(ctx,"PUR_IMPORT_FEE_REVIEW","PURCHASE_IMPORT",groupId,imports.json.read(g.get("fee_todos").toString(),List.class),todos);
        g.put("fee_todos",imports.json.write(todos));g.put("fee_todos_version",number(g,"fee_todos_version")+1);return imports.groupDto(g);
    });}
}
