import { Menu } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'

/**
 * 输入框右键菜单（v0.50 §3.1）。
 *
 * Electron 不自带右键菜单：不挂 `context-menu` 就一个菜单都没有，那四个编辑动作全得靠键盘。
 * 本模块只管**可编辑区**（输入框）；在气泡文字上右键直接不弹（用户裁决）。
 *
 * 四项文字只有这一份来源，别处不许再写第二遍。
 */
export const EDIT_MENU_LABELS = ['剪切', '复制', '粘贴', '全选'] as const

/** `params.editFlags` 里我们关心的四个字段，一一对应四个菜单项 */
export interface EditMenuFlags {
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
}

export interface EditMenuItem {
  label: string
  enabled: boolean
  /** 只有第 4 项带这个字段；其余项**不出现**该字段（不是 false） */
  separatorBefore?: boolean
}

/**
 * 纯函数：flags → 四个菜单项。
 *
 * 四项**永远都在**，全禁用时也返回四项（返回空数组会让菜单凭空消失，用户以为又坏了）。
 * `enabled` 与 flag 一一对应，不做任何合并推导。
 */
export function buildEditMenuTemplate(flags: EditMenuFlags): EditMenuItem[] {
  return [
    { label: EDIT_MENU_LABELS[0], enabled: flags.canCut },
    { label: EDIT_MENU_LABELS[1], enabled: flags.canCopy },
    { label: EDIT_MENU_LABELS[2], enabled: flags.canPaste },
    { label: EDIT_MENU_LABELS[3], enabled: flags.canSelectAll, separatorBefore: true }
  ]
}

/**
 * 菜单对象的模块级引用，**不能省**。
 *
 * 每次 build 后必须赋给它：`Menu.buildFromTemplate(...).popup()` 写成一行链式调用时，
 * 菜单对象在弹出期间没有活引用，可能被 GC 回收，表现为"偶尔点了没反应"（Electron 经典坑）。
 */
let lastMenu: Menu | null = null

/** 只挂主窗（HUD 没有输入框，不挂；也不要用 web-contents-created 全局挂） */
export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    // 只管输入框：气泡上右键什么都不弹，也不 preventDefault（不拦默认行为）
    if (!params.isEditable) return

    // 四个动作按索引与四项一一对应，别写四段重复的判断
    const actions: (() => void)[] = [
      () => win.webContents.cut(),
      () => win.webContents.copy(),
      () => win.webContents.paste(),
      () => win.webContents.selectAll()
    ]

    const template: MenuItemConstructorOptions[] = []
    buildEditMenuTemplate(params.editFlags).forEach((item, index) => {
      if (item.separatorBefore === true) template.push({ type: 'separator' })
      template.push({ label: item.label, enabled: item.enabled, click: actions[index] })
    })

    lastMenu = Menu.buildFromTemplate(template)
    lastMenu.popup({ window: win })
  })
}
