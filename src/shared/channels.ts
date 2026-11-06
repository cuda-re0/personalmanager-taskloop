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
    showMain: 'app:showMain',
    quit: 'app:quit',
    /** v0.60：本机 `updates/` 目录自检（设置页那一行的手动入口也走它） */
    checkUpdate: 'app:checkUpdate'
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
    /** v0.61：待提交卡上删掉一条选错的证据（按 `evidence` 数组下标定位） */
    removeEvidence: 'task:removeEvidence',
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
    /** v0.48：撤回/编辑共用——按轮切片、软删任务、不广播消息删除事件 */
    remove: 'msg:remove',
    list: 'msg:list'
  },
  attachment: {
    add: 'attachment:add',
    /** v0.36：证据卡片要 mime/url 才能画缩略图或角标，缺 Attachment 时按 id 补拉 */
    get: 'attachment:get'
  },
  ai: {
    confirmDraft: 'ai:confirmDraft',
    rejectDrafts: 'ai:rejectDrafts',
    review: 'ai:review',
    health: 'ai:health',
    /** v0.44（设置抽屉）：只读「有没有 key」，**不发网络请求、不做多模态探测** */
    keyStatus: 'ai:keyStatus',
    /** v0.47（设置抽屉）：写 `userData/ai-key.bin`，唯一副作用是写文件 */
    setKey: 'ai:setKey'
  },
  points: {
    balance: 'points:balance',
    ledger: 'points:ledger',
    monthStats: 'points:monthStats',
    adjust: 'points:adjust',
    preview: 'points:preview',
    streakPreview: 'points:streakPreview',
    /** v0.45 零花钱：记账 / 撤销 / 本月支出 */
    spend: 'points:spend',
    spendUndo: 'points:spendUndo',
    spendMonth: 'points:spendMonth'
  },
  reminder: {
    listByTask: 'reminder:listByTask',
    listUpcoming: 'reminder:listUpcoming',
    cancel: 'reminder:cancel',
    snooze: 'reminder:snooze',
    syncForTask: 'reminder:syncForTask',
    testChannel: 'reminder:testChannel'
  },
  /** 一天内的高频周期提醒（v0.86）：四条可 invoke 通道 */
  pulse: {
    list: 'pulse:list',
    create: 'pulse:create',
    setEnabled: 'pulse:setEnabled',
    remove: 'pulse:remove'
  },
  /** 提醒确认（v0.88）：只 record 不推送，所以不塞进 notify 那个单向组 */
  alert: {
    ack: 'alert:ack'
  },
  channel: {
    list: 'channel:list',
    setConfig: 'channel:setConfig',
    setGlobal: 'channel:setGlobal'
  },
  hud: {
    setMode: 'hud:setMode',
    moveTo: 'hud:moveTo',
    /** 长条拖动（v0.32）：dragBegin 取左上角算抓取偏移，dragTo 发绝对坐标，end=true 落库并判形态 */
    dragBegin: 'hud:dragBegin',
    dragTo: 'hud:dragTo',
    setVisible: 'hud:setVisible',
    getState: 'hud:getState',
    /** v0.62：悬浮条温度读数（无入参，主进程现取现回，内部有 1.5s 缓存） */
    sensors: 'hud:sensors'
  },
  /** 主进程 → 渲染进程的单向事件通道（DomainEvent） */
  bus: {
    event: 'bus:event'
  },
  /**
   * 提醒窗口（v0.58）：主进程 → notify 渲染入口的单向推送，**不是**可 invoke 的 api 方法。
   * 与 `bus.event` 同一类，因此同样不参与 IPC 注册表的覆盖检查。
   */
  notify: {
    show: 'notify:show'
  },
  /** 人物卡（v0.37）：v1 只有一张，读 + 局部改 */
  persona: {
    get: 'persona:get',
    update: 'persona:update'
  },
  /** 长期记忆（v0.37）：增删改查，均不广播域事件 */
  memory: {
    list: 'memory:list',
    add: 'memory:add',
    update: 'memory:update',
    remove: 'memory:remove'
  }
} as const

export type ChannelGroups = typeof CH
export type ChannelName = {
  [G in keyof ChannelGroups]: ChannelGroups[G][keyof ChannelGroups[G]]
}[keyof ChannelGroups]
