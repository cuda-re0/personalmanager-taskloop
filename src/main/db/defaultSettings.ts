import type { AppSettings } from '../../shared/types/ipc'

/**
 * settings 默认值。逐条对应 01 §2.7 的「默认值」列与 02 §3.0 的 `AppSettings` 封闭接口（20 个 key）。
 *
 * `ai.apiKey` 故意不在这里：它存 `safeStorage`，既不入 settings 表也不在 `AppSettings` 里（02 §3.0 末段）。
 *
 * v0.30：删 `hud.expanded`（展开态概念作废），加 `hud.size` / `hud.background` / `hud.opacity`，
 * `hud.mode` 默认改 `'ball'`。
 *
 * 这张表只负责"补齐"，不负责落库：迁移里不写业务数据（01 §5），DB 里只有用户真正改过的 key，
 * `settingRepo.getAll()` 用本表做底再做浅合并（W1 DELTA · W1-3）。
 */
export const DEFAULT_SETTINGS: AppSettings = {
  'ai.provider': { name: 'zhipu', model: 'glm-5.3-flash' },
  // v0.37（第 18 个 key）：闲聊与记忆提取用的便宜模型。纯文本、200K、强制思考。
  'ai.chat.model': 'glm-4.7-flashx',
  // v0.59b（第 20 个 key）：基址，不含 /chat/completions（路径由 glmClient.endpointOf 拼）
  'ai.baseUrl': 'https://open.bigmodel.cn/api/paas/v4',
  'hud.mode': 'ball',
  'hud.displayId': null,
  'hud.position': { x: null, y: null },
  'hud.size': null,
  'hud.background': null,
  'hud.opacity': 1,
  'hud.autoHideFullscreen': true,
  'points.difficultyBase': { trivial: 5, easy: 10, medium: 20, hard: 35, epic: 50 },
  // v0.54（第 19 个 key）：仅限时的难度基数，活动与每日仍走上面那张共用表
  'points.deadlineBase': { easy: 2, medium: 3, hard: 5 },
  'points.dailyBase': 1,
  'points.streakBonus': [
    { days: 7, bonus: 5 },
    { days: 30, bonus: 10 }
  ],
  'points.dailyCap': null,
  'reminder.quietHours': { from: '22:00', to: '08:00' },
  'reminder.channels': ['inapp', 'toast'],
  'channel.mail': { to: '' },
  'channel.webhook': null,
  'app.theme': 'light'
}

/** 白名单：写 setting 前用它挡掉未登记的 key（类型层已挡，这里防运行时字符串绕过） */
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]

export function isSettingKey(key: string): key is keyof AppSettings {
  return (SETTING_KEYS as string[]).includes(key)
}

/** 深拷贝一份默认值，避免调用方改到常量本身 */
export function cloneDefaultSettings(): AppSettings {
  return structuredClone(DEFAULT_SETTINGS)
}
