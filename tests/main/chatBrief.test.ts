import { describe, expect, it } from 'vitest'
import type { DayStat, Task, TaskType } from '../../src/shared/types/domain'
import { buildTodayBrief } from '../../src/main/services/chatBrief'

/**
 * `buildTodayBrief`（03 §4.3.1 第 3 段）。
 *
 * 纯函数：喂数据、断言字符串。**不查库、不读 settings**，所以这里不 openDb。
 */
const TZ = 'Asia/Shanghai'
/** 2026-10-31（周六）12:00 +08:00 */
const NOW = new Date('2026-10-31T04:00:00.000Z')
const TODAY = '2026-10-31'

function makeTask(overrides: Partial<Task> & { title: string; type?: TaskType }): Task {
  const { title, type, ...rest } = overrides
  return {
    id: title,
    type: type ?? 'deadline',
    status: 'todo',
    title,
    detailMd: '',
    parentId: null,
    sortKey: 0,
    priority: 0,
    difficulty: 'medium',
    estimateMin: null,
    dueAt: null,
    dailyTime: null,
    repeatRule: null,
    activeFrom: null,
    activeTo: null,
    reminderOffsets: [],
    reminderChannels: [],
    tags: [],
    pointsPlanned: 20,
    pointsAwarded: null,
    quality: null,
    requiresEvidence: false,
    evidence: [],
    streakCurrent: 0,
    streakBest: 0,
    source: 'chat',
    aiConfidence: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    ...rest
  }
}

function makeStat(overrides: Partial<DayStat> = {}): DayStat {
  return { day: TODAY, points: 30, tasksDone: 1, tasksCreated: 3, occurrencesDone: 1, ...overrides }
}

const THREE_TASKS = [
  makeTask({ title: '写季度报告', dueAt: '2026-10-31T10:00:00.000Z' }), // 今天 18:00
  makeTask({ title: '背单词', type: 'daily' }),
  makeTask({ title: '准备答辩', dueAt: '2026-11-02T01:00:00.000Z' }) // 11-02 09:00
]

describe('buildTodayBrief', () => {
  it('3 条待办 + 2 条已完成：条数、标题与时间都对', () => {
    const brief = buildTodayBrief({
      tasks: THREE_TASKS,
      stat: makeStat(),
      balance: 1280,
      now: NOW,
      timeZone: TZ
    })
    const lines = brief.split('\n')
    expect(lines[0]).toBe('今天是 2026-10-31（周六）。')
    expect(lines[1]).toContain('待办 3 条')
    expect(lines[1]).toContain('写季度报告 · 今天 18:00 截止')
    expect(lines[1]).toContain('背单词 · 每日')
    expect(lines[1]).toContain('准备答辩 · 11-02 09:00 截止')
    // tasksDone 1 + occurrencesDone 1
    expect(lines[1]).toContain('已完成 2 条')
    expect(lines[2]).toBe('今天已得 30 分，总积分 1280 分。')
  })

  it('0 条待办：不出现「0 条待办」这种机器腔', () => {
    const brief = buildTodayBrief({
      tasks: [],
      stat: makeStat({ tasksDone: 2, occurrencesDone: 0 }),
      balance: 100,
      now: NOW,
      timeZone: TZ
    })
    expect(brief).not.toContain('0 条待办')
    expect(brief).toContain('今天没有待办任务')
    expect(brief).toContain('已完成 2 条')
  })

  it('一条任务都没有：只说没有任何任务', () => {
    const brief = buildTodayBrief({
      tasks: [],
      stat: makeStat({ tasksDone: 0, occurrencesDone: 0, points: 0 }),
      balance: 0,
      now: NOW,
      timeZone: TZ
    })
    expect(brief).toContain('今天没有任何任务。')
    expect(brief).not.toContain('0 条待办')
  })

  it('8 条待办：只列 5 条，末尾带「等 8 条」（N 是总数）', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => makeTask({ title: `任务${i + 1}` }))
    const brief = buildTodayBrief({
      tasks,
      stat: makeStat({ tasksDone: 0, occurrencesDone: 0 }),
      balance: 0,
      now: NOW,
      timeZone: TZ
    })
    expect(brief).toContain('任务5')
    expect(brief).not.toContain('任务6')
    expect(brief).toContain('等 8 条')
  })

  it('标题超过 12 字截断加「…」', () => {
    const long = '把第三季度的所有数据整理成一份报告'
    const brief = buildTodayBrief({
      tasks: [makeTask({ title: long })],
      stat: makeStat(),
      balance: 0,
      now: NOW,
      timeZone: TZ
    })
    expect(brief).toContain('把第三季度的所有数据整理…')
    expect(brief).not.toContain('一份报告')
  })

  it('昨天：条数按 tasksDone + occurrencesDone 合计，无记录只说没有记录，不传就整行省略', () => {
    const base = {
      tasks: [],
      stat: makeStat({ tasksDone: 0, occurrencesDone: 0 }),
      balance: 0,
      now: NOW,
      timeZone: TZ
    }

    // tasksDone 2 + occurrencesDone 1 = 3 条
    const withData = buildTodayBrief({
      ...base,
      yesterday: makeStat({ points: 12, tasksDone: 2, occurrencesDone: 1 })
    })
    const doneLines = withData.split('\n')
    expect(doneLines[doneLines.length - 1]).toBe('昨天：完成 3 条，得 12 分。')

    const blank = buildTodayBrief({
      ...base,
      yesterday: makeStat({ points: 0, tasksDone: 0, occurrencesDone: 0 })
    })
    const blankLines = blank.split('\n')
    expect(blankLines[blankLines.length - 1]).toBe('昨天没有记录。')

    // 不传 yesterday：整行省略，也不留空行
    const absent = buildTodayBrief(base)
    expect(absent).not.toContain('昨天')
    expect(absent.split('\n')).toHaveLength(3)
  })
})
