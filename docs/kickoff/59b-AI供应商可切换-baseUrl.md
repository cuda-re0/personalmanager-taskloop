# 59b · AI 供应商可切换（baseUrl）

## 执行须知（施工方必读）

你是**施工方**，不是架构方。

- 本文档是给你的**执行指令**。读完直接按它改代码。
- **不要重写、扩写、重新生成施工单**，不要新建任何 `docs/kickoff/*` 文件。
- **不要先产出「实施方案 / 评审意见 / 风险分析」**，读完就动手。
- 交付时只贴 `git diff --stat` + 自检结果 + 未能自验的条目，**不要复述单子内容**。
- 单子里写「不要动」的地方就是不要动；写「必须」的地方没有解释余地。你认为单子有错时，照单做完在交付里指出来，不要边做边改规格。

---

## §0 范围

用户裁决：只做**最小可换（A 档）**，即「能接任何 OpenAI 兼容端点」，**不做** provider 预设表、**不做** 多 key 并存、**不做** `reasoning_effort` 跨供应商适配。

**默认模型一个都不换**：`ai.provider.model` 仍 `glm-5.3-flash`，`ai.chat.model` 仍 `glm-4.7-flashx`。换模型名是用户在设置页自己做的动作，本单只提供「能改」的能力，不替用户改默认值。

**明确不做（越界即返工）：**

- 不改 `ai.provider.name` 的类型。它现在仍是字面量 `'zhipu'`，本单**不启用**这个字段（它至今全仓 0 处读取，本单也不新增读取）。只在注释里写清「预留，未启用」。
- 不加 provider 下拉、不加「测试连接」按钮、不加任何网络探测。
- 不做多 key 并存（`ai-key.bin` 仍是单文件）。
- 不碰 `chatJson` 的重试、`reasoning_effort` 的下发逻辑。
- 不改 `CHAT_MAX_TOKENS`（8000）与 `CHAT_TIMEOUT_MS`（60s）。

---

## §1 新增配置 key：`ai.baseUrl`

`src/shared/types/ipc.ts` 的 `AppSettings` 新增一个 key（**第 20 个**）：

- 键名：`'ai.baseUrl'`
- 类型：`string`
- 语义（**必须写进注释，这是本单最容易出错的点**）：**基址**，**不含** `/chat/completions`。客户端负责拼路径。
- 默认值：`'https://open.bigmodel.cn/api/paas/v4'`

注释里要写清两件事：

1. 这是基址不是完整 URL；完整 URL 由 `glmClient` 的 `endpointOf()` 拼出。
2. 这是本单可换供应商的唯一开关；`ai.provider.name` 仍是死字段。

`src/main/db/defaultSettings.ts`：

- `DEFAULT_SETTINGS` 加 `'ai.baseUrl': 'https://open.bigmodel.cn/api/paas/v4'`。
- 文件头注释「19 个 key」改为 **20 个 key**。

> 为什么要拆基址和路径：智谱的基址是 `https://open.bigmodel.cn/api/paas/v4`，DeepSeek 的基址是 `https://api.deepseek.com`，两家拼上 `/chat/completions` 都正确。若把完整 URL 当配置项，用户换域名时极易漏掉路径段而得到 404。

---

## §2 `glmClient` 接上可配置基址

`src/main/ai/glmClient.ts`：

1. `GLM_BASE_URL` 常量的值改为**基址** `'https://open.bigmodel.cn/api/paas/v4'`（去掉 `/chat/completions`）。
2. 新增导出函数 `endpointOf(baseUrl: string): string`。规格：
   - 先 `trim`；
   - 去掉**尾部所有** `/`；
   - 结果为**空串**时，回落 `GLM_BASE_URL` 再走一遍；
   - 若结果**已以 `/chat/completions` 结尾**，原样返回（幂等，避免拼成双路径）；
   - 否则拼 `'/chat/completions'`。
   - 不做协议校验（那是 guard 的职责，见 §6）。
