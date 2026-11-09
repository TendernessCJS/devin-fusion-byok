# Devin 3.12.28 适配审查报告（2026-11-09）

对象：本机 `/Applications/Devin.app` Desktop **3.12.28** × 本仓库 `a05e527`（插件 0.6.6）。
`devin-fusion-byok-0.6.6.vsix` 解包后 `extension/src` 与仓库 `src` **逐字节一致**——但只比较了交付包与仓库，本机已安装目录未被逐字比对，不声称两者完全一样。
证据目录：`/tmp/fusion-byok-evidence.817aJj/`（npm-test.log、native-contract-report.json、native-selected/、vsix-unpacked/、rea-evidence.json）。

## 发现（优先）

- **无已确认必须修复的实现缺陷**。native-contract 探针 `status: "ok"`、五产物 required 标记全部命中；全量测试 0 失败。
- **一个确认的验证缺口（中优先级）**：`test/goal-idle-regression.test.cjs:205-210` 硬编码旧 ACP 模块路径
  `/Applications/Devin.app/Contents/Resources/app/node_modules/@exa/windsurf-acp/index.cjs`——本机 3.12.28 中该旧模块路径不存在，等价逻辑可在 `dist/extension.js` 读到，文件不存在导致该用例被 **skip**（即初检全量里那 1 个 skipped）。
  **已于 2026-11-09 补齐**：新增 `test/helpers/installed-acp.cjs` 按唯一 export 锚点从真实 bundle 抽取该谓词及其依赖的两个函数源、用 `node:vm`（1000ms 超时）求值（不执行 bundle bootstrap）；app root 缺席才 skip，其余锚点缺失/重复/形状不支持一律 fail-loud。变异验证（真实 bundle 副本上删 `stopReason` 要求 / 删方法名判断各一份）两条用例都按预期失败，证明断言有牙。
  新 bundle 中静态核对的等价物：`N5(e,t){return"session/prompt"===e.method&&null!=t}` / `P5(e,t){return N5(e,t)&&"stopReason"in t}`（导出 `isTurnCompletingPromptResponse`→`P5`）。
  这不是 Goal 运行失败的证据，也不是实现 bug；初检仅记录，现已迁移测试入口（不涉及运行逻辑变更）。
- **文档过时点已纠正**：`native-contract-probe.md` 的 `PROBE_VERSION` 记述已由 7 更正为实际的 8（`cognition.ai/auth` 降级触发 7→8）。
- **未做真实端到端验收**：以下结论全部来自静态核对 + 自动测试，不是新 hook 的实机运行记录——新版原生 ACP bundle 仍调 `windsurfAuth.setAuthStatus({..., userStatusProtoBinaryBase64: ...})` 与 `windsurfLanguageServer.setPort(...)`，桌面仍从 `userStatusProtoBinaryBase64` 解码目录，属静态兼容证据。`assignment_jwt` 客户端是否新增运行时校验**本轮未测**，不宣称已验证。

## 审查对象与产物指纹

`node scripts/native-contract-report.cjs --json`（见证据目录）五产物 sha256。表中路径的 `…` 前缀均为 `/Applications/Devin.app/Contents/Resources/app`：

| 产物 | 路径 | 字节 | sha256 |
| --- | --- | --- | --- |
| cli | `…/extensions/windsurf/devin/bin/devin` | 192,197,504 | `37b74a53a0f27efd9dc3bd333dc3710fe2159568b07ec4873201a976b764a63e` |
| ls | `…/extensions/windsurf/bin/language_server_macos_arm` | 147,108,640 | `3d88be6863572d364384e1b2914300dc8a2fc1be3cc9d3092926319b8fd7e0e5` |
| desktop | `…/out/vs/workbench/workbench.desktop.main.js` | 23,708,308 | `25833ff3d4533e149fae0f32e9352e2b8bd302f5ba8352aa73f426a95925e374` |
| chat | `…/out/vs/workbench/windsurf-chat-client/index.js` | 28,818,965 | `014bb1a40ae726740f543fa3f52ddeccc7bebb2534851f587e69801fd404fe1f` |
| acp | `…/extensions/windsurf/dist/extension.js` | 6,539,407 | `33472e9482d2e5f54aa7f43dc249d3075148c1ef673f5eca02b30f6b3c575291` |

探针结果：`status: "ok"`、`missing: {}`；唯一 informational 缺失 `desktop: devin.refreshUserStatus`（3.12.17 起官方删除该命令，缺失是稳态不是漂移）。`PROBE_VERSION = 8`。

## 关键链路判据（本轮静态核对过的仓库路径）

