package com.hs.jxc.pur.controller;
import com.hs.jxc.pur.service.*;

import com.hs.jxc.attachment.AttachmentService;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import java.util.*;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/v1/pur/order-imports")
public class PurchaseImportController {
    private final PurchaseImportTraceService trace;private final PurchaseImportMatchService matches;private final PurchaseImportDraftService drafts;private final PurchaseImportPhotoService photos;private final com.hs.jxc.md.api.ProductImageApi images;private final PurchaseImportProductService products;private final PurchaseImportService imports;private final PurchaseImportTaskService tasks;private final JsonCodec json;
    public PurchaseImportController(PurchaseImportService imports,PurchaseImportTaskService tasks,JsonCodec json,PurchaseImportProductService products,PurchaseImportDraftService drafts,PurchaseImportPhotoService photos,com.hs.jxc.md.api.ProductImageApi images,PurchaseImportMatchService matches,PurchaseImportTraceService trace){this.trace=trace;this.matches=matches;this.drafts=drafts;this.photos=photos;this.images=images;this.products=products;this.imports=imports;this.tasks=tasks;this.json=json;}
    private RequestContext ctx(){return RequestContextHolder.require();}
    private ApiEnvelope ok(Object data){return ApiEnvelope.ok(data,ctx().traceId());}
    @GetMapping("/capabilities") public ApiEnvelope capabilities(){return ok(imports.capabilities(ctx()));}
    @PostMapping(consumes=MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<ApiEnvelope> upload(@RequestPart MultipartFile file,@RequestParam String header,@RequestParam(required=false)UUID batchId,@RequestHeader("Idempotency-Key")String key)throws java.io.IOException{
        if(file.getSize()>100L*1024*1024)throw new ApiException(413,"PUR_IMPORT_ASSET_LIMIT","采购文件不能超过100MiB");
        return ResponseEntity.accepted().body(ok(imports.upload(ctx(),file.getOriginalFilename(),file.getBytes(),json.readMap(header),batchId,key)));
    }
    @GetMapping("/{batchId}") public ApiEnvelope get(@PathVariable UUID batchId){return ok(imports.get(ctx(),batchId));}
    @PutMapping("/{batchId}") public ApiEnvelope header(@PathVariable UUID batchId,@RequestBody Map<String,Object> body){return ok(imports.saveHeader(ctx(),batchId,body));}
    @PutMapping("/{batchId}/rows/{rowId}") public ApiEnvelope row(@PathVariable UUID batchId,@PathVariable long rowId,@RequestBody Map<String,Object> body){return ok(imports.saveRow(ctx(),batchId,Inputs.id(rowId),body));}
    @DeleteMapping("/{batchId}/rows/{rowId}") public ApiEnvelope delete(@PathVariable UUID batchId,@PathVariable long rowId,@RequestHeader("If-Match")long version){return ok(imports.deleteRow(ctx(),batchId,Inputs.id(rowId),Inputs.id(version)));}
    @GetMapping("/{batchId}/sources/{sourceId}/content") public ResponseEntity<byte[]> source(@PathVariable UUID batchId,@PathVariable long sourceId){return binary(imports.content(ctx(),batchId,Inputs.id(sourceId),false));}
    @GetMapping("/{batchId}/images/{imageId}/content") public ResponseEntity<byte[]> image(@PathVariable UUID batchId,@PathVariable long imageId){return binary(imports.content(ctx(),batchId,Inputs.id(imageId),true));}
    @PutMapping("/{batchId}/rows/{rowId}/images/{imageId}/association") public ApiEnvelope association(@PathVariable UUID batchId,@PathVariable long rowId,@PathVariable long imageId,@RequestBody Map<String,Object> body){return ok(imports.associate(ctx(),batchId,Inputs.id(rowId),Inputs.id(imageId),body));}
    @PutMapping("/{batchId}/rows/{rowId}/decision") public ApiEnvelope decision(@PathVariable UUID batchId,@PathVariable long rowId,@RequestBody Map<String,Object> body){return ok(products.decide(ctx(),batchId,Inputs.id(rowId),body));}
    @PostMapping("/{batchId}/rows/{rowId}/products") public ApiEnvelope product(@PathVariable UUID batchId,@PathVariable long rowId,@RequestBody Map<String,Object> body,@RequestHeader("Idempotency-Key")String key){return ok(products.createProduct(ctx(),batchId,Inputs.id(rowId),body,key));}
    @PostMapping("/{batchId}/matches") public ApiEnvelope matches(@PathVariable UUID batchId,@RequestBody Map<String,Object> body,@RequestHeader("Idempotency-Key")String key){return ok(matches.start(ctx(),batchId,body,key));}
    @PostMapping("/{batchId}/rows/{rowId}/explanations") public ApiEnvelope explain(@PathVariable UUID batchId,@PathVariable long rowId,@RequestBody Map<String,Object> body,@RequestHeader("Idempotency-Key")String key){return ok(matches.explain(ctx(),batchId,Inputs.id(rowId),body,key));}
    @PostMapping("/{batchId}/previews") public ApiEnvelope previews(@PathVariable UUID batchId,@RequestBody Map<String,Object> body){return ok(drafts.previews(ctx(),batchId,body));}
    @PutMapping("/{batchId}/groups/{groupId}") public ApiEnvelope group(@PathVariable UUID batchId,@PathVariable long groupId,@RequestBody Map<String,Object> body){return ok(drafts.saveGroup(ctx(),batchId,Inputs.id(groupId),body));}
    @PutMapping("/{batchId}/groups/{groupId}/fee-todos") public ApiEnvelope fees(@PathVariable UUID batchId,@PathVariable long groupId,@RequestBody Map<String,Object> body){return ok(trace.save(ctx(),batchId,Inputs.id(groupId),body));}
    @PostMapping("/{batchId}/groups/{groupId}/drafts") public ApiEnvelope draft(@PathVariable UUID batchId,@PathVariable long groupId,@RequestBody Map<String,Object> body,@RequestHeader("Idempotency-Key")String key){return ok(drafts.create(ctx(),batchId,Inputs.id(groupId),body,key));}
    @GetMapping("/{batchId}/groups/{groupId}/creation") public ApiEnvelope creation(@PathVariable UUID batchId,@PathVariable long groupId){return ok(drafts.creation(ctx(),batchId,Inputs.id(groupId)));}
    @PostMapping("/{batchId}/rows/{rowId}/photos") public ApiEnvelope photos(@PathVariable UUID batchId,@PathVariable long rowId,@RequestBody Map<String,Object> body,@RequestHeader("Idempotency-Key")String key){return ok(photos.publish(ctx(),batchId,Inputs.id(rowId),body,key));}
    @GetMapping("/gallery/status") public ApiEnvelope gallery(){return ok(images.gallery(ctx()));}
    @PostMapping("/gallery/rebuild") public ApiEnvelope rebuild(@RequestBody Map<String,Object> body,@RequestHeader("Idempotency-Key")String key){return ok(photos.rebuild(ctx(),UUID.fromString(Inputs.required(body,"batchId")),key));}
    @GetMapping("/tasks/{taskId}") public ApiEnvelope task(@PathVariable UUID taskId){return ok(tasks.get(ctx(),taskId));}
    @PostMapping("/tasks/{taskId}/retry") public ApiEnvelope retry(@PathVariable UUID taskId,@RequestHeader("Idempotency-Key")String key,@RequestBody(required=false) Map<String,Object> body){return ok(tasks.retry(ctx(),taskId,key,body==null?null:Inputs.text(body,"sheet",null)));}
    static ResponseEntity<byte[]> binary(AttachmentService.Download file){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).header("X-Content-Type-Options","nosniff").header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.attachment().filename(file.fileName(),java.nio.charset.StandardCharsets.UTF_8).build().toString()).contentType(MediaType.parseMediaType(file.contentType())).body(file.bytes());}
}