3. 构造函数里 `this.baseUrl` 改为 `endpointOf(options.baseUrl ?? GLM_BASE_URL)`。**其余字段与逻辑一个字不动。**
4. 两个请求方法（`request` / `requestText`）仍然 POST 到 `this.baseUrl`，不改。

> 幂等那一条不是防御性冗余：用户按住默认值改成别的域名后，很可能把路径一起留在里面。拼成 `.../chat/completions/chat/completions` 只会得到一个 404，且报错信息看不出原因。

---

## §3 `aiService` 传 baseUrl 并纳入缓存 key

`src/main/services/aiService.ts` 的 `parseProvider()` 与 `chatProvider()`：

- 各读一次 `settingRepo.get('ai.baseUrl')`，传给 `new GlmClient({ apiKey, model, baseUrl })`。
- **两个缓存 key 的字符串都要把 baseUrl 拼进去**（现在分别是 `${apiKey}|${model}|parse` 与 `${apiKey}|${model}|chat`）。不拼的话，用户改完地址下一轮仍然拿旧 client，表现为「保存了但没生效」，而且重启才恢复。
- `chatProvider` 仍需保留 `timeoutMs: CHAT_TIMEOUT_MS`，`parseProvider` 不加 timeout（走默认 180s）。

`currentProvider()` / `backgroundProvider()` 不改。

---

## §4 默认模型：一个都不改

`DEFAULT_SETTINGS` 里两个模型名**保持原值不动**：`ai.provider.model` = `glm-5.3-flash`，`ai.chat.model` = `glm-4.7-flashx`。

`src/shared/types/ipc.ts` 里 `'ai.chat.model'` 那段注释（含「默认 `glm-4.7-flashx`」那句）**原样保留**，不删不改。

本单只让用户**能在设置页改**模型名，不预设改成哪个。用户填什么就是什么；填错了是用户自己的选择，系统不纠、不猜、不回落。

---

## §5 设置页：三个字段可编辑

入口已经齐了 —— `app.setSetting` 通道、guard、registry、preload 全都现成（HUD 的 `hud.background` / `hud.opacity` 就在用）。**不要新开通道。**

### §5.1 `useSettingsData.ts`

- `SettingsModels` 接口加 `baseUrl: string`；`useState` 初值加 `baseUrl: ''`。
- 拉数据时从 `bootstrapRes.data.settings['ai.baseUrl']` 取值，与现有两个模型名一并 `setModels`。
- 新增 `aiSaving: boolean` 状态 + `saveAiConfig(next: SettingsModels): Promise<boolean>`：
  - 逐条比较 `models` 与 `next`，**只提交真正改动的字段**（没改的不发请求，避免无谓的 `app.setting.changed` 广播）。
  - 三条写入**串行** `await`（`window.api.app.setSetting`），任一条 `!res.ok` 立即停止并 `setAiError(错误信息)`，返回 `false`。
  - 全部成功后：`setModels(next)`、复用现有 `flashNotice()`、返回 `true`。
  - 写入顺序：`ai.baseUrl` → `ai.provider`（仅 model 变化时整对象写 `{ name: 'zhipu', model }`）→ `ai.chat.model`。
- `SettingsData` 接口导出 `aiSaving` 与 `saveAiConfig`。

### §5.2 `SettingsDrawer.tsx` 的 `AiBlock`

现有三行 `settings-kv`（任务模型 / 聊天模型 / API Key）里，**前两行**的 `settings-kv-value` 那个 `<span>` 换成 `<input>`：

- `className="settings-input"`、`type="text"`、`autoComplete="off"`、`spellCheck={false}`
- 输入受控，值来自组件内的草稿 state（初值取 `data.models`，`data.models` 变化时同步刷新，**否则外部改完会拿旧值覆盖新值**）

新增**第三行** `settings-kv`：标签文字 `接口地址`，同样是一个 `<input className="settings-input">`，绑 `baseUrl`。

标签文字**只允许**上面三个：`任务模型` / `聊天模型` / `接口地址`。

**硬规定（违反即返工）：**

