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

/** 三个可改的 AI 配置项（v0.59b）。取自 `bootstrap.settings`，与 AI 管线的取值同源 */
export interface SettingsModels {
  task: string
  chat: string
  /** 基址，不含 `/chat/completions`（完整地址由主进程 `endpointOf()` 拼） */
  baseUrl: string
}

/** 更新检查的展示状态（v0.60）：`note` 是 2.6 秒后自己消失的瞬时提示 */
export interface SettingsUpdate {
  version: string
  latest: string | null
  hasUpdate: boolean
  checking: boolean
  note: string | null
  /** 按钮上的结果文字（'已是最新' / '正在更新'），2 秒后回 null；错误不走这里 */
  buttonNote: string | null
}

export interface SettingsData {
  form: PersonaForm
  /** 已保存快照：脏值判断的基准（`null` = 人物卡还没拉到） */
  saved: PersonaForm | null
  memories: Memory[]
  models: SettingsModels
  /** `null` = 还没拿到 `ai.keyStatus`：这一行先不写字，不猜「未配置」 */
  configured: boolean | null
  /** 正在写 `ai-key.bin`（保存按钮 `disabled`） */
  keySaving: boolean
  /** 正在写 `ai.baseUrl` / 两个模型名（AI 配置保存按钮 `disabled`） */
  aiSaving: boolean
  saving: boolean
  /** 正在删除的那行记忆 id（该行按钮 `disabled`） */
  busyId: string | null
  personaError: string | null
  memoryError: string | null
  aiError: string | null
  /** `已保存` 的瞬时提示（1.2 秒后自己消失；文字在展示组件里） */
  notice: boolean
  /** 更新检查（v0.60）：版本号 + 一行手动入口 */
  update: SettingsUpdate
  /** 查一次本机 `updates/`；结果写回 `update`，`note` 2.6 秒后自己消失 */
  refreshUpdate(): Promise<void>
  dirty: boolean
  canSave: boolean
  setField<K extends keyof PersonaForm>(key: K, value: PersonaForm[K]): void
  save(): void
  /** 返回 `false` = 没保存成功，调用方留着编辑态让用户改 */
  updateMemory(id: string, contentMd: string): Promise<boolean>
  removeMemory(id: string): void
  /** 返回 `false` = 没加成功；`true` 时由调用方把底部输入框置空 */
  addMemory(contentMd: string, kind: MemoryKind): Promise<boolean>
  /** 返回 `true` = 已写入 `ai-key.bin`；`true` 时由调用方把输入框置空 */
  saveKey(key: string): Promise<boolean>
  /**
   * 写三个 AI 配置项（v0.59b）：只提交真正改动的字段，串行、任一条失败即停。
   * 返回 `true` = 三条都写成功（或本来就没改动），调用方据此把草稿对齐回已保存值。
   */
  saveAiConfig(next: SettingsModels): Promise<boolean>
  /** 退出整个应用（含悬浮条与后台 sweeper），fire-and-forget */
  quit(): void
}

/** 还没拉到人物卡时的表单初值：四个字段都空、语气按第一项，`saved` 仍是 `null`（于是不可保存） */
const EMPTY_FORM: PersonaForm = { name: '', userCall: '', personaMd: '', tone: 'warm' }

/** `已保存` 提示的存活时间（ms） */
const NOTICE_MS = 1200
/** 更新检查提示的存活时间（ms，v0.60）：比"已保存"长一点——它带一句话，扫一眼要时间 */
const UPDATE_NOTE_MS = 2600
/** 按钮上结果文字的停留时间（ms，v0.61）：与主进程 applyUpdate 的 2 秒等待对齐 */
const UPDATE_BUTTON_MS = 2000

/** 更新状态的初值：版本号还没拿到时留空，不猜一个数字 */
const EMPTY_UPDATE: SettingsUpdate = {
  version: '',
  latest: null,
  hasUpdate: false,
  checking: false,
  note: null,
  buttonNote: null
}

