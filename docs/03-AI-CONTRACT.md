# 03 · AI 能力契约

> 供应商：智谱 GLM（默认 `glm-5.3-flash`，原生多模态）
> 落点：`src/main/ai/`
> 铁律：**模型只做理解与分类，不做数值裁决，不直接写库。**

---

## 1. 为什么把 AI 关在这么小的笼子里

你的要求是"AI 识别内容、补充细节、给适当积分、最后形成任务"。这三件事的可信度完全不同：

| 能力 | 模型擅长吗 | 我们的处理 |
|---|---|---|
| 读一段话/一张图，看出里面有几件事 | 擅长，出错也只是语义偏差 | 完全交给模型 |
| 补全细节（拆步骤、预估时长） | 擅长，但会编造 | 交给模型，**必须**输出 `missing_info` 暴露不确定 |
| 给一个分数 | 不擅长且不可复现：同样输入两次可能给 15 和 30 | **模型只给难度档位，分数由公式算** |
| 判定"做完了没有" | 中等，容易被说服 | 模型给结论 + 理由，用户有最终否决权 |

这就是 R3 "适当的积分奖励"能不飘的唯一办法：把数字从概率模型里拿出来，放进确定函数里。

---

## 2. 调用拓扑

```
用户消息（文本 + 可选图片）
        │
        ▼
┌───────────────────┐
│  Router（一次调用）│  intent 分类 + 抽取，合并为一次请求以省延迟
└─────────┬─────────┘
          │ intent
   ┌──────┼──────────┬───────────┐
   ▼      ▼          ▼           ▼
create_task review_task  query     chat
   │      │          │           │
   ▼      ▼          ▼           ▼
 TaskDraft[] Verdict  只读查询   纯文本回复
   │
   ▼
rubric.computePlannedPoints()  ← 代码算分
   │
   ▼
messages(kind='task_draft')  ← 等用户确认
```

意图判定放在同一次调用里（输出 JSON 的 `intent` 字段），不做独立分类模型：省一次往返、省一次钱，且 GLM 对"先分类再答"的合并式 prompt 响应稳定。代价是 prompt 变长，可接受。

---

## 3. 客户端封装与模型接入方式

### 3.0 两种接入方式的区别（**本版走 `zhipu` 直连，harness 保留为可选实现**）

**用户决定（2026-10-28）**：harness 保留想法，暂不实施。所以 W4 只做 `zhipu` 一个实现，但**接口按双实现设计**，以后接 harness 不用改上层。

主程序只认一个接口 `AiProvider`，底下按 `settings['ai.provider'].name` 选实现。**本版只有 `zhipu` 一个实现**，`harness` 留签名不留代码：

| provider | 走法 | key 存哪 | prompt 存哪 | 状态 |
|---|---|---|---|---|
| `zhipu` | 主进程直连智谱 | 本机 `safeStorage` | 主程序 `ai/prompts/` | **本版唯一实现** |
| `harness` | 主进程 → 你的 harness → DeepSeek | harness 的环境变量 | **仍必须在主程序**（见下） | 契约保留，暂不实现（06 文档） |

```ts
export interface AiProvider {
  chatJson<T>(opts: {
    messages: ChatMessage[];
    schema: ZodSchema<T>;
    temperature?: number;
    maxRetries?: number;
    signal?: AbortSignal;
  }): Promise<{ data: T; usage: { in: number; out: number }; latencyMs: number }>;
}
```

**将来接 harness 时的唯一硬约束：即使把模型调用交给 harness，也别把 prompt 交给它。**

harness 有两种工作模式：

| 模式 | 主程序发什么 | harness 干什么 | prompt 归属 |
|---|---|---|---|
| **`proxy`（唯一允许的模式）** | 完整 `messages[]`（system 已拼好） | 转发给模型、返回原文 | 主程序 |
| `agent`（**本产品不采用**） | 只发原始输入 + 意图 | 自己拼 prompt、自己算 | harness |

理由很实在：prompt 是这个产品最需要反复调的东西。放在主程序里，改一行重启就能试；放在 harness 里，每次调 prompt 都要重新部署，而且一旦主程序升级了 prompt 而 harness 没同步，就会出现"同一个任务在两个版本下表现不同"的鬼问题，排查成本极高。

