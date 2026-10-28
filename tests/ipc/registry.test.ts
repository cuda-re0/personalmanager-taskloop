import { describe, expect, it } from 'vitest'
import { CH } from '@shared/channels'
import { NOT_WIRED, WIRED_CHANNELS } from '../../src/main/ipc/registry'

/** 收集 CH 的全部叶子（通道字符串本身）。`bus.event` 是单向事件通道，不是 api 方法，见下方排除说明 */
function channelStrings(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  return Object.values(node as Record<string, unknown>).flatMap(v => channelStrings(v))
}

const ALL_API_CHANNELS = channelStrings(CH).filter(ch => ch !== CH.bus.event)

describe('registry 通道覆盖', () => {
  it('WIRED 有 30 条（W5 起 promoteDraft、W6 起 task.complete 与 occurrence 三条）', () => {
    expect(WIRED_CHANNELS.length).toBe(30)
    expect(new Set(WIRED_CHANNELS).size).toBe(30)
    expect(WIRED_CHANNELS).toContain(CH.task.promoteDraft)
    expect(WIRED_CHANNELS).toContain(CH.task.complete)
    for (const ch of [CH.occurrence.complete, CH.occurrence.undo, CH.occurrence.skip]) {
      expect(WIRED_CHANNELS).toContain(ch)
    }
  })

  it('WIRED ∪ NOT_WIRED == CH 的全部 api 叶子，且不交叠（新通道没人接必须红）', () => {
    const notWiredKeys = Object.keys(NOT_WIRED)
    const union = new Set([...WIRED_CHANNELS, ...notWiredKeys])

    const missing = ALL_API_CHANNELS.filter(ch => !union.has(ch))
    expect(missing).toEqual([])

    const unknown = [...union].filter(ch => !ALL_API_CHANNELS.includes(ch))
    expect(unknown).toEqual([])

    const overlap = WIRED_CHANNELS.filter(ch => ch in NOT_WIRED)
    expect(overlap).toEqual([])
  })

  it('NOT_WIRED 每条都带 owner，且取值都是计划内的波次', () => {
    const allowed = new Set(['W4', 'W5', 'W6', 'W8', 'W9', 'W11'])
    for (const [channel, { owner }] of Object.entries(NOT_WIRED)) {
      expect(allowed.has(owner), `${channel} 的 owner=${owner} 不在归属表里`).toBe(true)
    }
    expect(Object.keys(NOT_WIRED).length).toBe(21)
  })

  it('关键归属抽查：promoteDraft 已接通（v0.14 改判 W5）、task.complete 与 occurrence 三条已接通（W6）、ai.*→W4、hud.*→W9、attachment.add→W11', () => {
    expect(NOT_WIRED[CH.task.promoteDraft]).toBeUndefined()
    expect(NOT_WIRED[CH.task.complete]).toBeUndefined()
    expect(NOT_WIRED[CH.occurrence.complete]).toBeUndefined()
    expect(NOT_WIRED[CH.occurrence.undo]).toBeUndefined()
    expect(NOT_WIRED[CH.occurrence.skip]).toBeUndefined()
    expect(NOT_WIRED[CH.ai.review]).toEqual({ owner: 'W4' })
    expect(NOT_WIRED[CH.hud.getState]).toEqual({ owner: 'W9' })
    expect(NOT_WIRED[CH.attachment.add]).toEqual({ owner: 'W11' })
  })
})