export function useSettingsData(): SettingsData {
  const [form, setForm] = useState<PersonaForm>(EMPTY_FORM)
  /** 已保存快照：脏值判断的唯一基准，成功后随返回值一起换掉 */
  const [saved, setSaved] = useState<PersonaForm | null>(null)
  const [memories, setMemories] = useState<Memory[]>([])
  const [models, setModels] = useState<SettingsModels>({ task: '', chat: '', baseUrl: '' })
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [keySaving, setKeySaving] = useState(false)
  const [aiSaving, setAiSaving] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [personaError, setPersonaError] = useState<string | null>(null)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [notice, setNotice] = useState(false)
  const [update, setUpdate] = useState<SettingsUpdate>(EMPTY_UPDATE)

  const mounted = useRef(true)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const buttonNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      if (updateNoteTimer.current !== null) clearTimeout(updateNoteTimer.current)
      if (buttonNoteTimer.current !== null) clearTimeout(buttonNoteTimer.current)
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

  /** 更新检查的提示：同一时刻只有一句，后一句覆盖前一句并重新计时 */
  const flashUpdateNote = useCallback((note: string): void => {
    setUpdate(prev => ({ ...prev, note }))
    if (updateNoteTimer.current !== null) clearTimeout(updateNoteTimer.current)
    updateNoteTimer.current = setTimeout(() => {
      updateNoteTimer.current = null
      if (mounted.current) setUpdate(prev => ({ ...prev, note: null }))
    }, UPDATE_NOTE_MS)
  }, [])

  /**
   * 查一次有没有新版本（v0.60）。**主进程决定装不装**，这里只显示：
   * 结果写进**按钮文字**（v0.61）：`hasUpdate` 为真写"正在更新"（真的会重启），否则"已是最新"，
   * 2 秒后回落到"检查更新"；失败仍走 `settings-notice` 显示后端 message 原文。
   */
  const refreshUpdate = useCallback(async (): Promise<void> => {
    // 连点保护：上一次的按钮结果定时器不能提前把这一次的结果抹掉
    if (buttonNoteTimer.current !== null) {
      clearTimeout(buttonNoteTimer.current)
      buttonNoteTimer.current = null
    }
    setUpdate(prev => ({ ...prev, checking: true, buttonNote: null }))
    try {
      const res = await window.api.app.checkUpdate()
      if (!mounted.current) return
      if (!res.ok) {
        setUpdate(prev => ({ ...prev, checking: false }))
        flashUpdateNote(res.error.message)
        return
      }
      setUpdate(prev => ({
        ...prev,
        version: res.data.current,
        latest: res.data.latest,
        hasUpdate: res.data.hasUpdate,
        checking: false,
        buttonNote: res.data.hasUpdate ? '正在更新' : '已是最新'
      }))
      buttonNoteTimer.current = setTimeout(() => {
        buttonNoteTimer.current = null
        if (mounted.current) setUpdate(prev => ({ ...prev, buttonNote: null }))
      }, UPDATE_BUTTON_MS)
    } catch (e) {
      console.error('[settings] app.checkUpdate 调用失败', e)
      if (!mounted.current) return
      setUpdate(prev => ({ ...prev, checking: false }))
      flashUpdateNote(e instanceof Error ? e.message : String(e))
    }
  }, [flashUpdateNote])

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
            chat: bootstrapRes.data.settings['ai.chat.model'],
            baseUrl: bootstrapRes.data.settings['ai.baseUrl']
          })
        } else {
          setAiError(prev => prev ?? bootstrapRes.error.message)
        }
      })
      .catch((e: unknown) => console.error('[settings] 打开时拉数据失败', e))
  }, [])

  // 挂载时先查一次（v0.60）：主要是把版本号填进那一行。`refreshUpdate` 是稳定引用，
  // 所以这个 effect 只跑一次（抽屉每次打开都是重新挂载）
  useEffect(() => {
    void refreshUpdate()
  }, [refreshUpdate])

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

  /**
   * 写 Key（v0.47）：状态只认返回值里的 `configured`，不硬编码 true。
   * **key 不许进任何一条日志**——这里最多报调用失败本身。
   */
  const saveKey = useCallback(async (key: string): Promise<boolean> => {
    setAiError(null)
    setKeySaving(true)
    try {
      const res = await window.api.ai.setKey(key)
      if (!mounted.current) return false
      if (!res.ok) {
        setAiError(res.error.message)
        return false
      }
      setConfigured(res.data.configured)
      return true
    } catch (e) {
      console.error('[settings] ai.setKey 调用失败', e)
      if (mounted.current) setAiError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      if (mounted.current) setKeySaving(false)
    }
  }, [])

  /**
   * 写三个 AI 配置项（v0.59b）。三条纪律：
   *
   * 1. **只提交真正改动的字段**：没改的不发请求，免得白广播 `app.setting.changed`。
   * 2. **串行 `await`**：任一条失败立即停，错误原文进 `aiError`（已写下的那条仍然生效）。
   * 3. 顺序固定 `ai.baseUrl` → `ai.provider` → `ai.chat.model`：地址先落地，
   *    后面两条即便失败，下一轮也不会带着新模型名打到旧地址上。
   */
  const saveAiConfig = useCallback(
    async (next: SettingsModels): Promise<boolean> => {
      setAiError(null)
      setAiSaving(true)
      try {
        if (next.baseUrl !== models.baseUrl) {
          const res = await window.api.app.setSetting({ key: 'ai.baseUrl', value: next.baseUrl })
          if (!mounted.current) return false
          if (!res.ok) {
            setAiError(res.error.message)
            return false
          }
        }
        if (next.task !== models.task) {
          const res = await window.api.app.setSetting({
            key: 'ai.provider',
            value: { name: 'zhipu', model: next.task }
          })
          if (!mounted.current) return false
          if (!res.ok) {
            setAiError(res.error.message)
            return false
          }
        }
        if (next.chat !== models.chat) {
          const res = await window.api.app.setSetting({
            key: 'ai.chat.model',
            value: next.chat
          })
          if (!mounted.current) return false
          if (!res.ok) {
            setAiError(res.error.message)
            return false
          }
        }
        if (!mounted.current) return false
        setModels(next)
        flashNotice()
        return true
      } catch (e) {
        console.error('[settings] app.setSetting 调用失败', e)
        if (mounted.current) setAiError(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        if (mounted.current) setAiSaving(false)
      }
    },
    [models, flashNotice]
  )

  /**
   * 退出整个应用（v0.55）：`app.quit()` 一旦生效渲染进程就没了，Promise 不会正常回来，
   * 所以是 fire-and-forget——不 await、不置"正在退出"标志、失败也不做 UI 反馈（进程都要没了，
   * 报错没有落点）。
   */
  const quit = useCallback((): void => {
    void window.api.app.quit().catch((e: unknown) => {
      console.error('[settings] app.quit 调用失败', e)
    })
  }, [])

  return useMemo(
    () => ({
      form,
      saved,
      memories,
      models,
      configured,
      keySaving,
      aiSaving,
      saving,
      busyId,
      personaError,
      memoryError,
      aiError,
      notice,
      update,
      dirty,
      canSave: dirty && !saving,
      setField,
      save,
      updateMemory,
      removeMemory,
      addMemory,
      saveKey,
      saveAiConfig,
      refreshUpdate,
      quit
    }),
    [
      form,
      saved,
      memories,
      models,
      configured,
      keySaving,
      aiSaving,
      saving,
      busyId,
      personaError,
      memoryError,
      aiError,
      notice,
      update,
      dirty,
      setField,
      save,
      updateMemory,
      removeMemory,
      addMemory,
      saveKey,
      saveAiConfig,
      refreshUpdate,
      quit
    ]
  )
}
