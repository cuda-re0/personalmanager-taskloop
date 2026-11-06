**你是施工方，不是架构方。下面这份是给你的执行指令，直接照它改代码。**

---

# 78b · 更新检查改走 Chromium 网络栈 + 错误分档

## 执行须知（施工方必读）

1. 你是施工方，不是架构方。本文档是执行指令，读完直接改代码；**不要重写/扩写本单**，不要新建 `docs/kickoff/*`，不要先产出"实施方案/评审意见"。
2. 只碰 §3 白名单的 4 个文件（含 1 个新建测试）。白名单之外一律不动。
3. 交付只贴 `git diff --stat` + 自检结果 + 未能自验的条目，不要复述单子内容。
4. 版本号见 §4。

---

## §0 为什么改（已取证，不要重新调研）

用户 2026-11-06 反馈：点「检查更新」提示「检查更新失败：无法访问 GitHub」，但浏览器能正常登录 GitHub。

已核实的四件事：

1. `C:\Windows\System32\drivers\etc\hosts` 里有 `# Steam++ Start` 段，其中 **`127.0.0.1 api.github.com`**（还有 `raw.githubusercontent.com`、`objects.githubusercontent.com` 等一整批）。
2. `127.0.0.1:443` 的监听进程是 **`Steam++.Accelerator`**。瓦特加速器（Steam++ / Watt Toolkit）的加速原理就是 hosts 指向本机 + 本地反向代理做 MITM。
3. 从这个 443 拿到的证书：`subject=CN=api.github.com`、**`issuer=CN=SteamTools Certificate, O=BeyondDimension, C=CN`**，`openssl` 校验报 `unable to verify the first certificate`（错误码 21）。即它用自己的根证书现签。
4. 浏览器能上是**因为浏览器读 Windows 受信任根证书库**，Steam++ 的根证书装在那儿；而 **Node.js 的 `fetch` 只用自带的 CA 列表，不读系统证书库**，握手直接失败。

**结论：`github.ts` 用的裸 `fetch` 是 Node 实现，信任链对不上，跟"有没有 Release""有没有登录"都无关。** 换成 Electron 的 `net.fetch`（Chromium 网络栈，读系统证书库、跟随系统代理）即可。

顺带一个独立缺陷：`checkUpdate` 把所有异常收成同一句话「无法访问 GitHub」，404（仓库一个 Release 都没发）与 TLS 失败在界面上完全分不出来。本单一并修掉。

---

## §1 `github.ts`：默认请求实现换成 `net.fetch`

### 1.1 现状

```ts
export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<ReleaseInfo>
export async function downloadPayload(url: string, fetchImpl: typeof fetch = fetch): Promise<string>
```

两个函数的默认参数都是裸 `fetch`。**保留 `fetchImpl` 形参**（单测靠它注入假 fetch），只换默认值。

### 1.2 要写成什么样

- 顶部 `import { net } from 'electron'`。**不要在模块顶层解构或调用 `net.fetch`**，只在默认实现里调——`net.fetch` 必须在 `app.ready` 之后才可用，模块加载时调用会抛。
- 新增一个模块级私有函数，签名与 `fetch` 兼容 `(input: string, init?: RequestInit) => Promise<Response>`，内部转发给 `net.fetch`。
- 两个导出的 `fetchImpl` 默认值都改成这个私有函数。
- 其余逻辑（10 秒 / 60 秒超时、`AbortController`、`Accept` 与 `User-Agent` 头、JSON 解析、asset 查找）**一行不改**。

### 1.3 两个已知细节，不要为它们改设计

- `net.fetch` 可能忽略自定义 `User-Agent`（Chromium 对部分头有保留）。**不影响功能**：GitHub API 认 Electron 自带 UA。不许为了"确保 UA 生效"去改 `session.setUserAgent` 或加额外配置。
- `net.fetch` 的返回是标准 `Response`，`.ok` / `.status` / `.json()` / `.text()` 行为与现在完全一致，不用改调用方。

---

## §2 错误分档（`github.ts` 抛带标记的错误，`updateService` 映射文案）

### 2.1 `github.ts`

给每条失败路径挂一个 `failure` 标记字段（普通 `Error` 上加属性即可，不必新建类）：

