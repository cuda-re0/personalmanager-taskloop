import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Memory, MemoryKind } from '@shared/types/domain'
import { diffPersona, toPersonaForm, type PersonaForm } from './settingsModel'

/**
 * 设置抽屉的数据与动作（v0.44）。
 *
 * 三条纪律，都跟「抽屉一关就卸载」有关：
 *
 * 1. **打开即并发拉四份**：`persona.get` / `memory.list` / `ai.keyStatus` 三条读通道，
 *    外加 `app.getBootstrap`（两个模型名在那里，不为它们另开通道）。
 *    抽屉每次打开都是重新挂载，所以这里不需要任何「刷新」入口。
 * 2. **不做乐观更新**：人物卡与记忆都等返回值再改本地状态。单用户界面没有延迟问题，
 *    乐观更新只会多出一套「失败了怎么回滚」的分支。
 * 3. 失败一律把后端 `error.message` 原文放进**对应那一段**（人物卡 / 记忆 / AI 各一个字段）。
 *    一个全局 error 会让「保存人设失败」跑到记忆块下面去，用户对着错误的段落排查。
 *
 * 所有 setState 前判一次 `mounted`：抽屉随时可能被关掉（关掉即卸载），
 * 在路上的读/写回调不该往已卸载的组件里写状态。
 */

/** 两个模型名（只读展示，04 §5.5）。取自 `bootstrap.settings`，与 AI 管线的取值同源 */
export interface SettingsModels {
  task: string
  chat: string
}

export interface SettingsData {
  form: PersonaForm
  /** 已保存快照：脏值判断的基准（`null` = 人物卡还没拉到） */
  saved: PersonaForm | null
  memories: Memory[]
  models: SettingsModels
  /** `null` = 还没拿到 `ai.keyStatus`：这一行先不写字，不猜「未配置」 */
  configured: boolean | null
  saving: boolean
  /** 正在删除的那行记忆 id（该行按钮 `disabled`） */
  busyId: string | null
  personaError: string | null
  memoryError: string | null
  aiError: string | null
  /** `已保存` 的瞬时提示（1.2 秒后自己消失；文字在展示组件里） */
  notice: boolean
  dirty: boolean
  canSave: boolean
  setField<K extends keyof PersonaForm>(key: K, value: PersonaForm[K]): void
  save(): void
  /** 返回 `false` = 没保存成功，调用方留着编辑态让用户改 */
  updateMemory(id: string, contentMd: string): Promise<boolean>
  removeMemory(id: string): void
  /** 返回 `false` = 没加成功；`true` 时由调用方把底部输入框置空 */
  addMemory(contentMd: string, kind: MemoryKind): Promise<boolean>
}

/** 还没拉到人物卡时的表单初值：四个字段都空、语气按第一项，`saved` 仍是 `null`（于是不可保存） */
const EMPTY_FORM: PersonaForm = { name: '', userCall: '', personaMd: '', tone: 'warm' }

/** `已保存` 提示的存活时间（ms） */
const NOTICE_MS = 1200

