import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH } from '@shared/channels'
import type { Api, AppSettings, Bootstrap, IpcResult } from '@shared/types/ipc'
import type {
  Attachment,
  DayIndexEntry,
  DayStat,
  DayTaskItem,
  Message,
  NotifyChannel,
  Occurrence,
  PointEntry,
  Reminder,
  ReviewVerdict,
  Task
} from '@shared/types/domain'
import type { DomainEvent } from '@shared/types/events'

/** 统一走信封返回值（02 §1.2）：异常在主进程转成 ok:false，不从 invoke 抛出 */
function invoke<T>(channel: string, payload?: unknown): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<T>>
}

/**
 * 白名单暴露（02 §1.3）。渲染进程拿不到 ipcRenderer，只能调这里列出的方法。
 * W2 只需要在主进程注册对应 handler，本文件的通道名不用改。
 */
const api: Api = {
  app: {
    getBootstrap: () => invoke<Bootstrap>(CH.app.getBootstrap),
    setSetting: <K extends keyof AppSettings>(input: { key: K; value: AppSettings[K] }) =>
      invoke<void>(CH.app.setSetting, input),
    openExternal: input => invoke<void>(CH.app.openExternal, input),
    quit: () => invoke<void>(CH.app.quit)
  },

  task: {
    list: input => invoke<Task[]>(CH.task.list, input),
    get: input => invoke<Task & { subtasks: Task[] }>(CH.task.get, input),
    promoteDraft: input => invoke<Task>(CH.task.promoteDraft, input),
    update: input => invoke<Task>(CH.task.update, input),
    transition: input => invoke<Task>(CH.task.transition, input),
    complete: input => invoke<{ task: Task; entry: PointEntry | null }>(CH.task.complete, input),
    undo: input => invoke<{ task: Task; entry: PointEntry | null }>(CH.task.undo, input),
    addEvidence: input => invoke<Task>(CH.task.addEvidence, input),
    setRequiresEvidence: input => invoke<Task>(CH.task.setRequiresEvidence, input),
    reorder: input => invoke<void>(CH.task.reorder, input),
    createManual: input => invoke<Task>(CH.task.createManual, input),
    remove: input => invoke<void>(CH.task.remove, input),
    setReminderOffsets: input => invoke<Task>(CH.task.setReminderOffsets, input)
  },

  occurrence: {
    today: () => invoke<Occurrence[]>(CH.occurrence.today),
    listByRange: input => invoke<Occurrence[]>(CH.occurrence.listByRange, input),
    complete: input =>
      invoke<{ occurrence: Occurrence; entry: PointEntry; streakAfter: number }>(
        CH.occurrence.complete,
        input
      ),
    undo: input =>
      invoke<{ occurrence: Occurrence; balanceAfter: number }>(CH.occurrence.undo, input),
    skip: input => invoke<Occurrence>(CH.occurrence.skip, input)
  },

  calendar: {
    dayIndex: input => invoke<DayIndexEntry[]>(CH.calendar.dayIndex, input),
    dayDetail: input => invoke<DayTaskItem[]>(CH.calendar.dayDetail, input)
  },

  msg: {
    send: input => invoke<{ userMessage: Message; assistantMessageId: string }>(CH.msg.send, input),
    retry: input => invoke<void>(CH.msg.retry, input),
    list: input => invoke<Message[]>(CH.msg.list, input)
  },

  attachment: {
    add: input => invoke<Attachment>(CH.attachment.add, input)
  },

  ai: {
    confirmDraft: input => invoke<Task>(CH.ai.confirmDraft, input),
    rejectDrafts: input => invoke<void>(CH.ai.rejectDrafts, input),
    review: input => invoke<ReviewVerdict>(CH.ai.review, input),
    health: () =>
      invoke<{ configured: boolean; model: string; multimodal: boolean | null }>(CH.ai.health)
  },

  points: {
    balance: () => invoke<number>(CH.points.balance),
    ledger: input => invoke<PointEntry[]>(CH.points.ledger, input),
    monthStats: input => invoke<DayStat[]>(CH.points.monthStats, input),
    adjust: input => invoke<PointEntry>(CH.points.adjust, input),
    preview: input => invoke<number>(CH.points.preview, input),
    streakPreview: input => invoke<number>(CH.points.streakPreview, input)
  },

  reminder: {
    listByTask: input => invoke<Reminder[]>(CH.reminder.listByTask, input),
    listUpcoming: input => invoke<Reminder[]>(CH.reminder.listUpcoming, input),
    cancel: input => invoke<void>(CH.reminder.cancel, input),
    snooze: input => invoke<Reminder>(CH.reminder.snooze, input),
    syncForTask: input => invoke<Reminder[]>(CH.reminder.syncForTask, input),
    testChannel: input => invoke<{ ok: boolean; error?: string }>(CH.reminder.testChannel, input)
  },

  channel: {
    list: () => invoke<{ id: NotifyChannel; available: boolean; hint: string }[]>(CH.channel.list),
    setConfig: input => invoke<void>(CH.channel.setConfig, input),
    setGlobal: input => invoke<void>(CH.channel.setGlobal, input)
  },

  hud: {
    setMode: input => invoke<void>(CH.hud.setMode, input),
    moveTo: input => invoke<void>(CH.hud.moveTo, input),
    setVisible: input => invoke<void>(CH.hud.setVisible, input),
    getState: () =>
      invoke<{
        mode: 'ball' | 'panel'
        displayId: number
        visible: boolean
      }>(CH.hud.getState)
  },

  onEvent: cb => {
    const listener = (_event: IpcRendererEvent, payload: DomainEvent): void => cb(payload)
    ipcRenderer.on(CH.bus.event, listener)
    return () => {
      ipcRenderer.removeListener(CH.bus.event, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
