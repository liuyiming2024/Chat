/* ------------------------------------------------------------------
 * electron/preload.js —— 桥接层
 *
 * 页面里拿不到 require：nodeIntegration 是关着的，这是对的 ——
 * 把整个 Node 能力暴露给网页内容属于自找风险。
 *
 * 所以只能通过 contextBridge 开最小接口。这里只给两个：
 * 设任务栏角标、把窗口提到前台。多一样都不给。
 * ------------------------------------------------------------------ */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ElectronBridge', {
  setBadge: (n) => ipcRenderer.send('chat:badge', n),
  focus: () => ipcRenderer.send('chat:focus')
});
