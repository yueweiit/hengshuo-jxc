package com.hs.jxc.pur.controller;
import com.hs.jxc.pur.service.*;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;

/**
 * 采购模块接口入口，处理采购单、国内收货单和出口登记。
 * 接口接收请求并统一包装响应，业务规则及权限校验由对应服务处理。
 */
@RestController
@RequestMapping("/api/v1/pur")
public class PurchaseController {

    private final PurchaseService s;
    private final PurchaseOrderImportTemplate importTemplate;

    public PurchaseController(PurchaseService s, PurchaseOrderImportTemplate importTemplate) {
        this.s = s;
        this.importTemplate = importTemplate;
    }

    /** 获取当前请求上下文；缺少有效上下文时直接报错。 */
    private RequestContext c() {
        return RequestContextHolder.require();
    }

    /** 统一包装成功响应，并附带本次请求的追踪编号。 */
    private ApiEnvelope ok(Object d) {
        return ApiEnvelope.ok(d, c().traceId());
    }

    /** 下载采购单导入模板；登录、国家及采购创建权限由模板服务校验。 */
    @GetMapping("/orders/import-template")
    public ApiEnvelope importTemplate() {
        return ok(importTemplate.download(c()));
    }

    /** 按单据类型查询列表，筛选及分页参数原样交给采购服务。 */
    @GetMapping("/{kind:orders|domestic-receipts|export-nodes}")
    public ApiEnvelope list(
            @PathVariable String kind,
            @RequestParam Map<String, String> query) {
        return ok(s.list(c(), kind, query));
    }

    /** 查询指定单据详情，先校验单据编号。 */
    @GetMapping("/{kind:orders|domestic-receipts|export-nodes}/{id}")
    public ApiEnvelope get(@PathVariable String kind, @PathVariable long id) {
        return ok(s.get(c(), kind, Inputs.id(id)));
    }

    /** 创建单据，将可选的幂等键交给服务处理，避免重复请求产生重复业务结果。 */
    @PostMapping("/{kind:orders|domestic-receipts|export-nodes}")
    public ApiEnvelope create(
            @PathVariable String kind,
            @RequestBody Map<String, Object> b,
            @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        return ok(s.create(c(), kind, b, key));
    }

    /** 更新指定单据，是否允许编辑由采购服务根据单据状态及权限判断。 */
    @PutMapping("/{kind:orders|domestic-receipts|export-nodes}/{id}")
    public ApiEnvelope update(
            @PathVariable String kind,
            @PathVariable long id,
            @RequestBody Map<String, Object> b) {
        return ok(s.update(c(), kind, Inputs.id(id), b));
    }

    /** 处理提交、确认、作废、取消明细和关闭操作，具体规则由采购服务判断。 */
    @PostMapping("/{kind:orders|domestic-receipts|export-nodes}/{id}/{action:submit|confirm|void|cancel-lines|close}")
    public ApiEnvelope action(
            @PathVariable String kind,
            @PathVariable long id,
            @PathVariable String action,
            @RequestBody(required = false) Map<String, Object> b,
            @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        // 部分操作不需要请求体，此时传入空参数集合，沿用服务的现有处理约定。
        return ok(s.action(c(), kind, Inputs.id(id), action, b == null ? Map.of() : b, key));
    }

    /** 处理指定国内收货明细的转换操作。 */
    @PostMapping("/domestic-receipts/lines/{id}/convert")
    public ApiEnvelope convert(
            @PathVariable long id,
            @RequestBody Map<String, Object> b,
            @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        return ok(s.convert(c(), Inputs.id(id), b, key));
    }

    /** 查询指定采购单的收货、出口及物流进度。 */
    @GetMapping("/orders/{id}/progress")
    public ApiEnvelope progress(@PathVariable long id) {
        return ok(s.progress(c(), Inputs.id(id)));
    }

    /** 查询出口登记可选择的来源明细。 */
    @GetMapping("/export-nodes/sources")
    public ApiEnvelope exportSources() {
        return ok(s.sources(c(), true));
    }

    /** 查询可出运来源，编辑出运单时可传入当前出运单编号参与数量计算。 */
    @GetMapping("/shippable-sources")
    public ApiEnvelope sources(@RequestParam(required = false) Long excludeShipmentId) {
        return ok(s.sources(c(), false, excludeShipmentId));
    }
}