- `src/runtime/bridge.cjs`：CATALOG 三命名空间（`language_server_pb`/`api_server_pb`/`seat_management_pb`）+ `GetCliTeamSettings` 白名单；未知目录形 RPC 记一次 `catalog-rpc-unknown`；流式 RPC 不设 body 空闲上限（316 次误杀实测后删除）；`countOwn` 改字节扫描。
- `src/catalog/codec.cjs` + `src/catalog/assignment.cjs`：请求 `AssignModelRequest` f2 `model_router_uid` / f6 `fusion_lead_router_uid`；响应 `ModelAssignment` 子消息 f2 `model_uid` / f3 `harness_uids`；Lead/Sidekick harness 选择规则。
- `src/runtime/host/auth-status.cjs`：`setAuthStatus` 只重写可验证的目录载荷，`augment` 不可验证时原样透传（Promise 身份不变），发布确认链已随 3.12.17 删除。
- `src/runtime/host/ls-injection.cjs` / `acp-hook.cjs` / `acp-observer.cjs`：注入与观测面。
- `src/runtime/backend.cjs` / `backend-control.cjs`：loopback 监听、Origin 一律 403、控制令牌 `timingSafeEqual`。
- `test/helpers/installed-renderer.cjs`：webapp mapper/picker/family 的真实函数抽取源（生产交集验证来自它，不是 playground 文件）。

## REA 覆盖与边界

- 原生 ACP `open_binary` digest `33472e94…c575291` 与探针报告一致。
- **插件交付包**（`vsix-unpacked/extension`，扫的是发行物非源码）：119 个 JS 全部解析、120 relevant files、**0 parse failures**；application partial、semantic unknown、30,221 semantic unknowns、6 sources examination limited、alias selection limit 512。parent evidence `ev_9d6db99f1e215d91e1a888b28df1757b6cd431634c80e0ba1394714c16017002`，root digest `d8ade187c61d527d7cfb324f57b3182587a6be935019c1f071908149ec66e115`。
- **native-selected 两文件**（modelCatalogSource-CDrEG7GB.js、model-picker-concept-CUUYutJ7.js）：2/2 解析、0 失败、928 unknowns；parent `ev_fa081d5630190c03818d528973663979bdff40dc422363b0535e7866c44f0948`、root `b45871e9dcd2bacecdbf02e88539fff080328ee90016002a09185be25480751f`。
- **`model-picker-concept-CUUYutJ7.js` 文件自身声明是 non-production mock/playground**——绝不能当当前生产 picker 的证据；生产 picker/维度验证来自 `test/helpers/installed-renderer.cjs` 抽取并测试的真实函数。
- `mapModelCatalog` 仍按 label→uid Map 解析 sort labels、重复 label 后写覆盖，因此 `build.cjs` 的 family 去重规则仍有必要。
- REA 提供的是静态候选关系：不证明无漏洞、不证明运行时行为；本轮未对大型原生 bundle 做语义图/反编译，历史 provider 面可用性结论未按当前版本复测。证据已导出 `rea-evidence.json`（164,681,105 B，4 records），REA session 已 `close_binary` 关闭。export 包装层 unknowns=0 不等于图无 unknowns。
- **临时证据目录可被清理**：`/tmp/fusion-byok-evidence.817aJj/` 随 `/tmp` 清理消失；永久结论以本报告中的版本、sha256 与可复跑命令（`node scripts/native-contract-report.cjs --json`、`npm test`）为准。

## 测试

- `npm test`（初次审查）：**1739 例 / 1738 pass / 0 fail / 1 skipped**。唯一 skipped 即上文 `goal-idle-regression` 的旧 ACP 路径缺口。
- `npm test`（补齐后最终结果）：**1748 例 / 1748 pass / 0 fail / 0 skipped**——新增 `installed-acp` 9 例；原回归用例由 skip 转为真实执行。
- native-field 契约、webapp mapper/picker/family 用例在本机 3.12.28 安装物上全部执行通过（非 skip）。

- 夹具 `test/fixtures/real-picker.json` 已按 3.12.28 实时观测重捕（审计对象为 `~/Library/Application Support/Devin/User/globalStorage/local.devin-fusion-byok/native-cache.json`，savedAt 2026-11-09T00:19:53.245Z）：uid 选择与 3.12.17 快照相同，22 条的 uid/label/order 未变，仅新增各维 `controlType`。

注意：以上均为静态兼容证据与有界自动测试；真实收费推理 E2E 仍未做，不宣称运行时完全兼容。

## 未执行的手工验收（留给用户）

新会话选择普通 BYOK 模型；Fusion Lead/Sidekick 两角色组合；工具续轮 / 取消 / 会话重开；MCP 新 UI 与独立 Fast Context 的区分显示。这些未在本轮验证，不宣称可用。