- **不许加 placeholder、不许加说明文字、不许加提示语、不许加图例注释。** 输入框只显示用户自己的值。
- 不解释「基址含不含路径」，不解释「格式要求」。校验失败时只显示 guard 返回的那句错误文案。
- **不要给这三个 input 加 `aria-label`。** 每行左侧已有可见文字标签，再加一个只会多出一条中文字面量。只有顶部那个没有可见文字的 key 输入框保持原状，不动。
- **`SettingsDrawer.tsx` 里不许出现 `window.api`。** 所有 IPC 调用都必须在 `useSettingsData.ts` 里，Drawer 只调 `data.saveAiConfig`。

> 后两条不是洁癖：`tests/renderer/settingsWiring.test.ts` 有一条中文文案白名单（第 66–99 行），Drawer 里任何新的中文字面量/JSX 文本都会让那条断言红；同一文件还有 `expect(DRAWER).not.toContain('window.api')`。见 §7 的对应行。

在这三行下面单独一行放一个保存按钮：

- 文字：`保存`
- `disabled` 条件：三字段与 `data.models` 全等（无改动）或 `data.aiSaving` 为真
- 点击 `void data.saveAiConfig(draft)`，返回 `true` 时把草稿对齐回 `data.models`
- 失败时用现有 `settings-error settings-error--block` 显示 `data.aiError`（**复用已有节点，不新建**）

**API Key 那一行与它自己的保存按钮保持原样不动。**

### §5.3 样式

只允许复用现有 class（`settings-kv` / `settings-input` / `settings-add`）。如果 `input` 放进 `settings-kv` 后宽度/对齐明显坏掉，**才**在 `settings.css` 加最小规则（让 input 撑满剩余宽度即可），不得改任何现有选择器，不得新增颜色/字号/间距的设计决策。

---

## §6 guard 校验（`setSettingSchema`）

`src/main/ipc/guards.ts` 的 `setSettingSchema.superRefine` 里，与 hud 三项平行再加两个分支。失败一律 `ctx.addIssue({ code: 'custom', path: ['value'], message })`，与现有写法一致。

- `input.key === 'ai.baseUrl'`：
  - 必须是 `string`，`trim()` 后非空；
  - 必须以 `http://` 或 `https://` 开头；
  - `new URL(trimmed)` 不得抛异常；
  - 失败文案：`接口地址必须是以 http:// 或 https:// 开头的完整地址`
- `input.key === 'ai.chat.model'`：
  - 必须是 `string`，`trim()` 后非空；
  - 失败文案：`模型名不能为空`

`ai.provider` **不加**校验（对象型，本单不开放编辑）。未知 key 仍由 `settingRepo.set` 抛 `INVALID_INPUT`，不要在这里重复实现。

---

## §7 白名单（逐文件动作）

| 文件 | 动作 |
|---|---|
| `src/shared/types/ipc.ts` | `AppSettings` 加 `'ai.baseUrl'`（含语义注释）。`ai.chat.model` 那段注释**不动** |
| `src/main/db/defaultSettings.ts` | 加 `ai.baseUrl` 默认值；头注释 19 → 20。**两个模型名的默认值一个字都不改** |
| `src/main/ai/glmClient.ts` | `GLM_BASE_URL` 改基址；新增导出 `endpointOf()`；构造函数接上 |
| `src/main/services/aiService.ts` | 两个 provider 读 `ai.baseUrl` 并传参；两个缓存 key 拼上 baseUrl |
| `src/main/ipc/guards.ts` | `setSettingSchema` 加 `ai.baseUrl` / `ai.chat.model` 两条校验 |
| `src/renderer/main/features/settings/useSettingsData.ts` | `SettingsModels` 加 `baseUrl`；新增 `aiSaving` / `saveAiConfig` |
| `src/renderer/main/features/settings/SettingsDrawer.tsx` | `AiBlock` 前两行改 input、新增接口地址行、加保存按钮 |
| `src/renderer/main/features/settings/settings.css` | **仅必要时**加最小宽度规则，不改现有选择器 |
| `tests/renderer/settingsWiring.test.ts` | `const ALLOWED = new Set([...])` 那个集合里**加一个 `'接口地址'`**。`'保存'` / `'任务模型'` / `'聊天模型'` 已在集合里，不用动。**其余断言一条都不许动**，特别是 `not.toMatch(/placeholder/)` 与 `not.toContain('window.api')` |
| `tests/db/settings.test.ts` | 第 17 行那条 it 的标题「19 个 key」→「20 个 key」（断言本身走 `SETTING_KEYS`，不用改） |
| `tests/renderer/tasksModel.test.ts` | 第 226 行附近的 mock settings 对象补 `'ai.baseUrl'`（否则类型不过） |
| `tests/ai/glmClient.test.ts` | 新增 `endpointOf` 三条 |
| `tests/ipc/handlers.test.ts` | 新增 `ai.baseUrl` 校验一条 |

