---
trigger: model_decision
description: "改 CLI 缓存写入资格、代际判定、coverage 与 health 映射时必读——各代际格式与判定规则的实测契约。"
---
# CLI 缓存代际与 coverage（cli-cache-generations）

## 代际判定与 coverage（Devin 3.11.216 / CLI 3000.11.216 实测后新增；3.11.228 复核、3.12.17 再复核仍 `model_configs_v6`）

- `model_configs_v6.<16hex>.bin` 是当前 CLI 版本在写的格式；**可写性按内容判定，代际号只用于展示**——
  `model_configs*`（含无后缀=v1）一律是候选：信封+载荷校验通过即 supported（任意 `_vN` 可写，
  由 `rpcFor` 前缀派生 `GetCliModelConfigs`）；非 JSON → `legacy`（历史残留）；
  是 JSON 但校验失败 → `unsupported`（未来格式，请更新插件）。supported 中 `_vN`>6 → `coverage.dynamic`。
- 写入资格（任意代际、内容判定同上）：>64MiB 先 statSync 拒绝不读；JSON 信封必须
  `{version:1, identity_digest 非空字符串, fetched_at_secs 安全整数, payload 严格 base64}`；
  model_configs 须有合法 f1 wire2 条目、唯一非空 f22 UID；零字节是合法空表且不取得写资格。
  输出也须校验；仅 expected 为空且原 UID 全属我方时可退役为空表，已知字段类型须合法；
  仅 UID 中的自有前缀可判归属，label/其他字段含 marker 不算。user_status 校验裸/信封内真实目录，
  team_settings 从 f7 UID 允许列表判归属。JSON 解析失败须保留原始字节分类，不能把损坏 JSON 当 legacy。
  `read-failed`/`too-large` 只进 `skipped` 稳定 code、不计 supported/legacy；其余校验失败
  同时进 `skipped`（`unsupported-envelope`/`malformed-payload`）与 coverage 分类，字节不变。
- `coverage`：`{dirState, supported, legacy:[{name,generation}], unsupported:[...],
  generations:[{generation,name,fetchedAt,own}], current, dynamic}`，
  `current` = supported model_configs 中最大 generation（同代取 `fetched_at_secs` 最新），
  纯由目录内容决定；它不是 CLI 实际读取代际的观测，面板应称「检测到兼容缓存 vN」，不得宣称「当前使用」。
  目录缺失不得表现为「全部正常」。
- `expectedUids` 为空**仍执行一次检查**，让已识别的我方陈旧条目走保守 retirement；
  真实模型 UID/允许列表中的自有条目不在 expected 时也须触发退役；缓存/auth 使用显式 retireOwn，
  空 emit 不能早退而留下最后一个已删模型。保留原生与未知字段，二次检查不得 churn。
  无 known UID 依据时不得删 native 形态组合、不得伪造空目录清空。
  `loading`/`unavailable` 下 `retire:false`：`preserveUnemitted` 只增不删（emit 替换、其余保留）+ 硬闸禁删**输入全部 UID**
  （`retire-withheld`）；`expected` 接纳 `matrixUids` 但不授予文件所有权；retirement 只在权威态允许；权威首达补写。
- 面板语义：未知代际/格式异常 = 「未处理/请更新插件」，与 `no-improvement` 的「无需重写」分开；
  health 映射：coverage 缺失或 dirState≠ok → unknown，unsupported 或写失败 → bad，legacy 不影响。
