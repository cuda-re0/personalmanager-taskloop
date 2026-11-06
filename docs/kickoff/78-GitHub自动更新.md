**你是施工方，不是架构方。下面这份是给你的执行指令，直接照它改代码。**

---

# 78 · 更新改从 GitHub 拉（自动下载 + 替换 + 重启）

## 背景（一句话）

仓库 `https://github.com/cuda-re0/personalmanager-taskloop` 已公开、master 已推。现在更新只认 exe 同级的 `updates/` 目录，要换成本机去 GitHub 取最新 Release，自动下载、替换 `resources/app`、重启。

## 执行须知（施工方必读）

1. 你是施工方，不是架构方。本文档是执行指令，读完直接改代码；不要重写/扩写本单，不要新建 `docs/kickoff/*`，不要先产出“实施方案/评审意见”。
2. **不装任何 npm 依赖**。尤其不许 `electron-updater`、`adm-zip`、`extract-zip`——载荷用 JSON + base64，Node 自带能力就够。
3. 测试**一律不联网**：网络层用参数注入的假 `fetch`，单测里不许真打 GitHub。
4. 只碰 A 节白名单的 9 个文件。不碰渲染层，不改 `CheckResult` 形状，不改设置页任何文案。
5. 交付只贴 `git diff --stat` + 自检结果 + 未能自验的条目，不要复述单子内容。
6. 本单占版本号 **0.75.0**（71 顺延 0.76.0）。

## A 文件白名单（9 个）

**A1. 新建 `src/main/update/github.ts`**
**A2. 新建 `src/main/update/payload.ts`**
**A3. 改写 `src/main/update/updateService.ts`**
**A4. `src/main/index.ts`**（一行）
**A5. `src/main/ipc/registry.ts`**（一行）
**A6. 新建 `scripts/make-payload.mjs`**
**A7. `package.json`**（版本号 + 一个脚本）
**A8. 改写 `tests/main/updateService.test.ts`**
**A9. 新建 `tests/main/updatePayload.test.ts`**

## B 规格

### B1 `github.ts`

```ts
const OWNER = 'cuda-re0'
const REPO = 'personalmanager-taskloop'

export interface ReleaseInfo { version: string; payloadUrl: string }
export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<ReleaseInfo>
export async function downloadPayload(url: string, fetchImpl: typeof fetch = fetch): Promise<string>
```

`fetchLatestRelease`：
- `GET https://api.github.com/repos/{OWNER}/{REPO}/releases/latest`
- 必须带两个头：`Accept: application/vnd.github+json`、`User-Agent: taskloop-updater`（GitHub 无 UA 会 403）
- 超时 **10 秒**（`AbortController` + `setTimeout`，超时后 `abort()`，并在 `finally` 里清定时器）
- `res.ok !== true` → `throw new Error(\`GitHub 返回 ${res.status}\`)`
- 取 `tag_name`：`string` 才能用；去掉前导 `v` / `V` 再 `trim()`；空串 → throw
- 在 `assets[]` 里找 `name === 'payload.json'`，取 `browser_download_url`；找不到 → throw
- 返回 `{ version, payloadUrl }`

`downloadPayload`：
- `GET url`，同样带 `User-Agent: taskloop-updater`
- 超时 **60 秒**
- `!res.ok` → throw；返回 `await res.text()`

### B2 `payload.ts`

```ts
export interface UpdatePayload { version: string; files: Record<string, string> }
export function parsePayload(raw: string): UpdatePayload      // 抛错即视为无效包
export function writePayloadTree(payload: UpdatePayload, targetDir: string): number
```

