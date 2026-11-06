import { describe, expect, it } from 'vitest'
import { CH } from '@shared/channels'
import { NOT_WIRED, WIRED_CHANNELS } from '../../src/main/ipc/registry'

/** 收集 CH 的全部叶子（通道字符串本身）。单向事件通道不是 api 方法，见下方排除说明 */
function channelStrings(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  return Object.values(node as Record<string, unknown>).flatMap(v => channelStrings(v))
}

/**
 * `bus.event`（主进程 → 渲染层的域事件）与 `notify.show`（v0.58，主进程 → 提醒窗口的负载）
 * 都是**单向推送**，不是可 invoke 的 api 方法，因此不参与注册表的覆盖检查。
 */
const ONE_WAY_CHANNELS: readonly string[] = [CH.bus.event, CH.notify.show]

const ALL_API_CHANNELS = channelStrings(CH).filter(ch => !ONE_WAY_CHANNELS.includes(ch))

describe('registry 通道覆盖', () => {
  it('WIRED 有 71 条（W5 起 promoteDraft、W6 起 task.complete 与 occurrence 三条、W9 起 hud 四条 + v0.32 dragBegin/dragTo、v0.19 起 task.undo、W4 起 msg 两条 + ai 四条、v0.36 起 attachment 两条、v0.37 起 persona 两条 + memory 四条、v0.44 起 ai.keyStatus、v0.45 起 points 三条、v0.46 起 app.showMain、v0.47 起 ai.setKey、v0.48 起 msg.remove、v0.58 起 reminder 五条、v0.60 起 app.checkUpdate、v0.61 起 task.removeEvidence、v0.62 起 hud.sensors、v0.88 起 alert.ack）', () => {
    expect(WIRED_CHANNELS.length).toBe(71)
    expect(new Set(WIRED_CHANNELS).size).toBe(71)
    expect(WIRED_CHANNELS).toContain(CH.task.promoteDraft)
    expect(WIRED_CHANNELS).toContain(CH.task.complete)
    expect(WIRED_CHANNELS).toContain(CH.task.undo)
    // v0.58：提醒五条接通（testChannel 仍留 NOT_WIRED，外部渠道没做）
    for (const ch of [
      CH.reminder.listByTask,
      CH.reminder.listUpcoming,
      CH.reminder.cancel,
      CH.reminder.snooze,
      CH.reminder.syncForTask
    ]) {
      expect(WIRED_CHANNELS).toContain(ch)
    }
    for (const ch of [CH.occurrence.complete, CH.occurrence.undo, CH.occurrence.skip]) {
      expect(WIRED_CHANNELS).toContain(ch)
    }
    for (const ch of [CH.hud.setMode, CH.hud.moveTo, CH.hud.setVisible, CH.hud.getState]) {
      expect(WIRED_CHANNELS).toContain(ch)
    }
    // W4：AI 接入的六条
    for (const ch of [
      CH.msg.send,
      CH.msg.retry,
      CH.ai.confirmDraft,
      CH.ai.rejectDrafts,
      CH.ai.review,
      CH.ai.health
    ]) {
      expect(WIRED_CHANNELS).toContain(ch)
    }
    // v0.37：人物卡两条 + 记忆四条
    for (const ch of [
      CH.persona.get,
      CH.persona.update,
      CH.memory.list,
      CH.memory.add,
      CH.memory.update,
      CH.memory.remove
    ]) {
      expect(WIRED_CHANNELS).toContain(ch)
    }
    // v0.44：设置抽屉的 key 状态（只读，不发探测请求）
    expect(WIRED_CHANNELS).toContain(CH.ai.keyStatus)
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
    expect(Object.keys(NOT_WIRED).length).toBe(4)
  })

  it('关键归属抽查：promoteDraft 已接通（v0.14 改判 W5）、task.complete 与 occurrence 三条已接通（W6）、hud 五条已接通（W9）、task.undo 是新增通道（v0.19）、msg.*/ai.*→W4 已接通、channel.*→W9、attachment 两条已随 v0.36 接通', () => {
    expect(NOT_WIRED[CH.task.promoteDraft]).toBeUndefined()
    expect(NOT_WIRED[CH.task.complete]).toBeUndefined()
    // task.undo 不在 NOT_WIRED 里：它不是"待接的既有通道"，而是 v0.19 新增的一条
    expect(NOT_WIRED[CH.task.undo]).toBeUndefined()
    expect(NOT_WIRED[CH.occurrence.complete]).toBeUndefined()
    expect(NOT_WIRED[CH.occurrence.undo]).toBeUndefined()
    expect(NOT_WIRED[CH.occurrence.skip]).toBeUndefined()
    expect(NOT_WIRED[CH.hud.getState]).toBeUndefined()
    expect(NOT_WIRED[CH.hud.setMode]).toBeUndefined()
    expect(NOT_WIRED[CH.msg.send]).toBeUndefined()
    expect(NOT_WIRED[CH.msg.retry]).toBeUndefined()
    expect(NOT_WIRED[CH.ai.review]).toBeUndefined()
    expect(NOT_WIRED[CH.ai.confirmDraft]).toBeUndefined()
    expect(NOT_WIRED[CH.ai.rejectDrafts]).toBeUndefined()
    expect(NOT_WIRED[CH.ai.health]).toBeUndefined()
    expect(NOT_WIRED[CH.channel.list]).toEqual({ owner: 'W9' })
    // v0.36：attachment.add / attachment.get 已随 W7 接通，不在 NOT_WIRED 里
    expect(NOT_WIRED[CH.attachment.add]).toBeUndefined()
    expect(NOT_WIRED[CH.attachment.get]).toBeUndefined()
  })
})
