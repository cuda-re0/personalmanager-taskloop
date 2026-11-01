import { describe, expect, it } from 'vitest'
import { ParseResultSchema, ReviewResultSchema, reviewResultSchema } from '../../src/main/ai/schema'

/**
 * schema 层面的拒绝（开工词 §6 的第 4、5、7 条）。
 *
 * 这些断言就是"模型输出是不可信输入"那条纪律的落点：拒绝要发生在这里，
 * 不能等业务层"顺手"归位或补默认值。
 */

function validTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'create_task',
    reply: '记成限时任务了。',
    tasks: [validTask()],
    ...overrides
  }
}

function issuesOf(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, value: unknown): string[] {
  const result = schema.safeParse(value)
  if (result.success) return []
  return (result.error?.issues ?? []).map(i => i.message)
}

describe('ParseResultSchema', () => {
  it('合法输出通过', () => {
    expect(ParseResultSchema.safeParse(validResult()).success).toBe(true)
  })

  it('多余的键被拒（strict，不是剥掉）', () => {
    const result = ParseResultSchema.safeParse(validResult({ extra: 1 }))
    expect(result.success).toBe(false)
    const taskExtra = ParseResultSchema.safeParse(
      validResult({ tasks: [validTask({ points: 20 })] })
    )
    expect(taskExtra.success).toBe(false)
  })

  it('type × difficulty 越界 → 拒绝，不归位', () => {
    const dailyHard = ParseResultSchema.safeParse(
      validResult({ tasks: [validTask({ type: 'daily', difficulty: 'hard', daily_time_hint: '21:00' })] })
    )
    expect(dailyHard.success).toBe(false)
    expect(issuesOf(ParseResultSchema, { intent: 'chat', reply: 'x', tasks: [validTask({ type: 'event', difficulty: 'easy' })] })).not.toHaveLength(0)
    // 合法组合仍然通过
    expect(
      ParseResultSchema.safeParse(
        validResult({ tasks: [validTask({ type: 'daily', difficulty: 'easy' })] })
      ).success
    ).toBe(true)
  })

  it('due_hint 接受三档精度（带时分 / 只有日期 / 只有月份）', () => {
    for (const good of ['2026-11-05T09:00:00+08:00', '2026-11-05', '2026-11']) {
      const result = ParseResultSchema.safeParse(validResult({ tasks: [validTask({ due_hint: good })] }))
      expect(result.success, `due_hint=${good} 应该通过`).toBe(true)
    }
    for (const bad of ['10-30 18:00', '2026-11-05T09', '2026-13-01', '2026-02-30', '明天下午三点']) {
      const result = ParseResultSchema.safeParse(
        validResult({ tasks: [validTask({ due_hint: bad })] })
      )
      expect(result.success, `due_hint=${bad} 应该被拒`).toBe(false)
    }
    expect(
      ParseResultSchema.safeParse(validResult({ tasks: [validTask({ due_hint: null })] })).success
    ).toBe(true)
  })

  it('confidence 必须 0~1，tasks 最多 3 条', () => {
    expect(
      ParseResultSchema.safeParse(validResult({ tasks: [validTask({ confidence: 1.2 })] })).success
    ).toBe(false)
    expect(
      ParseResultSchema.safeParse(validResult({ tasks: [validTask(), validTask(), validTask(), validTask()] })).success
    ).toBe(false)
  })

  it('intent 只认四个枚举值，"create_task|review_task" 不通过', () => {
    expect(
      ParseResultSchema.safeParse(validResult({ intent: 'create_task|review_task' })).success
    ).toBe(false)
  })
})

describe('reviewResultSchema（按任务类型特化）', () => {
  it('event 的 result 为 null → schema 层面拒（活动没有结果就没法算）', () => {
    const schema = reviewResultSchema('event')
    expect(
      schema.safeParse({
        verdict: 'pass',
        quality: 'met',
        result: null,
        reason: '比赛拿了第三名',
        followup: null
      }).success
    ).toBe(false)
    expect(
      schema.safeParse({
        verdict: 'pass',
        quality: 'met',
        result: 'exceeded',
        reason: '比赛拿了第三名，超出预期',
        followup: null
      }).success
    ).toBe(true)
  })

  it('非 event 的 result 必须为空（给了具体档位就拒）', () => {
    const schema = reviewResultSchema('deadline')
    expect(
      schema.safeParse({
        verdict: 'pass',
        quality: 'met',
        result: 'met',
        reason: '截图显示报告已导出',
        followup: null
      }).success
    ).toBe(false)
    expect(
      schema.safeParse({
        verdict: 'pass',
        quality: 'met',
        result: null,
        reason: '截图显示报告已导出',
        followup: null
      }).success
    ).toBe(true)
    // 缺省也接受，由 toVerdict 归成 null
    expect(
      schema.safeParse({
        verdict: 'pass',
        quality: 'met',
        reason: '截图显示报告已导出',
        followup: null
      }).success
    ).toBe(true)
  })

  it('reason ≤50 字、followup ≤40 字', () => {
    const tooLong = '很'.repeat(51)
    expect(
      ReviewResultSchema.safeParse({
        verdict: 'pass',
        quality: 'met',
        result: null,
        reason: tooLong,
        followup: null
      }).success
    ).toBe(false)
    expect(
      ReviewResultSchema.safeParse({
        verdict: 'need_evidence',
        quality: null,
        result: null,
        reason: '证据与任务对不上',
        followup: '补'.repeat(41)
      }).success
    ).toBe(false)
  })
})
