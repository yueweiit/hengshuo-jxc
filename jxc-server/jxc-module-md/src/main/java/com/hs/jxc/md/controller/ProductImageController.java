package com.hs.jxc.md.controller;
import com.hs.jxc.md.api.ProductImageApi;
import com.hs.jxc.common.api.ApiEnvelope;
import com.hs.jxc.common.context.RequestContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
@RestController @RequestMapping("/api/v1/md")
public class ProductImageController {
 private final ProductImageApi images;public ProductImageController(ProductImageApi images){this.images=images;}
 @GetMapping("/products/{id}/images") public ApiEnvelope list(@PathVariable long id){var ctx=RequestContextHolder.require();return ApiEnvelope.ok(images.list(ctx,id),ctx.traceId());}
 @GetMapping("/product-images/{id}/content") public ResponseEntity<byte[]> content(@PathVariable long id){var file=images.content(RequestContextHolder.require(),id);return ResponseEntity.ok().cacheControl(CacheControl.noStore()).header("X-Content-Type-Options","nosniff").contentType(MediaType.parseMediaType(file.contentType())).body(file.bytes());}
}
