# W4 · 真机验证结果

> 执行人：施工方（W4 落地）。验证时间 2026-10-29 11:48–11:56（GMT+8）。
> Key 来源：仓库根 `.env.local`（`ZHIPU_API_KEY`），**本文不记录 key 的任何片段**。
> 脚本：`node scripts/verify-ai.mjs` / `--quick`。

---

## 1. 结论

| 项 | 结果 |
|---|---|
| 模型 | `glm-5.3-flash`（`settings['ai.provider'].model` 默认值） |
| 纯文本建任务 | ✅ JSON 可解析，`intent=create_task`，`type=deadline` |
| 带图 | ✅ 8×8 纯红 PNG → 回答「红色」，**真吃图** |
| `usage` | ✅ `prompt_tokens` / `completion_tokens` / `completion_tokens_details.reasoning_tokens` 齐备 |
| **`due_hint`（03 §9.5 的 P0）** | ✅ **注入当前时间后不再恒 null**，三句话全部按预期填出或留空 |
| `finish_reason` | 三次全为 `stop`，无 `length` 截断 |

---

## 2. `scripts/verify-ai.mjs --quick`（03 §1 的复核命令）

```
[1/1] 纯文本建任务：明天下午三点前把季度报告初稿写完
  模型: glm-5.3-flash
  finish_reason: stop
  耗时: 5.6s
  usage: prompt_tokens=2772 completion_tokens=332 total_tokens=3104 reasoning_tokens=184
  JSON 可解析: 是（content 409 字符）
  intent: create_task  type: deadline
  title: 写季度报告初稿
  due_hint: "2026-10-30T15:00:00+08:00"
  difficulty: medium  requires_evidence: true

结果: 1/1 项通过
```

---

## 3. `scripts/verify-ai.mjs`（三项全量）

```
[1/3] 纯文本建任务：明天下午三点前把季度报告初稿写完
  finish_reason: stop
  耗时: 6.1s
  usage: prompt_tokens=2772 completion_tokens=278 total_tokens=3050 reasoning_tokens=128
  JSON 可解析: 是（content 411 字符）
  intent: create_task  type: deadline
  due_hint: "2026-10-30T15:00:00+08:00"

[2/3] 带图（8×8 纯红 PNG）：这张图片主要是什么颜色？
  finish_reason: stop
  耗时: 3.0s
  usage: prompt_tokens=57 completion_tokens=50 total_tokens=107 reasoning_tokens=43
  回答: 红色
  是否吃图: 是

[3/3] usage 字段完整性
  usage 字段: completion_tokens, completion_tokens_details, prompt_tokens, prompt_tokens_details, total_tokens
  reasoning_tokens: 128

结果: 3/3 项通过
```

---

## 4. 端到端三句话（真 Key + 真 prompt + 真 `GlmClient` + 真 `aiService` + 内存库）

这一步不走脚本、走主进程真实链路：`aiService.send()` → 后台 `runTurn()` → `message.patch` /
`message.appended` → 从库里读回 assistant 消息与 `task_draft` 草稿。

| # | 用户输入 | 耗时 | 落库结果 |
|---|---|---|---|
| 1 | 明天下午三点前把季度报告初稿写完 | 10.3s | `deadline` / `写季度报告初稿` / `dueHint=2026-10-30T07:00:00.000Z`（= 本地 15:00）/ `medium` / `pointsPlanned=20` / `reminderOffsets=[-1440,-60]` / `requiresEvidence=true` / `confidence=0.9` |
| 2 | 每天早上背单词 | 29.3s | `daily` / `背单词` / `dueHint=null` / `dailyTimeHint=null` / `pointsPlanned=1` / `reminderOffsets=[]` / `requiresEvidence=false` |
| 3 | 今天天气不错 | 4.2s | **不出草稿卡**，只有一句回复 |

**第 2 句是关键**：模型没有替用户编一个"早上 7 点"，`daily_time_hint` 填 `null`，
并在 `missing_info` 里问「早上几点提醒？」——这正是 03 §4.1 要求的行为。

---

## 5. 三句话的原始 `content`（不裁剪，不含推理字段）

### 5.1 明天下午三点前把季度报告初稿写完（5.8s，finish=stop，prompt 2772 / completion 372 / reasoning 223）

