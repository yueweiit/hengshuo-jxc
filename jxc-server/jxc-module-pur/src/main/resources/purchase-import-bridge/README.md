# 采购导入桥接源码交付

这是C:/project/docling-demo对应文件的版本化交付副本，不是第二个运行入口。实际调用仍是Java任务→受限Python bridge→原Docling与n8n；不从此资源目录启动Python。

部署时先备份原工作台，再按相对路径同步这些文件，保留原convert.py、documents.py、vision/gallery模块、模型、环境和凭据；使用既有Python环境运行workbench/tests/test_jxc_supplier.py及test_jxc_bridge.py。新字段工作流需绑定已有DeepSeek凭据及专用Header凭据后启用。源码不包含真实凭据。

字段环境：JXC_SUPPLIER_N8N_URL（必须以/jxc-purchase-fields-v1结尾）与JXC_SUPPLIER_N8N_KEY。Java原任务retry接受mappingOverrides，仅允许原格映射、规格列标签和明确确认。旧/internal/jxc/parse保留给尚未升级客户端；当前本机客户端切换后，其他运行客户端是否仍调用不确定；全部客户端迁移且核实无调用后可删除，无承诺日期。

manifest.json记录UTF-8文本将CRLF统一为LF后的SHA-256，避免Windows检出行尾导致相同源码误报变更。校验时按上述规范化读取；不移除空白、不改代码正文。运行包内旧清单按当时实际字节留存，其运行源码没有变化。
