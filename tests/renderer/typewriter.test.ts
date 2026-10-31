import { describe, expect, it } from 'vitest'
import {
  TYPE_BASE_CPS,
  TYPE_FAST_CPS,
  TYPE_FAST_THRESHOLD,
  createTyper
} from '../../src/renderer/main/features/chat/typewriter'

/**
 * `createTyper`（04 §3.4.2）：注入了 `now`，所以用例不依赖真实时间。
 * 断言的是"按已过时间算出的字数"，不是逐字吐字的过程。
 */
describe('createTyper', () => {
  it('40 字/秒：0.5 秒 20 字、1 秒 40 字', () => {
    let shown = ''
    const typer = createTyper({
      text: 'a'.repeat(100),
      now: () => 0,
      onUpdate: partial => {
        shown = partial
      }
    })
    expect(TYPE_BASE_CPS).toBe(40)
    typer.tick(500)
    expect(Array.from(shown)).toHaveLength(20)
    typer.tick(1000)
    expect(Array.from(shown)).toHaveLength(40)
    expect(typer.done()).toBe(false)
  })

  it('总长 401 字时提到 80 字/秒', () => {
    let shown = ''
    const typer = createTyper({
      text: 'b'.repeat(TYPE_FAST_THRESHOLD + 1),
      now: () => 0,
      onUpdate: partial => {
        shown = partial
      }
    })
    expect(TYPE_FAST_CPS).toBe(80)
    typer.tick(500)
    expect(Array.from(shown)).toHaveLength(40)
  })

  it('400 字仍是 40 字/秒（阈值是「大于 400」）', () => {
    let shown = ''
    const typer = createTyper({
      text: 'c'.repeat(TYPE_FAST_THRESHOLD),
      now: () => 0,
      onUpdate: partial => {
        shown = partial
      }
    })
    typer.tick(500)
    expect(Array.from(shown)).toHaveLength(20)
  })

  it('tick 停在末尾不越界，结束后不再推更新', () => {
    const updates: string[] = []
    const typer = createTyper({
      text: '短句',
      now: () => 0,
      onUpdate: partial => updates.push(partial)
    })
    typer.tick(10_000)
    expect(updates[updates.length - 1]).toBe('短句')
    expect(typer.done()).toBe(true)
    const count = updates.length
    typer.tick(20_000)
    expect(updates.length).toBe(count)
  })

  it('finish() 立即全显', () => {
    let shown = ''
    const typer = createTyper({
      text: '还没打完的一句话',
      now: () => 0,
      onUpdate: partial => {
        shown = partial
      }
    })
    typer.tick(100)
    expect(shown).not.toBe('还没打完的一句话')
    typer.finish()
    expect(shown).toBe('还没打完的一句话')
  })

  it('stop() 之后不再推更新', () => {
    let calls = 0
    const typer = createTyper({
      text: 'a'.repeat(100),
      now: () => 0,
      onUpdate: () => {
        calls += 1
      }
    })
    typer.tick(500)
    const before = calls
    typer.stop()
    typer.tick(2000)
    expect(calls).toBe(before)
  })

  it('按码点切字：emoji 不会被截成半个', () => {
    let shown = ''
    const typer = createTyper({
      text: '😀😀😀😀',
      now: () => 0,
      onUpdate: partial => {
        shown = partial
      }
    })
    typer.tick(50) // 40 字/秒 → 2 个
    expect(Array.from(shown)).toHaveLength(2)
    expect(shown).toBe('😀😀')
  })
})