### 3.1 客户端接口

```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } };  // base64 data URL 或 https
      >;
}
```

`GlmClient` 实现上面的 `AiProvider`。`HarnessClient` 是**预留实现，本版不写**。`aiService` 只依赖 `AiProvider`，不 import 具体实现。

**v0.37 给 `AiProvider` 加第二个方法——`chatText`**（闲聊是纯文本，不套 JSON，见 §4.3）：

```ts
export interface ChatTextOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatTextResult {
  text: string;          // 已 trim，空字符串视为失败
  usage: ChatUsage;
  latencyMs: number;
}

export interface AiProvider {
  chatJson<T>(opts: ChatJsonOptions<T>): Promise<ChatJsonResult<T>>;
  chatText(opts: ChatTextOptions): Promise<ChatTextResult>;   // v0.37
}
```

`chatText` **不做 zod 校验**（本来就没有结构可校），只做三件事：剥掉模型偶尔自带的 markdown 围栏、`trim`、空字符串报 `AI_PARSE_FAILED`。`chatJson` 的行为约定一条不改。

**两个方法用两个不同的模型**：`chatText` 用 `settings['ai.chat.model']`（默认 `glm-4.7-flashx`，纯文本、非推理、便宜），`chatJson` 用 `settings['ai.provider'].model`（`glm-5.3-flash`，要推理、要识图）。`GlmClient` 构造时要能接收两个模型名，或提供 `withModel(model)` 派生实例——**不许在调用点直接 new 一个 client 塞模型名**，那是把配置读取散到各处。

行为约定（实现必须满足）：

1. `response_format: { type: 'json_object' }`；上游不支持时退化为在 system prompt 里强制"只输出 JSON，不要 markdown 围栏"，并在解析前剥围栏。
2. 解析流程：`JSON.parse` → `schema.safeParse` → 失败则把校验错误拼进第二次请求让模型自修（**只重试 1 次**）。
3. 最终失败：返回 `AI_PARSE_FAILED`，由 `aiService` 落一条 `kind='error'` 消息，`retryable: true`。**不准静默失败，不准抛到渲染层崩界面。**
4. 超时 **60s**（v0.22 从 45s 上调，实测 `glm-5.3-flash` 单次最慢 29.9s，45s 余量不够），`AbortController` 可控（用户关窗口要能中断）。
5. 每次调用把 `tokens_in/out/latency_ms` 写回 `messages`，方便后期看成本。**`tokens_out` 必须包含推理 token**：上游把 `reasoning_tokens` 算在 `completion_tokens` 里，只记 `content` 的估算值会少算一半以上（实测一次 172 tokens 里有 151 是推理）。
6. API Key 从安全存储读，**绝不进日志、不进 DB 明文、不进 git**。
7. **任何 provider 返回的内容都要过 zod 校验。** 将来接 harness 时同样不能免检——它不是可信边界。

---

## 4. 四个能力契约

### 4.1 `parse` — 识别 + 补全 + 分类（R1/R2）

输入：`{ text: string; images: base64[]; recentContext: Message[] }`（最近 6 条做上下文，让"这个""刚才那个"能解析）

输出 schema：

```json
{
  "intent": "create_task | review_task | query | chat",
  "reply": "对用户说的一句话，≤60字，口语",
  "tasks": [
    {
      "type": "daily | deadline | event",
      "title": "动词开头的短标题，≤24字",
      "detail_md": "补全后可直接执行的任务描述，可含简短列表",
      "requires_evidence": true,
      "difficulty": "trivial | easy | medium | hard | epic",
      "estimate_min": 30,
      "due_hint": "2026-10-30T10:00:00.000Z 或 null",
      "daily_time_hint": "21:00 或 null",
      "tags": ["工作"],
      "steps": [{ "title": "步骤", "estimate_min": 10 }],
      "missing_info": ["需要用户补充的信息"],
      "confidence": 0.86
    }
  ]
}
```

Prompt 硬约束（写进 system prompt，实现方照抄）：

