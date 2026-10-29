import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, computePlannedPoints } from '../../src/shared/points/rubric'
import type { PointsConfig } from '../../src/shared/points/rubric'
import type { ParseResult } from '../../src/main/ai/schema'
import {
  MAX_IMAGES,
  REMINDER_OFFSETS,
  buildParseRequest,
  toTaskDrafts,
  withImageNote
} from '../../src/main/ai/pipelines/parse'
import { parseFewshotMessages } from '../../src/main/ai/prompts'

/**
 * parse 管线的"右半边"（开工词 §6 的第 8、9 条）：`ParseResult` → `TaskDraft[]`。
 * 这一半不碰网络，所以断言可以精确到分值。
 */

function task(overrides: Partial<ParseResult['tasks'][number]> = {}): ParseResult['tasks'][number] {
  return {
    type: 'deadline',
    title: '写季度报告初稿',
    detail_md: '整理数据后写初稿。',
    requires_evidence: true,
    difficulty: 'medium',
    estimate_min: 90,
    due_hint: '2026-10-30T15:00:00+08:00',
    daily_time_hint: null,
    tags: ['工作'],
    steps: [],
    missing_info: [],
    confidence: 0.9,
    ...overrides
  }
}

function result(tasks: ParseResult['tasks']): ParseResult {
  return { intent: 'create_task', reply: '记好了。', tasks }
}

/** 与生产同一份配置，但把两处基准调开，能看出到底用了哪一份 */
const CUSTOM: PointsConfig = {
  ...DEFAULT_CONFIG,
  difficultyBase: { ...DEFAULT_CONFIG.difficultyBase, medium: 99 },
  dailyBase: 7
}

describe('toTaskDrafts：分值口径（02 §5.2b）', () => {
  it('deadline 用 computePlannedPoints，且真的用了传入的 cfg', () => {
    const [draft] = toTaskDrafts(result([task()]), CUSTOM)
    expect(draft.pointsPlanned).toBe(99)
    // 拿默认配置算一次作为对照：如果实现里漏传 cfg，这里会是 20
    expect(computePlannedPoints('medium', DEFAULT_CONFIG)).toBe(20)
  })

  it('daily 恒取 cfg.dailyBase（不看难度）', () => {
    const [draft] = toTaskDrafts(
      result([task({ type: 'daily', difficulty: 'trivial', daily_time_hint: '21:00' })]),
      CUSTOM
    )
    expect(draft.pointsPlanned).toBe(7)
  })

  it('event 也走 computePlannedPoints', () => {
    const [draft] = toTaskDrafts(
      result([task({ type: 'event', difficulty: 'hard', due_hint: '2026-11-04T01:00:00Z' })]),
      CUSTOM
    )
    expect(draft.pointsPlanned).toBe(DEFAULT_CONFIG.difficultyBase.hard)
  })
})

describe('toTaskDrafts：默认提醒偏移（开工词 §6 第 9 条）', () => {
  it('三种 type 各取各的', () => {
    const drafts = toTaskDrafts(
      result([
        task({ type: 'deadline' }),
        task({ type: 'event', difficulty: 'hard' }),
        task({ type: 'daily', difficulty: 'easy', daily_time_hint: '21:00' })
      ]),
      DEFAULT_CONFIG
    )
    expect(drafts[0].reminderOffsets).toEqual([-1440, -60])
    expect(drafts[1].reminderOffsets).toEqual([-10080, -4320, -1440])
    expect(drafts[2].reminderOffsets).toEqual([])
    // 与常量同源，不是各写一份
    expect(REMINDER_OFFSETS.deadline).toEqual([-1440, -60])
  })

  it('偏移是拷贝，不是共享同一个数组', () => {
    const drafts = toTaskDrafts(result([task(), task()]), DEFAULT_CONFIG)
    drafts[0].reminderOffsets.push(-5)
    expect(drafts[1].reminderOffsets).toEqual([-1440, -60])
  })
})

