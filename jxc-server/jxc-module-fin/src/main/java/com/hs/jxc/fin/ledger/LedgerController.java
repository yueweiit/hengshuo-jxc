package com.hs.jxc.fin.ledger;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/fin")
public class LedgerController {
    private final LedgerService ledger;private final org.springframework.beans.factory.ObjectProvider<com.hs.jxc.sys.jobs.JobApi> jobs;
    public LedgerController(LedgerService ledger,org.springframework.beans.factory.ObjectProvider<com.hs.jxc.sys.jobs.JobApi> jobs){this.ledger=ledger;this.jobs=jobs;}
    private RequestContext c(){return RequestContextHolder.require();}
    private ApiEnvelope ok(Object data){return ApiEnvelope.ok(data,c().traceId());}
    private Map<String,Object> body(Map<String,Object> body){return body==null?Map.of():body;}
    @GetMapping("/{resource:accounts|cashflow-items|voucher-words|category-account-maps|opening-balances}")
    public ApiEnvelope configList(@PathVariable String resource,@RequestParam(required=false)Long bookId,@RequestParam Map<String,String> query){return ok(ledger.list(c(),bookId,resource,query));}
    @GetMapping("/{resource:accounts|cashflow-items|voucher-words|category-account-maps|opening-balances}/{id}")
    public ApiEnvelope configGet(@PathVariable String resource,@PathVariable long id,@RequestParam(required=false)Long bookId){return ok(ledger.configGet(c(),bookId,resource,id));}
    @PostMapping("/{resource:accounts|cashflow-items|voucher-words|category-account-maps|opening-balances}")
    public ApiEnvelope configCreate(@PathVariable String resource,@RequestParam(required=false)Long bookId,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(ledger.configure(c(),bookId,resource,null,"POST",body,key));}
    @PutMapping("/{resource:accounts|cashflow-items|voucher-words|category-account-maps|opening-balances}/{id}")
    public ApiEnvelope configUpdate(@PathVariable String resource,@PathVariable long id,@RequestParam(required=false)Long bookId,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(ledger.configure(c(),bookId,resource,id,"PUT",body,key));}
    @DeleteMapping("/{resource:accounts|cashflow-items|voucher-words|category-account-maps|opening-balances}/{id}")
    public ApiEnvelope configDelete(@PathVariable String resource,@PathVariable long id,@RequestParam(required=false)Long bookId,@RequestParam(required=false)Long version,@RequestBody(required=false)Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(ledger.configure(c(),bookId,resource,id,"DELETE",version==null?body(body):Map.of("version",version),key));}
    @PostMapping("/opening-balances/confirm")
    public ApiEnvelope openingConfirm(@RequestParam(required=false)Long bookId,@RequestBody(required=false)Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(ledger.confirmOpening(c(),bookId,body(body),key));}
    @GetMapping("/vouchers") public ApiEnvelope vouchers(@RequestParam(required=false)Long bookId,@RequestParam Map<String,String> query){return ok(ledger.voucherList(c(),bookId,query));}
    @GetMapping("/vouchers/{id}") public ApiEnvelope voucher(@PathVariable long id,@RequestParam(required=false)Long bookId){return ok(ledger.voucherGet(c(),bookId,id));}
    @PostMapping("/vouchers") public ApiEnvelope create(@RequestParam(required=false)Long bookId,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(ledger.voucherCreate(c(),bookId,body,key));}
    @PutMapping("/vouchers/{id}") public ApiEnvelope update(@PathVariable long id,@RequestParam(required=false)Long bookId,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(ledger.voucherUpdate(c(),bookId,id,body,key,false));}
    @DeleteMapping("/vouchers/{id}") public ApiEnvelope delete(@PathVariable long id,@RequestParam(required=false)Long bookId,@RequestParam(required=false)Long version,@RequestBody(required=false)Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(ledger.voucherUpdate(c(),bookId,id,version==null?body(body):Map.of("version",version),key,true));}
    @PostMapping("/vouchers/{id}/{action:submit|audit|unaudit|post|reverse}") public ApiEnvelope action(@PathVariable long id,@PathVariable String action,@RequestParam(required=false)Long bookId,@RequestBody(required=false)Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(ledger.action(c(),bookId,id,action,body(body),key));}
    @PostMapping("/vouchers/batch-{action:audit|post}") public ApiEnvelope batch(@PathVariable String action,@RequestParam(required=false)Long bookId,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){return ok(ledger.batch(c(),bookId,action,body,key));}
    @GetMapping("/ledgers/{type:detail|general|balance|journal}") public ApiEnvelope ledgers(@PathVariable String type,@RequestParam(required=false)Long bookId,@RequestParam(required=false)Long periodId,@RequestParam(required=false)Long accountId,@RequestParam(required=false)Long fundAccountId,@RequestParam(required=false)String auxKey){return ok(ledger.ledger(c(),bookId,type,periodId,accountId,fundAccountId,auxKey));}
    @PostMapping("/ledgers/{type:detail|general|balance|journal|trial}/export") public ApiEnvelope export(@PathVariable String type,@RequestBody Map<String,Object> body,@RequestHeader(value="Idempotency-Key",required=false)String key){var request=new LinkedHashMap<String,Object>(body);long book=Inputs.id(request.remove("bookId"));request.put("type",type);var service=jobs.getIfAvailable();if(service==null)throw new ApiException(503,"SYS_JOB_UNAVAILABLE","导出任务服务尚不可用");return ok(service.enqueue(c(),"FIN_LEDGER_EXPORT",book,request,key));}
    @GetMapping("/trial-balance") public ApiEnvelope trial(@RequestParam(required=false)Long bookId,@RequestParam(required=false)Long periodId){return ok(ledger.ledger(c(),bookId,"trial",periodId,null,null,null));}
}