- 一次最多抽 **3** 个任务；多于 3 个时合并或只取最主要的 3 个，并在 `reply` 里说明。
- **绝不臆造日期**。用户没说、图里也没有时间线索，`due_hint` 必须为 `null`。
- 信息不足时，宁可 `missing_info` 列出问题、`confidence` 给低分，也不要把细节编满。
- **任务分类判定（这条决定提醒时刻，判错=提醒全错）：**

| type | 判定信号 | 反例（不要归到这里） |
|---|---|---|
| `daily` | 含"每天/每日/坚持/养成/打卡"，或周期性重复的自我训练 | 一次性的事 |
| `deadline` | 有明确交付物 + 一个截止时间："X 号前交""周五之前写完""作业/报告/论文/报名/缴费" | 只是"要做"，没有截止时间 → 仍归 deadline 但 `due_hint: null` |
| `event` | 在**某个时刻发生**、需要提前准备、你本人要到位："考试/面试/答辩/会议/体检/竞赛" | 需要你产出东西的事 → deadline |

判断不清时默认 `deadline`：它只在前一天和前一小时催你，即使判错，打扰也最小；`event` 会提前 7 天开始提醒，判错的代价更大。

- `due_hint` 的语义随 type 变：`deadline` = 截止时刻，`event` = 发生时刻，`daily` = null（用 `daily_time_hint`）。
- `daily_time_hint`：仅 `daily` 有值，是每日提醒时刻。用户没说就填 `null`，由客户端取默认值，**不要自己编一个时间**。
- **`requires_evidence`（S4 已定）**：判断"这件事有没有可验证的产出"。

| 判定 | 例子 |
|---|---|
| `true` | 写文档、交报告、做作业、发邮件给对方、完成代码提交、考试成绩出来 |
| `false` | 跑步、背单词、喝水、冥想、打电话问候、看一集课程 |

判不准时填 `true`。宁可多要一句"做完了"，也不要让积分变成空口领奖。`daily` 类型默认 `false`（每天要传一次截图太折磨，习惯靠连续天数约束），除非该习惯本身有产出（如"每天写 500 字"）。

- `difficulty` 判定标准：
  - `trivial`：≤10 分钟、单步、无依赖（回一条消息、买个东西）
  - `easy`：10-30 分钟、步骤清楚
  - `medium`：0.5-2 小时，或需要 2-3 个步骤
  - `hard`：半天以上，或跨人协作、有明显阻碍
  - `epic`：多天、有明显不确定性
- **`difficulty` 还受 type 限制（2026-10-28 定稿，见 02 §5.2b）**，模型给出的档位必须落在下表内，越界视为无效输出：

| type | 允许的 difficulty |
|---|---|
| `daily` | `trivial` / `easy` / `medium` |
| `deadline` | `easy` / `medium` / `hard` |
| `event` | `medium` / `hard` / `epic` |

  校验用 `ALLOWED_DIFFICULTIES`（`src/shared/taskRules.ts`）。zod 里直接 `refine`，**不要静默改成合法值**——越界说明模型判错了类型或判错了难度，静默修正会让错误藏起来。返回 `AI_SCHEMA` 错误并重试一次。
  
  另外：`estimate_min` 只用于提示与判定难度，**不再参与积分计算**（02 §5.2，v0.7 起）。所以不要把"估时长"当作抬分的理由。
- 图片中没有任务信息（纯风景、无字截图）→ `intent='chat'`，`tasks=[]`，正常对话回复。
- 图中出现的是**已完成事项**（如打卡记录、完成的清单截图）→ `intent='review_task'`，不要重复建任务。
- 用户说"做完了 / 交了 / 搞定了" → `intent='review_task'`。
- `reply` 是给用户看的，不要复述 JSON，不要列字段名。

映射到 `TaskDraft` 时，主进程补齐：`localId = nanoid(8)`、`pointsPlanned = computePlannedPoints(difficulty)`（v0.7 起只看难度；`daily` 取 `cfg.dailyBase`）、`reminderOffsets` 按 type 取 §4.1 默认值。

### 4.2 `review` — 完成审核（R5 + S4）

输入：

```ts
{
  task: {
    title: string;
    detailMd: string;
    type: TaskType;
    requiresEvidence: boolean;   // v0.38 起不再参与判定，保留字段仅为兼容；证据要求一律按 type
    dueAt: string | null;
    steps: { title: string; done: boolean }[];
  };
  evidence: { kind: 'text' | 'image'; text?: string; imageBase64?: string }[];
  userText?: string;
}
```

