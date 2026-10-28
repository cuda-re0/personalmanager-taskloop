import { computePlannedPoints } from '@shared/points/rubric'
import { snapDifficulty } from '@shared/taskRules'
import type { Attachment, Evidence, Message, ReviewVerdict, Task, TaskDraft } from '@shared/types/domain'
import { TYPE_DEFAULT_OFFSETS, draftPointsOf } from '../chatViewModel'

/**
 * W3 专用 fixture。所有对象都显式标注为 @shared 的领域类型，
 * 不是本地仿造结构 —— W2 接上 IPC 后这些常量直接删掉即可。
 */

const THREAD = 'thread-demo'
const DAY = '2026-10-28'

/** 占位图：SVG data URI，只为让缩略图/九宫格有可见内容，不参与任何样式 */
function mockImage(label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">` +
    `<rect x="0.5" y="0.5" width="95" height="95" fill="none" stroke="#a0a0a8"/>` +
    `<text x="8" y="52" font-size="11" fill="#6b6b73" font-family="sans-serif">${label}</text>` +
    `</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

export const FIXTURE_ATTACHMENTS: Attachment[] = [
  {
    id: 'att-a',
    kind: 'image',
    url: mockImage('IMG_2041'),
    mime: 'image/svg+xml',
    bytes: 20480,
    width: 96,
    height: 96
  },
  {
    id: 'att-b',
    kind: 'image',
    url: mockImage('IMG_2042'),
    mime: 'image/svg+xml',
    bytes: 18432,
    width: 96,
    height: 96
  },
  {
    id: 'att-c',
    kind: 'file',
    url: 'app://attach/att-c',
    mime: 'application/pdf',
    bytes: 348160,
    width: null,
    height: null
  }
]

const attachmentById = new Map(FIXTURE_ATTACHMENTS.map(a => [a.id, a]))

export function findAttachment(id: string | undefined): Attachment | null {
  if (!id) return null
  return attachmentById.get(id) ?? null
}

function makeTask(seed: Pick<Task, 'id' | 'type' | 'title'> & Partial<Task>): Task {
  return {
    status: 'todo',
    detailMd: '',
    parentId: null,
    sortKey: 0,
    priority: 0,
    difficulty: 'medium',
    estimateMin: 60,
    dueAt: null,
    dailyTime: null,
    repeatRule: null,
    activeFrom: null,
    activeTo: null,
    reminderOffsets: [],
    reminderChannels: ['inapp'],
    tags: [],
    pointsPlanned: 20,
    pointsAwarded: null,
    quality: null,
    requiresEvidence: false,
    evidence: [],
    streakCurrent: 0,
    streakBest: 0,
    source: 'chat',
    aiConfidence: 0.8,
    createdAt: `${DAY}T01:00:00.000Z`,
    updatedAt: `${DAY}T01:00:00.000Z`,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    ...seed
  }
}

/** v0.8：Evidence 只区分 text / attachment，截图与 PDF 由 Attachment.kind 决定 */
const evidencePhoto: Evidence = {
  kind: 'attachment',
  attachmentId: 'att-c',
  addedAt: `${DAY}T02:02:00.000Z`
}
const evidenceShot: Evidence = {
  kind: 'attachment',
  attachmentId: 'att-a',
  addedAt: `${DAY}T02:05:00.000Z`
}
const evidenceText: Evidence = { kind: 'text', text: '实验数据在第 3 页，误差分析在附录', addedAt: `${DAY}T02:06:00.000Z` }

export const FIXTURE_TASKS: Task[] = [
  makeTask({
    id: 'task-physics',
    type: 'deadline',
    title: '交物理作业',
    detailMd: '把本周实验报告导出 PDF 后提交。',
    difficulty: 'medium',
    estimateMin: 60,
    dueAt: `${DAY}T10:00:00.000Z`,
    // 提前 96h 完成 → 提前 4 天，效率系数 1.2（04 §3.3 的示例场景）
    completedAt: `2026-10-24T10:00:00.000Z`,
    pointsPlanned: computePlannedPoints('medium'),
    requiresEvidence: true,
    evidence: [evidencePhoto, evidenceShot],
    reminderOffsets: [-1440, -60],
    status: 'doing'
  }),
  makeTask({
    id: 'task-words',
    type: 'daily',
    title: '背单词 30 个',
    difficulty: 'trivial',
    estimateMin: 30,
    dailyTime: '21:00',
    repeatRule: 'DAILY',
    // 每日任务入库的就是单日基数（默认 1），与卡片显示一致
    pointsPlanned: 1,
    streakCurrent: 7
  }),
  makeTask({
    id: 'task-cet',
    type: 'event',
    title: '英语六级考试',
    difficulty: 'hard',
    estimateMin: 120,
    dueAt: `2026-11-14T01:00:00.000Z`,
    pointsPlanned: computePlannedPoints('hard'),
    requiresEvidence: true
  }),
  makeTask({
    id: 'task-report',
    type: 'deadline',
    title: '客户回访记录',
    detailMd: '整理三家客户的回访结论。',
    difficulty: 'easy',
    estimateMin: 30,
    dueAt: `${DAY}T12:00:00.000Z`,
    pointsPlanned: computePlannedPoints('easy'),
    requiresEvidence: true,
    evidence: [evidenceText],
    reminderOffsets: [-1440]
  })
]

function draft(seed: Partial<TaskDraft> & Pick<TaskDraft, 'localId' | 'type' | 'title'>): TaskDraft {
  // 02 §5.2b：fixture 里的难度也必须落在该类型允许的档位内
  const difficulty = snapDifficulty(seed.type, seed.difficulty ?? 'medium')
  const estimateMin = seed.estimateMin === undefined ? 60 : seed.estimateMin
  return {
    detailMd: '',
    dueHint: null,
    dailyTimeHint: null,
    activeToHint: null,
    reminderOffsets: [...TYPE_DEFAULT_OFFSETS[seed.type]],
    tags: [],
    steps: [],
    missingInfo: [],
    requiresEvidence: false,
    confidence: 0.8,
    ...seed,
    difficulty,
    estimateMin,
    // 只看难度/类型，基数由调用方给；fixture 传 1，useChatData 进来时还会归一一次
    pointsPlanned: draftPointsOf({ type: seed.type, difficulty }, 1)
  }
}

export const FIXTURE_DRAFTS: TaskDraft[] = [
  draft({
    localId: 'draft-1',
    type: 'deadline',
    title: '交物理作业',
    detailMd: '把本周实验报告导出 PDF 后提交，**含完整实验数据**。',
    difficulty: 'medium',
    estimateMin: 60,
    dueHint: '2026-10-30T10:00:00.000Z',
    steps: [
      { localId: 's-1', title: '整理实验数据', estimateMin: 20, done: false },
      { localId: 's-2', title: '导出 PDF', estimateMin: 10, done: false },
      { localId: 's-3', title: '提交到课程平台', estimateMin: 5, done: false }
    ],
    requiresEvidence: true,
    confidence: 0.82
  }),
  draft({
    localId: 'draft-2',
    type: 'daily',
    title: '背单词 30 个',
    detailMd: '晚上刷牙后背，`30` 个一组。',
    difficulty: 'trivial',
    estimateMin: 30,
    dailyTimeHint: '21:00',
    activeToHint: '2026-11-30',
    steps: [{ localId: 's-4', title: '复习昨日错词', estimateMin: 5, done: false }],
    confidence: 0.42
  }),
  draft({
    localId: 'draft-3',
    type: 'event',
    title: '英语六级考试',
    detailMd: '',
    difficulty: 'hard',
    estimateMin: 120,
    dueHint: '2026-11-14T01:00:00.000Z',
    requiresEvidence: true,
    confidence: 0.66
  }),
  // 跨年：UTC 1 月 5 日 01:00 = 本地 1 月 5 日 09:00，用来确认卡片不会显示成今年
  draft({
    localId: 'draft-4',
    type: 'deadline',
    title: '春季选课申请',
    detailMd: '系统 1 月 6 日关闭，先把志愿填了。',
    difficulty: 'easy',
    estimateMin: 30,
    dueHint: '2027-01-05T01:00:00.000Z',
    confidence: 0.74
  })
]

function msg(seed: Partial<Message> & Pick<Message, 'id' | 'role' | 'kind'>): Message {
  return {
    threadId: THREAD,
    contentMd: '',
    meta: { kind: 'none' },
    linkedTaskId: null,
    status: 'sent',
    attachments: [],
    createdAt: `${DAY}T01:00:00.000Z`,
    ...seed
  }
}

const reviewPass: ReviewVerdict = {
  verdict: 'pass',
  quality: 'exceeded',
  // v0.9：仅 event 有值，限时/每日传 null
  result: null,
  reason: '导出的 PDF 含完整实验数据，第 3 页有误差分析。',
  followup: null,
  gaps: []
}
const reviewNeed: ReviewVerdict = {
  verdict: 'need_evidence',
  quality: null,
  result: null,
  reason: '看不到回访记录本身。',
  followup: '补一份回访纪要，标注客户与日期。',
  gaps: []
}
const reviewPartial: ReviewVerdict = {
  verdict: 'partial',
  quality: 'partial',
  result: null,
  reason: '只交了前两家客户的记录。',
  followup: null,
  gaps: ['第三家客户（张先生）的回访记录', '每家客户的回访日期']
}
const reviewFail: ReviewVerdict = {
  verdict: 'fail',
  quality: null,
  // 没有完成动作就没有分值可算：fail 不带结果档，卡片也不渲染下拉
  result: null,
  reason: '截图里是一张空白页。',
  followup: null,
  gaps: []
}
/** 活动任务重考通过：用来演示 04 §3.3 的 [结果 ▾] 与分值重算 */
const reviewCetPass: ReviewVerdict = {
  verdict: 'pass',
  quality: 'met',
  result: 'met',
  reason: '成绩单显示 585 分。',
  followup: null,
  gaps: []
}

export const FIXTURE_MESSAGES: Message[] = [
  msg({
    id: 'm-1',
    role: 'user',
    kind: 'text',
    contentMd: '这周的物理作业和报销，帮我排一下。',
    attachments: [FIXTURE_ATTACHMENTS[0], FIXTURE_ATTACHMENTS[1]],
    createdAt: `${DAY}T01:12:00.000Z`
  }),
  msg({
    id: 'm-2',
    role: 'assistant',
    kind: 'text',
    contentMd:
      '拆成两件事，按截止时间排。\n\n' +
      '- **交物理作业**：10-30 18:00 前，`60` 分钟\n' +
      '- 报销单：本周内，15 分钟\n\n' +
      '1. 先做物理，数据齐了再导出\n' +
      '2. 报销放在晚上',
    createdAt: `${DAY}T01:12:06.000Z`
  }),
  msg({
    id: 'm-3',
    role: 'assistant',
    kind: 'task_draft',
    meta: { kind: 'task_draft', drafts: FIXTURE_DRAFTS },
    createdAt: `${DAY}T01:12:08.000Z`
  }),
  msg({
    id: 'm-4',
    role: 'assistant',
    kind: 'task_review',
    contentMd: '交物理作业',
    meta: { kind: 'task_review', taskId: 'task-physics', verdict: reviewPass },
    linkedTaskId: 'task-physics',
    createdAt: `${DAY}T02:07:00.000Z`
  }),
  msg({
    id: 'm-5',
    role: 'assistant',
    kind: 'task_review',
    contentMd: '客户回访记录',
    meta: { kind: 'task_review', taskId: 'task-report', verdict: reviewNeed },
    linkedTaskId: 'task-report',
    createdAt: `${DAY}T02:20:00.000Z`
  }),
  msg({
    id: 'm-6',
    role: 'assistant',
    kind: 'task_review',
    contentMd: '客户回访记录',
    meta: { kind: 'task_review', taskId: 'task-report', verdict: reviewPartial },
    linkedTaskId: 'task-report',
    createdAt: `${DAY}T02:32:00.000Z`
  }),
  msg({
    id: 'm-7',
    role: 'assistant',
    kind: 'task_review',
    contentMd: '英语六级考试',
    meta: { kind: 'task_review', taskId: 'task-cet', verdict: reviewFail },
    linkedTaskId: 'task-cet',
    createdAt: `${DAY}T02:40:00.000Z`
  }),
  msg({
    id: 'm-10',
    role: 'assistant',
    kind: 'task_review',
    contentMd: '英语六级考试',
    meta: { kind: 'task_review', taskId: 'task-cet', verdict: reviewCetPass },
    linkedTaskId: 'task-cet',
    createdAt: `${DAY}T03:05:00.000Z`
  }),
  msg({
    id: 'm-8',
    role: 'system',
    kind: 'reminder',
    meta: {
      kind: 'reminder',
      reminderId: 'rem-1',
      taskId: 'task-physics',
      title: '交物理作业',
      fireAt: `${DAY}T09:00:00.000Z`,
      offsetMin: -60
    },
    createdAt: `${DAY}T09:00:00.000Z`
  }),
  msg({
    id: 'm-9',
    role: 'system',
    kind: 'error',
    meta: {
      kind: 'error',
      code: 'AI_UPSTREAM_ERROR',
      message: '模型调用超时（30s）。',
      retryable: true
    },
    createdAt: `${DAY}T09:05:00.000Z`
  })
]

/** 向上翻页用的旧消息池，按时间正序（最早的在前） */
export function makeOlderMessages(count: number): Message[] {
  const pool: Message[] = []
  for (let i = 0; i < count; i++) {
    const user = i % 2 === 0
    const day = String(20 + (i % 8)).padStart(2, '0')
    pool.push(
      msg({
        id: `old-${i}`,
        role: user ? 'user' : 'assistant',
        kind: 'text',
        contentMd: user
          ? `历史消息 ${i + 1}：还有一件事没排。`
          : `历史消息 ${i + 1}：已经排到 **${10 + (i % 5)} 月** 了，` + '`sort` 按截止时间。',
        createdAt: `2026-09-${day}T00:${String(i % 60).padStart(2, '0')}:00.000Z`
      })
    )
  }
  return pool
}

/** 1000 条压测数据（03 验收项：1000 条滚动 60fps） */
export function makeBulkMessages(count: number): Message[] {
  const pool: Message[] = []
  for (let i = 0; i < count; i++) {
    const user = i % 2 === 0
    pool.push(
      msg({
        id: `bulk-${i}`,
        role: user ? 'user' : 'assistant',
        kind: 'text',
        contentMd: user
          ? `第 ${i + 1} 条：把这件事排进去。`
          : `第 ${i + 1} 条回复，包含 **粗体**、\`inline\` 与\n\n- 列表项 A\n- 列表项 B`,
        createdAt: `${DAY}T01:${String(i % 60).padStart(2, '0')}:00.000Z`
      })
    )
  }
  return pool
}
