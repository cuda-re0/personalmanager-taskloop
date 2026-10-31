# 43 · 清两笔小账：`[取消]` 禁用态 · 待提交卡缺项清单

> 基线：`46a67f9`（W12 + 42 补丁已合入，工作区干净）。四命令 **57 文件 / 708 条**。
> 两件事互不依赖，可以一起做完一次交。**只准动 §4 白名单里的文件。**

## 1. 现象与根因（都已取证，不用再猜）

### A. `[取消]` 点了像没反应（缺禁用态）

`.btn--ghost` 只有一条 `color: var(--text-sub)`（`chat.css:778`），**没有任何 `:disabled` 规则**。
v0.40 只补了 `.submit-card .btn--primary:disabled`（`chat.css:625`），把 ghost 漏了。

后果：提交中（`busy` / `localBusy`）两颗按钮都 `disabled`，`[提交]` 会变灰，旁边的 `[取消]` 纹丝不动——
用户看到的是"一个能点一个不能点"，实际两个都不能点。同一处 `TaskReviewCard` 的 `[取消]` / `[重新审核]` 也一样。

### B. 待提交期间看不到"上次 AI 说要补什么"

v0.41 的「一任务一卡位」把 `pending_review` 任务的审核卡整条从渲染数组里过滤掉，改由待提交卡顶替。
搬过去的信息只有 **`need_evidence` 的 `followup` 一句话**（`latestNeedEvidenceHint`，`chatViewModel.ts:211`）。

漏掉的是 **`verdict.gaps`**（`partial` 时的"未完成项"列表，审核卡上用 `<ul class="review-gaps">` 渲染）。
于是：上次被判 `partial`、列了 3 条还差什么 → 用户再点完成进待提交 → 那 3 条消失了，只剩一句概括。
**用户最需要这张清单的时刻，恰好是它不可见的时候。**

根因定性：这是 v0.41 的**遗漏**，不是新需求——hint 的搬法已经做了，gaps 忘了搬。

## 2. 改动 A —— `chat.css`（1 条规则）

紧跟 `.btn--ghost` 那条之后新增：

```css
/* 弱化按钮的禁用态（v0.42）：四个值与 `.ci-send:disabled` / `.submit-card .btn--primary:disabled` 同源，
   不发明新观感。`.btn:hover` 在 disabled 上照样命中并把背景改亮，所以这一条必须排在 `.btn:hover` 之后，
   并且把 background 显式写回。 */
.btn--ghost:disabled {
  background: var(--bg-hover);
  color: var(--text-faint);
  cursor: default;
  opacity: 1;
}
```

- **不加 `.submit-card` 前缀**：本轮要覆盖的是所有 ghost 按钮（待提交卡、审核卡、草稿卡），
  只给一处加前缀等于把同一个毛病留在原地。
- 只加这一条，**不改 `.btn` / `.btn--primary` / 已有的 v0.40 规则**。

## 3. 改动 B —— 待提交卡补上 `gaps`

### 3.1 取值函数（`chatViewModel.ts`）

新增一个纯函数，与 `latestNeedEvidenceHint` 并列，**不改它**：

| 项 | 规则 |
|---|---|
| 入参 | `messages: Message[]`（全量，不是可见数组） |
| 出参 | `Record<string, string[]>`：`taskId → 该任务最近一条审核消息的 gaps` |
| 选取范围 | 只遍历 `meta.kind === 'task_review'` 的消息，从尾向头，**每个 taskId 只取第一条**（即最近一张卡） |
| 过滤 | `gaps` 为空数组时**不写进结果**（键不存在，调用方拿 `?? []`） |
| 不看 verdict 类型 | 只按 `gaps.length > 0` 判断。`partial` 自然命中，`need_evidence` 的 gaps 一般为空自然不命中 |
| 不做的 | 不合并多条历史、不去重、不截断、不排序（保持 AI 给的顺序） |

伪代码（只表达规则）：

```
从 messages 尾部往前扫
  跳过非 task_review
  taskId 已记录？跳过
  记下这个 taskId
  若 verdict.gaps 长度 > 0 → 结果[taskId] = verdict.gaps
```

### 3.2 接线（4 处，逐处写死）

