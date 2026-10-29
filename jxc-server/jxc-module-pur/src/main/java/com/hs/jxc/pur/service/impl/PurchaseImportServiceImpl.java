package com.hs.jxc.pur.service.impl;
import com.hs.jxc.pur.service.*;

import com.hs.jxc.pur.mapper.*;

import com.hs.jxc.attachment.*;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.*;
import java.math.*;
import java.time.LocalDate;
import java.util.*;

import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** 采购导入的唯一暂存写入口；不调用正式商品或采购创建。 */
@Service
public class PurchaseImportServiceImpl implements PurchaseImportService {
    @org.springframework.beans.factory.annotation.Value("${jxc.purchase-import.worker-enabled:false}") private boolean workerEnabled;
    static final String BASE="/api/v1/pur/order-imports";
    static final List<String> FIELDS=List.of("sourceOrderNo","photo","productSpec","purchaseQty","saleUnitPrice","saleTotal","purchaseUnitPrice","freight","landedUnitCost","usdUnitCost","usdTotal");
    static final List<String> COLUMNS=List.of("source_order_no","photo","product_spec","purchase_qty","sale_unit_price","sale_total","purchase_unit_price","freight","landed_unit_cost","usd_unit_cost","usd_total");
    final PurchaseImportMapper mapper;final PurchaseImportTaskMapper sourceMapper;final PurchaseImportTraceMapper traceMapper;final JsonCodec json;final AuthorizationService auth;final TransactionTemplate tx;
    private final AttachmentAssetService assets;private final IdempotencyExecutor commands;private final AuditWriter audit;
    public PurchaseImportServiceImpl(PurchaseImportMapper mapper,JsonCodec json,AuthorizationService auth,AttachmentAssetService assets,IdempotencyExecutor commands,AuditWriter audit,PlatformTransactionManager tm,PurchaseImportTraceMapper traceMapper,PurchaseImportTaskMapper sourceMapper){this.mapper=mapper;this.sourceMapper=sourceMapper;this.traceMapper=traceMapper;this.json=json;this.auth=auth;this.assets=assets;this.commands=commands;this.audit=audit;tx=new TransactionTemplate(tm);}
    Access access(RequestContext ctx,boolean write){
        Access a=auth.authorize(ctx);a.requireCountry();a.require("pur:order:create");
        for(String group:List.of("COST","CUSTOMER_PRICE","ORDER_TOTAL"))if(FieldPolicyService.rank(a.fieldGroups().get(group))<(write?2:1))throw ApiException.forbidden();
        return a;
    }
    @org.springframework.beans.factory.annotation.Value("${jxc.purchase-import.draft-creation.enabled:false}") private boolean draftCreationEnabled;
    @org.springframework.beans.factory.annotation.Value("${jxc.purchase-import.recognition.enabled:false}") private boolean recognitionEnabled;
    public Map<String,Object> capabilities(RequestContext ctx){return tx.execute(s->{Access a=auth.authorize(ctx);a.requireCountry();var out=new LinkedHashMap<String,Object>();out.put("canCreatePurchase",a.has("pur:order:create"));out.put("draftCreationEnabled",draftCreationEnabled);out.put("recognitionEnabled",recognitionEnabled);out.put("canPublishPhotos",a.has("md:product:edit")&&a.has("md:product:view"));out.put("canQueryProducts",a.has("md:product:view"));out.put("canMaintainGlobalProducts",a.platformAdmin()&&a.has("md:product:edit"));out.put("canConfigureCountrySku",a.has("md:country-sku:edit"));out.put("sourceLimitBytes",AttachmentAssetService.Policy.PURCHASE_SOURCE.maxBytes);out.put("imageLimitBytes",AttachmentAssetService.Policy.PURCHASE_IMAGE.maxBytes);out.put("expandedLimitBytes",512*1024*1024);out.put("fieldPolicies",a.fieldGroups());return out;});}
    Map<String,Object> batch(Access a,UUID batch,boolean lock){
        var rows=mapper.selectBatch(a.requireCountry(),batch,lock);
        if(rows.size()!=1)throw ApiException.notFound();var b=rows.getFirst();
        if(number(b,"created_by")!=a.userId())throw ApiException.notFound();
        requireHeaderAccess(a,map(b.get("header")));
        for(var group:mapper.selectGroupHeaders(a.requireCountry(),batch))requireHeaderAccess(a,map(group.get("effective_header")));
        return b;
    }
    Long bookId(Map<String,Object> header){Object value=header.get("bookId");return value==null?null:Inputs.id(value);}
    void requireHeaderAccess(Access a,Map<String,Object> header){Long book=bookId(header);if(book!=null&&!a.canBook(book))throw ApiException.notFound();}
    /** 暂存只规范已提供值；缺失业务信息保持未知，实际选项在业务保存时核验。 */
    private Map<String,Object> stagingHeader(Map<String,Object> input){
        var h=new LinkedHashMap<String,Object>();
        for(String field:List.of("bookId","supplierId"))h.put(field,input.get(field)==null?null:Inputs.id(input.get(field)));
        String currency=Inputs.text(input,"currency",null);if(currency!=null&&currency.isBlank())currency=null;
        if(currency!=null&&!currency.matches("[A-Z]{3}"))throw Inputs.bad("币种格式不正确");h.put("currency",currency);
        h.put("orderDate",date(input.get("orderDate"),true));h.put("expectedDate",date(input.get("expectedDate"),true));
        String terms=Inputs.text(input,"paymentTerms","");if(terms.length()>200)throw Inputs.bad("付款条件最多200字");h.put("paymentTerms",terms);
        BigDecimal ratio=decimal(input.get("prepayRatio"),6,1,false);if(ratio!=null&&ratio.compareTo(BigDecimal.ONE)>0)throw Inputs.bad("预付比例须为0至1");h.put("prepayRatio",ratio==null?null:ratio.stripTrailingZeros().toPlainString());
        Object days=input.get("termDays");if(days!=null&&(!(days instanceof Number)||new BigDecimal(days.toString()).scale()>0||((Number)days).longValue()<0||((Number)days).longValue()>Integer.MAX_VALUE))throw Inputs.bad("账期天数须为非负整数");h.put("termDays",days==null?null:((Number)days).intValue());return h;
    }
    Map<String,Object> header(Access a,Map<String,Object> input){
        var h=stagingHeader(input);if(h.get("bookId")==null)throw Inputs.bad("请选择当前可用账套");if(h.get("supplierId")==null)throw Inputs.bad("请选择当前可用供应商");
        long book=Inputs.id(h.get("bookId")),supplier=Inputs.id(h.get("supplierId"));
        if(!a.canBook(book)||PurchaseRows.one(mapper.countActiveBook(a.requireCountry(),book))!=1)throw ApiException.notFound();
        if(PurchaseRows.one(mapper.countEnabledSupplier(a.requireCountry(),supplier))!=1)throw Inputs.bad("供应商不存在或未启用");
        if(h.get("currency")==null||PurchaseRows.one(mapper.countEnabledCurrency(h.get("currency")))!=1)throw Inputs.bad("币种不存在或未启用");
        date(h.get("orderDate"),false);return h;
    }
    static String date(Object value,boolean optional){if(optional&&(value==null||"".equals(value)))return null;if(!(value instanceof String text)||!text.matches("\\d{4}-\\d{2}-\\d{2}"))throw Inputs.bad("日期格式不正确");try{return LocalDate.parse(text).toString();}catch(java.time.DateTimeException e){throw Inputs.bad("日期无效");}}
    static BigDecimal decimal(Object value,int scale,int digits,boolean positive){
        if(value==null||"".equals(value)){if(positive)throw Inputs.bad("采购数量须大于0");return null;}
        if(!(value instanceof String text)||!text.matches("\\d{1,"+digits+"}(\\.\\d{1,"+scale+"})?"))throw Inputs.bad("数值须为符合字段精度的十进制字符串");
        BigDecimal n=new BigDecimal(text);if(positive&&n.signum()<=0)throw Inputs.bad("采购数量须大于0");return n.setScale(scale);
    }
    static Map<String,Object> values(Map<String,Object> input){
        var out=new LinkedHashMap<String,Object>();if(!input.keySet().equals(new HashSet<>(FIELDS)))throw Inputs.bad("导入明细字段不完整或包含不可编辑字段");
        for(int i=0;i<FIELDS.size();i++){String field=FIELDS.get(i);Object value=input.get(field);if(i<3){if(value!=null&&!(value instanceof String))throw Inputs.bad("文字字段格式不正确");String text=value==null?null:value.toString().trim();out.put(field,text==null||text.isEmpty()?null:text);}else out.put(field,decimal(value,i==3?4:10,i==3?16:20,i==3));}
        Object source=out.get("sourceOrderNo");if(source==null||source.toString().length()>100)throw Inputs.bad("采购单号不能为空或超过100字");return out;
    }
    public Map<String,Object> upload(RequestContext ctx,String name,byte[] bytes,Map<String,Object> input,UUID existing,String key){
        if(!workerEnabled)throw new ApiException(503,"PARSER_DISABLED","采购解析后台尚未启用，文件未导入；请联系管理员完成受限桥接配置");
        if(name==null||!name.toLowerCase(Locale.ROOT).endsWith(".xlsx"))throw Inputs.bad("请上传.xlsx采购模板");
        var h=tx.execute(s->{Access a=access(ctx,true);if(existing!=null){var current=map(batch(a,existing,false).get("header"));if(!input.isEmpty()&&!sameHeader(current,stagingHeader(input)))throw Inputs.conflict();return current;}return stagingHeader(input);});
        var prepared=assets.prepare(ctx,AttachmentAssetService.Policy.PURCHASE_SOURCE,name,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",bytes);
        return tx.execute(s->{Access a=access(ctx,true);var checked=stagingHeader(h);requireHeaderAccess(a,checked);var intent=new LinkedHashMap<String,Object>();if(!input.isEmpty())intent.put("header",checked);intent.put("fileSha256",prepared.sha256());intent.put("fileName",name);intent.put("batchId",existing==null?null:existing.toString());
            return commands.execute(ctx,"POST",BASE,key,intent,input.isEmpty()?null:bookId(h),()->{
                UUID id=existing==null?UUID.randomUUID():existing;
                if(existing==null)mapper.insertBatch(a.requireCountry(),id,json.write(checked),a.userId());
                var b=batch(a,id,true);if(existing!=null&&!sameHeader(map(b.get("header")),checked))throw Inputs.conflict();
                long asset=assets.register(ctx,prepared);long source=PurchaseRows.one(mapper.insertSource(a.requireCountry(),id,asset,name,prepared.sha256()));
                UUID task=UUID.randomUUID();mapper.insertParseTask(task,a.requireCountry(),id,source,number(b,"version"),prepared.sha256(),a.userId(),json.write(Map.of("userId",a.userId(),"tokenHash",ctx.tokenHash())));
                mapper.markBatchParsing(a.requireCountry(),id);
                audit.append(ctx,"PUR_IMPORT_UPLOAD","PURCHASE_IMPORT",number(b,"id"),null,Map.of("sourceId",source,"sha256",prepared.sha256()));var result=snapshot(a,id);result.put("taskId",task.toString());return result;
            },r->batch(a,UUID.fromString(r.get("batchId").toString()),false));
        });
    }
    public Map<String,Object> get(RequestContext ctx,UUID id){return tx.execute(s->snapshot(access(ctx,false),id));}
    Map<String,Object> snapshot(Access a,UUID id){
        var b=batch(a,id,false);var out=new LinkedHashMap<String,Object>();out.put("batchId",id.toString());out.put("version",b.get("version"));out.put("status",b.get("status"));out.put("sourceStatus",b.get("source_status"));out.put("header",map(b.get("header")));
        out.put("rows",mapper.selectRows(a.requireCountry(),id).stream().map(this::rowDto).toList());out.put("groups",mapper.selectGroups(a.requireCountry(),id).stream().map(this::groupDto).toList());
        out.put("sources",mapper.selectSources(a.requireCountry(),id).stream().map(this::sourceDto).toList());
        out.put("tasks",mapper.selectTasks(a.requireCountry(),id).stream().map(this::taskDto).toList());return out;
    }
    Map<String,Object> groupDto(Map<String,Object> row){var out=new LinkedHashMap<String,Object>();out.putAll(PurchaseImportTraceServiceImpl.view(this,row));out.put("id",row.get("id"));out.put("version",row.get("version"));out.put("sourceOrderNo",row.get("source_order_no"));out.put("header",map(row.get("effective_header")));out.put("createStatus",row.get("create_status"));out.put("verifyStatus",row.get("verify_status"));out.put("previewToken",row.get("preview_token")==null?null:row.get("preview_token").toString());out.put("orderId",row.get("target_order_id"));out.put("errorCode",row.get("error_code"));out.put("errorMessage",row.get("error_message"));out.put("preview",row.get("preview_snapshot")==null?null:map(row.get("preview_snapshot")).get("preview"));out.put("errors",row.get("preview_snapshot")==null?List.of():map(row.get("preview_snapshot")).get("errors"));if(row.get("outer_key")!=null&&row.get("create_request")!=null)out.put("createIntent",Map.of("key",row.get("outer_key").toString(),"request",map(row.get("create_request"))));if(row.get("result_snapshot")!=null){var result=map(row.get("result_snapshot"));out.put("docNo",result.get("docNo"));out.put("orderStatus",result.get("status"));}return out;}
    Map<String,Object> taskDto(Map<String,Object> row){var out=new LinkedHashMap<String,Object>();for(String k:List.of("id","kind","phase","status","attempt_count","error_code","error_message"))out.put(camel(k),row.get(k)==null?null:row.get(k) instanceof UUID?row.get(k).toString():row.get(k));if(row.get("result")!=null){var result=map(row.get("result"));out.put("result",Set.of("MATCH","EXPLAIN").contains(row.get("kind"))?result.get("public"):result);}return out;}
    private Map<String,Object> sourceDto(Map<String,Object> r){var out=new LinkedHashMap<String,Object>();for(String k:List.of("id","file_name","file_sha256","parser_version","status","origin","error_code","error_message"))out.put(camel(k),r.get(k));for(String k:List.of("sheets","warnings","associations"))out.put(k,json.read(r.get(k).toString(),List.class));return out;}
    static Map<String,Object> valueDto(Map<String,Object> row){var out=new LinkedHashMap<String,Object>();for(int i=0;i<FIELDS.size();i++){Object v=row.get(COLUMNS.get(i));out.put(FIELDS.get(i),v instanceof BigDecimal d?d.toPlainString():v);}return out;}
    Map<String,Object> rowDto(Map<String,Object> row){var out=new LinkedHashMap<String,Object>();out.put("id",row.get("id"));out.put("version",row.get("version"));out.put("rowNo",row.get("row_no"));out.putAll(valueDto(row));for(String k:List.of("source_id","source_sheet","source_row","source_item_key","group_id","target_order_line_id"))out.put(camel(k),row.get(k));for(String field:List.of("matched_product_id","purchase_unit","supplied_product_code","supplied_product_name","supplier_product_code","decision","readiness","confirmed_by","confirmed_at")){Object value=row.get(field);out.put(camel(field),value instanceof java.sql.Timestamp timestamp?timestamp.toInstant().toString():value);}out.put("matchTaskId",row.get("match_task_id")==null?null:row.get("match_task_id").toString());out.put("matchResult",row.get("match_result")==null?null:map(row.get("match_result")));for(String field:List.of("product_snapshot","product_operation"))out.put(camel(field),row.get(field)==null?null:map(row.get(field)));out.put("setupReasons",json.read(row.get("setup_reasons").toString(),List.class));out.put("images",mapper.selectRowImages(row.get("country_id"),row.get("id")).stream().map(this::imageDto).toList());return out;}
    private Map<String,Object> imageDto(Map<String,Object> row){var out=new LinkedHashMap<String,Object>();out.put("id",row.get("id"));out.put("sha256",row.get("image_sha256"));out.put("status",row.get("association_status"));out.put("origin",row.get("origin"));out.put("anchor",map(row.get("anchor")));out.put("publishStatus",row.get("publish_status"));out.put("productImageId",row.get("product_image_id"));out.put("publishedProductId",row.get("publish_product_id"));out.put("publishError",row.get("publish_error"));return out;}
    Map<String,Object> row(Access a,UUID batch,long id){var rows=mapper.selectRowForUpdate(a.requireCountry(),batch,id);if(rows.size()!=1)throw ApiException.notFound();return rows.getFirst();}
    public Map<String,Object> uploadPhoto(RequestContext ctx,UUID id,long rowId,String name,String mime,byte[] bytes,Map<String,Object> input,String key){
        tx.execute(s->{Access a=access(ctx,true);batch(a,id,false);row(a,id,rowId);return null;});
        var image=PurchaseImportImageFile.inspect(name,mime,bytes);
        var v=values(map(input.get("values")));long version=Inputs.version(input);
        // 复用附件的两阶段保存：对象I/O在事务外，事务内重新核实权限、行版本及绑定。
        var prepared=assets.prepare(ctx,AttachmentAssetService.Policy.PURCHASE_IMAGE,name,image.mime(),bytes);
        var intent=Map.<String,Object>of("fileName",name,"fileSha256",AttachmentObjectStore.sha256(bytes),"mime",image.mime(),"version",version,"values",valueIntent(v));
        return tx.execute(s->{Access a=access(ctx,true);var b=batch(a,id,true);var current=row(a,id,rowId);
            return commands.execute(ctx,"POST",BASE+"?batchId="+id+"&imageRowId="+rowId,key,intent,bookId(map(b.get("header"))),()->{
                requireEditable(current);if(number(current,"version")!=version)throw Inputs.conflict();
                var previous=mapper.selectRowImages(a.requireCountry(),rowId).stream().filter(old->!"REJECTED".equals(old.get("association_status"))).toList();
                if(previous.stream().anyMatch(old->old.get("product_image_id")!=null))throw new ApiException(409,"PUR_IMPORT_PHOTO_PUBLISHED","照片已形成正式商品关系，导入区不能直接替换");
                long asset=assets.register(ctx,prepared),source=PurchaseRows.one(mapper.insertManualImageSource(a.requireCountry(),id,asset,name,prepared.sha256()));
                long imageId=PurchaseRows.one(sourceMapper.insertImage(a.requireCountry(),source,asset,prepared.sha256(),"manual-upload/"+name,image.mime(),image.width(),image.height()));
                for(var old:previous)if(mapper.updateImageAssociation("REJECTED",a.userId(),a.requireCountry(),rowId,old.get("id"))!=1)throw Inputs.conflict();
                sourceMapper.upsertRowImage(a.requireCountry(),rowId,imageId,json.write(Map.of("origin","MANUAL_UPLOAD","fileName",name)));
                if(mapper.updateImageAssociation("CONFIRMED",a.userId(),a.requireCountry(),rowId,imageId)!=1)throw Inputs.conflict();
                saveRow(ctx,id,rowId,input);
                audit.append(ctx,"PUR_IMPORT_PHOTO_UPLOAD","PURCHASE_IMPORT",rowId,null,Map.of("imageId",imageId,"sourceId",source,"sha256",prepared.sha256()));
                return snapshot(a,id);
            },r->batch(a,id,false));
        });
    }
    private Map<String,Object> valueIntent(Map<String,Object> values){var out=new LinkedHashMap<String,Object>();values.forEach((field,value)->out.put(field,value instanceof BigDecimal decimal?decimal.toPlainString():value));return out;}
    public Map<String,Object> saveRow(RequestContext ctx,UUID id,long rowId,Map<String,Object> input){return tx.execute(s->{Access a=access(ctx,true);var b=batch(a,id,true);var before=row(a,id,rowId);requireEditable(before);if(number(before,"version")!=Inputs.version(input))throw Inputs.conflict();var v=values(map(input.get("values")));var args=new ArrayList<Object>();FIELDS.forEach(field->args.add(v.get(field)));var origins=map(before.get("field_origins"));v.forEach((k,value)->{if(!Objects.equals(Objects.toString(before.get(COLUMNS.get(FIELDS.indexOf(k))),null),Objects.toString(value,null)))origins.put(k,"MANUAL");});args.add(json.write(origins));args.add(a.requireCountry());args.add(rowId);
        mapper.updateRowValues(args.get(0),args.get(1),args.get(2),args.get(3),args.get(4),args.get(5),args.get(6),args.get(7),args.get(8),args.get(9),args.get(10),args.get(11),args.get(12),args.get(13));if(input.containsKey("matchInputs")){var supplied=map(input.get("matchInputs"));if(!supplied.keySet().equals(Set.of("suppliedProductCode","suppliedProductName","supplierProductCode")))throw Inputs.bad("补充文字字段不完整或包含不可修改字段");for(String field:List.of("suppliedProductCode","suppliedProductName","supplierProductCode")){Object raw=supplied.get(field);if(raw!=null&&!(raw instanceof String))throw Inputs.bad("补充编码和名称须为文字");String text=raw==null?null:raw.toString().trim();if(text!=null&&text.length()>200)throw Inputs.bad("补充编码或名称过长");supplied.put(field,text==null||text.isEmpty()?null:text);origins.put(field,"MANUAL");}mapper.updateMatchInputs(supplied.get("suppliedProductCode"),supplied.get("suppliedProductName"),supplied.get("supplierProductCode"),json.write(origins),a.requireCountry(),rowId);}touch(a,id);var out=rowDto(row(a,id,rowId));out.put("batchVersion",number(b,"version")+1);audit.append(ctx,"PUR_IMPORT_EDIT","PURCHASE_IMPORT",number(b,"id"),Map.of("rowId",rowId,"version",before.get("version")),Map.of("rowId",rowId,"version",out.get("version")));return out;});}
    public Map<String,Object> saveHeader(RequestContext ctx,UUID id,Map<String,Object> input){return tx.execute(s->{Access a=access(ctx,true);var b=batch(a,id,true);requireResolvedBatch(a,id);if(PurchaseRows.one(mapper.countCreatedRows(a.requireCountry(),id))>0)throw new ApiException(409,"PUR_IMPORT_CREATED_READ_ONLY","已创建草稿的来源基础信息不能整体修改");if(number(b,"version")!=Inputs.id(input.get("batchVersion")))throw Inputs.conflict();var current=mapper.selectRowVersionsForUpdate(a.requireCountry(),id);var versions=list(input.get("versions"));if(current.size()!=versions.size()||current.stream().anyMatch(r->versions.stream().noneMatch(v->Inputs.id(v.get("id"))==number(r,"id")&&Inputs.id(v.get("version"))==number(r,"version"))))throw Inputs.conflict();var h=header(a,map(input.get("header")));mapper.updateBatchHeader(json.write(h),a.requireCountry(),id);mapper.updateRowsHeader(h.get("bookId"),h.get("supplierId"),h.get("currency"),h.get("orderDate"),h.get("expectedDate"),h.get("paymentTerms"),h.get("prepayRatio"),h.get("termDays"),a.requireCountry(),id);mapper.updateInheritedGroupHeaders(json.write(h),a.requireCountry(),id);touch(a,id);audit.append(ctx,"PUR_IMPORT_HEADER","PURCHASE_IMPORT",number(b,"id"),map(b.get("header")),h);return snapshot(a,id);});}
    public Map<String,Object> deleteRow(RequestContext ctx,UUID id,long rowId,long version){return tx.execute(s->{Access a=access(ctx,true);var b=batch(a,id,true);var r=row(a,id,rowId);requireEditable(r);if(number(r,"version")!=version)throw Inputs.conflict();mapper.deleteRow(a.requireCountry(),rowId);touch(a,id);audit.append(ctx,"PUR_IMPORT_DELETE","PURCHASE_IMPORT",number(b,"id"),Map.of("rowId",rowId),null);return Map.of("deleted",true,"id",rowId,"batchVersion",number(b,"version")+1);});}
    void requireResolvedBatch(Access a,UUID id){if(PurchaseRows.one(mapper.countUnresolvedBatchGroups(a.requireCountry(),id))>0)throw new ApiException(409,"PUR_IMPORT_CREATE_UNRESOLVED","请先按原请求核实采购创建结果");}
    void requireEditable(Map<String,Object> row){if(row.get("group_id")!=null&&PurchaseRows.one(mapper.countUnresolvedGroup(row.get("country_id"),row.get("group_id")))>0)throw new ApiException(409,"PUR_IMPORT_CREATE_UNRESOLVED","请先按原请求核实采购创建结果");if(row.get("target_order_line_id")!=null)throw new ApiException(409,"PUR_IMPORT_CREATED_READ_ONLY","本行已关联真实采购草稿，不能修改或删除来源");}
    void touch(Access a,UUID id){mapper.invalidatePreviews(a.requireCountry(),id);mapper.incrementBatchVersion(a.requireCountry(),id);}
    public AttachmentService.Download content(RequestContext ctx,UUID id,long assetId,boolean image){var snap=tx.execute(s->{Access a=access(ctx,false);batch(a,id,false);var r=mapper.selectAsset(a.requireCountry(),id,assetId,image);if(r.size()!=1)throw ApiException.notFound();return r.getFirst();});byte[] data=assets.read(snap,image?AttachmentAssetService.Policy.PURCHASE_IMAGE:AttachmentAssetService.Policy.PURCHASE_SOURCE);tx.execute(s->{Access a=access(ctx,false);batch(a,id,false);return null;});return new AttachmentService.Download(snap.get("file_name").toString(),snap.get("content_type").toString(),data);}
    public Map<String,Object> associate(RequestContext ctx,UUID id,long rowId,long imageId,Map<String,Object> input){return tx.execute(s->{Access a=access(ctx,true);batch(a,id,true);var r=row(a,id,rowId);requireEditable(r);if(number(r,"version")!=Inputs.version(input))throw Inputs.conflict();String state=Inputs.required(input,"association");if(!Set.of("CONFIRMED","REJECTED").contains(state))throw Inputs.bad("请明确确认或排除图片归属");if(PurchaseRows.one(mapper.countPublishedImage(a.requireCountry(),rowId,imageId))>0)throw new ApiException(409,"PUR_IMPORT_PHOTO_PUBLISHED","照片已形成正式商品关系，导入区不能直接撤销归属");if(mapper.updateImageAssociation(state,a.userId(),a.requireCountry(),rowId,imageId)!=1)throw ApiException.notFound();mapper.incrementRowVersion(a.requireCountry(),rowId);touch(a,id);audit.append(ctx,"PUR_IMPORT_IMAGE_ASSOCIATION","PURCHASE_IMPORT",rowId,null,Map.of("imageId",imageId,"association",state));var out=rowDto(row(a,id,rowId));out.put("batchVersion",PurchaseRows.one(mapper.selectBatchVersion(a.requireCountry(),id)));return out;});}
    Map<String,Object> map(Object value){if(value instanceof Map<?,?> m){var out=new LinkedHashMap<String,Object>();m.forEach((k,v)->out.put(k.toString(),v));return out;}if(value instanceof org.postgresql.util.PGobject) return json.readMap(value.toString());throw Inputs.bad("对象字段格式不正确");}
    static List<Map<String,Object>> list(Object value){if(!(value instanceof List<?> list))throw Inputs.bad("列表字段格式不正确");var out=new ArrayList<Map<String,Object>>();for(Object item:list){if(!(item instanceof Map<?,?> m))throw Inputs.bad("列表项格式不正确");var row=new LinkedHashMap<String,Object>();m.forEach((k,v)->row.put(k.toString(),v));out.add(row);}return out;}
    static long number(Map<String,Object> row,String key){return ((Number)row.get(key)).longValue();}
    private boolean sameHeader(Map<String,Object> left,Map<String,Object> right){return json.write(IdempotencyExecutor.canonical(normalizedHeader(left))).equals(json.write(IdempotencyExecutor.canonical(normalizedHeader(right))));}
    private Map<String,Object> normalizedHeader(Map<String,Object> value){var copy=new LinkedHashMap<>(value);if(copy.get("prepayRatio")!=null)copy.put("prepayRatio",new BigDecimal(copy.get("prepayRatio").toString()).stripTrailingZeros().toPlainString());return copy;}
    private static String camel(String key){StringBuilder s=new StringBuilder();boolean up=false;for(char c:key.toCharArray())if(c=='_')up=true;else{s.append(up?Character.toUpperCase(c):c);up=false;}return s.toString();}
}