describe('toTaskDrafts：字段映射', () => {
  it('localId 是 8 位且互不相同（步骤也各自一个）', () => {
    const drafts = toTaskDrafts(
      result([
        task({ steps: [{ title: '整理数据', estimate_min: 30 }, { title: '写初稿', estimate_min: 60 }] })
      ]),
      DEFAULT_CONFIG
    )
    expect(drafts[0].localId).toHaveLength(8)
    const ids = [drafts[0].localId, ...drafts[0].steps.map(s => s.localId)]
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).toHaveLength(8)
  })

  it('daily 的 dueHint 归成 null，dailyTimeHint 只给 daily', () => {
    const [daily, deadline] = toTaskDrafts(
      result([
        task({ type: 'daily', difficulty: 'easy', daily_time_hint: '21:30' }),
        task()
      ]),
      DEFAULT_CONFIG
    )
    expect(daily.dueHint).toBeNull()
    expect(daily.dailyTimeHint).toBe('21:30')
    expect(deadline.dailyTimeHint).toBeNull()
  })

  it('due_hint 归一成 UTC 的完整 ISO（带偏移的输入也吃）', () => {
    const [draft] = toTaskDrafts(result([task({ due_hint: '2026-10-30T15:00:00+08:00' })]), DEFAULT_CONFIG)
    expect(draft.dueHint).toBe('2026-10-30T07:00:00.000Z')
  })

  it('steps 的 done 默认 false、estimateMin 缺省为 null', () => {
    const [draft] = toTaskDrafts(
      result([task({ steps: [{ title: '只写标题' }] })]),
      DEFAULT_CONFIG
    )
    expect(draft.steps[0].done).toBe(false)
    expect(draft.steps[0].estimateMin).toBeNull()
  })
})

describe('buildParseRequest', () => {
  const image = { mime: 'image/png', bytes: Buffer.from('fake-png') }

  it('system 里带【当前时间】，且 fewshot 在 system 之后', () => {
    const { messages } = buildParseRequest({
      text: '明天下午三点前把季度报告初稿写完',
      images: [],
      now: new Date('2026-10-29T02:52:00Z'),
      timeZone: 'Asia/Shanghai'
    })
    expect(messages[0].role).toBe('system')
    expect(String(messages[0].content)).toContain('【当前时间】2026-10-29 星期四 10:52')
    expect(messages[messages.length - 1].role).toBe('user')
  })

  it('最多 4 张图进 payload，多的丢掉并计数（不报错）', () => {
    const { messages, droppedImages } = buildParseRequest({
      text: '这几张截图里的事都记一下',
      images: [image, image, image, image, image, image]
    })
    expect(droppedImages).toBe(2)
    const last = messages[messages.length - 1].content
    expect(Array.isArray(last)).toBe(true)
    const parts = last as Array<{ type: string }>
    expect(parts.filter(p => p.type === 'image_url')).toHaveLength(MAX_IMAGES)
    // 图片走 data URL（03 §9.3）
    const first = parts.find(p => p.type === 'image_url') as unknown as {
      image_url: { url: string }
    }
    expect(first.image_url.url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('非图片附件不发给模型，只在文字里提一句', () => {
    const { messages } = buildParseRequest({
      text: '看这个',
      images: [{ mime: 'application/pdf', bytes: Buffer.from('pdf') }]
    })
    const last = messages[messages.length - 1].content as Array<{ type: string; text?: string }>
    expect(last.filter(p => p.type === 'image_url')).toHaveLength(0)
    expect(last.map(p => p.text ?? '').join('')).toContain('application/pdf')
  })

  it('withImageNote 只在真丢了图时补一句', () => {
    expect(withImageNote('记好了。', 0)).toBe('记好了。')
    expect(withImageNote('记好了。', 2)).toContain('4 张图')
  })
})

describe('fewshot（03 §9.5 / 开工词 §4.5）', () => {
  it('必须有 event 正例（考试/面试/答辩这类不能被判成 deadline）', () => {
    const raw = parseFewshotMessages().map(m => String(m.content)).join('\n')
    expect(raw).toContain('"type":"event"')
    expect(raw).toContain('考试')
  })

  it('四组正例：单任务 / 图转任务 / 多任务 / 纯闲聊', () => {
    const users = parseFewshotMessages()
      .filter(m => m.role === 'user')
      .map(m => String(m.content))
    expect(users).toHaveLength(4)
    expect(users.some(u => u.includes('图片'))).toBe(true)
    expect(users.some(u => u.includes('天气'))).toBe(true)
  })
})
