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
const APP_VERSION = require('./version');

contextBridge.exposeInMainWorld('ElectronBridge', {
  setBadge: (n) => ipcRenderer.send('chat:badge', n),
  focus: () => ipcRenderer.send('chat:focus'),

  /* 本机桥接：把已登录身份交给本地服务，供网页版免密进入。
     只有"真的在 Electron 里"才有这个对象 —— 网页端据此判断要不要去探测。 */
  isApp: true,
  bridgePublish: (nick, code) => ipcRenderer.send('bridge:publish', nick, code),
  bridgeClear: () => ipcRenderer.send('bridge:clear'),

  /* 更新相关。版本由主进程给出（读 app.getVersion），
     下载交给主进程 —— 渲染进程没有写文件的能力。 */
  version: APP_VERSION,
  openDownload: (url) => ipcRenderer.send('chat:openDownload', url),
  downloadUpdate: (url, file) => ipcRenderer.invoke('chat:downloadUpdate', url, file),
  /* 下载进度回调。返回取消函数 —— 组件卸载时必须调，否则重复监听会叠加。 */
  onDownloadProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('chat:downloadProgress', h);
    return () => ipcRenderer.removeListener('chat:downloadProgress', h);
  }
});
