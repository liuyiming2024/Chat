/* ------------------------------------------------------------------
 * electron/main.js —— 桌面版主进程
 *
 * 这里只做三件事：开窗口、给菜单、管生命周期。
 * 业务逻辑一行都不复制 —— 网页和桌面版跑的是同一份前端代码，
 * 否则改一处要改两遍，迟早对不上。
 * ------------------------------------------------------------------ */
'use strict';
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

/* 网页是纯静态的，装了也没有 nodeIntegration 的必要。
   开着只会把整个 Node 能力暴露给页面内容，属于自找风险。 */
function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 420,
    title: '聊天室',
    backgroundColor: '#ffffff',
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      /* 允许页面加载自己的 service worker 与 IndexedDB */
      partition: 'persist:chat'
    }
  });

  const entry = app.isPackaged
    ? path.join(__dirname, '..', 'index.html')
    : path.join(__dirname, '..', '..', 'index.html');

  win.loadFile(entry);

  /* 外链一律交给系统浏览器，不在应用里开 ——
     应用内没有地址栏，用户点出去就回不来了。 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  const menu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => win.reload() },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: '查看',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => zoom(win, 1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoom(win, -1) },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => win.webContents.setZoomFactor(1) },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', click: () => win.webContents.toggleDevTools() }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

function zoom(win, d) {
  const cur = win.webContents.getZoomFactor();
  win.webContents.setZoomFactor(Math.min(3, Math.max(0.5, cur + d * 0.1)));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  /* Windows / Linux 关窗即退出；macOS 保留习惯 */
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