输出 schema：

```json
{
  "verdict": "pass | partial | fail | need_evidence",
  "quality": "partial | met | exceeded | null",
  "result": "exceeded | met | below | null",
  "reason": "一句话说明判断依据，≤50字",
  "followup": "要补什么证据，≤40字，verdict=need_evidence 时必填"
}
```

`result` 只对 `type='event'` 有意义，其他类型必须为 `null`；而 event 的 `quality` 恒为 `met`（活动不看"做没做完"，看结果）。判定依据：用户说了排名/名次/分数/评价就据此判，什么都没说就填 `met`（不猜）。

判定标准（写进 prompt，**v0.38 起不再区分"要不要证据"**）：

1. **先看证据，再看用户话术。** 用户说"做完了"不构成证据。
2. `evidence` 为空 → **只能返回 `need_evidence`**，`followup` 说明需要什么（"发一下报告文件""截个提交记录"）。**不许猜、不许先给分。** 主进程在调模型之前就用 `hardGateOf` 拦掉这一步，模型通常根本不会被问到。
3. `evidence` 非空 → 逐个对照证据与任务描述：
   - 证据能证明核心产出完成 → `pass` + `met`（明显超出要求 → `exceeded`）
   - 证据只覆盖部分步骤，或有明显缺口 → `partial` + `partial`，`reason` 说明缺什么
   - 证据与任务**对不上**（发了个无关截图、文字是"我做了"）→ `need_evidence` + `followup` 指出对不上在哪
4. 用户明确说没做 → `fail`。
5. `reason` 必须写出**判断依据**（"截图显示报告已导出为 PDF"），不能写"看起来完成了"这类空话。

> **v0.38 删掉的是这一条**：「`requiresEvidence = false`（跑步、背单词这类）→ 按用户陈述判定，`pass` + `met` 即可」。
> 它导致手动建的限时任务（`requires_evidence` 默认 0）全部凭一句"我做完了"秒过、直接发分。现在**限时/活动一律要证据**，每日任务根本不进审核。

业务层拿到 `verdict` 后的动作，AI 不管钱：

| verdict | 业务动作 |
|---|---|
| `pass` (met / exceeded) | `task.complete` → 按 rubric 入账 → `done` |
| `partial` | **不发分**。`due_at` 已过 → `missed`；否则回 `doing`，卡片列出缺口（v0.34 裁决：部分完成不算通过） |
| `need_evidence` | **不入账、状态停在 `reviewing`**，会话里追问一句，等 `task.addEvidence` 后重跑审核 |
| `fail` | 不扣分。`due_at` 已过 → `missed`；否则回 `doing` |

**关键差异（与旧版的区别）**：旧版允许 `pass + followup` 先入账再追问，那是为了让流程不卡住。S4 落地后取消这个口子——**没证据就不发分**。否则"证据"只是个装饰。

**防自欺的一道硬闸**：`need_evidence` 连续出现 3 次后，卡片上出现 `[直接标记完成（不计分）]`，让用户能结束这件事而不必撒谎，也不给分。这只是避免流程死锁，不是后门。

### 4.3 `chat` — 闲聊（v0.37 重写：独立管线，纯文本）

**这是唯一不走 `chatJson` 的能力。** 以前它和 `parse` 挤在一条管线上（每轮都要回 `{reply ≤60 字, tasks}`），所以既聊不深也聊不长。v0.37 起它是独立管线 `src/main/ai/pipelines/chat.ts`，输出纯文本。

**触发条件**：`msg.send` 的 `mode === 'chat'`（默认）。**不看文本内容**——模式由输入区按钮决定，主进程不做关键词猜测。

**模型**：`settings['ai.chat.model']`，默认 `glm-4.7-flashx`。纯文本模型，**图片一律不送**（`attachmentIds` 照常挂到消息上，但不进 prompt）。

#### 4.3.1 请求构成

`messages` 数组固定四段，顺序不许变：

