import { describe, expect, it } from 'vitest'
import { buildNowHint, nowHint } from '../../src/main/ai/timeHint'
import { buildParseSystem } from '../../src/main/ai/prompts'

/**
 * 注入的「当前时间」串（开工词 §6 第 10 条、03 §9.6）。
 *
 * 这一条是 P0：`due_hint` 恒 null 的根因就是 prompt 里没有当前时间（03 §9.5）。
 * 所以格式必须逐字固定，不能"看着差不多"。
 */

/** 03 §9.6 原文，逐字照抄 */
const EXPECTED =
  '【当前时间】2026-10-29 星期四 10:52（Asia/Shanghai）\n' +
  '解析"明天/下周三/三小时后"这类相对时间时，一律以此为准，并换算成带时区的 ISO8601。'

describe('buildNowHint', () => {
  it('输出与 03 §9.6 逐字一致（固定时钟 + Asia/Shanghai）', () => {
    // 2026-10-29T02:52Z = 东八区 10:52
    const now = new Date('2026-10-29T02:52:00Z')
    expect(buildNowHint(now, 'Asia/Shanghai')).toBe(EXPECTED)
  })

  it('日期取本地日，不是 UTC 日（东八区凌晨不能差一天）', () => {
    // UTC 还是 10-28，东八区已经是 10-29 00:30
    const now = new Date('2026-10-28T16:30:00Z')
    const hint = buildNowHint(now, 'Asia/Shanghai')
    expect(hint).toContain('【当前时间】2026-10-29 星期四 00:30（Asia/Shanghai）')
  })

  it('星期与时刻都按传入时区算（换时区，日期不变内容跟着变）', () => {
    const now = new Date('2026-10-29T02:52:00Z')
    expect(buildNowHint(now, 'UTC')).toContain('【当前时间】2026-10-29 星期四 02:52（UTC）')
  })

  it('nowHint 在同一个分钟里复用缓存，跨分钟重算', () => {
    const first = nowHint(new Date('2026-10-29T02:52:10Z'), 'Asia/Shanghai')
    const second = nowHint(new Date('2026-10-29T02:52:50Z'), 'Asia/Shanghai')
    expect(second).toBe(first)
    const later = nowHint(new Date('2026-10-29T02:53:00Z'), 'Asia/Shanghai')
    expect(later).toContain('10:53')
  })
})

describe('parse 的 system 消息', () => {
  it('【当前时间】贴在 system 末尾（模型对末尾指令最敏感）', () => {
    const system = buildParseSystem(new Date('2026-10-29T02:52:00Z'), 'Asia/Shanghai')
    expect(system.trimEnd().endsWith('ISO8601。')).toBe(true)
    expect(system).toContain(EXPECTED)
  })

  it('prompt 里不出现任何分值示例（03 §1 铁律：不许让模型看到"这个值 20 分"）', () => {
    const system = buildParseSystem(new Date('2026-10-29T02:52:00Z'), 'Asia/Shanghai')
    // "10 分钟""半小时"是时长，不是分值；要找的是"数字 + 分"当计量单位的那种
    expect(system).not.toMatch(/\d+\s*分(?!钟)/)
    expect(system).not.toMatch(/[加扣奖]\s*\d+\s*分/)
    // 也不许让它看到"按难度给分"的说法——那会诱导它输出数字
    expect(system).not.toContain('给分')
  })
})