```json
{"intent":"create_task","reply":"还是这条：季度报告初稿，截止明天下午三点。写完发我做凭证。","tasks":[{"type":"deadline","title":"写季度报告初稿","detail_md":"把本季度数据整理进模板，输出初稿文件，供后续评审。","requires_evidence":true,"difficulty":"medium","estimate_min":90,"due_hint":"2026-10-30T15:00:00+08:00","daily_time_hint":null,"tags":["工作"],"steps":[{"title":"整理本季度数据","estimate_min":30},{"title":"套模板写初稿","estimate_min":60}],"missing_info":[],"confidence":0.9}]}
```

### 5.2 每天早上背单词（13.9s，finish=stop，prompt 2765 / completion 762 / reasoning 663）

```json
{"intent":"create_task","reply":"记成每天背单词了。早上想几点提醒你？","tasks":[{"type":"daily","title":"背单词","detail_md":"每天早上背一批单词，坚持打卡。","requires_evidence":false,"difficulty":"easy","estimate_min":20,"due_hint":null,"daily_time_hint":null,"tags":["学习"],"steps":[],"missing_info":["早上几点提醒？"],"confidence":0.88}]}
```

### 5.3 今天天气不错（2.6s，finish=stop，prompt 2764 / completion 110 / reasoning 85）

```json
{"intent":"chat","reply":"又说了一遍，看来是真不错，出去晒晒吧。","tasks":[]}
```

---

## 6. 单次 token 与耗时汇总

| 场景 | 耗时 | prompt | completion | 其中推理 | 备注 |
|---|---|---|---|---|---|
| 纯文本（复核 ×3） | 5.6 / 6.1 / 5.8s | 2772 / 2772 / 2772 | 332 / 278 / 372 | 184 / 128 / 223 | 首次请求无缓存 |
| 纯文本（第 2 句） | 13.9s | 2765 | 762 | 663 | `prompt_tokens_details.cached_tokens=2752`（prompt 缓存命中） |
| 纯文本（第 3 句） | 2.6s | 2764 | 110 | 85 | 同样命中缓存 |
| 带 1 张图 | 3.0s | 57 | 50 | 43 | 图只有 75 字节，几乎不计费 |

**成本口径变了**：`03 §8` 记的"prompt 39"是不带 system/fewshot 的最小请求；
现在每轮真实请求的输入是 **~2.7k token**（人格 + 约束 + 四条 fewshot + 当前时间）。
命中 prompt 缓存后仍按 2764 计 prompt_tokens，但 `cached_tokens` 会告诉你实际折扣。

---

## 7. 与 `03 §9` 的不一致（逐条）

| # | 03 §9 的说法 | 实测 | 判断 |
|---|---|---|---|
| 1 | 带图延迟 **8.1s**（§9.3） | **3.0s** | 更快。图的体积差异（75 字节 vs 之前那张）+ 网络状态都可能造成，**不构成矛盾**，但 UI 上"正在看图"的提示不能按 8s 设计超时 |
| 2 | 纯文本 **5.5–29.9s**（§9.4） | 5.6 / 5.8 / 6.1 / 13.9 / 29.3s | 落在原区间内，一致 |
| 3 | `due_hint` **恒为 null**（§9.5） | **注入当前时间后全部有值**（第 1 句 `2026-10-30T15:00:00+08:00`） | **不是矛盾，是修复**：§9.5 的结论是"根因是 prompt 里没有当前时间"，本版按 §9.6 注入后确实好了。这一条建议在 §9.5 补一句"注入后已修复" |
| 4 | `usage` 记"prompt 39 + completion 172–1337"（§8） | prompt 固定 **~2.77k**，completion 110–762 | **口径过时**：39 是不含 prompt 模板的裸请求。建议 §8 的 token 列更新为"输入 ~2.8k（含 fewshot），输出 100–800" |
| 5 | §9.2 说 `response_format` 生效且"仍要保留剥围栏" | 全部返回裸 JSON，无围栏 | 一致（兜底保留，测试覆盖四种围栏形态） |
| 6 | §9.4 说 `glm-4-flash` 非推理 | 未复测（本轮不许换模型） | 无结论，不影响交付 |

`finish_reason` 三次全部 `stop`，`max_tokens: 2048` 足够（最长一次 762 completion）。

---

## 8. key 自检

用 key 的前 6 个字符做全仓库检索（排除 `.env.local` 自身、`node_modules`、`.git`、`.workbuddy`）：

```
$ grep -rlF "<key 前 6 位>" . --exclude-dir=node_modules --exclude-dir=.git --exclude=.env.local --exclude-dir=.workbuddy
（无输出，命中文件数 0）
```

`docs/`、`tests/`、`out/`、`scripts/` 全部 0 命中——key 的片段没有落进任何被 git 跟踪的文件。