`parsePayload` 的校验，任一不满足就 throw 一句中文消息：
- `JSON.parse` 失败 / 结果不是对象 / 是数组
- `version` 不是非空字符串
- `files` 不是普通对象，或键数量为 0
- 每个键：**不许**含 `..` 路径段、**不许**以 `/` 或 `\` 开头、**不许**匹配 `/^[A-Za-z]:/`、**不许**含反斜杠
- 每个值：必须是非空字符串（base64）

`writePayloadTree`：
- 逐个键 `resolve(targetDir, key)`，再校验结果 `startsWith(resolve(targetDir) + sep)`；越界就跳过并 `console.warn`，**不许抛**
- `mkdirSync` 建父目录，`Buffer.from(value, 'base64')` 写入
- 返回实际写入的文件数

### B3 `updateService.ts`

**删掉**：`UPDATE_DIR`、`readManifest()`。
**保留不动**：`compareVersion`、`segmentsOf`、`readState` / `writeState`、`versionOf`、`copyTree`、以及 `applyUpdate` 里那段同步换装与回滚逻辑（先 `relaunch` 再 `destroy` 窗口再改名拷贝那条顺序一个字不能改，理由见文件里既有注释）。

新增模块级变量：

```ts
let pending: { version: string; url: string } | null = null
```

`checkUpdate(options)` 改成：
1. `current = app.getVersion()`
2. `try { const r = await fetchLatestRelease() } catch (e)`：
   - `options.manual === true` → **throw** `new Error('检查更新失败：无法访问 GitHub')`（设置页会把 message 原样显示成提示，不需要改渲染层）
   - 自动路径 → `console.error('[update] 查询 GitHub 失败', e)`，返回 `{ current, latest: null, hasUpdate: false, applying: false }`
3. `hasUpdate = compareVersion(r.version, current) > 0`；不新 → 返回带 `latest: r.version`
4. 自动路径且 `readState().attemptedVersion === r.version` → 返回 `{ hasUpdate: true, applying: false }`（保持现有防重启循环语义）
5. `writeState({ attemptedVersion: r.version })`，写失败则不装（保持现有行为）
6. `pending = { version: r.version, url: r.payloadUrl }`
7. 返回 `{ current, latest: r.version, hasUpdate: true, applying: true }`

`applyUpdate()` 改成 `async`：
1. `pending === null` → 直接 return（**不 relaunch**）
2. 取 `{ version, url }` 后**立刻** `pending = null`
3. `staging = join(app.getPath('userData'), 'update-staging')`；先 `rmSync(recursive)` 再 `mkdirSync`
4. `raw = await downloadPayload(url)`；`payload = parsePayload(raw)`
5. `payload.version !== version` → 记日志、清 staging、**`writeState({ attemptedVersion: null })`**、return
6. `writePayloadTree(payload, staging)`
7. 之后进入**原有的同步换装段**，逻辑与顺序一行不改，唯一区别：`copyTree` 的源从 `updates/app` 换成 `staging`，校验目标版本用 `version`
8. 第 4~7 步任何一步抛错：清 staging、`writeState({ attemptedVersion: null })`、`console.error`、return——**不 relaunch、不 destroy 窗口、不 quit**

关于第 5、8 步清标记：此时**根本没重启**，不存在死循环风险；不清标记会让一次网络抖动永久挡死这一版的自动更新，只能等下一版。

### B4 `index.ts`（一行）

`if (result.applying) applyUpdate()` → `if (result.applying) void applyUpdate()`

### B5 `registry.ts`（一行）

`setTimeout(() => applyUpdate(), 2000)` → `setTimeout(() => { void applyUpdate() }, 2000)`

### B6 `scripts/make-payload.mjs`

- 输入固定 `dist/taskloop/updates/app`（`npm run pack` 的产物）；目录不存在 → 报错「先跑 npm run pack」并 `process.exit(1)`
- 递归收集 `out/**` 与 `package.json`，键用**正斜杠**相对路径（如 `out/main/index.js`）
- 值 = 文件内容 base64
- `version` 取自该目录 `package.json`
- 输出 `dist/release/payload.json`（目录不存在就建），UTF-8、不换行美化
- stdout 打印三行：`version: x.y.z`、`files: N`、`size: N KB`

### B7 `package.json`

- `version` → `0.75.0`
- 新增脚本：`"release": "npm run build && npm run pack && node scripts/make-payload.mjs"`

### B8 `tests/main/updateService.test.ts`（改写）

- **保留** `compareVersion` 那三条 `it` 原样不动
- **删除** `readManifest` 的 describe
- 顶部两个 mock：`vi.mock('electron')` 提供 `app.getVersion()`（返回 `'0.75.0'`）与 `app.getPath('userData')`（指向 `os.tmpdir()` 下的临时目录）；`vi.mock('../../src/main/update/github')` 让 `fetchLatestRelease` / `downloadPayload` 由用例控制
- 新增四条：
  1. 远端 `0.99.0` → `hasUpdate: true`、`applying: true`
  2. 远端与当前同版本 → `hasUpdate: false`
  3. 自动路径下 `fetchLatestRelease` 抛错 → 返回 `hasUpdate: false`，**不抛**
  4. `manual: true` 下 `fetchLatestRelease` 抛错 → 抛

### B9 `tests/main/updatePayload.test.ts`（新建，五条）

1. 合法包解析出 `version` 与 `files`
2. 键含 `../evil` → throw
3. 键是绝对路径（`/etc/x`、`C:/x`）→ throw
4. `version` 为空串 → throw
5. `writePayloadTree` 写到临时目录：落盘内容等于 base64 解码结果，越界键不落盘（在临时目录里断言文件存在与否），测完删临时目录

## C 明确不做（越界即返工）

- 不引任何依赖、不做增量 diff、不做签名校验、不做 beta / 多通道
- 不保留本地 `updates/` 回退路径，`readManifest` 直接删——两套来源并存会让“为什么没更新”变成猜谜
- 不改 `CheckResult`、不改设置页文案与按钮逻辑、不新增可见文字
- 不在代码里自动创建 GitHub Release（发布由架构方手动上传 `payload.json`）

## D 验收（三条）

1. `npm run typecheck`、`npm run lint` 全绿；`npm test` 除 `tests/main/chatBrief.test.ts:74` 那条历史红外全过（基线 832 条）。
2. `npm run release` 在 `dist/release/payload.json` 生成载荷，`version` 与 `package.json` 一致，体积约 1.1 MB（`out/` 828 KB 的 base64）。
3. 拔网线或仓库无 Release 时启动：不弹窗、不卡、旧版照跑，主进程日志里有 `[update]` 记错；设置页点「检查更新」显示「检查更新失败：无法访问 GitHub」。

## E 发布流程（写进文档，不是代码）

1. `npm run release`
2. GitHub → Releases → Draft a new release → tag 填 `v0.75.0`（**必须与 `package.json` 一致**，前面带不带 v 都行，程序会剥掉）→ 上传 `dist/release/payload.json` → Publish
3. 之后每次改版本号重复 1~2；客户端启动 8 秒后自动检查、下载、替换、重启

**已知过渡问题**：当前装着 0.74.0 的程序只认本地 `updates/`，看不到这次改造。所以 0.75.0 这一版需要**手动装一次 zip**，从 0.76.0 起才会自动更新。
