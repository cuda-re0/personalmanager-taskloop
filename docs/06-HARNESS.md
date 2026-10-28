# 06 · 自建 harness 指南（参考设计 · 暂不实施）

> **状态：暂缓。本文档不是施工任务。**
>
> 2026-10-28 用户决定：**harness 的想法保留，先不做**；模型走 `zhipu` 直连，通知走邮箱（02 §6.3）。
> 所以：W4 只实现 `glmClient`，W8B 只要求 `mail` 通。**任何实现方不要照本文档开新工程、不要建 `harness/` 目录。**
>
> 本文档留着的原因：代码是实测跑通的，哪天你想上（比如要换模型、要手机端也能用、要推到 QQ），把这里的 `server.mjs` 拿起来就能用，不用重新设计。接口侧已经预留好（`AiProvider` 可切换、`webhookChannel` 支持自定义 header），接的时候不需要改上层代码。

> 目标读者：你。照着做完大概 1–2 小时。
> 前置：Node 20+（`node -v` 看版本）。
> 本文档里的代码是**完整可运行**的，不是伪代码。

---

## 1. 先厘清：harness 是什么，不是什么

**它不是 QQ 通道。** 它是你自己跑的一个小 HTTP 服务，站在主程序和模型之间，顺手把提醒转发到手机。QQ 只是它下游的其中一个出口。

**它不是必需的。** 主程序直连智谱也能跑完所有功能。加它的理由只有三个：

1. API key 不放在桌面应用里（应用被翻配置文件也拿不到 key）。
2. 你在手机、平板上也能用同一套能力（以后做移动端时直接复用）。
3. 换模型不用改主程序、不用重新打包。

**它不负责 prompt。** 这是最重要的一条，我在 §7 展开。

### 三个角色的边界

```
┌──────────────┐   ① HTTP    ┌──────────────┐   ② 各家 API   ┌────────────┐
│  主程序       │ ─────────→ │  harness      │ ────────────→ │ DeepSeek   │
│  (Electron)   │             │  (你的服务)    │               │ / 视觉模型  │
│              │ ←───────── │              │                └────────────┘
│  prompt 在这里│   ④ 结果     │  路由 + 转发   │
│  数据在这里   │             │              │   ③ 推送       ┌────────────┐
└──────────────┘             └──────────────┘ ────────────→ │ PushDeer / │
                                                             │ 微信 / QQ  │
                                                             └────────────┘
```

**主程序仍负责**：数据库、prompt、积分计算、UI、提醒何时触发。
**harness 负责**：拿请求、选模型、转发、把 key 藏好、把提醒推到手机。

你说"审核创建任务都可以交给它"——用 `proxy` 模式就满足：所有模型调用确实发生在 harness 上，主程序只管拼 prompt 和校验结果。这样责任清楚，也不会出现两边 prompt 版本不同步的鬼问题（§7 详述）。

---

## 2. 它要对主程序提供什么

三个接口，都是 JSON：

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| `GET` | `/health` | 自检：模型配了没、视觉可用没、推送配了没 | Bearer |
| `POST` | `/v1/chat` | 转发模型调用，返回模型原始文本 | Bearer |
| `POST` | `/v1/notify` | 发一条提醒到手机 | Bearer |

### `POST /v1/chat`

请求（和 OpenAI 的 chat/completions 几乎一样，主程序好拼）：

```json
{
  "messages": [
    { "role": "system", "content": "你是任务助手…" },
    { "role": "user", "content": [
        { "type": "text", "text": "这是明天的作业安排" },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/..." } }
    ]}
  ],
  "temperature": 0.2,
  "response_format": { "type": "json_object" }
}
```

响应：

```json
{
  "content": "{\"intent\":\"create_task\",...}",
  "usage": { "in": 1203, "out": 412 },
  "latencyMs": 1840,
  "model": "deepseek-chat"
}
```

**harness 不做 JSON 校验、不做 schema 检查。** 那是主程序的事（同样的 zod schema，不因为是自家服务就免检）。

### `POST /v1/notify`

```json
{ "title": "交物理作业", "body": "前 1 小时", "level": "normal" }
```

响应 `{ "ok": true }` 或 `{ "ok": false, "error": "PUSH_401" }`。

---

## 3. 完整代码

一个文件，零依赖，不需要 `npm install`。建目录 `harness/`，放两个文件。

### 3.1 `harness/server.mjs`

