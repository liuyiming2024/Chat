# 聊天室 · 原生端（Android）

真原生实现：**没有 WebView，不加载 www/**。（NATIVE-ARCH）

## 为什么重写

旧四端（Web / Android / Win / Mac / Linux）读的都是同一份 `www/` 网页：
Android 用 Capacitor（`webDir: "www"`），桌面用 Electron（`loadFile(www/index.html)`）。
**四个端本质是同一个网页的本地化**，被反馈"仍是 website 套壳"是准确的。

## 现在的差别

| 项 | 旧（套壳） | 现（原生） |
|---|---|---|
| 渲染 | WebView/Chromium 加载 HTML | Compose 绘制，XML/HTML 不参与 |
| 存储 | localStorage + IndexedDB | SQLite（Room） |
| 网络 | 浏览器 fetch | OkHttp |
| 同步 | 页面 JS 轮询 | SyncEngine（协程，前后台降频） |

## 服务端契约

**不变**。原生端调的还是那 39 个 RPC（`state_get` / `state_delta` / `msg_send` …），
协议三条（照抄 `chat/js/sb.js`，错一条就整个连不上）：

1. anon key 放 `apikey` 头 —— 放进 `Authorization: Bearer` 会被网关当 JWT 解析而报 Invalid JWT
2. 身份用 `x-session` 头传 token（服务端查 sessions 表）
3. RPC 一律 POST `/rest/v1/rpc/<name>`

## 状态

- [x] 项目骨架、认证、网络层（ApiClient）、本地库（Room 五表）
- [x] SyncEngine：state_peek 比序号 → state_delta 增量；补发队列**成功后才删**；前后台降频
- [x] 消息流：Compose 列表 + 输入框；撤回超时标「已超时」而非消失
- [x] 媒体：三步上传协议（prepare → 传字节 → **commit 绝不能省**）；本地缓存落 filesDir + SHA-256 去重
- [x] 多语言：zh-CN/en，缺 key 不返回 key 本身；中英词典 key 双向校验
- [x] 设置页、系统通知、Markdown 渲染（Markwon）
- [x] 补发队列 UI：**待发条数常驻可见**（静默补发会让用户重发一遍）
- [ ] 真机编译验证（需 JDK 17 + Android SDK）

## 构建

需要 Android SDK 与 JDK 17。当前环境只有 JDK 11，**未做编译验证**。