| # | role | 内容 |
|---|---|---|
| 1 | `system` | 身份段 + 记忆段 + 时间与今日数据段 + 历史摘要段 + 铁律段（下面逐段规定） |
| 2..n | `user` / `assistant` 交替 | 最近 **20 条**历史原文（`messageService.recentChatMessages(20)`，只取 `kind='text'` 的，`task_draft` / `task_review` 不进上下文） |
| n+1 | `user` | 本轮文本 |

**system 五段拼装顺序**（段间空一行，段内不换行）：

1. **身份段**
   ```
   你是 {persona.name}。{persona.personaMd}
   称呼对方为「{persona.user_call}」。（`user_call` 为空时整句省略，下文用「你」）
   语气：{tone 对应一句}
   ```
   `tone` 三档的固定句（**不要自由发挥**）：`warm` =「说话温和、有耐心，不说教」；`plain` =「直接说结论，不铺垫、不客套」；`playful` =「轻松一点，可以开玩笑，但不油腻」。

2. **记忆段**
   ```
   关于对方，你记得这些：
   - {memory.contentMd}
   - …
   ```
   取 `memories` 按 `updated_at DESC` 前 **12 条**，不再按 kind 分组排序（分组会让「最近记住的」沉底）。一条都没有时整段省略。这 12 条的 `hits + 1`，一条 SQL 批量更新。

3. **时间与今日数据段**（`buildTodayBrief()` 拼装，**主进程查库模板拼接，不让模型算数字**）
   ```
   今天是 2026-10-30（周五）。
   今天的任务：待办 3 条（写季度报告 · 今天 18:00 截止；背单词；准备答辩 · 11-02 09:00），已完成 2 条，逾期 0 条。
   今天已得 30 分，总积分 1280 分。
   ```
   - 待办最多列 **5 条**，超出时末尾加「等 N 条」（N 是总数）；标题超过 12 字截断加 `…`。
   - 每日任务在括号里写「每日」，限时/活动写截止时刻（今天 → `今天 HH:mm`，别的日子 → `MM-DD HH:mm`）。
   - 空数据时对应子句整句省略：没有待办就只写「今天没有待办任务」，一条任务都没有就写「今天没有任何任务」。**不许出现「0 条待办，0 条已完成」这种机器腔。**
   - 这段的数字必须与 `04 §4③` 积分区、① 任务区**同源同值**（都走 `01 §4` 的统计口径），出现差值算 bug。

4. **历史摘要段**
   `chat_state.summary_md` 非空时才有：
   ```
   更早的对话摘要：{summary_md}
   ```

5. **铁律段**（写死，逐字）
   ```
   规则：
   - 用中文，口语，不要分点罗列，不要输出 JSON 或 markdown 代码块。
   - 只说你确定的事。不知道就说不知道，不要编数字、编日期、编你做过的事。
   - 你现在处在聊天模式，不能创建、修改、完成任何任务。用户让你记任务时，如实告诉他这个模式不能建任务，不要假装记下了。
   - 不要复述上面「关于对方，你记得这些」和「今天」的原文，把它们当成你已经知道的事自然使用。
   ```

#### 4.3.2 参数与失败

| 项 | 值 | 理由 |
|---|---|---|
| `temperature` | `0.8` | 闲聊要松，`parse` 用的低温在这里会像客服 |
| `maxTokens` | `800` | 约 500~600 汉字，够一段长回复；放开到 2000 会明显变慢 |
| 超时 | `30s` | 非推理模型，比 `chatJson` 的 60s 短。超时按失败处理 |
| 空字符串 | 按失败处理 | `chatText` 内部就报 `AI_PARSE_FAILED`，**不许拿空串 patch 消息让气泡变空气泡** |

失败路径（与 `msg.send` 现有失败一致，不新增分支）：落一条 `kind='error'` 消息 + `message.appended`，占位 assistant 消息 `status='failed'`，`retryable: true`。用户点重试重跑同一轮。

#### 4.3.3 不做什么

- **不抽任务。** 聊天模式永远不产出 `task_draft`。想建任务就切模式，这是用户 2026-10-30 的决定（「忘了切换我自己处理，损失也不大」）。
- **不调工具、不查库。** 所有数据在 system 里摆好了，模型只负责说话。**不许给它「自己查」的错觉**——那会导致它编造查询结果。
- **不做意图分类。** `intent` 字段在 chat 管线里不存在。它在 `parse` 管线里保留，但主进程仍然不消费（`query` 的模板拼装已经被本节的今日数据段替代）。

