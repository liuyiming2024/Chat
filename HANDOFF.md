# HANDOFF（接手指针）

本仓库是**发布仓库**：只放项目本身（站点源码 + 使用手册），不放开发脚手架。

接手一个新对话时，请先读这几份文档，读完即可无缝接手，无需用户重新解释：

| 文档 | 在哪 | 说明 |
|---|---|---|
| **接手说明** | 私有库 `liuyiming2024/Tool` → `handoff/Chat/接手说明.md` | 架构、三条硬性约束、核心概念、同步方式 |
| **待办清单** | 私有库 `liuyiming2024/Tool` → `handoff/Chat/下一步待办.md` | 只记未完成项 |
| **接库前安全审查** | 私有库 `liuyiming2024/Tool` → `notes/接库前安全审查.md` | 接 Supabase 前必读 |
| **回归测试** | 私有库 `liuyiming2024/Tool` → `tests/` | SHA-256 标准向量、冒烟走查 |

私有库地址：<https://github.com/liuyiming2024/Tool>（需本人账号访问）

## 为什么分开

- 公开库会被 GitHub Pages 发布到公网，**开发脚本、内部结论、未发布的审查意见不应公开**
- `tools/ghsync.py` 这类同步脚本，之前就误放在 Pages 根目录，公网可直接访问 —— 已移出
- 私有库按项目分子目录：`handoff/<项目名>/`，未来新项目照此加

## 同步工具

`ghsync.py` 在私有库 `Tool/tools/` 下，用法见 <https://github.com/liuyiming2024/Tool>。
**必须显式指定 `--repo`**，例如：

```bash
GHTOK=<token> python3 tools/ghsync.py --repo liuyiming2024/Chat --dry
```

## 当前状态

**后端已就绪。** 数据库已建好（10 表 + 45 函数），填入 URL 与 key 后刷新即切换在线模式。
未填配置时以本机模式运行（数据存 localStorage）。

**唯一待办**：权限判定仍在前端（`chat/js/acl.js`），可被 DevTools 绕过。
服务端已有 `auth_uid()` / `auth_role()` / `auth_is_staff()` 可用，贴吧权限已走服务端，
聊天室主流程的 ACL 待迁移。
