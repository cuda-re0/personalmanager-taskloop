# 47 · W10c：设置里填 API Key（v0.47）

> 基线：`75909ad`（W10b 已合入，工作区干净）。四命令 **63 文件 / 755 条**（754 绿，1 红为基线自带的 chatBrief 时间炸弹，与本病无关，**不许碰**）。
> 这一单只给设置抽屉的 AI 块加**一个密码框 + 一个保存按钮**，多一条通道。**只准动 §6 白名单里的 13 个文件。**

---

## 执行须知（施工方必读）

**你现在的角色是施工方。** 这份文档是**已经定稿的施工指令**，由架构方写好、用户转交给你，不是草稿、不是参考资料、不是征询意见的方案。

1. **直接照它改代码。** 读完就开始动手，不要先产出一份"实施方案""评审意见""任务拆解"。
2. **不要重写、扩写、重新生成这份施工单。** 不要新建 `docs/kickoff/*` 下的任何文件，不要重排章节。你产出的是**代码改动**，不是文档。
3. **不要和单子商量。** 裁决、白名单、常量、禁用项都是已经拍板的。有疑问按字面执行；实在无法执行的，在交付里如实说明，**不要自行替换成你更喜欢的设计**。
4. **交付格式固定**（§9）：`git diff --stat` + §8 自检逐条实测结果 + 一行「哪几条验收我没法自己点」。不要复述单子内容，不要写"我将要做…"的计划。
5. **不要提交**，等架构方核完再按单号提交。

---

## 0. 一句话目标

设置抽屉的 AI 块从「三行只读」变成「三行只读 + 一行可填」：用户能粘贴 Key、点保存，写进 `userData/ai-key.bin`（safeStorage 加密），保存后那一行状态变成「已配置」。**不验证连通性、不显示 Key 的回显片段、不提供"清除"按钮。**

## 1. 现状（读这段，别自己摸）

- `src/main/ai/config.ts` 里 `writeKey(key: string): boolean` **已经实现好了**：trim、空值返回 `false`、`safeStorage` 不可用时拒绝写明文并返回 `false`、成功则 `safeStorage.encryptString` 写 `userData/ai-key.bin`。**不要改它的逻辑**，只改它文件头那句已经过时的注释（§2.6）。
- `readKey()` 每次调用都重新读文件，所以**写完立即生效，不需要重启应用**。
- `aiService.keyStatus(): { configured: boolean }` 是只读状态通道（`CH.ai.keyStatus`），判据是 `isConfigured()`。
- 设置抽屉 = `SettingsDrawer.tsx`（314 行起是 ③ AI 块，`AiBlock`）+ `useSettingsData.ts`（数据与动作）。AI 块现在是三个 `settings-kv`：`任务模型` / `聊天模型` / `API Key`（值是 `已配置` 或 `未配置`）。
- 样式**全都有现成的**：`.settings-add-row`（flex 行）+ `.settings-input`（含 :focus）+ `.settings-add`（含 :disabled）。**这一单不改 CSS，一行都不加。**
- 文案白名单 `tests/renderer/settingsWiring.test.ts` 的 `ALLOWED` 里**已经有** `保存`、`已配置`、`未配置`、`API Key`。所以**必须做到"零新增中文串"**，那条断言才不会红。

## 2. 设计规格

### 2.1 新通道 `ai:setKey`

| 文件 | 动作 |
|---|---|
| `src/shared/channels.ts` | `ai` 域内、`keyStatus` **之后**加 `setKey: 'ai:setKey'` |
| `src/shared/types/ipc.ts` | `ai` 接口内、`keyStatus()` **之后**加 `setKey(key: string): Promise<IpcResult<{ configured: boolean }>>` |
| `src/preload/index.ts` | `ai` 命名空间内、`keyStatus` **之后**加 `setKey: (key: string) => invoke<{ configured: boolean }>(CH.ai.setKey, { key })` |
| `src/main/ipc/guards.ts` | `g` 里 `keyStatus: z.undefined(),` 之后加 `setKey: z.object({ key: z.string().max(200) }),`；查表里 `[CH.ai.keyStatus]` 之后加 `[CH.ai.setKey]: g.setKey` |
| `src/main/ipc/registry.ts` | `row(CH.ai.keyStatus, …)` **之后**加 `row(CH.ai.setKey, g.setKey, input => aiService.setKey(input.key))`；头部注释计数与枚举同步（§2.5） |

