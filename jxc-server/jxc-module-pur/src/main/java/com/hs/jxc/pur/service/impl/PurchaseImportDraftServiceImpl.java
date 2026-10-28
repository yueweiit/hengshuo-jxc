package com.hs.jxc.pur.service.impl;
import com.hs.jxc.pur.service.*;

import com.hs.jxc.pur.mapper.*;

import static com.hs.jxc.pur.service.impl.PurchaseImportServiceImpl.*;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.md.api.MasterProductMaintenanceApi;
import com.hs.jxc.sys.api.Access;
import java.math.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/** 固定预览→原采购创建→真实读回；不写审批、库存、费用或成本。 */
@Service
public class PurchaseImportDraftServiceImpl implements PurchaseImportDraftService {
    private final PurchaseImportDraftMapper mapper;
    private final PurchaseImportServiceImpl imports;private final PurchaseServiceImpl purchases;private final MasterProductMaintenanceApi master;private final IdempotencyExecutor commands;
    @Value("${jxc.purchase-import.draft-creation.enabled:false}") private boolean creationEnabled;
    public PurchaseImportDraftServiceImpl(PurchaseImportServiceImpl imports,PurchaseServiceImpl purchases,MasterProductMaintenanceApi master,IdempotencyExecutor commands,PurchaseImportDraftMapper mapper){this.mapper=mapper;this.imports=imports;this.purchases=purchases;this.master=master;this.commands=commands;}
    private Map<String,Object> group(Access a,UUID batch,long id,boolean lock){var rows=mapper.selectGroup(a.requireCountry(),batch,id,lock);if(rows.size()!=1)throw ApiException.notFound();var row=rows.getFirst();if(!a.canBook(Inputs.id(imports.map(row.get("effective_header")).get("bookId"))))throw ApiException.notFound();return row;}
    private List<Map<String,Object>> sourceRows(Access a,UUID batch,long group){return mapper.selectSourceRows(a.requireCountry(),batch,group);}
    private void synchronizeGroups(Access a,UUID batch,Map<String,Object> header){
        var rows=mapper.selectRowsWithGroups(a.requireCountry(),batch);
        for(var row:rows){if(row.get("target_order_line_id")!=null)continue;if(row.get("group_id")!=null&&Objects.equals(row.get("source_order_no"),row.get("group_source")))continue;String no=row.get("source_order_no").toString(),key="SOURCE:"+Digests.sha256(no);var existing=mapper.selectGroupByKey(a.requireCountry(),batch,key);long id;
            if(existing.isEmpty())id=PurchaseRows.one(mapper.insertGroup(a.requireCountry(),batch,key,no,imports.json.write(header),UUID.randomUUID()));
            else{var target=existing.getFirst();if(Set.of("CREATING","UNKNOWN").contains(target.get("create_status")))throw new ApiException(409,"PUR_IMPORT_CREATE_UNRESOLVED","该源单号的原创建结果待核实，不能添加明细");if(target.get("target_order_id")!=null)throw new ApiException(409,"PUR_IMPORT_SOURCE_ALREADY_CREATED","该源单号已创建草稿，请使用新批次表达新的采购意图");id=number(target,"id");}
            mapper.assignRowGroup(id,a.requireCountry(),row.get("id"));
        }
    }
    public Map<String,Object> previews(RequestContext ctx,UUID batch,Map<String,Object> body){return imports.tx.execute(s->{Access a=imports.access(ctx,true);var b=imports.batch(a,batch,true);if(number(b,"version")!=Inputs.id(body.get("batchVersion")))throw Inputs.conflict();synchronizeGroups(a,batch,imports.map(b.get("header")));var groups=mapper.selectGroupsForUpdate(a.requireCountry(),batch);
        for(var g:groups){if(g.get("target_order_id")!=null||Set.of("UNKNOWN","CREATING").contains(g.get("create_status")))continue;var prepared=prepare(ctx,a,batch,b,g);boolean ready=list(prepared.get("errors")).isEmpty();mapper.savePreview(imports.json.write(prepared),prepared.get("basisHash"),ready?UUID.randomUUID():null,ready?"READY":"DRAFT",a.requireCountry(),g.get("id"));}
        return imports.snapshot(a,batch);
    });}
    public Map<String,Object> saveGroup(RequestContext ctx,UUID batch,long id,Map<String,Object> body){return imports.tx.execute(s->{Access a=imports.access(ctx,true);imports.batch(a,batch,true);var before=group(a,batch,id,true);if(Set.of("UNKNOWN","CREATING").contains(before.get("create_status")))throw new ApiException(409,"PUR_IMPORT_CREATE_UNRESOLVED","请先按原请求核实采购创建结果");if(before.get("target_order_id")!=null||number(before,"version")!=Inputs.id(body.get("groupVersion")))throw Inputs.conflict();var supplied=imports.map(body.get("header"));var h=imports.header(a,supplied);Object tax=supplied.get("taxRate");BigDecimal rate=decimal(tax,6,1,false);if(rate!=null&&rate.compareTo(BigDecimal.ONE)>0)throw Inputs.bad("税率须为0至1");h.put("taxRate",rate==null?null:rate.toPlainString());String basis=Inputs.text(supplied,"priceTaxBasis",null);if(basis!=null&&!basis.equals("EXCLUSIVE"))throw Inputs.bad("原采购按未含税单价计算，请先核对供应商单价");h.put("priceTaxBasis",basis);
        long target=id;
        if(body.get("splitRowIds") instanceof List<?> ids&&!ids.isEmpty()){var rows=sourceRows(a,batch,id);Set<Long> selected=new HashSet<>();ids.forEach(v->selected.add(Inputs.id(v)));if(selected.size()!=ids.size()||selected.size()>=rows.size()||rows.stream().filter(r->selected.contains(number(r,"id"))).count()!=selected.size())throw Inputs.bad("拆单明细必须是当前组未创建行的一个非空子集");target=PurchaseRows.one(mapper.insertOverrideGroup(a.requireCountry(),batch,"SPLIT:"+UUID.randomUUID(),before.get("source_order_no"),imports.json.write(h),UUID.randomUUID()));for(long row:selected)mapper.assignRowGroup(target,a.requireCountry(),row);mapper.invalidateGroupPreview(a.requireCountry(),id);}
        mapper.updateGroupHeader(imports.json.write(h),a.requireCountry(),target);return imports.snapshot(a,batch);
    });}
    private Map<String,Object> issue(Map<String,Object> row,String field,String message){var item=new LinkedHashMap<String,Object>();item.put("rowId",row==null?null:row.get("id"));item.put("sourceSheet",row==null?null:row.get("source_sheet"));item.put("sourceRow",row==null?null:row.get("source_row"));item.put("field",field);item.put("code","PUR_IMPORT_PREVIEW_REQUIRED");item.put("message",message);item.put("retryable",false);return item;}
    private String canonical(Object value){return imports.json.write(IdempotencyExecutor.canonical(value));}
    private Map<String,Object> prepare(RequestContext ctx,Access a,UUID batch,Map<String,Object> b,Map<String,Object> group){
        if("PARSING".equals(b.get("status")))throw new ApiException(409,"PUR_IMPORT_PARSING","请等待本批次解析结束后再核对采购预览");var h=imports.map(group.get("effective_header"));var rows=sourceRows(a,batch,number(group,"id"));var errors=new ArrayList<Map<String,Object>>();var nativeInput=new LinkedHashMap<String,Object>();var lines=new ArrayList<Map<String,Object>>();var catalogs=new ArrayList<Object>();
        try{nativeInput.putAll(imports.header(a,h));}catch(ApiException error){errors.add(issue(null,"header",error.getMessage()));}
        if(!"EXCLUSIVE".equals(h.get("priceTaxBasis")))errors.add(issue(null,"priceTaxBasis","采购单价的价税口径待核实，请明确确认未含税单价"));
        if(h.get("prepayRatio")==null||h.get("termDays")==null)errors.add(issue(null,"paymentTerms","请明确预付比例和账期天数，未知值不能按0处理"));
        if(rows.isEmpty())errors.add(issue(null,"rows","本组没有采购明细"));
        for(var row:rows){if(!"READY".equals(row.get("readiness"))||row.get("matched_product_id")==null||row.get("purchase_unit")==null){errors.add(issue(row,"productId","本行商品或单位未确认，不能跳过后创建不完整采购单"));continue;}
            Object rate=row.get("tax_rate")==null?h.get("taxRate"):row.get("tax_rate").toString();if(rate==null){errors.add(issue(row,"taxRate","本行税率待核实，请明确填写"));continue;}if(row.get("purchase_unit_price")==null){errors.add(issue(row,"purchaseUnitPrice","本行采购单价待核实"));continue;}
            var line=new LinkedHashMap<String,Object>();line.put("productId",row.get("matched_product_id"));line.put("unit",row.get("purchase_unit"));line.put("qty",row.get("purchase_qty"));line.put("unitPrice",((BigDecimal)row.get("purchase_unit_price")).setScale(4,RoundingMode.HALF_UP));line.put("taxRate",decimal(rate,6,1,false));lines.add(line);
        }
        nativeInput.put("lines",lines);nativeInput.put("submit",false);if(nativeInput.get("prepayRatio")!=null)nativeInput.put("prepayRatio",new BigDecimal(nativeInput.get("prepayRatio").toString()));
        Map<String,Object> preview=null;
        if(errors.isEmpty())try{preview=purchases.previewOrder(ctx,nativeInput);for(var row:rows){var current=master.inspect(ctx,number(row,"matched_product_id"));catalogs.add(current);if(row.get("product_snapshot")==null||!canonical(imports.map(row.get("product_snapshot"))).equals(canonical(current)))errors.add(issue(row,"productId","商品、本国状态或单位资料已变化，请重新人工确认本行"));}
            var preparedLines=list(preview.get("lines"));for(int n=0;n<rows.size();n++){var row=rows.get(n);var line=preparedLines.get(n);BigDecimal source=(BigDecimal)row.get("purchase_unit_price"),price=new BigDecimal(line.get("unitPrice").toString());line.put("sourceRowId",row.get("id"));line.put("sourceSheet",row.get("source_sheet"));line.put("sourceRow",row.get("source_row"));line.put("sourceUnitPrice",source.toPlainString());line.put("unitPriceDifference",price.subtract(source).toPlainString());line.put("productSpec",row.get("product_spec"));}preview.put("lines",preparedLines);
        }catch(ApiException error){errors.add(issue(null,"purchase",error.getMessage()));}
        var basis=new LinkedHashMap<String,Object>();basis.put("header",h);basis.put("rows",rows.stream().map(r->List.of(r.get("id"),r.get("version"))).toList());basis.put("catalogs",catalogs);basis.put("permissions",new TreeSet<>(a.permissions()));basis.put("fields",a.fieldGroups());basis.put("books",a.scope().books().stream().sorted().toList());basis.put("allBooks",a.scope().all());basis.put("prepared",preview);
        var out=new LinkedHashMap<String,Object>();out.put("errors",errors);out.put("basisHash",Digests.sha256(canonical(basis)));out.put("preview",preview);out.put("nativeInput",nativeInput);return out;
    }
    public Map<String,Object> create(RequestContext ctx,UUID batch,long groupId,Map<String,Object> body,String key){
        if(!creationEnabled)throw new ApiException(503,"PUR_IMPORT_DRAFT_DISABLED","采购导入创建草稿尚未启用");if(!Boolean.TRUE.equals(body.get("confirm")))throw Inputs.bad("请明确确认完整采购预览");
        String requestHash=Digests.sha256(canonical(body));var attempted=new java.util.concurrent.atomic.AtomicBoolean();
        try{imports.tx.execute(s->{Access a=imports.access(ctx,true);var b=imports.batch(a,batch,true);var g=group(a,batch,groupId,true);
            if(g.get("target_order_id")!=null){if(!Objects.equals(g.get("outer_key"),uuid(key)))throw new ApiException(409,"PUR_IMPORT_ALREADY_CREATED","本组已创建采购草稿，请读取原创建结果");if(!Objects.equals(g.get("request_hash"),requestHash))throw new ApiException(409,"SYS_IDEMPOTENCY_CONFLICT","同一请求编号不能改变创建内容");return null;}
            if(g.get("outer_key")!=null&&!Objects.equals(g.get("outer_key"),uuid(key)))throw new ApiException(409,"PUR_IMPORT_CREATE_INTENT_CHANGED","请使用原创建请求恢复，不要更换请求编号");
            if(number(g,"version")!=Inputs.id(body.get("groupVersion"))||g.get("preview_token")==null||!g.get("preview_token").equals(uuid(Inputs.required(body,"previewToken"))))throw Inputs.conflict();
            var current=prepare(ctx,a,batch,b,g);if(!list(current.get("errors")).isEmpty()||!Objects.equals(g.get("preview_hash"),current.get("basisHash")))throw new ApiException(409,"PUR_IMPORT_PREVIEW_CHANGED","预览依据已变化，请重新核对完整采购单");
            long book=Inputs.id(imports.map(g.get("effective_header")).get("bookId"));commands.execute(ctx,"POST",BASE+"/"+batch+"/groups/"+groupId+"/drafts",key,body,book,()->{
                mapper.markCreating(uuid(key),requestHash,imports.json.write(body),a.requireCountry(),groupId);attempted.set(true);
                var fixed=imports.map(imports.map(g.get("preview_snapshot")).get("nativeInput"));var result=purchases.create(ctx,"orders",fixed,g.get("create_key").toString());long order=Inputs.id(result.get("id"));var actual=list(result.get("lines"));var source=sourceRows(a,batch,groupId);if(actual.size()!=source.size())throw new ApiException(409,"PUR_IMPORT_MAPPING_FAILED","原采购返回的明细数量不一致，整单未提交");
                for(int n=0;n<source.size();n++){final int lineNo=n+1;var targets=actual.stream().filter(l->((Number)l.get("lineNo")).intValue()==lineNo).toList();if(targets.size()!=1)throw new ApiException(409,"PUR_IMPORT_MAPPING_FAILED","原采购行序号不完整，整单未提交");mapper.assignOrderLine(Inputs.id(targets.getFirst().get("id")),a.requireCountry(),source.get(n).get("id"));}
                mapper.markCreated(order,imports.json.write(result),a.requireCountry(),groupId);return Map.of("id",order,"orderId",order,"groupId",groupId,"createStatus","CREATED");
            },r->group(a,batch,groupId,false));return null;
        });}catch(ApiException error){if(attempted.get())recordFailure(ctx,batch,groupId,body,key,"FAILED",error.getCode(),error.getMessage());throw error;}catch(RuntimeException error){if(attempted.get())recordFailure(ctx,batch,groupId,body,key,"UNKNOWN","PUR_IMPORT_CREATE_UNKNOWN","原创建请求结果需核实，请按原请求查询或恢复");throw error;}
        return creation(ctx,batch,groupId);
    }
    private static UUID uuid(String value){try{return UUID.fromString(value);}catch(RuntimeException error){throw Inputs.bad("请求编号或预览凭证须为UUID");}}
    public Map<String,Object> creation(RequestContext ctx,UUID batch,long groupId){
        var source=imports.tx.execute(s->{Access a=imports.access(ctx,false);imports.batch(a,batch,false);var g=group(a,batch,groupId,false);g.put("sourceMappings",sourceRows(a,batch,groupId).stream().map(r->r.get("target_order_line_id")).toList());return g;});if(source.get("target_order_id")==null)return imports.groupDto(source);
        String status="VERIFIED",code=null,message=null;Map<String,Object> actual=null;
        try{actual=purchases.get(ctx,"orders",number(source,"target_order_id"));var fixed=imports.map(imports.map(source.get("preview_snapshot")).get("nativeInput"));var expected=list(fixed.get("lines"));var lines=list(actual.get("lines"));if(!"DRAFT".equals(actual.get("status"))||expected.size()!=lines.size())status="DIFFERENT";else for(int n=0;n<expected.size();n++){var e=expected.get(n);final int lineNo=n+1;var found=lines.stream().filter(l->((Number)l.get("lineNo")).intValue()==lineNo).toList();if(found.size()!=1){status="DIFFERENT";break;}var l=found.getFirst();for(String field:List.of("productId","unit"))if(!Objects.toString(e.get(field)).equals(Objects.toString(l.get(field))))status="DIFFERENT";for(String field:List.of("qty","unitPrice","taxRate"))if(new BigDecimal(e.get(field).toString()).compareTo(new BigDecimal(l.get(field).toString()))!=0)status="DIFFERENT";}
            for(String field:List.of("bookId","supplierId","currency","orderDate","expectedDate","paymentTerms","termDays"))if(!Objects.equals(Objects.toString(fixed.get(field),null),Objects.toString(actual.get(field),null)))status="DIFFERENT";if(new BigDecimal(fixed.get("prepayRatio").toString()).compareTo(new BigDecimal(actual.get("prepayRatio").toString()))!=0)status="DIFFERENT";
            var planned=imports.map(imports.map(source.get("preview_snapshot")).get("preview"));for(String field:List.of("totalAmount","taxAmount","totalQty"))if(new BigDecimal(planned.get(field).toString()).compareTo(new BigDecimal(actual.get(field).toString()))!=0)status="DIFFERENT";
            var originalLines=list(planned.get("lines"));var mappings=(List<?>)source.get("sourceMappings");for(int n=0;n<originalLines.size();n++){var plannedLine=originalLines.get(n);final int no=n+1;var found=list(actual.get("lines")).stream().filter(l->((Number)l.get("lineNo")).intValue()==no).toList();if(found.size()!=1||n>=mappings.size()){status="DIFFERENT";continue;}var line=found.getFirst();if(!Objects.equals(Objects.toString(mappings.get(n),null),Objects.toString(line.get("id"),null)))status="DIFFERENT";for(String field:List.of("factor","baseQty","amount"))if(new BigDecimal(plannedLine.get(field).toString()).compareTo(new BigDecimal(line.get(field).toString()))!=0)status="DIFFERENT";}
            if(status.equals("DIFFERENT")){code="PUR_IMPORT_READBACK_DIFFERENT";message="当前采购草稿的表头、明细或来源映射与确认预览不一致";}
        }catch(ApiException error){status="READ_FAILED";code=error.getCode();message=error.getMessage();}catch(RuntimeException error){status="READ_FAILED";code="PUR_IMPORT_VERIFY_FAILED";message="采购草稿已创建，真实读回校验失败，请重试读取";}
        final String verified=status,errorCode=code,errorMessage=message;final Map<String,Object> actualResult=actual;
        return imports.tx.execute(s->{Access a=imports.access(ctx,false);imports.batch(a,batch,false);var current=group(a,batch,groupId,true);mapper.saveVerification(verified,errorCode,errorMessage,a.requireCountry(),groupId);var out=imports.groupDto(group(a,batch,groupId,false));if(actualResult!=null)out.put("actualOrder",actualResult);return out;});
    }
    private void recordFailure(RequestContext ctx,UUID batch,long id,Map<String,Object> body,String key,String status,String code,String message){imports.tx.execute(s->{Access a=imports.access(ctx,true);imports.batch(a,batch,true);var g=group(a,batch,id,true);if(g.get("target_order_id")==null&&(g.get("outer_key")==null||g.get("outer_key").equals(uuid(key))))mapper.saveCreationFailure(status,uuid(key),Digests.sha256(canonical(body)),imports.json.write(body),code,message,a.requireCountry(),id);return null;});}
}