### 4.4 `memory-extract` — 记忆自动提取（v0.37 新增）

**在 `chat` 轮次成功之后异步跑**，不阻塞回复、失败静默（只写日志，不给用户看错误）。

| 项 | 规则 |
|---|---|
| 模型 | `settings['ai.chat.model']`（同样的便宜模型），`chatJson` 调用 |
| `temperature` | `0` |
| 输入 | 本轮 user 文本 + 本轮 assistant 回复 + 现有记忆的 `contentMd` 列表（≤50 条，用于去重） |
| 输出 schema | `{ "memories": [ { "contentMd": string, "kind": "profile" \| "preference" \| "fact" } ] }` |
| 条数 | 最多 **2 条**；没有值得记的就返回空数组，**这是常态** |
| 超时 | `15s`，超时直接放弃这一轮 |
| 落库 | `INSERT OR IGNORE`（`content_md` 唯一），`source='auto'`。已满 50 条先淘汰（01 §2.9） |

**prompt 里要写死的四条否定条件**（不写的话它会每轮都记一句废话）：

- 「对方随口说的话」、「这次聊的具体内容」、「已经存在的记忆」都不记。
- 只记**跨对话仍然成立**的事实：身份、长期偏好、稳定的人际/宠物/工作关系、明确说过的目标。
- 不记情绪（「他今天心情不好」）、不记临时状态（「他现在在写代码」）、不记任务本身（任务是任务表的事）。
- 一条不超过 30 字，写成陈述句，主语用「对方」。

**不做的事**：不更新已有记忆（只增），不删，不做「这条记忆是不是过时了」的判断。过时由用户手动改——这是丙方案（自动 + 手动）里手动的意义。

---

## 5. 图片处理管线

```
用户粘贴/拖入
  → 主进程校验 mime ∈ {png,jpeg,webp}，单张 ≤ 10MB（超出返回 FILE_TOO_LARGE）
  → sha256 去重：命中已有 attachments 则复用，不重复落盘
  → 原图存 userData/attachments/YYYY/MM/<id>.<ext>
  → 生成缩略图长边 320px 供会话气泡
  → 生成模型入参图：长边 ≤1568px、JPEG q80、base64
  → 该 base64 只存在于单次请求内，用完即弃，不落库
```

一次最多 4 张图。多图合计 base64 超过约 8MB 时按比例再压一档。

---

## 6. 接入前置验证（实现方第一步就要做，别跳过）

在你写任何 pipeline 之前，先跑通这一件事：

1. 用真实 Key 发一次**纯文本**请求，确认返回 JSON 可解析。
2. 再发一次**带图片**的请求（随便一张含中文的截图），确认模型真的描述了图里的内容。
3. 检查返回体里是否有可用的 `usage` 字段。

理由：多模态是**计费与能力上最容易踩空**的一项，模型名/版本/是否走 vision 端点都可能有差异。**不要凭文档假设**，用一次真实调用把这件事钉死。验证结果写进 `ai.health` 的 `multimodal` 字段，设置页可视化。

**本版验证对象就是 `glm-5.3-flash`**（`zhipu` 直连），不改模型、不加中转。

将来若要接 harness（暂缓，见 06），这一步更麻烦，因为**要重新验证一次**：

DeepSeek 的主力 API 模型以文本为主，**视觉能力是否可用必须先验证**，不能假定"DeepSeek 也能看图"。如果验证下来不能，harness 必须做**双模型路由**：

```
请求里含 image → 走 VISION_MODEL（多模态，如 glm-5.3-flash 或你验证过的其他）
请求里只有 text → 走 TEXT_MODEL（DeepSeek）
```

harness 侧按请求内容自动选模型，主程序无感。这个路由在 06 文档里有实现。**如果两边都拿不到可用的视觉模型，`create_task` 的图片识别这条路就走不通**——那时要么保住智谱做视觉、要么把图片功能降级为"仅文字输入"，这是要和你说清楚的产品取舍，不是实现细节。

