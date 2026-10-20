# M4 证据重算

这些脚本读取已完成的命令结果，不运行测试，不改业务数据库。默认仓库路径从脚本位置确定；可用 `--root` 指定其他副本。

```sh
python3 docs/backend/evidence/scripts/m4-verification.py --run-results /tmp/hengshuo-m4-run-results.json --browser docs/backend/evidence/browser-m4.json
python3 docs/backend/evidence/scripts/m4-stats.py
```

完整重算须保留对应的 M4 开工快照。默认读取 `/tmp/hengshuo-m4-baseline-path` 指向的目录，也可使用 `--baseline /path/to/m4-before`。开工与最终目录比较范围是 `docs`、`jxc-server`、`jxc-web`，不依赖 Git HEAD；最终 manifest 的 hash 不能还原已经丢失的开工源文件。

`--run-results` JSON 必须包含 `backend`、`frontend`、`build`、`contracts`，每项记录实际的 `command`、`exitCode`、带时区的 ISO `startedAt`、`finishedAt`。`runtime` 可另附本次实际 Java/Maven 版本。默认四份日志路径为：

- `/tmp/hengshuo-m4-final-pg.log`
- `/tmp/hengshuo-m4-final-web-tests.log`
- `/tmp/hengshuo-m4-final-web-build.log`
- `/tmp/hengshuo-m4-final-contract-check.log`

路径不同可使用 `--backend-log`、`--web-log`、`--build-log`、`--contract-log`。后端只接受完整 `clean verify -Ppg-it`，拒绝指定测试或跳过测试命令；XML 必须在本次命令启动后生成，并与所有当前可执行测试类对应，保留 M3 原回归类。测试执行数来自 XML 和 Node 日志，独立方法/参数展开另列，不预填预计数量。

验证期间及之后若再修改业务源码、测试或构建配置，脚本拒绝沿用旧运行结果；需在最终修改完成后重跑对应命令。这样第一轮完整通过不会被误用为浏览器修复之后的版本证据。文档、截图和证据脚本自身的整理不要求重复业务测试。

浏览器清单至少包含：`status: "passed"`、`mockDisabled: true`、`countries` 中的 CN/MX；每国分别记录 `apiPreparation` 与 `browserChecks`。后者每项有实际 `name`、`status: "passed"`、`channel: "browser"`、具体 `evidence`。缺少 `--browser` 时输出保持 `pending_browser`；未完成清单不能生成通过结论。

统计分类中，截图/CSV 目录 `docs/backend/evidence/browser-m4/` 与 `browser-m4.json`、`runtime-m4.json` 归 `acceptance_artifacts`；此脚本目录归 `configuration_build_scripts`。逐文件 hash 比较、`git diff --no-index --numstat` 计行，二进制保留文件计数。`verification-m4.json` 和 `change-statistics-m4.json` 自身排除以避免循环，文件变化另外报告。最终文档编辑后重跑统计。

默认输出在 `docs/backend/evidence/`；试运行使用 `--output /tmp/preview.json`，避免覆盖最终证据。原 `/tmp/hengshuo-m4-stats.py` 与 `/tmp/hengshuo-m4-verification.py` 为兼容入口，需从仓库运行或传 `--root`。

## 一期收口证据模式

`--phase release` 继续使用原重算逻辑，比较一期开始前的 M5 基线。统计另纳入根目录 Git/Docker 忽略规则和 `deploy/production`，将业务代码、测试、运维脚本、契约生成物、截图与验收记录分别统计。基线指针为 `/tmp/hengshuo-release-baseline-path`；没有原快照时必须显式提供保存的目录，Git 初始基线提交不算本轮新增。

本机 Documents 目录的部分历史 `target/classes N` 缓存发生 FileProvider 目录读取阻塞。未删除、移动或修改这些旧缓存；Maven 改在外部新临时目录的已校验源码副本执行。副本根据 `git ls-files --cached --others --exclude-standard -z` 清单逐文件复制、拒绝符号链接，并记录 SHA-256 清单。正式重算传入 `--execution-root`，逐一核对当前工作区与副本的全部 Maven 源码、迁移、测试及构建配置，缺失、多出或字节变化均失败。XML 和 jar 必须来自该完整运行；不通过复制旧报告或跳过测试替代。

外部副本必须同时带上原 `jxc-web/tests/contracts/http-scenarios.json`，后端原契约测试会向上查找它。漏复制时测试明确失败，不修改测试使其忽略缺文件。下面从仓库根目录创建全新副本，保留原文件时间与权限，并逐字核对；输出目录用于完整 Maven 运行与 `--execution-root`，不能用于覆盖现有 checkout：

