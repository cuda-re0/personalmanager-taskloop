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

行为约定（实现必须满足）：

1. `response_format: { type: 'json_object' }`；上游不支持时退化为在 system prompt 里强制"只输出 JSON，不要 markdown 围栏"，并在解析前剥围栏。
2. 解析流程：`JSON.parse` → `schema.safeParse` → 失败则把校验错误拼进第二次请求让模型自修（**只重试 1 次**）。
3. 最终失败：返回 `AI_PARSE_FAILED`，由 `aiService` 落一条 `kind='error'` 消息，`retryable: true`。**不准静默失败，不准抛到渲染层崩界面。**
4. 超时 **60s**（v0.22 从 45s 上调，实测 `glm-5.3-flash` 单次最慢 29.9s，45s 余量不够），`AbortController` 可控（用户关窗口要能中断）。
5. 每次调用把 `tokens_in/out/latency_ms` 写回 `messages`，方便后期看成本。**`tokens_out` 必须包含推理 token**：上游把 `reasoning_tokens` 算在 `completion_tokens` 里，只记 `content` 的估算值会少算一半以上（实测一次 172 tokens 里有 151 是推理）。
6. API Key 从安全存储读，**绝不进日志、不进 DB 明文、不进 git**。
7. **任何 provider 返回的内容都要过 zod 校验。** 将来接 harness 时同样不能免检——它不是可信边界。

---

## 4. 三个能力契约

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
    requiresEvidence: boolean;
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

判定标准（写进 prompt）：

1. **先看证据，再看用户话术。** 用户说"做完了"不构成证据。
2. `requiresEvidence = true` 且 `evidence` 为空 → **只能返回 `need_evidence`**，`followup` 说明需要什么（"发一下报告文件""截个提交记录"）。**不许猜、不许先给分。**
3. `requiresEvidence = true` 且 `evidence` 非空 → 逐个对照证据与任务描述：
   - 证据能证明核心产出完成 → `pass` + `met`（明显超出要求 → `exceeded`）
   - 证据只覆盖部分步骤，或有明显缺口 → `partial` + `partial`，`reason` 说明缺什么
   - 证据与任务**对不上**（发了个无关截图、文字是"我做了"）→ `need_evidence` + `followup` 指出对不上在哪
4. `requiresEvidence = false`（跑步、背单词这类）→ 按用户陈述判定，`pass` + `met` 即可，不要求证据。
5. 用户明确说没做 → `fail`。
6. `reason` 必须写出**判断依据**（"截图显示报告已导出为 PDF"），不能写"看起来完成了"这类空话。

业务层拿到 `verdict` 后的动作，AI 不管钱：

| verdict | 业务动作 |
|---|---|
| `pass` (met / exceeded) | `task.complete` → 按 rubric 入账 → `done` |
| `partial` | 入账 60% → 状态回 `doing`，卡片列出缺口 |
| `need_evidence` | **不入账、状态停在 `reviewing`**，会话里追问一句，等 `task.addEvidence` 后重跑审核 |
| `fail` | 不扣分，状态回 `doing` |

**关键差异（与旧版的区别）**：旧版允许 `pass + followup` 先入账再追问，那是为了让流程不卡住。S4 落地后取消这个口子——**没证据就不发分**。否则"证据"只是个装饰。

**防自欺的一道硬闸**：`need_evidence` 连续出现 3 次后，卡片上出现 `[直接标记完成（不计分）]`，让用户能结束这件事而不必撒谎，也不给分。这只是避免流程死锁，不是后门。

### 4.3 `chat` — 闲聊与其他

不建任务、不改数据。`reply` 直接进会话。用户问"我今天做了多少"这类查询 → `intent='query'`，由主进程用 SQL 取数后**模板拼装**回复，不让模型算数字（同 §1 的道理：查库比问模型准）。

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
- v1 **不提供**"在界面里输入 key"的通道：04 没有设置页，加了也没人调。`writeKey()` 写好并导出，留给将来的设置页，但**不许注册成 IPC**。
- 任何日志、错误 `detail`、`console.*` 里都不许出现 key 的前 6 位。用它做断言（见 16 号开工词自检表）。
