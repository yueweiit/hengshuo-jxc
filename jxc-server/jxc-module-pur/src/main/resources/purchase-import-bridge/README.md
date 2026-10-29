# 采购导入桥接源码交付

这是C:/project/docling-demo对应文件的版本化交付副本，不是第二个运行入口。实际调用仍是Java任务→受限Python bridge→原Docling与n8n；不从此资源目录启动Python。

部署时先备份原工作台，再按相对路径同步这些文件，保留原convert.py、documents.py、jxc_gallery.py、vision_routes.py、模型、环境和凭据；vision.py由此交付副本更新，共用一个运行入口。使用既有Python环境运行workbench/tests/test_jxc_supplier.py、test_jxc_gallery.py及原test_jxc_bridge.py、test_vision.py、test_vision_api.py。新字段工作流只绑定专用Header凭据及受控Java根地址；DeepSeek密钥改由JXC后端配置，工作流不再单独持有。源码不包含真实凭据。

新建图片索引统一采用IndexIDMap2包装的HNSW，使用归一化向量与内积计算余弦相似度；保留稳定featureId，参数初值为M=32、efConstruction=200、efSearch=256。JXC与演示图库继续共用write_vector_index，不另建识别流程。HNSW为近似搜索，可能漏候选，结果仍需人工确认；上述参数与算法测试不代表真实照片识别准确率。

读取兼容已发布的IDMap2+Flat正式索引，以及仅演示入口允许的旧裸Flat索引。新建或重建才使用HNSW，不自动覆盖旧图库；旧读取保留至正式图库重建、旧演示迁移且核实无调用后移除，具体日期及其他调用方不确定。同步源码后需按运行维护流程重启Python进程；已有正式图库还需通过原有重建入口发布新索引，代码交付本身不代表这些运行步骤已执行。

旧启动配置的字段环境：JXC_SUPPLIER_N8N_URL（必须以/jxc-purchase-fields-v1结尾）与JXC_SUPPLIER_N8N_KEY。页面配置模式不读取这两个值，Python经短期任务凭证调用Java /fields，由Java调用对应n8n。Java原任务retry接受mappingOverrides，仅允许原格映射、规格列标签和明确确认。旧/internal/jxc/parse保留给尚未升级客户端；当前本机客户端切换后，其他运行客户端是否仍调用不确定；全部客户端迁移且核实无调用后可删除，无承诺日期。

manifest.json记录UTF-8文本将CRLF统一为LF后的SHA-256，避免Windows检出行尾导致相同源码误报变更。校验时按上述规范化读取；不移除空白、不改代码正文。运行包内旧清单按当时实际字节留存，其运行源码没有变化。

## 商品AI图文核对

n8n/jxc-purchase-recognition.json是同一受限商品识别工作流的版本化交付，替代其旧版“只解释编号与分数”的实现；不是额外运行一套流程。导入后保持未激活，绑定专用Header凭据及Validate task中的受控Java、Python根地址，再沿原发布流程启用。没有页面配置时Java沿用jxc.purchase-import.n8n-url；页面配置后使用所绑定版本，路径保持/jxc-purchase-recognition-v1。源码交付不等于已激活线上工作流。

Resolve real products后增加REVIEW工具调用：后台从固定FAISS命中选取每个候选的最佳命中配对，回查国家、图库代次和照片归属后读取真实图片；读文件在数据库事务之外，保存前再次校验证据。原图和候选图使用不同键，单图不超过10MiB、总原始图片不超过24MiB，超限或读取失败在候选原因中保留；不会创建公开图片URL。任务只存图片键及SHA，不存base64，模型请求不含任务凭证，n8n沿用不保存执行内容的设置。

页面选定的DeepSeek模型接收实际image_url内容，先判照片同款，再核对来源productSpec与候选spec内真实的尺码、颜色、型号等属性。candidateChecks逐候选返回图片与规格状态；缺图/不确定/规格缺失不能伪装成一致，模型失败保留原候选。原确认商品与单位入口保留，候选及模型结果不自动创建商品或采购单。

旧版本外部文件C:/project/docling-demo/n8n/jxc-purchase-recognition.json暂保留：当前在线工作流或其他运维脚本是否仍引用该文件不确定；保留到新版本完成授权发布且旧任务结束，核实无入口引用并归档旧发布包后再删除或同步。旧MatchRunV1文字解释仍可读；历史持久化结果是兼容对象，尚在运行的其他旧回调调用方不确定。全部工作流升级、旧任务结束且历史读取策略明确后才可收紧旧合同，不承诺删除日期。

## 系统外部服务配置

设置入口为 `/settings/external-services`；仅平台管理员维护，所有国家共用。后端配置接口为 `/api/v1/sys/external-services`，按 n8n、deepseek、docling 分区保存与检查。密钥留空保留，清除必须使用明确标志，接口只返回是否已配置。

应用运行环境需提供 `JXC_INTEGRATIONS_MASTER_KEY`（32字节随机值的Base64编码），它是独立的加密主密钥，不是DeepSeek Key，也不能与数据库密文一起托管。主密钥缺失或格式不正确时仍可读配置，但禁止保存；解密失败明确报错，不回退明文或其他连接。当前通用Compose不会自动传入任意宿主变量；实际发布可用仓库外的受控override为application显式注入该环境变量，不能只在.env里填写就认为已生效。本次源码交付不包含运行环境改动。

首次保存会把当时各服务的完整连接固化为一个配置版本，来源为启动配置的分区保留对应快照；不要期望随后修改启动参数覆盖已保存版本。新任务领取时绑定版本，正在执行和自动恢复的任务不混用；人工点击重试后重新绑定最新配置。历史密文版本保留供任务引用，不自动清除；主密钥轮换需要同步迁移历史密文，不能直接换一个新值。

`POST /internal/purchase-import/tasks/{id}/fields` 和 `/model` 均复用原任务租约、任务种类与请求人当前权限；不接收任意服务地址，且不返回密钥。模型入口按每次执行最多两次调用，拒绝远程图片地址与工具调用。工作流仍关闭执行内容持久化；采购字段与候选的原校验、回调及人工处理保持原入口。

n8n连接检查使用 `JxcConnectionProbeV1`，只确认入口认证和版本协议，不解析文件或请求模型；解析桥接使用相同格式的 `/internal/jxc/connection-test`。DeepSeek检查调用已保存API根地址下的 `/models`，确认配置模型在返回目录中；它不是图文效果或采购业务验收。

发布顺序应先等旧任务结束，再按授权发布应用与迁移、同步原Python桥接、绑定两个工作流的受控Java根地址与入口Header凭据、在页面保存正确配置，并按原流程激活和做连接/真实业务验证。外部运行目录及在线旧工作流本轮不自动修改；当前实际调用方和在线版本未核查，因此保留旧启动环境分支到全量切换且核实无调用后，才能清理。其他工作流是否仍使用n8n中的旧DeepSeek凭据不确定，不删除共享凭据。

协议核对依据：[DeepSeek模型目录](https://api-docs.deepseek.com/api/list-models/)、[n8n HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)。