```sh
python3 - <<'PYEXPORT'
from pathlib import Path
import hashlib, json, shutil, subprocess, tempfile
root = Path.cwd()
raw = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'jxc-server'])
files = sorted({name.decode() for name in raw.split(b'\0') if name} | {'jxc-web/tests/contracts/http-scenarios.json'})
target = Path(tempfile.mkdtemp(prefix='hengshuo-release-clean-'))
target.chmod(0o700)
manifest = {}
for name in files:
    source, copy = root / name, target / name
    if source.is_symlink() or not source.is_file():
        raise ValueError('Only regular source files are accepted: ' + name)
    copy.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, copy)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    if hashlib.sha256(copy.read_bytes()).hexdigest() != before:
        raise ValueError('Source changed during export: ' + name)
    manifest[name] = before
(target / 'source-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
print(target)
PYEXPORT
```


```sh
python3 docs/backend/evidence/scripts/m4-verification.py --phase release \
  --execution-root /absolute/verified-clean-export \
  --run-results /tmp/hengshuo-release-run-results.json \
  --backend-log /tmp/hengshuo-release-final-pg.log \
  --web-log /tmp/hengshuo-release-final-web.log \
  --build-log /tmp/hengshuo-release-final-build.log \
  --contract-log /tmp/hengshuo-release-final-contracts.log \
  --browser /absolute/completed-real-browser-run.json \
  --operations /absolute/completed-release-operations.json
python3 docs/backend/evidence/scripts/m4-stats.py --phase release
```

缺少或未通过的浏览器、运维清单继续保持未完成，不能用候选包的旧演练补齐。release 模式要求同 jar 的逻辑恢复、worker 中断恢复和容器运行证据，以及实际结构审计和 WAL/PITR；同时校验迁移、合同、工具与日志的 hash。浏览器要求原 A01–A38 和第二国家 12 个核心场景的准确 50 个国家/用例组合、独立国家 ID、Mock 禁用证据、实际文件 hash 及同制品信息。API/SQL 初始化只记准备层。

`release-ui-actions.py` 只建立及记录动作清单，不调用业务 API、SQL 或浏览器；`record` 不能替代原页面操作。`release-ui-runtime.py` 只新建有独立名称和标签的合成环境，首次基础初始化与首个仓店明确列为准备；后续迁移和进程切换必须保留该库已有事实。任何本地验证报告均保留 `productionDeployment=false`，生产参数、真实期初和生产放行另行验收。

`record --result passed` 必须同时提供真实 PNG/JPEG 页面截图、完整的本环境页面 URL、操作者、业务/凭证引用及阶段数量金额；不适用项填写明确的 `N/A` 和原因。API 准备 JSON、SQL 日志及其他文件可以附加，不能单独使页面用例通过。工具记录执行时的 runtime jar SHA、国家 ID 和 Vite 前端源码及 `.env*` 配置指纹；最终重算再次核验这些绑定及截图 hash。有历史记录后不能把国家 ID、本币或时区重新绑定给另一国家，旧记录不补造当时身份。修改顶层 jar 字段不能把旧包记录升级为新包验收。修复后保留旧执行记录，并在新包实际重新进入原页面、检查有关结果和必要动作后追加重验记录；这不是自动浏览器重放或对截图内容的自动识别。

证据入口自身的独立回归：

```sh
python3 -m unittest discover -s docs/backend/evidence/scripts/tests -p test_release_ui_actions.py -v
```

`mockDisabled/mockEvidence` 仍是操作者现场检查后的声明，须结合实际 Mock 禁用截图、网络来源和运行配置材料阅读；工具只检验声明非空，不自动分析截图、识别页面当前国家或重放业务动作。不能把这项人工边界宣称为自动化端到端验证。

## 公开源码副本的验收准备

公开仓库保留本目录的可复用脚本、独立测试和必要的纯结构审计合同，不发布历史截图、下载物、执行回执、主机状态或真实业务数据。历史运行记录保留在原本地工作区；新的运行生成物放在被 Git 忽略的 `docs/backend/evidence/` 下或仓库外。

首次从公开仓库准备页面验收时，使用 [未执行用例模板](../../acceptance-template.json)，在仓库根目录复制到原脚本读取的位置。模板只有 A01–A38 的规则、页面和操作步骤，所有状态为 `NOT_RUN`，不证明任何用例已执行。目标已有文件时 `cp -n` 保留原记录，先核对已有记录的来源及版本，不覆盖历史结果。

```sh
cp -n docs/backend/acceptance-template.json docs/backend/evidence/closure-acceptance.json
python3 docs/backend/evidence/scripts/release-ui-actions.py init --runtime /absolute/private/isolated-runtime.json --directory /absolute/private/new-browser-run
```

`--runtime` 必须来自本次隔离环境及已核对的应用制品，不能填写生产账号或复用另一环境的身份。复制模板和 `init` 只准备动作清单，不创建业务单据，也不会将状态改成通过；后续仍按原脚本要求执行真实页面操作、记录证据和绑定制品。运行时凭据、会话、私有配置、截图、导出文件及执行结果均不提交 Git。