export function useSettingsData(): SettingsData {
  const [form, setForm] = useState<PersonaForm>(EMPTY_FORM)
  /** 已保存快照：脏值判断的唯一基准，成功后随返回值一起换掉 */
  const [saved, setSaved] = useState<PersonaForm | null>(null)
  const [memories, setMemories] = useState<Memory[]>([])
  const [models, setModels] = useState<SettingsModels>({ task: '', chat: '' })
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [personaError, setPersonaError] = useState<string | null>(null)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [notice, setNotice] = useState(false)

  const mounted = useRef(true)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // StrictMode 下 effect 会跑两遍：这里必须重新置 true，否则第二次挂载后 mounted 一直是 false
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
    },
    []
  )

  const flashNotice = useCallback((): void => {
    setNotice(true)
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null
      if (mounted.current) setNotice(false)
    }, NOTICE_MS)
  }, [])

  useEffect(() => {
    void Promise.all([
      window.api.persona.get(),
      window.api.memory.list({}),
      window.api.ai.keyStatus(),
      window.api.app.getBootstrap()
    ])
      .then(([personaRes, memoryRes, keyRes, bootstrapRes]) => {
        if (!mounted.current) return
        if (personaRes.ok) {
          const next = toPersonaForm(personaRes.data)
          setForm(next)
          setSaved(next)
        } else {
          setPersonaError(personaRes.error.message)
        }
        if (memoryRes.ok) setMemories(memoryRes.data)
        else setMemoryError(memoryRes.error.message)
        if (keyRes.ok) setConfigured(keyRes.data.configured)
        else setAiError(prev => prev ?? keyRes.error.message)
        if (bootstrapRes.ok) {
          setModels({
            task: bootstrapRes.data.settings['ai.provider'].model,
            chat: bootstrapRes.data.settings['ai.chat.model']
          })
        } else {
          setAiError(prev => prev ?? bootstrapRes.error.message)
        }
      })
      .catch((e: unknown) => console.error('[settings] 打开时拉数据失败', e))
  }, [])

  const dirty = saved !== null && diffPersona(form, saved) !== null

  const setField = useCallback(<K extends keyof PersonaForm>(key: K, value: PersonaForm[K]): void => {
    setForm(prev => ({ ...prev, [key]: value }))
  }, [])

  const save = useCallback((): void => {
    const patch = saved === null ? null : diffPersona(form, saved)
    if (patch === null || saving) return
    setSaving(true)
    setPersonaError(null)
    void window.api.persona
      .update(patch)
      .then(res => {
        if (!mounted.current) return
        if (!res.ok) {
          setPersonaError(res.error.message)
          return
        }
        const next = toPersonaForm(res.data)
        setForm(next)
        setSaved(next)
        flashNotice()
      })
      .catch((e: unknown) => {
        console.error('[settings] persona.update 调用失败', e)
        if (mounted.current) setPersonaError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (mounted.current) setSaving(false)
      })
  }, [form, saved, saving, flashNotice])

  const updateMemory = useCallback(async (id: string, contentMd: string): Promise<boolean> => {
    setMemoryError(null)
    try {
      const res = await window.api.memory.update({ id, contentMd })
      if (!mounted.current) return false
      if (!res.ok) {
        setMemoryError(res.error.message)
        return false
      }
      const next = res.data
      // 就地替换：列表顺序按 `updatedAt` 降序由后端给，前端不重排（04 §5.4）
      setMemories(prev => prev.map(m => (m.id === next.id ? next : m)))
      return true
    } catch (e) {
      console.error('[settings] memory.update 调用失败', e)
      if (mounted.current) setMemoryError(e instanceof Error ? e.message : String(e))
      return false
    }
  }, [])

  const removeMemory = useCallback((id: string): void => {
    setMemoryError(null)
    setBusyId(id)
    void window.api.memory
      .remove({ id })
      .then(res => {
        if (!mounted.current) return
        if (!res.ok) {
          setMemoryError(res.error.message)
          return
        }
        setMemories(prev => prev.filter(m => m.id !== id))
      })
      .catch((e: unknown) => {
        console.error('[settings] memory.remove 调用失败', e)
        if (mounted.current) setMemoryError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (mounted.current) setBusyId(null)
      })
  }, [])

  const addMemory = useCallback(async (contentMd: string, kind: MemoryKind): Promise<boolean> => {
    setMemoryError(null)
    try {
      const res = await window.api.memory.add({ contentMd, kind })
      if (!mounted.current) return false
      if (!res.ok) {
        setMemoryError(res.error.message)
        return false
      }
      const created = res.data
      // 重复内容后端会返回已有那条（02 §3.8）：id 已在列表里就不重复插入，列表原样不动
      setMemories(prev => (prev.some(m => m.id === created.id) ? prev : [created, ...prev]))
      return true
    } catch (e) {
      console.error('[settings] memory.add 调用失败', e)
      if (mounted.current) setMemoryError(e instanceof Error ? e.message : String(e))
      return false
    }
  }, [])

  return useMemo(
    () => ({
      form,
      saved,
      memories,
      models,
      configured,
      saving,
      busyId,
      personaError,
      memoryError,
      aiError,
      notice,
      dirty,
      canSave: dirty && !saving,
      setField,
      save,
      updateMemory,
      removeMemory,
      addMemory
    }),
    [
      form,
      saved,
      memories,
      models,
      configured,
      saving,
      busyId,
      personaError,
      memoryError,
      aiError,
      notice,
      dirty,
      setField,
      save,
      updateMemory,
      removeMemory,
      addMemory
    ]
  )
}
