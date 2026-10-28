---
description: REA 原生面与 JS 语义图的能力边界与预算实测——本机哪些 REA 工具不可用及原因、语义图为何拿不到、partial evidence 的同会话失效纪律、产物指纹交叉验证；用 REA 取证或怀疑证据可复用性时必读
trigger: model_decision
---

# REA 取证：能力边界与语义图预算

本卷是从 `acp-protocol-fields-forensics.md` 拆出的 **REA 侧证据**：字段号读法留在原卷，这里只记本机 REA 能做什么、不能做什么，以及为什么。

## REA 的原生面与语义图预算（2026-10-28 复测，REA 6.8.0）

- **原生面整体不可用**，错误码是 `provider_unavailable`（旧的 `capability_unavailable` 记录已过期）：候选
  `ghidra/hopper/ida/kuna` 全被拒，Ghidra 一项的 `java_probe_failure` 显示**本机没有 Java 运行时**（`java` 退出 1）
  ⇒ 只装 Ghidra 不够，还要 JDK。`binary_overview`（仅读 Mach-O 元数据）走同一 provider 选择器，**同样不可用**——元数据不是绕道。
- **`search_strings` 不是 JS 检索工具**：它只按原生 provider 选路，对本仓 JS bundle 一样返回 `provider_unavailable`。
  查 bundle 字面量只能用 `grep -abo` 取偏移 + `dd` 读窗口。
- **`find_xrefs_to_name` 仍是 `target_unavailable`**：JS 分析产出是证据快照，不是活符号库。
- **另两处能力缺口**：`recover_javascript_sources` 需要 `REA_WAKARU_COMMAND` 指向
  **Wakaru ^1.13.0 Linux x64**，macOS 无解；`analyze_web_bundle` 需要活浏览器 `cdp_endpoint` + `target_id`，
  **对磁盘产物不适用**。

#### 语义图预算实测表（8 组，结论一致：拿不到可用图）

| 输入 / 预算 | 结果 |
| --- | --- |
| 单文件路径 | 拒绝 `unsupported_target`（只收目录或 `.asar`） |
| `/Applications/Devin.app` | 预算耗尽，停在 `node_modules/react-dom/...development.js`，未触及 sessions |
| `out/vs/sessions`(40 MB) | 解析期堆耗尽：heap `1098907648 B`、`visited_ast_nodes 4479`、`skipped_javascript_files 1`、`partial`、`retryable:false` |
| `sessions` + `max_heap_mb:4096` + `detail:summary` | 仍堆耗尽：`heap_limit_bytes 4320133120`、`parsed_javascript_files 0` |
| `dist/extension.js`，6.7.0 默认（1024 MB / 300 s） | `interrupted` + `resource_constraint`，stderr 是真 V8 `Ineffective mark-compacts near heap limit` |
| 同上，6.8.0 `max_heap_mb:4096` / `300000` | `provider_timeout`（堆没爆，撞的是时间） |
| 同上，6.8.0 `max_heap_mb:8192` / `900000` | 仍 `provider_timeout`：**0 节点、0 unknowns、峰值 RSS 3.5 GB**（离 8 GiB 上限很远） |
| 同上，4 GiB + 语义配额（nodes 20000 / unknowns 5000）+ `detail:summary` | 仍 `provider_timeout`，`parent_evidence_id` 为 `null`——**语义配额不参与解析期的早停** |

判读：

- **瓶颈是时间不是内存**：8192 MB 只用到 3.5 GB。别再把「加大内存」当解法；`javascript.analysis_timeout_ms` 上限
  2147483647，但 15 分钟不够，是否 30 分钟够**未测**（要试就按次传，且预算 ≥30 分钟）。
- **旧的「1 GiB 硬顶、无运行时覆盖」是错的**：该说法出处是上游 `docs/javascript-recovery.md`，与已装 skill v49 正文相反。
  6.8.0 起 `analyze_javascript_application` 可用 `max_heap_mb` / `analysis_timeout_ms` **按次覆盖**，也可用
  `update_analysis_settings` 改运行期默认；实证是 worker argv 真带 `--max-old-space-size=8192`。这两项**不影响** MCP 进程堆与客户端工具超时。
- 上一轮记的「partial(truncated) / 1,085 模块 / unknowns 79,318·142,708·18,203」**不可复现**，降级为历史一次性观测：
  不得当基线，更不得当「不存在某调用」的证明。只指向 `dist` 目录时只出 9 节点 partial 图（无 app 结构），同样不可用。
- 根 digest 两次一致（`4d07c15a…f9f2c`）；`source_paths` 只选 1 个文件时目录摘要 `examined 2 / total 7`。

⇒ 证据只能停在**字节级静态观察**（`grep -abo` 取偏移 + `dd` 读窗口）。

**取证纪律**：超时/中断会留 `error.details.partial_observation`（`kind:"retained-evidence"` + `evidence_id`），但它只在
**同一 MCP 会话内**有效——进程一退就取不到（2026-10-28 三次超时的 id 全部作废）。要留住部分证据必须**在同一次会话里**
紧接着 `inspect_analysis_view`，或立刻 `export_evidence_bundle`；会话重启后按旧 id 取会得
`evidence_integrity_mismatch`（`reason: missing`）。

**交叉验证一条**：REA `open_binary` 的 `sha256` 与本仓探针 `native-contract.json` 的 `signature` 逐段对应
（顺序 `cli:ls:desktop:chat:acp`；2026-10-28 复核 ls=第 2 段 `9d9fad2b…`、acp=第 5 段 `fa7fbaba…`），
可复用确认「两边看的是同一份产物」。