```js
import http from 'node:http';
import fs from 'node:fs';

// ── 读 .env（10 行手写解析，不引依赖）
if (fs.existsSync(new URL('./.env', import.meta.url))) {
  for (const line of fs.readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const CFG = {
  port:        Number(process.env.PORT || 3001),
  token:       process.env.HARNESS_TOKEN || '',
  textModel:   process.env.TEXT_MODEL || 'deepseek-chat',
  textBase:    process.env.TEXT_BASE || 'https://api.deepseek.com/v1',
  textKey:     process.env.TEXT_API_KEY || '',
  visionModel: process.env.VISION_MODEL || '',        // 留空 = 不接受图片请求
  visionBase:  process.env.VISION_BASE || '',
  visionKey:   process.env.VISION_API_KEY || '',
  pushUrl:     process.env.PUSH_URL || '',
  pushToken:   process.env.PUSH_TOKEN || '',
  pushKind:    process.env.PUSH_KIND || 'generic',    // generic | pushdeer | serverchan
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > 16 * 1024 * 1024) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch { reject(new Error('BAD_JSON')); }
  });
  req.on('error', reject);
});

const authorized = (req) =>
  Boolean(CFG.token) && req.headers.authorization === `Bearer ${CFG.token}`;

const hasImage = (messages) =>
  Array.isArray(messages) && messages.some((m) =>
    Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url'));

/** 按请求里有没有图片，自动选模型 */
async function callModel(messages, opts = {}) {
  const wantVision = hasImage(messages);
  if (wantVision && !(CFG.visionModel && CFG.visionBase && CFG.visionKey)) {
    const e = new Error('NO_VISION_MODEL'); e.code = 'NO_VISION_MODEL'; throw e;
  }
  if (!wantVision && !(CFG.textBase && CFG.textKey)) {
    const e = new Error('NO_TEXT_MODEL'); e.code = 'NO_TEXT_MODEL'; throw e;
  }
  const base  = wantVision ? CFG.visionBase : CFG.textBase;
  const key   = wantVision ? CFG.visionKey  : CFG.textKey;
  const model = wantVision ? CFG.visionModel : CFG.textModel;

  const t0 = Date.now();
  const r = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      response_format: opts.response_format ?? { type: 'json_object' },
      stream: false,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!r.ok) {
    const e = new Error(`UPSTREAM_${r.status}: ${(await r.text()).slice(0, 300)}`);
    e.code = 'UPSTREAM'; throw e;
  }
  const d = await r.json();
  return {
    content: d.choices?.[0]?.message?.content ?? '',
    usage: { in: d.usage?.prompt_tokens ?? 0, out: d.usage?.completion_tokens ?? 0 },
    latencyMs: Date.now() - t0,
    model,
  };
}

/** 推送到下游（PushDeer / Server酱 / 任意 webhook） */
async function push(title, body) {
  if (!CFG.pushUrl) return { ok: false, error: 'PUSH_NOT_CONFIGURED' };

  const payload =
    CFG.pushKind === 'pushdeer'    ? { text: title, desp: body }
  : CFG.pushKind === 'serverchan'  ? { title, desp: body }
  :                                  { title, body };

  const r = await fetch(CFG.pushUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(CFG.pushToken ? { authorization: `Bearer ${CFG.pushToken}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return { ok: false, error: `PUSH_${r.status}` };
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (!authorized(req)) return json(res, 401, { ok: false, error: 'UNAUTHORIZED' });

  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        textModel: CFG.textModel,
        visionModel: CFG.visionModel || null,
        multimodal: Boolean(CFG.visionModel),
        push: Boolean(CFG.pushUrl),
      });
    }

    if (url.pathname === '/v1/chat' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json(res, 400, { ok: false, error: 'MESSAGES_REQUIRED' });
      }
      const out = await callModel(body.messages, body);
      return json(res, 200, out);
    }

    if (url.pathname === '/v1/notify' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.title) return json(res, 400, { ok: false, error: 'TITLE_REQUIRED' });
      const out = await push(String(body.title), String(body.body ?? ''));
      const status = out.ok ? 200 : out.error === 'PUSH_NOT_CONFIGURED' ? 501 : 502;
      return json(res, status, out);
    }

    return json(res, 404, { ok: false, error: 'NOT_FOUND' });
  } catch (e) {
    const code = ['NO_VISION_MODEL', 'NO_TEXT_MODEL', 'UPSTREAM'].includes(e?.code) ? e.code
               : e?.message === 'BAD_JSON' ? 'BAD_JSON'
               : e?.message === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE'
               : 'INTERNAL';
    console.error('[harness]', code, e?.message);
    const status = code === 'NO_VISION_MODEL' || code === 'NO_TEXT_MODEL' ? 501
                 : code === 'UPSTREAM' ? 502
                 : code === 'BAD_JSON' || code === 'PAYLOAD_TOO_LARGE' ? 400
                 : 500;
    return json(res, status, { ok: false, error: code, message: e?.message });
  }
});