如果验证发现该模型不吃图：不要自己换模型了事——列入变更单，由你决定是升级到更强的多模态型号，还是接一个专门的视觉模型做前置描述（用视觉模型把图转成文字，再喂给主模型）。

---

## 7. Prompt 存放与迭代

```
src/main/ai/prompts/
  system.base.md        # 人格、语言、铁律（中文输出、不臆造、不比数字）
  parse.system.md       # 4.1 的约束
  review.system.md      # 4.2 的判定标准
  parse.fewshot.json    # 3-5 组正例，覆盖：单任务、图转任务、多任务、纯闲聊
  chat.system.md        # 4.3 的五段模板（v0.37，带 {{PERSONA}} {{MEMORY}} {{BRIEF}} {{SUMMARY}} 占位符）
  memory.system.md      # 4.4 的提取规则与四条否定条件（v0.37）
  summarize.system.md   # 01 §2.10 的历史压缩（v0.37，≤600 字、只留事实不留寒暄）
```

- 每个 prompt 带版本号注释（`<!-- v1 2026-10-27 -->`），改 prompt 要写变更记录，因为 prompt 改动对效果的影响不比代码小。
- 调 prompt 时只改 one thing at a time，用同一组输入（`ai/__fixtures__/*.json`）回归。
- 所有 prompt 用中文写，要求模型**中文输出**。

---

## 8. 成本与延迟预算（v0.22 按实测修正）

| 场景 | 原目标首字延迟 | **实测** | 单次 token 量级（实测） |
|---|---|---|---|
| 纯文字建任务 | ≤ 1.5s | **4.3–5.4s**（`glm-4-flash`）/ **5.5–29.9s**（`glm-5.3-flash`） | prompt 39 + completion 172–1337（含推理） |
| 带 1 张图建任务 | ≤ 3s | **8.1s**（8×8 图，`glm-5.3-flash`） | 图占大头 |
| 完成审核 | ≤ 1.5s | 未测（prompt 更短，预计 3–10s） | 短 |

**原 1.5s 目标作废**：`glm-5.3-flash` 是推理模型，先产 `reasoning_content` 再产 `content`，单次 5.5s 起步、长任务 13–30s。UI 必须按"转圈 + 可取消"设计，不许假设秒回。

延迟不达标时的处置顺序（与旧版一致，只是目标值换了）：先减 fewshot → 再精简 system → **最后才考虑换模型**。换模型是产品取舍，必须由架构方裁决（见 §9.4）。

---

## 9. 模型行为实测（v0.22，架构方真机跑过，施工方据此写代码）

> 实测环境：`https://open.bigmodel.cn/api/paas/v4/chat/completions`，key 为临时试用 key。
> 以下每条都是**实测结果**，不是文档推断。施工方若复现不出，停下来报告，不要改设计绕过去。

### 9.1 `glm-5.3-flash` 是推理模型

响应体里 `choices[0].message` 有两个字段：

```json
{ "role": "assistant", "reasoning_content": "……564 字符的思考过程……", "content": "{\"tasks\":[…]}" }
```

- **`content` 才是答案**，`reasoning_content` 必须丢弃，不许拼进 JSON 解析。
- **`max_tokens` 必须给够**：实测 `max_tokens: 32` 时 32 个 token 全被推理吃掉，`content` 返回**空字符串**，`finish_reason: "length"`。建任务场景一律 `max_tokens: 2048`，并检查 `finish_reason`——为 `length` 时按 `AI_PARSE_FAILED` 处理，**不要重试**（重试也是同样的截断）。
- `usage.completion_tokens_details.reasoning_tokens` 存在，计费与耗时都在这里。

### 9.2 `response_format: { type: 'json_object' }` 可用

