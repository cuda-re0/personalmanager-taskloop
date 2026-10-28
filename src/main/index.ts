import { app, BrowserWindow } from 'electron'
import { initDb } from './db'
import { registerIpcHandlers } from './ipc'
import { createHudWindow, createMainWindow } from './windowManager'

app.whenReady().then(() => {
  initDb() // W1 填实现
  console.log('[main] initDb() invoked')
  createMainWindow()
  createHudWindow()
  registerIpcHandlers() // W2 填实现
  console.log('[main] registerIpcHandlers() invoked')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
