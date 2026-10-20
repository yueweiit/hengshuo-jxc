package com.hs.jxc.attachment;

import com.hs.jxc.common.api.ApiEnvelope;
import com.hs.jxc.common.context.RequestContextHolder;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/v1/sys/attachments")
public class AttachmentController {
    private final AttachmentService service;
    public AttachmentController(AttachmentService service){this.service=service;}
    @GetMapping public ApiEnvelope list(@RequestParam String bizType,@RequestParam long bizId,@RequestParam String category) {
        var ctx=RequestContextHolder.require();return ApiEnvelope.ok(service.list(ctx,bizType,bizId,category),ctx.traceId());
    }
    @PostMapping(consumes=MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiEnvelope upload(@RequestParam String bizType,@RequestParam long bizId,@RequestParam String category,@RequestPart MultipartFile file)throws IOException {
        var ctx=RequestContextHolder.require();return ApiEnvelope.ok(service.upload(ctx,bizType,bizId,category,file.getOriginalFilename(),file.getContentType(),file.getBytes()),ctx.traceId());
    }
    @GetMapping("/{id}/url") public ApiEnvelope url(@PathVariable long id) {
        var ctx=RequestContextHolder.require();return ApiEnvelope.ok(service.url(ctx,id),ctx.traceId());
    }
    @GetMapping("/{id}/content")
    public ResponseEntity<byte[]> content(@PathVariable long id,@RequestParam String bizType,@RequestParam long bizId,
            @RequestParam String category,@RequestParam int linkVersion,@RequestParam String sha256) {
        var body=service.download(RequestContextHolder.require(),new AttachmentService.EvidenceSpec(id,bizType,bizId,category,linkVersion,sha256));
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(body.contentType()))
            .header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.attachment().filename(body.fileName(),StandardCharsets.UTF_8).build().toString())
            .header("X-Content-Type-Options","nosniff").header(HttpHeaders.CACHE_CONTROL,"no-store").body(body.bytes());
    }
    @PostMapping("/{id}/unlink") public ApiEnvelope unlink(@PathVariable long id,@RequestBody(required=false)Map<String,Object> body) {
        var ctx=RequestContextHolder.require();service.unlink(ctx,id,body!=null&&body.get("reason")!=null?String.valueOf(body.get("reason")):null);return ApiEnvelope.ok(null,ctx.traceId());
    }
}
