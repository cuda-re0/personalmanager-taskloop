"use strict";
const electron = require("electron");
const CH = {
  app: {
    getBootstrap: "app:getBootstrap",
    setSetting: "app:setSetting",
    openExternal: "app:openExternal",
    showMain: "app:showMain",
    quit: "app:quit",
    /** v0.60：本机 `updates/` 目录自检（设置页那一行的手动入口也走它） */
    checkUpdate: "app:checkUpdate"
  },
  task: {
    list: "task:list",
    get: "task:get",
    promoteDraft: "task:promoteDraft",
    update: "task:update",
    transition: "task:transition",
    complete: "task:complete",
    undo: "task:undo",
    addEvidence: "task:addEvidence",
    /** v0.61：待提交卡上删掉一条选错的证据（按 `evidence` 数组下标定位） */
    removeEvidence: "task:removeEvidence",
    setRequiresEvidence: "task:setRequiresEvidence",
    reorder: "task:reorder",
    createManual: "task:createManual",
    remove: "task:remove",
    setReminderOffsets: "task:setReminderOffsets"
  },
  occurrence: {
    today: "occurrence:today",
    listByRange: "occurrence:listByRange",
    complete: "occurrence:complete",
    undo: "occurrence:undo",
    skip: "occurrence:skip"
  },
  calendar: {
    dayIndex: "calendar:dayIndex",
    dayDetail: "calendar:dayDetail"
  },
  msg: {
    send: "msg:send",
    retry: "msg:retry",
    /** v0.48：撤回/编辑共用——按轮切片、软删任务、不广播消息删除事件 */
    remove: "msg:remove",
    list: "msg:list"
  },
  attachment: {
    add: "attachment:add",
    /** v0.36：证据卡片要 mime/url 才能画缩略图或角标，缺 Attachment 时按 id 补拉 */
    get: "attachment:get"
  },
  ai: {
    confirmDraft: "ai:confirmDraft",
    rejectDrafts: "ai:rejectDrafts",
    review: "ai:review",
    health: "ai:health",
    /** v0.44（设置抽屉）：只读「有没有 key」，**不发网络请求、不做多模态探测** */
    keyStatus: "ai:keyStatus",
    /** v0.47（设置抽屉）：写 `userData/ai-key.bin`，唯一副作用是写文件 */
    setKey: "ai:setKey"
  },
  points: {
    balance: "points:balance",
    ledger: "points:ledger",
    monthStats: "points:monthStats",
    adjust: "points:adjust",
    preview: "points:preview",
    streakPreview: "points:streakPreview",
    /** v0.45 零花钱：记账 / 撤销 / 本月支出 */
    spend: "points:spend",
    spendUndo: "points:spendUndo",
    spendMonth: "points:spendMonth"
  },
  reminder: {
    listByTask: "reminder:listByTask",
    listUpcoming: "reminder:listUpcoming",
    cancel: "reminder:cancel",
    snooze: "reminder:snooze",
    syncForTask: "reminder:syncForTask",
    testChannel: "reminder:testChannel"
  },
  /** 一天内的高频周期提醒（v0.86）：四条可 invoke 通道 */
  pulse: {
    list: "pulse:list",
    create: "pulse:create",
    setEnabled: "pulse:setEnabled",
    remove: "pulse:remove"
  },
  /** 提醒确认（v0.88）：只 record 不推送，所以不塞进 notify 那个单向组 */
  alert: {
    ack: "alert:ack"
  },
  channel: {
    list: "channel:list",
    setConfig: "channel:setConfig",
    setGlobal: "channel:setGlobal"
  },
  hud: {
    setMode: "hud:setMode",
    moveTo: "hud:moveTo",
    /** 长条拖动（v0.32）：dragBegin 取左上角算抓取偏移，dragTo 发绝对坐标，end=true 落库并判形态 */
    dragBegin: "hud:dragBegin",
    dragTo: "hud:dragTo",
    setVisible: "hud:setVisible",
    getState: "hud:getState",
    /** v0.62：悬浮条温度读数（无入参，主进程现取现回，内部有 1.5s 缓存） */
    sensors: "hud:sensors"
  },
  /** 主进程 → 渲染进程的单向事件通道（DomainEvent） */
  bus: {
    event: "bus:event"
  },
  /**
   * 提醒窗口（v0.58）：主进程 → notify 渲染入口的单向推送，**不是**可 invoke 的 api 方法。
   * 与 `bus.event` 同一类，因此同样不参与 IPC 注册表的覆盖检查。
   */
  notify: {
    show: "notify:show"
  },
  /** 人物卡（v0.37）：v1 只有一张，读 + 局部改 */
  persona: {
    get: "persona:get",
    update: "persona:update"
  },
  /** 长期记忆（v0.37）：增删改查，均不广播域事件 */
  memory: {
    list: "memory:list",
    add: "memory:add",
    update: "memory:update",
    remove: "memory:remove"
  }
};
function invoke(channel, payload) {
  return electron.ipcRenderer.invoke(channel, payload);
}
const api = {
  app: {
    getBootstrap: () => invoke(CH.app.getBootstrap),
    setSetting: (input) => invoke(CH.app.setSetting, input),
    openExternal: (input) => invoke(CH.app.openExternal, input),
    showMain: () => invoke(CH.app.showMain),
    quit: () => invoke(CH.app.quit),
    checkUpdate: () => invoke(CH.app.checkUpdate)
  },
  task: {
    list: (input) => invoke(CH.task.list, input),
    get: (input) => invoke(CH.task.get, input),
    promoteDraft: (input) => invoke(CH.task.promoteDraft, input),
    update: (input) => invoke(CH.task.update, input),
    transition: (input) => invoke(CH.task.transition, input),
    complete: (input) => invoke(CH.task.complete, input),
    undo: (input) => invoke(CH.task.undo, input),
    addEvidence: (input) => invoke(CH.task.addEvidence, input),
    removeEvidence: (input) => invoke(CH.task.removeEvidence, input),
    setRequiresEvidence: (input) => invoke(CH.task.setRequiresEvidence, input),
    reorder: (input) => invoke(CH.task.reorder, input),
    createManual: (input) => invoke(CH.task.createManual, input),
    remove: (input) => invoke(CH.task.remove, input),
    setReminderOffsets: (input) => invoke(CH.task.setReminderOffsets, input)
  },
  occurrence: {
    today: () => invoke(CH.occurrence.today),
    listByRange: (input) => invoke(CH.occurrence.listByRange, input),
    complete: (input) => invoke(
      CH.occurrence.complete,
      input
    ),
    undo: (input) => invoke(CH.occurrence.undo, input),
    skip: (input) => invoke(CH.occurrence.skip, input)
  },
  calendar: {
    dayIndex: (input) => invoke(CH.calendar.dayIndex, input),
    dayDetail: (input) => invoke(CH.calendar.dayDetail, input)
  },
  msg: {
    send: (input) => invoke(CH.msg.send, input),
    retry: (input) => invoke(CH.msg.retry, input),
    remove: (input) => invoke(CH.msg.remove, input),
    list: (input) => invoke(CH.msg.list, input)
  },
  attachment: {
    add: (input) => invoke(CH.attachment.add, input),
    get: (input) => invoke(CH.attachment.get, input)
  },
  ai: {
    confirmDraft: (input) => invoke(CH.ai.confirmDraft, input),
    rejectDrafts: (input) => invoke(CH.ai.rejectDrafts, input),
    review: (input) => invoke(CH.ai.review, input),
    health: () => invoke(CH.ai.health),
    keyStatus: () => invoke(CH.ai.keyStatus),
    setKey: (key) => invoke(CH.ai.setKey, { key })
  },
  points: {
    balance: () => invoke(CH.points.balance),
    ledger: (input) => invoke(CH.points.ledger, input),
    monthStats: (input) => invoke(CH.points.monthStats, input),
    adjust: (input) => invoke(CH.points.adjust, input),
    preview: (input) => invoke(CH.points.preview, input),
    streakPreview: (input) => invoke(CH.points.streakPreview, input),
    spend: (input) => invoke(CH.points.spend, input),
    spendUndo: (input) => invoke(CH.points.spendUndo, input),
    spendMonth: () => invoke(CH.points.spendMonth)
  },
  reminder: {
    listByTask: (input) => invoke(CH.reminder.listByTask, input),
    listUpcoming: (input) => invoke(CH.reminder.listUpcoming, input),
    cancel: (input) => invoke(CH.reminder.cancel, input),
    snooze: (input) => invoke(CH.reminder.snooze, input),
    syncForTask: (input) => invoke(CH.reminder.syncForTask, input),
    testChannel: (input) => invoke(CH.reminder.testChannel, input)
  },
  /** 一天内的高频周期提醒（v0.86） */
  pulse: {
    list: () => invoke(CH.pulse.list),
    create: (input) => invoke(CH.pulse.create, input),
    setEnabled: (input) => invoke(CH.pulse.setEnabled, input),
    remove: (input) => invoke(CH.pulse.remove, input)
  },
  alert: {
    ack: (input) => invoke(CH.alert.ack, input)
  },
  channel: {
    list: () => invoke(CH.channel.list),
    setConfig: (input) => invoke(CH.channel.setConfig, input),
    setGlobal: (input) => invoke(CH.channel.setGlobal, input)
  },
  hud: {
    setMode: (input) => invoke(CH.hud.setMode, input),
    moveTo: (input) => invoke(CH.hud.moveTo, input),
    dragBegin: () => invoke(CH.hud.dragBegin),
    dragTo: (input) => invoke(CH.hud.dragTo, input),
    setVisible: (input) => invoke(CH.hud.setVisible, input),
    getState: () => invoke(CH.hud.getState),
    sensors: () => invoke(CH.hud.sensors)
  },
  /** 人物卡 / 长期记忆（v0.37）：本单只交付数据与 IPC，界面入口在 W12B */
  persona: {
    get: () => invoke(CH.persona.get),
    update: (input) => invoke(CH.persona.update, input)
  },
  memory: {
    list: (input) => invoke(CH.memory.list, input),
    add: (input) => invoke(CH.memory.add, input),
    update: (input) => invoke(CH.memory.update, input),
    remove: (input) => invoke(CH.memory.remove, input)
  },
  /** 提醒窗口（v0.58）：与 onEvent 同一套「注册监听 + 返回解绑函数」的写法 */
  notify: {
    onShow: (cb) => {
      const listener = (_event, payload) => cb(payload);
      electron.ipcRenderer.on(CH.notify.show, listener);
      return () => {
        electron.ipcRenderer.removeListener(CH.notify.show, listener);
      };
    }
  },
  onEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    electron.ipcRenderer.on(CH.bus.event, listener);
    return () => {
      electron.ipcRenderer.removeListener(CH.bus.event, listener);
    };
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
