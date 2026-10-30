/**
 * IPC 通道名常量。
 * 命名规则见 02 §1：`<domain>:<action>`，domain ∈ task | msg | points | ai | reminder | hud | app | occurrence | calendar | attachment | bus。
 * 主进程注册（W2）与 preload 调用共用这一份，不允许在别处手写通道字符串。
 */
export const CH = {
  app: {
    getBootstrap: 'app:getBootstrap',
    setSetting: 'app:setSetting',
    openExternal: 'app:openExternal',
    quit: 'app:quit'
  },
  task: {
    list: 'task:list',
    get: 'task:get',
    promoteDraft: 'task:promoteDraft',
    update: 'task:update',
    transition: 'task:transition',
    complete: 'task:complete',
    undo: 'task:undo',
    addEvidence: 'task:addEvidence',
    setRequiresEvidence: 'task:setRequiresEvidence',
    reorder: 'task:reorder',
    createManual: 'task:createManual',
    remove: 'task:remove',
    setReminderOffsets: 'task:setReminderOffsets'
  },
  occurrence: {
    today: 'occurrence:today',
    listByRange: 'occurrence:listByRange',
    complete: 'occurrence:complete',
    undo: 'occurrence:undo',
    skip: 'occurrence:skip'
  },
  calendar: {
    dayIndex: 'calendar:dayIndex',
    dayDetail: 'calendar:dayDetail'
  },
  msg: {
    send: 'msg:send',
    retry: 'msg:retry',
    list: 'msg:list'
  },
  attachment: {
    add: 'attachment:add'
  },
  ai: {
    confirmDraft: 'ai:confirmDraft',
    rejectDrafts: 'ai:rejectDrafts',
    review: 'ai:review',
    health: 'ai:health'
  },
  points: {
    balance: 'points:balance',
    ledger: 'points:ledger',
    monthStats: 'points:monthStats',
    adjust: 'points:adjust',
    preview: 'points:preview',
    streakPreview: 'points:streakPreview'
  },
  reminder: {
    listByTask: 'reminder:listByTask',
    listUpcoming: 'reminder:listUpcoming',
    cancel: 'reminder:cancel',
    snooze: 'reminder:snooze',
    syncForTask: 'reminder:syncForTask',
    testChannel: 'reminder:testChannel'
  },
  channel: {
    list: 'channel:list',
    setConfig: 'channel:setConfig',
    setGlobal: 'channel:setGlobal'
  },
  hud: {
    setMode: 'hud:setMode',
    moveTo: 'hud:moveTo',
    setVisible: 'hud:setVisible',
    getState: 'hud:getState'
  },
  /** 主进程 → 渲染进程的单向事件通道（DomainEvent） */
  bus: {
    event: 'bus:event'
  }
} as const

export type ChannelGroups = typeof CH
export type ChannelName = {
  [G in keyof ChannelGroups]: ChannelGroups[G][keyof ChannelGroups[G]]
}[keyof ChannelGroups]