语义：**唯一副作用是写文件。不广播事件、不落库、不发网络请求、不触发任何 AI 管线。**

- 守卫只拦**类型与长度上限 200**，**不写 `.min(1)`**：空串由 service 判（否则守卫的通用句「请求参数格式不正确」会把可读文案换掉）。
- 返回值用**写入后重算**的 `{ configured: isConfigured() }`，不是硬编码 `true`——`writeKey` 返回 `false` 时这条根本走不到（会抛），但让返回值和真实状态同源，别处不用猜。

### 2.2 `src/main/services/aiService.ts` 新增 `setKey`

放在 `keyStatus()` **之后**、`health()` **之前**，导出 `setKey(key: string): { configured: boolean }`。规则（**伪代码，实现你自己写**）：

```
1   trimmed = key.trim()
2   若 trimmed 为空        → 抛 AppErrorException('INVALID_INPUT', 'API Key 不能为空')
3   若 writeKey(trimmed) === false → 抛 AppErrorException('INVALID_INPUT', 'API Key 保存失败')
4   返回 { configured: isConfigured() }
```

三条硬约束：

1. **任何日志、异常 `detail`、错误 message 里都不许出现 key**，连前 6 位都不许（03 §9.7 末条）。本函数**不许有任何 `console.*`**。
2. **错误 message 就是上面两句原话**，一个字都别改、别加标点、别加解释。它们要登记进 04 §1.1 的文案表，改了表就对不上。
3. **不做回滚**：`writeKey` 只在写失败时返回 false（此时文件没被写），覆盖写成功就是成功；不做"写前备份旧 key"。

导入：`writeKey` 与 `readKey` 同源，加进文件顶部已有的 `import { readKey } from '../ai/config'` 那一行（改成 `import { readKey, writeKey } from '../ai/config'`）。`AppErrorException` 已经导入过了。

### 2.3 `useSettingsData.ts`

1. 新增状态 `keySaving: boolean`，初值 `false`。
2. `SettingsData` 接口新增：
   - `keySaving: boolean`
   - `saveKey(key: string): Promise<boolean>` —— **返回 `true` = 保存成功，调用方清空输入框**（与 `addMemory` 同款契约）。
3. `saveKey` 实现规则：
   - 开始前 `setAiError(null)`、`setKeySaving(true)`；`finally` 里若 `mounted.current` 则 `setKeySaving(false)`。
   - 成功后 `setConfigured(res.data.configured)`（**用返回值，不要硬编码 true**），返回 `true`。
   - `!res.ok` → `setAiError(res.error.message)`，返回 `false`。
   - `catch` → `console.error('[settings] ai.setKey 调用失败', e)`，把 `e` 的 message 塞进 `aiError`，返回 `false`。
   - **不许 `console.log(key)` / 不许把 key 放进任何一条日志**。
4. 文件头注释里「打开即并发拉四份…三条读通道」那段不用改（读通道没变），但两块注释里凡提到「AI 块只读」的说法要同步成「前两行模型 + 一行状态只读，下面一行可填 Key」。

### 2.4 `SettingsDrawer.tsx` 的 `AiBlock`

1. `AiBlock` 里加**一个本地 `useState` 存草稿**（`keyDraft`），不放进 `useSettingsData`——草稿是纯 UI 状态，抽屉一关就该消失（`useSettingsData` 的注释已经把"不做乐观更新"写死了，别把表单草稿混进去）。
2. 在第三个 `settings-kv`（API Key 那行）**之后**、`aiError` 之前加：

   ```
   <div className="settings-add-row">
     <input
       className="settings-input"
       type="password"
       autoComplete="off"
       spellCheck={false}
       value={keyDraft}
       onChange={e => setKeyDraft(e.target.value)}
     />
     <button
       type="button"
       className="settings-add"
       disabled={keyDraft.trim().length === 0 || data.keySaving}
       onClick={() => { void data.saveKey(keyDraft).then(ok => { if (ok) setKeyDraft('') }) }}
     >
       保存
     </button>
   </div>
   ```

