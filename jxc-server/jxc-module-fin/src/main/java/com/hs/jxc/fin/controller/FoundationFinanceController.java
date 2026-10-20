package com.hs.jxc.fin.controller;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import com.hs.jxc.fin.service.BookService;
import org.springframework.web.bind.annotation.*;
import java.util.Map;
@RestController
@RequestMapping("/api/v1")
public class FoundationFinanceController {
    private final BookService books;
    public FoundationFinanceController(BookService books){this.books=books;}
    private RequestContext ctx(){return RequestContextHolder.require();}
    private ApiEnvelope ok(Object data){return ApiEnvelope.ok(data,ctx().traceId());}
    @GetMapping("/org/books") public ApiEnvelope orgBooks(@RequestParam(required=false)Long warehouseId){return ok(warehouseId==null?books.books(ctx(),false):books.warehouseBooks(ctx(),warehouseId));}
    @GetMapping("/fin/books") public ApiEnvelope books(){return ok(books.books(ctx(),true));}
    @PutMapping("/fin/books/{id}") public ApiEnvelope rename(@PathVariable long id,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(books.rename(ctx(),id,body,key));}
    @PostMapping("/fin/books/{id}/activate") public ApiEnvelope activate(@PathVariable long id,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(books.activate(ctx(),id,body,key));}
    @PostMapping("/fin/periods") public ApiEnvelope periods(@RequestParam(required=false)Long bookId,@RequestBody(required=false)Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(books.generatePeriods(ctx(),bookId,body==null?Map.of():body,key));}
}
