/* ------------------------------------------------------------------
 * electron/main.js —— 桌面版主进程
 *
 * 这里只做三件事：开窗口、给菜单、管生命周期。
 * 业务逻辑一行都不复制 —— 网页和桌面版跑的是同一份前端代码，
 * 否则改一处要改两遍，迟早对不上。
 * ------------------------------------------------------------------ */
'use strict';
const { app, BrowserWindow, Menu, shell, ipcMain, nativeImage } = require('electron');
const path = require('path');
const bridge = require('./local-bridge');

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
      /* 页面里没有 require，只通过 preload 暴露最小桥接 */
      preload: path.join(__dirname, 'preload.js'),
      /* 允许页面加载自己的 service worker 与 IndexedDB */
      partition: 'persist:chat'
    }
  });

  /* 打包后加载 www/ 副本；开发时直接加载仓库根目录的页面。
     www/index.html 会重定向到 chat/index.html，所以装成应用打开就是聊天室。 */
  const entry = app.isPackaged
    ? path.join(__dirname, '..', 'www', 'index.html')
    : path.join(__dirname, '..', 'www', 'index.html');

  win.loadFile(entry);

  /* 页面（比如点击通知后）请求把窗口带到前台 */
  require('electron').ipcMain.on('chat:focus', () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

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

/* 未读数角标：任务栏图标上叠一个红底数字。
   没有它，桌面版切到后台就完全看不出有新消息。 */
ipcMain.on('chat:badge', (e, n) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (!n || n <= 0) { win.setOverlayIcon(null, ''); return; }
  const txt = n > 99 ? '99+' : String(n);
  const size = 64;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="44" cy="44" r="20" fill="#e5453a"/>
    <text x="44" y="52" font-family="sans-serif" font-size="24" font-weight="bold"
      fill="#fff" text-anchor="middle">${txt}</text></svg>`;
  const img = nativeImage.createFromBuffer(
    Buffer.from(svg.replace(/\s+/g, ' '), 'utf-8'), { width: size, height: size });
  win.setOverlayIcon(img, `${txt} 条未读`);
});

/* 本机桥接：起一个只听 127.0.0.1 的服务，供网页版探测已登录身份。
   起不来（端口被占）也不能影响应用本身，所以错误在模块内部已吞掉。 */
let bridgeSrv = null;
function startBridge() {
  if (bridgeSrv) return;
  try { bridgeSrv = bridge.createServer(); } catch (e) { bridgeSrv = null; }
}

/* 页面申领票据成功后，把昵称与票据交给桥接服务 */
ipcMain.on('bridge:publish', (e, nick, code) => {
  bridge.publish(nick, code);
  startBridge();
});
ipcMain.on('bridge:clear', () => bridge.clear());

app.whenReady().then(() => {
  startBridge();
  createWindow();
});

app.on('before-quit', () => {
  bridge.clear();
  try { if (bridgeSrv) bridgeSrv.close(); } catch (e) { }
});

app.on('window-all-closed', () => {
  /* Windows / Linux 关窗即退出；macOS 保留习惯 */
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