**白名单之外的文件一律不要改。** 尤其是：`chat.ts`、`review.ts`、`parse.ts`、`provider.ts`、`channels.ts`、`preload/index.ts`、`registry.ts` —— 本单对它们零改动。

---

## §8 测试（+4，799 → 803）

1. `glmClient.test.ts` — `endpointOf`：
   - `'https://api.deepseek.com'` → `'https://api.deepseek.com/chat/completions'`
   - `'https://api.deepseek.com/'`（尾斜杠）→ 同上，不出现 `//chat`
   - `'https://x/v1/chat/completions'` → 原样返回（幂等，不拼第二次）
2. `handlers.test.ts` — `app.setSetting` 写 `ai.baseUrl`：
   - `'ftp://x'` 与 `'not-a-url'` 被拒（`INVALID_INPUT`）
   - 合法值通过且能读回

**不许动任何现有测试的断言**，除了 §7 里那三处（`settings.test.ts` 标题文字、`tasksModel.test.ts` mock 补字段、`settingsWiring.test.ts` 白名单加一个词）。

> 特别提醒：本仓有一批**读源码字符串**的接线测试（`tests/renderer/*Wiring.test.ts`、`submitFlow.test.ts`）。它们用正则或中文白名单钉死渲染层的具体写法，**不通过 import 关系起作用**，因此「改了哪些文件、谁 import 它」这种扫描看不出来。本单只碰 `settings` 这一组，已在上表列全；若你发现还有别的 `*Wiring` 读 `SettingsDrawer` / `useSettingsData` 而被撞红，**停下来在交付里报，不要自行改断言**。

---

## §9 验收（短）

1. `npm run typecheck` 0 error；`npm run lint` 0 warning；`npm run build` 成功。
2. `npm test` → 69 文件 / **803 条**，仅 `chatBrief.test.ts > 3 条待办 + 2 条已完成` 一红（时间炸弹，历史遗留，不修）。
3. 不改任何配置时，行为与 59 完全一致：仍是智谱地址，两个模型名仍是 `glm-5.3-flash` / `glm-4.7-flashx`。

真机那几条（打开设置改地址并保存、聊天实际打到新地址）留给用户。

---

## §10 边界：只开一扇门，不修路

本单做的是「把地址和模型名变成可配置」，不是「把系统改造成多供应商体系」。以下都**不做**，见到了也不要"顺手"：

- 不做供应商能力探测（不问对方支不支持图片、支不支持 `reasoning_effort`）。用户填了不支持的端点，`chatJson` 该失败就失败，错误照常透出。
- 不做自动降级、不做自动回滚到智谱。
- 不重试 429，不改 `chatText` 的重试口径，不动 `CHAT_TIMEOUT_MS` / `CHAT_MAX_TOKENS`。
- 不校验模型名是否真的存在于对方平台（设置页填任意非空字符串都合法）。
- 不加任何日志、不加任何埋点。

> 换端点后若撞上 429 / 超时 / 空正文，那是端点本身的能力差异。本单已经让用户**能**改回来，改回来就好了。
