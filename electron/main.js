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
const chunked = require('./chunked-download');

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

  /* ⚠ Web 版（www/）必须继续可用（KEEP-WWW）。
     原生端是**新增**，不是替换：www/ 仍被 Capacitor 与 Electron 打包，
     旧的安装包、网页版、桌面版都还在用它。
     在原生端达到同等完成度之前，删掉 www/ 等于让用户没得用。
     所以 native/ 与 www/ 会长期并存，两端的 bug 都要修，不能只修一边。 */

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
/* ---- 更新：下载安装包到临时目录，然后交给用户自己点开安装 ----
 * 为什么不静默替换正在运行的程序：
 *   一是做不到（文件被占用），二是用户在不知情时被换掉程序属于越界。
 *   这里只负责"把正确的文件下载下来并打开它"。 */
const { ipcMain: ipc } = require('electron');

/* ⚠ S-098（考古补回）：下载完**必须看校验结果再决定要不要打开**。
   原来这里下完直接 shell.showItemInFolder(res.path) ——
   chunked.download 当时也确实没做哈希校验，所以"没接线"和"没实现"
   两件事叠在一起，等于完全没有防护。

   现在 chunked 会返回 verified / reason，这里必须分三种处理：
     · verified:true  reason:'ok'        正常打开
     · verified:false reason:'no-hash'   清单没提供哈希 → 可以打开，
                                         但**必须如实告诉用户无法验证**
     · verified:false reason:'mismatch'  **绝不能打开**：
                                         内容对不上，要么包被换过，要么下坏了。
                                         删掉文件并明确报错。

   ⚠ 第三种绝不能"警告一下继续打开" ——
     那等于把决定权推给一个无法判断的用户，而他要装的是可执行程序。 */
ipc.handle('chat:downloadUpdate', async (e, url, file, sha256) => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const dest = path.join(os.tmpdir(), file);

  try {
    const res = await chunked.download({
      url,
      dest,
      sha256: sha256 || null,
      onProgress: (p) => {
        /* 进度推回渲染进程，界面上能显示百分比和速度 */
        if (e && e.sender && !e.sender.isDestroyed()) {
          e.sender.send('chat:downloadProgress', p);
        }
      }
    });

    if (res.reason === 'mismatch') {
      /* 内容对不上：删掉，绝不留一个看起来能装的文件在临时目录里。
         留着的话用户可能从别处找到它并手动运行。 */
      try { fs.unlinkSync(res.path); } catch (x) { }
      return {
        ok: false,
        err: '下载内容与清单记录不一致，已删除。'
           + '可能是下载出错，也可能是文件被替换过 —— 请换个网络重试，'
           + '或直接到 GitHub Releases 页面手动下载。',
        tampered: true
      };
    }

    shell.showItemInFolder(res.path);
    return {
      ok: true, path: res.path, bytes: res.bytes, chunks: res.chunks,
      fellBack: !!res.fellBack,
      verified: !!res.verified,
      /* no-hash 时必须把"无法验证"如实传回界面。
         静默当成已验证，比不做校验更糟 —— 界面上写着"已验证"，
         实际什么都没验，用户会因此放松警惕。 */
      verifyNote: res.reason === 'no-hash'
        ? '这份清单没有提供校验值，无法确认文件完整性'
        : (res.reason === 'no-webcrypto' ? '当前环境不支持校验' : '')
    };
  } catch (err) {
    return { ok: false, err: String((err && err.message) || err) };
  }
});

ipc.on('chat:openDownload', (e, url) => {
  /* 只在浏览器里打开下载链接，不自己接管。 */
  if (url) shell.openExternal(url);
});

ipcMain.on('bridge:publish', (e, nick, code) => {
  startBridge();                                  // 先确保服务起来了
  const ok = bridge.publish(nick, code, bridgeSrv);
  /* 端口被占时明确告知：宁可这个功能不生效，也不能让网页端拿到错的身份 */
  if (!ok && e && e.sender) {
    e.sender.send('bridge:unavailable', '本机桥接端口被占用，已停用');
  }
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