server.listen(CFG.port, '127.0.0.1', () => {
  console.log(`harness listening on http://127.0.0.1:${CFG.port}`);
  console.log(`  text:   ${CFG.textModel}`);
  console.log(`  vision: ${CFG.visionModel || '(未配置，图片请求会被拒)'}`);
  console.log(`  push:   ${CFG.pushUrl ? CFG.pushKind : '(未配置)'}`);
  if (!CFG.token) console.warn('  ⚠ HARNESS_TOKEN 为空，所有请求都会被拒绝');
});
```

### 3.2 `harness/.env`

```ini
PORT=3001
HARNESS_TOKEN=换成你自己的随机串

# 文本模型
TEXT_MODEL=deepseek-chat
TEXT_BASE=https://api.deepseek.com/v1
TEXT_API_KEY=sk-你的deepseek密钥

# 视觉模型（图片识别用，未验证前先留空）
VISION_MODEL=
VISION_BASE=
VISION_API_KEY=

# 推送下游
PUSH_KIND=generic
PUSH_URL=
PUSH_TOKEN=
```

生成随机 token：`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

### 3.3 跑起来

```bash
cd harness
node server.mjs
```

另开一个终端验：

```bash
curl -H "Authorization: Bearer 你的token" http://127.0.0.1:3001/health
```

PowerShell 用这个：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3001/health -Headers @{ Authorization = "Bearer 你的token" }
```

看到 `{"ok":true,"textModel":"deepseek-chat",...}` 就成了。

---

## 4. 三个必须自己验证的点

代码跑通 ≠ 能力可用。这三件事文档不能替你确认，跑一次才知道。

### 4.1 DeepSeek 能不能看图（最关键）

DeepSeek 的主力 API 以文本模型为主，**视觉能力不能假定有**。测试方法：把 `VISION_MODEL` 先填一个你手上确认支持图片的型号（比如智谱的多模态模型），跑通图片请求；再换成你想用的 DeepSeek 型号试一次。

如果 DeepSeek 不支持图片，就保持**双模型**：文本走 DeepSeek（便宜、够用），图片走多模态模型。代码里已经按"请求含图就切模型"实现了，你不用改逻辑，只要把两组配置都填上。

**如果两边都拿不到可用的视觉模型**，那"发一张图就变任务"这个功能就走不通。这时只有两条路：换一个有视觉能力的模型，或者把图片入口降级成纯文字。这是产品取舍，要你决定，不是我在实现时能糊过去的事。

### 4.2 推送真的能到手机

配好 `PUSH_URL` 后：

```bash
curl -X POST http://127.0.0.1:3001/v1/notify \
  -H "Authorization: Bearer 你的token" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"测试提醒\",\"body\":\"如果能收到就通了\"}"