实测生效，返回合法 JSON。**但仍要保留剥 ```json 围栏的兜底**——prompt 改坏或换模型时它会退化成带围栏的文本。

### 9.3 多模态：确认吃图

实测：8×8 纯红 PNG（`data:image/png;base64,…`）＋"这张图片里是什么颜色" → 返回 `"红色"`。**不是敷衍描述**，是真读了像素。

- 图片 payload 形状按 §3.1 的 `image_url` 走，`url` 必须是 `data:<mime>;base64,<…>`。
- 单次带图延迟实测 8.1s，比纯文本更慢，UI 上要能看出"正在看图"。

### 9.4 其他可用模型（换模型必须走裁决，不许自己换）

| 模型 | 可用 | 形态 | 实测延迟 | 结论 |
|---|---|---|---|---|
| `glm-5.3-flash` | ✅ | 推理 + 多模态 | 5.5 / 13.4 / 29.9s | **本版主模型** |
| `glm-4-flash` | ✅ | 非推理，纯文本 | 4.3 / 4.9 / 5.4s（稳定） | 快但错得多，见 9.5 |
| `glm-4.5-flash` | ✅ | 推理（`content` 空是 token 不够） | 未测 | 备选 |
| `glm-4.6` | ✅ | 推理 | 未测 | 备选 |
| `glm-4.6-flash` | ❌ `1220 您无权访问` | — | — | 此 key 不可用 |
| `glm-4.7-flashx` | 未实测 | 非推理，纯文本 | 未测（官方标 200 tok/s 档） | **v0.37 起的闲聊模型**，用户 2026-10-30 裁决「聊天不需要识图」。`ai.chat.model` 默认值 |

> **换模型必须走裁决，不许自己换**——包括"某个模型报错了我顺手换成 flash"。换模型看 `ai.health` 与 `messages.latency_ms`，改完在报告里写明换的模型名与三次实测延迟。
>
> **`glm-4.7-flashx` 上线前必须实测三件事**（W12 施工第一步，别跳过）：① 它是不是非推理模型（响应里有没有 `reasoning_content`）；② 单次闲聊的首字延迟与总耗时（三次取中位）；③ 用日文/英文各问一句，确认中文输出规则不串。实测结果写进本节下表，供以后换模型时对照。

### 9.5 必须靠 prompt 与校验硬扛的三个已知错误

实测三句话（"明天下午三点前把季度报告初稿写完" / "每天早上背单词" / "下周三考英语六级"）暴露：

| 现象 | 严重度 | 处理 |
|---|---|---|
| **`due_hint` 恒为 `null`**，模型把"明天下午三点"写进 `title` | **P0，功能等于废掉** | 根因是 **system prompt 里没有当前时间**，模型不知道"明天"是哪天。**必须在每次请求注入**：本地日期、星期、时区（`Asia/Shanghai`）、当前时刻。注入后仍为 `null` 才算模型能力问题 |
| `intent` 输出成 `"create_task|review_task"`（照抄枚举占位符） | 中 | zod 校验会拒；走既定的重试 1 次，重试仍错则 `AI_PARSE_FAILED` |
| "下周三考英语六级" 判成 `deadline` | 中 | fewshot 里放一条 event 正例（考试/面试/答辩），并在 system 里重申"要你到场 ≠ 要你交东西" |

### 9.6 当前时间的注入格式（写死，别自创）

```
【当前时间】2026-10-29 星期四 10:52（Asia/Shanghai）
解析"明天/下周三/三小时后"这类相对时间时，一律以此为准，并换算成带时区的 ISO8601。
```

日期与星期都由主进程算（用 `src/shared/localDay.ts` 的本地日实现，**不许 `toISOString().slice(0,10)`**），拼进 system 消息末尾。同一进程内可按小时缓存，避免每条消息重算。

### 9.7 Key 的读取优先级（v0.22）

```
1. safeStorage 加密文件（userData/ai-key.bin）—— 打包版唯一来源
2. process.env.ZHIPU_API_KEY —— 开发期来源，由 .env.local 提供
3. 都没有 → ai.health 返回 { configured: false }，ai.* 调用返回 AI_NOT_CONFIGURED
```

- `.env.local` 已在 `.gitignore` 里（`ZHIPU_API_KEY=…` 一行）。主进程仅在 `!app.isPackaged` 时读取它，**打包产物绝不读**。
- v1 **不提供**"在界面里输入 key"的通道。v0.44 设置抽屉已存在（04 §10），但 AI 块**只读**：`ai.keyStatus` 只回答"配没配"，`writeKey()` 仍**不许注册成 IPC**（改错 key 无回滚入口，且会同时打断建任务与聊天两条管线）。
- 任何日志、错误 `detail`、`console.*` 里都不许出现 key 的前 6 位。用它做断言（见 16 号开工词自检表）。