| 场景 | `failure` 值 | 现有错误信息 |
|---|---|---|
| `res.status === 404` | `'notfound'` | `GitHub 返回 404` |
| 其它 `!res.ok` | `'http'` | 现有 `GitHub 返回 ${status}` 保持 |
| `fetch` 本身抛错（网络 / TLS / 超时 abort） | `'network'` | 原错误对象保留，**不吞**，只加标记后重新抛出 |
| `tag_name` 缺失 / 为空 / 没有 `payload.json` | `'shape'` | 现有文案保持 |

`downloadPayload` 的失败不加标记（它只在确定有更新后才跑，走不到这里）。

**标记怎么挂**：捕获后 `Object.assign(err, { failure })` 再 `throw`，不要用 `try { } catch { throw new Error(...) }` 把原始错误信息丢掉——原始 message 要留在 `console.error` 里。

### 2.2 `updateService.ts` 的 `checkUpdate`

现在 catch 里是：

```ts
if (options.manual === true) {
  throw appError('UNKNOWN', '检查更新失败：无法访问 GitHub')
}
```

改成先读 `(e as { failure?: string }).failure`，按值给中文短句，**仍然用 `appError('UNKNOWN', ...)`**（`updateService.test.ts` 现有断言依赖这个 code）：

| `failure` | 提示文案 |
|---|---|
| `'notfound'` | `检查更新失败：仓库还没有发布任何版本` |
| `'network'` | `检查更新失败：连不上 GitHub` |
| `'http'` / `'shape'` / 其它 / 未标记 | `检查更新失败：无法访问 GitHub`（保持原文案） |

自动路径（`manual !== true`）的分支**不动**：仍然 `console.error` + 返回 `hasUpdate: false`。

---

## §3 白名单（4 个文件）

| 文件 | 动作 |
|---|---|
| `src/main/update/github.ts` | §1 换默认实现 + §2.1 打标记 |
| `src/main/update/updateService.ts` | §2.2 只改 catch 里那一个 `if (options.manual === true)` 分支 + 它的注释 |
| 新建 `tests/main/githubFetch.test.ts` | §5 |
| `package.json` | 版本号 |

**白名单之外一律不动。** 特别是：`src/main/update/payload.ts`、`src/main/index.ts`、`src/renderer/**` 的设置页与 `useSettingsData.ts`（它已经在 `res.error.message` 直接渲染，不用改）、`tests/main/updateService.test.ts`（**一行不改**，它 mock 掉了整个 `github` 模块，本单改动不会让它变红；若它红了，说明你碰了白名单外的东西）。

---

## §4 版本号

`version` → **你动手前读到的现值 +1**（不许与同期任何一单同号）。交付里写出实际写入值。

---

## §5 测试：新建 `tests/main/githubFetch.test.ts`（4 条）

只测 `fetchLatestRelease` 的错误分档，用注入的假 fetch，**不联网、不碰 `net`**：

1. 假 fetch 返回 `404` → 抛出错误的 `failure` 为 `'notfound'`
2. 假 fetch 返回 `500` → `failure` 为 `'http'`
3. 假 fetch 直接 `reject(new Error('boom'))` → `failure` 为 `'network'`，且原始 message `boom` 仍在
4. 假 fetch 返回 `200` 但 JSON 里没有 `assets`/`payload.json` → `failure` 为 `'shape'`

再补 1 条正常路径（共 5 条）：返回合法 `tag_name` 与 `assets[].name === 'payload.json'` → 拿到 `{ version, payloadUrl }`，且 `version` 去掉了 `v` 前缀。

**不许**在这份测试里 `import { net } from 'electron'`，也不要断言 UA 头被传出（Chromium 可能改写，断言会假红）。

---

## §6 验收（三条，别扩）

1. `npm run typecheck` / `npm run lint` 0 error；`npm test` 除 `chatBrief.test.ts:74` 那条时间炸弹外全过，总条数 = 改前基线 + 5。
2. 真机（Steam++ 保持运行、hosts 保持现状）：设置页点「检查更新」→ 提示变成 **「检查更新失败：仓库还没有发布任何版本」**，不再报「连不上 GitHub」。这一条同时证明了 TLS 通道已经打通——能读到 404 说明请求真的到达 GitHub 了。
3. 真机反向验证（可选，有手就行）：把 Steam++ 完全退出，再点一次 → 提示应为「检查更新失败：连不上 GitHub」。

---

## §7 明确不做

- 不改 hosts、不碰 Steam++、不要求用户关加速器
- 不加"代理地址"输入框、不加任何设置项
- 不打包、不发 Release（发版是架构方的事，本单只管代码）
- 不改 `payload.json` 的生成与上传流程
- 不改设置页任何文案与样式