```

手机没响就是没通。别在应用里点"测试"来验证——那是二手信息。

### 4.3 延迟能不能忍

看 `/v1/chat` 返回的 `latencyMs`。文本抽取目标 ≤1.5s，图片 ≤3s。超过就说明模型或网络有问题，先解决再往下做。

---

## 5. 推送怎么真正到 QQ

三个选项，优劣是真实的，你自己选。

| 方案 | 怎么做 | 能不能到 QQ 本体 | 风险 | 配好要多久 |
|---|---|---|---|---|
| **A. QQ 邮箱 + 邮件** | 主程序直接用 `mail` 渠道发到你的 QQ 邮箱，手机 QQ 会提示新邮件 | 不是 QQ 消息，但手机能弹 | 无 | 5 分钟 |
| **B. PushDeer / Server酱** | 注册 → 拿 URL → 填进 `PUSH_URL`，`PUSH_KIND` 设成 `pushdeer` 或 `serverchan` | 推到微信，不是 QQ | 依赖第三方服务，免费额度会变 | 5 分钟 |
| **C. QQ 开放平台官方机器人** | 注册开发者 → 建应用 → 审核 → 拿 AppID/Token | 是 | 流程 1–3 天，且主要面向群/频道，私聊权限受限 | 数天 |
| **D. 非官方 QQ 协议框架**（NapCat / LLOneBot 等） | 在本地挂一个客户端，通过 HTTP 发消息 | 是 | **逆向协议，有封号风险，随时失效** | 半天 |

**我的建议：先 B（或 A），要 QQ 本体再上 C。D 不要碰。**

不是道德问题，是工程现实：D 类的接口没有契约，作者一停更你就得跟着折腾，而且账号被封的成本远大于提醒准时带来的收益。你有权知道它存在，但我不建议把它作为主路径。

选 B 的话，`PUSH_URL` 填服务商给的地址就行，代码里 `PUSH_KIND` 已经支持这两种格式。

---

## 6. 放哪台机器上跑

| 位置 | 优点 | 缺点 | 适合 |
|---|---|---|---|
| 本机常开 | 零成本，延迟最低 | 电脑关机就收不到提醒 | 你电脑基本不关 |
| 一台常开的小主机 / 树莓派 | 独立、稳定 | 要买/要维护 | 长期用 |
| 云函数（腾讯云 SCF / 阿里云 FC） | 免运维、有免费额度 | 冷启动慢、要处理鉴权与出网 | 只在特定时段用 |
| 一台 VPS | 最灵活 | 要钱 | 以后做多端同步时 |

提醒这件事**必须有一台不关机的机器**，否则"前 1 小时提醒"在你电脑睡眠时就是一句空话。这是我建议你至少放到云函数或小主机上的原因。

安全底线（无论放哪）：

- `HARNESS_TOKEN` 必须设，且不要和别处复用。
- 公网部署必须 HTTPS，不要裸 HTTP 暴露在公网。
- `.env` 不要提交到任何仓库，不要发到聊天里。
- 如果放公网，`server.listen` 的 `127.0.0.1` 要改成 `0.0.0.0`，并**务必**配好防火墙和 token。

---

## 7. 为什么 prompt 应该留在主程序

你说"审核创建任务都可以交给它"。我把它拆成两件事：

| 交出去的 | 留在主程序的 |
|---|---|
| 模型调用、key 保管、重试、超时、模型路由 | prompt 文本、JSON schema、积分公式 |

理由：

1. **改 prompt 的频率远高于改代码。** 放在主程序，改一行重启 3 秒见效；放在 harness，每次都要重新部署。
2. **版本会漂移。** 主程序升级了 prompt 而 harness 没同步，同一个任务在两个版本下表现不同，这种 bug 极难查——你以为是模型不稳定，其实是两边不一致。
3. **prompt 里含产品判断。** "判不清默认 deadline""宁可多要一句证据"这些是本产品的规则，跟着产品走，不跟着基础设施走。

harness 里我也留了 `agent` 模式的钩子（请求里带 `"mode":"agent"` 就由 harness 自己拼 prompt）。但那应该是你**明确想做多端统一逻辑**时的选择，不是默认。

---

## 8. 接进主程序

设置页填三项：

| 项 | 值 |
|---|---|
| 模型来源 | `harness` |
| Base URL | `http://127.0.0.1:3001`（或你的域名） |
| Token | 上面那个 `HARNESS_TOKEN` |

对应 `settings['ai.provider'] = {"name":"harness","baseUrl":"...","model":"deepseek-chat"}`，token 走 `safeStorage`。

提醒那边填：

| 渠道 | 配置 |
|---|---|
| `webhook` | URL = `http://127.0.0.1:3001/v1/notify`，Header `Authorization: Bearer <token>`，body 模板 `{"title":"{{title}}","body":"{{detail}} · {{offsetLabel}}","level":"{{level}}"}` |

**注意**：`webhookChannel` 必须支持自定义 header，否则带不了 Bearer token。这条已经写进 02 §6 的验收。

---

## 9. 分步验收（照着打勾）

- [ ] `node server.mjs` 能起来，`/health` 返回 `ok:true`
- [ ] 不带 token 请求 `/health` 返回 401
- [ ] `/v1/chat` 传一句纯文本，返回的 `content` 能 `JSON.parse`
- [ ] `/v1/notify` 能让手机真的响一次
- [ ] 主程序设置页填 harness，`ai.health` 显示已连接
- [ ] 主程序里发一句"明天交作业"，走 harness 也能出草稿卡片
- [ ] 图片请求：如果 `multimodal: false`，主程序要**明确提示**不支持而不是静默失败

---

## 10. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 一直 401 | `.env` 没生效 / token 有空格 | 打印 `CFG.token` 长度确认；`.env` 里不要加引号外的东西 |
| `NO_VISION_MODEL` | 发了图片但没配视觉模型 | 填 `VISION_MODEL`，或主程序侧禁用图片入口 |
| `UPSTREAM_401` | 上游 key 错或过期 | 直接 curl 上游 API 验证 |
| `UPSTREAM_429` | 限流 | harness 侧加退避，或主程序降频 |
| 返回带 ```json 围栏 | 模型没遵守 json_object | 主程序解析前剥围栏（已写进 03 §3.1） |
| 手机收不到 | `PUSH_URL` 错 / 服务商额度用完 | 用 curl 直连推送服务验证，绕过 harness 定位 |
| 电脑睡眠后提醒全丢 | harness 跑在本机 | 换常开机器（§6） |