| 文件 | 动作 |
|---|---|
| `useChatData.ts` | 仿 `needEvidenceHint` 的写法加一条 `useMemo(() => latestReviewGaps(messages), [messages])`，命名 `reviewGaps`，并加进 return |
| `chatTypes.ts` | `ChatData` 加 `reviewGaps: Record<string, string[]>`（挨着 `needEvidenceHint` 放） |
| `ChatPanel.tsx` | 给 `<SubmitCard>` 透传 `gaps={data.reviewGaps[task.id] ?? []}` |
| `SubmitCard.tsx` | 新增 prop `gaps: string[]`；在 `hint` 那行**之后**、`<EvidencePanel>` **之前**渲染列表 |

### 3.3 渲染规则（`SubmitCard.tsx`）

```tsx
{gaps.length > 0 ? (
  <ul className="review-gaps">
    {gaps.map(item => <li key={item}>{item}</li>)}
  </ul>
) : null}
```

- **复用现成的 `review-gaps` 类**（审核卡同款），不新增 CSS、不新增类名。
- 空数组时**整块不进 DOM**（不是隐藏）。
- 列表项文字就是 AI 给的原句，**前后不加"还差：""未完成："这类引导语**（04 §1 文案纪律，这是本项目最容易返工的地方）。
- `Props` 的注释写一句它从哪来（最近一条审核消息的 gaps），别写"展示未完成项"这种复述。

## 4. 白名单（6 个源文件 + 2 个测试）

| 文件 | 动作 |
|---|---|
| `src/renderer/shared/styles/chat.css` | A：加 `.btn--ghost:disabled` 一条 |
| `src/renderer/main/features/chat/chatViewModel.ts` | B：新增 `latestReviewGaps` |
| `src/renderer/main/features/chat/useChatData.ts` | B：`reviewGaps` memo + return |
| `src/renderer/main/features/chat/chatTypes.ts` | B：`ChatData.reviewGaps` |
| `src/renderer/main/features/chat/ChatPanel.tsx` | B：透传 |
| `src/renderer/main/components/SubmitCard.tsx` | B：prop + 列表 |
| `tests/renderer/chatViewModel.test.ts` | 加 `latestReviewGaps` 用例（见 §5） |
| `tests/renderer/reviewFlow.test.ts` | 若 `ChatData` 构造处有假实现，补 `reviewGaps: {}` |

**不许碰**：`TaskReviewCard.tsx`、`MessageItem.tsx`、`MessageList.tsx`、`latestNeedEvidenceHint` 本体、
`reviewFlow.ts`、任何主进程文件、`docs/**`（文档我自己改）。

## 5. 测试（3 条，别多写）

1. 同一任务有三张审核卡（旧 partial 带 gaps → 新 need_evidence gaps 空）→ `latestReviewGaps` 返回 **`{}`**（取最近一张，空的就不覆盖）。
2. 同一任务旧卡 gaps 为空、新卡 gaps 两条 → 返回这两条，顺序与输入一致。
3. 两个任务各一张卡 → 各自独立，互不覆盖。

## 6. 自检（照抄，逐条实测后填）

- [ ] `npm run typecheck` 0 错、`npm run lint` 0 警、`npm test` 绿（基线 **57 文件 / 708 条**，新增用例后条数应 = 708 + 你加的条数，如实填）
- [ ] `grep -n "btn--ghost:disabled" src/renderer/shared/styles/chat.css` → 1 命中，且位置在 `.btn--ghost` 与 `.btn--faint` 之间
- [ ] `grep -rn "review-gaps" src/renderer` → 仍只有 CSS 定义 + 两处渲染（`TaskReviewCard` / `SubmitCard`），**没有新类名、没有新 CSS**
- [ ] `grep -rn "还差\|未完成：\|请补充" src/renderer/main/components/SubmitCard.tsx` → **0 命中**（不许加引导语）
- [ ] `git status --porcelain` → 只有 §4 的文件，无其它改动

## 7. 验收（2 条）

1. 打开一个限时任务、点完成 → 待提交卡出现；卡里能看到上一张 `partial` 卡列出的那几条未完成项（和审核卡上看到的一字不差），列表为空时这块**不存在**。
2. 在待提交卡里点 `[+]` 传一张图，趁上传/提交那一瞬看两颗按钮：`[取消]` 与 `[提交]` **一起变灰**，不再是"一个灰一个亮"。

## 8. 交付

贴 `git diff --stat` + §6 自检结果。**不要提交**。