3. **禁止**：placeholder、`aria-label`、`title`、tooltip、图标、"（输入后立即生效）"之类的说明文字、`maxLength` 之外的任何提示、显示 Key 前后几位。**这一行上的中文只有按钮的「保存」两字**，别的一律没有。
4. AI 块头部注释（第 313–315 行那块）「③ AI（三行只读，没有输入框、没有修改入口）」必须改——**它现在是假话**。改成「③ AI（前两行模型 + 一行 Key 状态只读，下面一行可填 Key）」，一句话，不要展开讲理由。

### 2.5 `registry.ts` 头部注释

文件头列举各版本通道的那段（含 `/* ---------------- ai（5：W4 四条 + v0.44 keyStatus） ---------------- */`）同步：

- `ai（5…）` → `ai（6：W4 四条 + v0.44 keyStatus + v0.47 setKey）`
- 文件头「只接 WIRED 里的 56 条」→ **57 条**，枚举里补一句「v0.47 起 `ai.setKey`」。
- `grep -c "row(CH\."` 必须变成 **57**。

### 2.6 `src/main/ai/config.ts` 只改注释

`writeKey()` 上方 doc 注释里那句「只留给将来的设置页：**不许注册成 IPC**」已经过时，改成「v0.47 起由 `ai.setKey` 调用（经 `aiService.setKey` 转一手）。本文件仍不直接注册通道。」

**逻辑一个字不许动**（`trim`、空值、`encryptionAvailable` 拒绝明文、`mkdirSync`、`mode: 0o600` 全部保持原样）。

## 3. 不许做的事

1. **不许新增任何界面中文串。** `tests/renderer/settingsWiring.test.ts` 的 `ALLOWED` 不许动一个字符——它绿着，就证明这一单没多出一个字。如果你发现必须加白名单才能过，说明你多写了字，回去删掉。
2. **不许在 AI 块加"测试连接 / 验证 Key"按钮。** 验证会真发一次带图请求（`ai.health()` 会探测多模态），那是要花钱的动作，不能在保存按钮旁边顺手做。
3. **不许加"清除 Key"按钮。** 覆盖写就是改，删掉 key 没有需求。
4. **不许回显 Key**：`ai.keyStatus` 不返回任何片段，保存后输入框**直接清空**（不保留掩码后的 `sk-***`）。
5. **不许把 Key 写进 `settingRepo` / 数据库 / bootstrap。** 它只存在于 `userData/ai-key.bin`。
6. **不许碰 chatBrief 的失败测试**（§0 里说的那条基线红），也不许为了让它绿去改 `chatBrief.ts`。

## 4. 已知边界（写在这里，别去修）

- `safeStorage` 不可用（Linux 无 keyring 之类）时保存必然失败，报「API Key 保存失败」。**不降级成明文**，这是 `config.ts` 的既有裁决，不动。
- 开发期 `readKey()` 本来就会读到 `.env.local` / `process.env`，所以开发版里这一行填不填都显示「已配置」。**这条功能真正起作用的是打包版**（打包版不读 `.env.local`）。
- 保存后 `isConfigured()` 仍为 `false` 只可能出现在"写了但读不出"的极端情况（换 OS 账号后旧文件解不开），本单不处理。

## 5. 测试

新增 `tests/main/aiSetKey.test.ts`，**只两条**：

1. 空串与纯空格 → `setKey('')` / `setKey('   ')` 都抛错，且 `error.message === 'API Key 不能为空'`。
2. 非 Electron 测试宿主下（`safeStorage` 不可用）→ `setKey('sk-test-123')` 抛错，`error.message === 'API Key 保存失败'`，并且**断言抛出的 message 里不含 `sk-test`**（守住"不许回显 key"这条）。

> 第 2 条的成立依据：测试宿主里 `app` / `safeStorage` 是 `undefined`，`encryptionAvailable()` 返回 false，`writeKey` 必然返回 false。这条是稳定断言，不是碰运气。

`tests/ipc/*.test.ts` 只改三个数字（§6 第 10–12 项），**不许新增用例**。

## 6. 白名单（13 个文件）

**新增 1**：`tests/main/aiSetKey.test.ts`

**改动 12**

