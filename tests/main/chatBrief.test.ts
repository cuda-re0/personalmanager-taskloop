import { describe, expect, it } from 'vitest'
import type { DayStat, Task, TaskType } from '../../src/shared/types/domain'
import { buildTodayBrief } from '../../src/main/services/chatBrief'
import { toLocalDay, todayLocalDay } from '../../src/shared/localDay'

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
    plannedDay: null,
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

describe('buildTodayBrief 计划日（v0.93 / 91）', () => {
  /**
   * `buildTodayBrief` 的「今天」取自**真实系统时钟**（`todayLocalDay(timeZone)`），
   * `now` 只钉住首行的时刻——这是既有事实（见文件开头那条例外允许的红）。
   * 所以本组用例的计划日不写死日期，一律由真实今天推导，否则过了那个月就整组失效。
   */
  const REAL_TODAY = todayLocalDay(TZ)
  const plusDays = (day: string, n: number): string => {
    const [y, m, d] = day.split('-').map(Number)
    return toLocalDay(new Date(Date.UTC(y, m - 1, d + n)), 'UTC')
  }

  it('计划日在未来的任务不算进「待办 N 条」', () => {
    const brief = buildTodayBrief({
      tasks: [
        makeTask({ title: '交月报', dueAt: '2026-10-31T10:00:00.000Z' }),
        // 下周才打算做：今天还没到，不该出现在今天的简报里
        makeTask({ title: '复习线性代数', plannedDay: plusDays(REAL_TODAY, 7) })
      ],
      stat: makeStat({ tasksDone: 0, occurrencesDone: 0 }),
      balance: 100,
      now: NOW,
      timeZone: TZ
    })
    const lines = brief.split('\n')
    expect(lines[1]).toContain('待办 1 条')
    expect(lines[1]).toContain('交月报')
    expect(lines[1]).not.toContain('复习线性代数')
  })

  it('计划日是今天或昨天的照样算（过期不搬运，只是继续显示）', () => {
    const brief = buildTodayBrief({
      tasks: [
        makeTask({ title: '今天做', plannedDay: REAL_TODAY }),
        makeTask({ title: '昨天没做完', plannedDay: plusDays(REAL_TODAY, -1) })
      ],
      stat: makeStat({ tasksDone: 0, occurrencesDone: 0 }),
      balance: 100,
      now: NOW,
      timeZone: TZ
    })
    expect(brief.split('\n')[1]).toContain('待办 2 条')
  })
})
