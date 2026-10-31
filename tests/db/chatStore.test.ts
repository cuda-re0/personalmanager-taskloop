import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as chatStateRepo from '../../src/main/db/repositories/chatStateRepo'
import * as memoryRepo from '../../src/main/db/repositories/memoryRepo'
import * as personaRepo from '../../src/main/db/repositories/personaRepo'
import * as memoryService from '../../src/main/services/memoryService'
import * as messageService from '../../src/main/services/messageService'
import * as personaService from '../../src/main/services/personaService'
import { closeTestDb, expectErrorCode, openMemoryDb } from './helpers'

/**
 * 聊天侧三张表与两个服务（01 §2.8~2.10、02 §3.8）。
 *
 * 只验契约里写死的边界：默认行只建一次、记忆唯一/上限/淘汰、聊天上下文只取 text。
 */
beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

describe('personaService.get（01 §2.8）', () => {
  it('空表首次调用建默认行，第二次返回同一行（不重复插入）', () => {
    expect(personaRepo.list()).toHaveLength(0)

    const first = personaService.get()
    expect(first.id).toBe('default')
    expect(first.name).toBe('小助手')
    expect(first.userCall).toBe('')
    expect(first.personaMd).toBe('')
    expect(first.tone).toBe('warm')
    expect(first.isActive).toBe(true)
    expect(personaRepo.list()).toHaveLength(1)

    const second = personaService.get()
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(personaRepo.list()).toHaveLength(1)
  })

  it('update 只写传了的字段，且长度超限给契约原句', () => {
    personaService.get()
    const updated = personaService.update({ userCall: '小明' })
    expect(updated.userCall).toBe('小明')
    expect(updated.name).toBe('小助手')
    expectErrorCode(() => personaService.update({ name: '' }), 'INVALID_INPUT')
    expectErrorCode(() => personaService.update({ name: 'x'.repeat(21) }), 'INVALID_INPUT')
    expectErrorCode(() => personaService.update({ personaMd: 'x'.repeat(801) }), 'INVALID_INPUT')
  })
})

describe('memoryService（01 §2.9）', () => {
  it('addManual 同一 contentMd 加两次 → 同一条，库里 1 行', () => {
    const first = memoryService.addManual({ contentMd: '养了一只猫叫豆豆', kind: 'fact' })
    const second = memoryService.addManual({ contentMd: '养了一只猫叫豆豆', kind: 'fact' })
    expect(second.id).toBe(first.id)
    expect(first.source).toBe('manual')
    expect(memoryRepo.count()).toBe(1)
  })

  it('第 51 条手动添加 → INVALID_INPUT，且库里仍是 50 条', () => {
    for (let i = 0; i < 50; i += 1) {
      memoryService.addManual({ contentMd: `第 ${i + 1} 条`, kind: 'fact' })
    }
    expect(memoryRepo.count()).toBe(50)
    expectErrorCode(() => memoryService.addManual({ contentMd: '第 51 条', kind: 'fact' }), 'INVALID_INPUT')
    expect(memoryRepo.count()).toBe(50)
  })

  it('addAuto 满 50 条时淘汰 hits 最低、最久没碰的那条', () => {
    const ids: string[] = []
    for (let i = 0; i < 50; i += 1) {
      const added = memoryService.addAuto({ contentMd: `自动第 ${i + 1} 条`, kind: 'fact' })
      expect(added).not.toBeNull()
      ids.push(added!.id)
    }
    // 第一条被拼进过 prompt → hits=1，淘汰时应该躲开它
    memoryService.touchHits([ids[0]])

    const added = memoryService.addAuto({ contentMd: '新记住的一条', kind: 'profile' })
    expect(added).not.toBeNull()
    expect(memoryRepo.count()).toBe(50)
    expect(memoryRepo.getById(ids[0])).not.toBeNull()
    expect(memoryRepo.getById(ids[1])).toBeNull()
  })

  it('addAuto 对空串与超长句直接丢弃（不截断）', () => {
    expect(memoryService.addAuto({ contentMd: '   ', kind: 'fact' })).toBeNull()
    expect(memoryService.addAuto({ contentMd: 'x'.repeat(121), kind: 'fact' })).toBeNull()
    expect(memoryRepo.count()).toBe(0)
  })

  it('update 撞另一条的内容 → INVALID_INPUT「这条记忆已经存在」', () => {
    const a = memoryService.addManual({ contentMd: '喜欢喝豆浆', kind: 'preference' })
    memoryService.addManual({ contentMd: '在读研二', kind: 'profile' })
    expectErrorCode(() => memoryService.update(a.id, { contentMd: '在读研二' }), 'INVALID_INPUT')
  })
})

describe('chat_state（01 §2.10）', () => {
  it('get 无行时就地插一行空摘要', () => {
    const state = chatStateRepo.get()
    expect(state.id).toBe('main')
    expect(state.summaryMd).toBe('')
    expect(state.uptoMessageId).toBeNull()
    const again = chatStateRepo.get()
    expect(again.id).toBe('main')
  })

  it('setSummary 写回摘要与游标', () => {
    chatStateRepo.setSummary({ summaryMd: '聊了工作和猫。', uptoMessageId: 'm-20' })
    const state = chatStateRepo.get()
    expect(state.summaryMd).toBe('聊了工作和猫。')
    expect(state.uptoMessageId).toBe('m-20')
  })
})

describe('recentChatMessages（03 §4.3.1）', () => {
  it('5 条 text + task_draft + task_review → 只返回 5 条 text，时间正序', () => {
    const texts: string[] = []
    for (let i = 1; i <= 5; i += 1) {
      const text = `第 ${i} 句`
      messageService.appendMessage({ role: 'user', kind: 'text', contentMd: text, status: 'sent' })
      texts.push(text)
    }
    messageService.appendMessage({
      role: 'assistant',
      kind: 'task_draft',
      contentMd: '',
      meta: { kind: 'task_draft', drafts: [] }
    })
    messageService.appendMessage({
      role: 'system',
      kind: 'error',
      contentMd: '',
      meta: { kind: 'error', code: 'UNKNOWN', message: '失败', retryable: true }
    })

    const recent = messageService.recentChatMessages(20)
    expect(recent).toHaveLength(5)
    expect(recent.map(m => m.contentMd)).toEqual(texts)
  })

  it('excludeId 排掉本轮用户消息（msg.send 是先落库再跑轮次）', () => {
    messageService.appendMessage({ role: 'user', kind: 'text', contentMd: '上一句' })
    const current = messageService.appendMessage({
      role: 'user',
      kind: 'text',
      contentMd: '本轮这句'
    })
    const recent = messageService.recentChatMessages(20, { excludeId: current.id })
    expect(recent.map(m => m.contentMd)).toEqual(['上一句'])
  })
})