| # | 文件 | 动作 |
|---|---|---|
| 1 | `src/shared/channels.ts` | `ai.setKey` 一行 |
| 2 | `src/shared/types/ipc.ts` | `ai.setKey` 一行 |
| 3 | `src/preload/index.ts` | `ai.setKey` 一行 |
| 4 | `src/main/ipc/guards.ts` | schema + 查表两处 |
| 5 | `src/main/ipc/registry.ts` | 一行 row + 头部注释两处 |
| 6 | `src/main/services/aiService.ts` | `setKey()` + import 加 `writeKey` |
| 7 | `src/main/ai/config.ts` | **只改 doc 注释**（§2.6） |
| 8 | `src/renderer/main/features/settings/useSettingsData.ts` | `keySaving` + `saveKey` + 两处注释 |
| 9 | `src/renderer/main/features/settings/SettingsDrawer.tsx` | `AiBlock` 加一行 + 改头部注释 |
| 10 | `tests/ipc/handlers.test.ts` | `56` → `57` |
| 11 | `tests/ipc/hudChannels.test.ts` | `56` → `57` |
| 12 | `tests/ipc/registry.test.ts` | `56` → `57` + 标题补 "v0.47 起 ai.setKey" |

**不许碰**：`src/renderer/main/features/settings/settings.css`、`tests/renderer/settingsWiring.test.ts`、`src/main/db/**`、`src/main/services/chatBrief.ts` 与其测试、`src/renderer/hud/**`、`src/main/autoStart.ts`、根目录 `.cmd`、`docs/**`。

## 7. 自检（照抄，逐条实测后填）

- [ ] 四命令绿；基线 **63 文件 / 755 条**（754 绿 1 红），本单条数如实填（预期 64 文件 / 757 条，仍是 1 红）
- [ ] `grep -c "row(CH\." src/main/ipc/registry.ts` → **57**
- [ ] `grep -rn "'ai:setKey'" src/ | wc -l` → **1**（只有 `channels.ts` 的定义；别处一律引 `CH.ai.setKey`）
- [ ] `grep -rn "writeKey" src/ | wc -l` → 如实报（预期「1 处定义 + 1 处 import + 1 处调用」，另有注释提及）
- [ ] `setKey` 函数体内 `console.*` → **0**
- [ ] `git diff --stat` 里 `settings.css`、`settingsWiring.test.ts` → **没有出现**
- [ ] `tests/renderer/settingsWiring.test.ts` 未改动且**绿**
- [ ] `git status --porcelain` → 只有 §6 的 13 个文件

## 8. 验收（3 条，别做分子料理）

> 第 2、3 条必须用**打包版**（`dist\taskloop\taskloop.exe`）验——开发版会从 `.env.local` 读到 key，永远显示「已配置」，验不出真假。

1. 打开设置抽屉 → AI 块最下面一行是密码框 + 灰色「保存」按钮（空输入时点不动）。
2. 打包版里先确认 AI 块显示「未配置」→ 粘贴真 Key → 点保存 → **输入框清空**、上面那行变成「已配置」；**不重启**，直接发一句话建任务，能通。
3. 输入框里只有空格 → 「保存」按钮保持灰色。

## 9. 交付

贴 `git diff --stat` + §7 自检结果 + 一行「哪几条验收我没法自己点」。**不要提交**，等我核完。

改了白名单以外的文件，不管多合理都按越界报，写清为什么必须动。

---

## 交付实况（架构方补记，2026-11-01）

- 施工方交付：12 改 + 1 新，四命令 typecheck ✓ / eslint 0 / build ✓ / test **64 文件 757 条**（756 绿，1 红仍是 chatBrief 时间炸弹）。自检计数全部对上（`row(CH.` 57、`ai:setKey` 字面量 1 处 + 3 处常量引用）。
- **一处施工方如实上报、由架构方补做**：`config.ts:18` 那句「`writeKey()` 只导出、不注册 IPC：v1 没有设置页」在 v0.47 之后是假话，而 §2.6 只授权改 `writeKey()` 上方的 doc 注释，白名单漏了这里。架构方自行改掉（假注释会误导后续会话）。
- **验收由架构方实跑，未麻烦用户**：`--user-data-dir=%TEMP%\tl-verify` 启动打包版 → AI 块 `未配置`、密码框在、`[保存]` 默认灰 → 纯空格仍灰 → 填 `sk-verify-fake-123` 按钮可用 → 保存后输入框清空、第三行变 `已配置`、临时目录出现 `ai-key.bin`（49 B 密文）→ 杀进程重启后 `keyStatus` 仍 `configured: true`。验完删临时目录，**没碰真实 `%APPDATA%\taskloop`**。
