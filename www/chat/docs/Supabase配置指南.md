# Supabase 配置：一步一步照着点

全程大约 10 分钟。不用写代码，不用懂数据库，照着点就行。

---

## 第 1 步：登录

打开 <https://supabase.com/dashboard>

点 **Continue with GitHub** → 用你的 GitHub 账号授权登录。

> 免费版不需要绑信用卡。

---

## 第 2 步：创建组织（第一次进才会看到）

如果弹出 "Create organization"：

1. **Name**：填 `my-chat`（英文即可）
2. **Type of organization**：选 `Personal` 或 `Developer`
3. 确认下面计划显示 **Free**
4. 点 **Create organization**

---

## 第 3 步：新建项目

点右上角绿色按钮 **New project**

| 填写项 | 怎么填 |
|---|---|
| Organization | 选刚建的那个 |
| **Name** | `chat`（或你喜欢的名字） |
| **Database Password** | ⚠️ 点右边的 **Generate a password**，然后把生成的密码**复制存到备忘录**——这是数据库管理员密码，丢了只能删项目重来 |
| **Region** | 选 **Southeast Asia (Singapore)**（离国内最近，延迟最低） |

点 **Create new project**，等 1–2 分钟（页面会转圈，正常）。

---

## 第 4 步：抄下 URL 和 Key（这两个要填进聊天室）

左侧最下面点齿轮 ⚙️ **Project Settings** → 点 **API Keys**（你刚才就在这一页）

往下找这两样，各复制一份存好：

**① Project URL**
- 形如 `https://abcdefgh.supabase.co`
- 如果这一页没看到，去 **Settings → Data API**，最上面也有

**② Publishable key**
- 就是你已经看到的那个 `sb_publishable_jPrK6j5l9NG...`
- 旁边有复制按钮，点一下

> ⚠️ **只要 Publishable，不要 Secret**。Secret key（`sb_secret_` 开头）权限极高，
> 一旦出现在网页代码里等于数据库裸奔。我们全程用不到它。

---

## 第 5 步：执行建库脚本（最关键的一步）

1. 左侧点 **SQL Editor**（图标像个数据库/终端）
2. 点 **New query**
3. 打开项目里的 `supabase/schema.sql`，**全选复制**，粘进编辑框
4. 点右下角绿色 **Run**（或按 Ctrl+Enter）

**成功的样子**：下面结果区显示绿色 `Success. No rows returned`，左侧 Table Editor 里能看到 users、rooms、messages 等 8 张表。

**如果报错**，把红色错误信息整段发给我，常见情况我都能修：
- `extension "pgcrypto" does not exist` → 换一段替代写法，我改
- `permission denied for table storage.buckets` → 正常，用下面第 6 步手动建桶即可
- `function ... already exists` → 说明跑过一次了，忽略

> 这段脚本只建表和函数，**不会泄露你的数据**，可以放心跑。

---

## 第 6 步：建媒体桶（存图片视频用）

左侧点 **Storage** → 点 **New bucket**

- **Name**：必须填 `media`（一字不差）
- **Public bucket**：**打开**（开关拨到开）

点 **Save**。

> 第 5 步如果 storage 那行没报错，这一步会自动建好，看到 `media` 已存在就不用建了。

---

## 第 7 步：回来说一声

到这里 Supabase 就配好了。把这两样告诉我（或者你自己填，不用给我）：

```
Project URL:      https://________.supabase.co
Publishable key:  sb_publishable________________
```

然后我继续把前端接上、写保活脚本、更新上线文档。

---

## 常见问题

**Q：为什么 Region 一定要新加坡？**
国内访问美国节点延迟 300ms+，新加坡 60–80ms。后面还能改，但要迁移数据，不如一次选对。

**Q：Database Password 和聊天室登录密码是一回事吗？**
完全不是。Database Password 是给 Supabase 后台用的，你基本用不到但必须存着。
聊天室的登录密码、保护密码都是建站时你自己设的，存在数据库里（bcrypt 哈希）。

**Q：7 天不活动会暂停，怎么办？**
我后面会加一个 GitHub Actions 定时保活，每 3 天自动 ping 一次数据库，
让项目永远"看起来在用"。你正常用就不用管。

**Q：Publishable key 放在网页里安全吗？**
安全。我们所有表都锁了 RLS，不开放直接读写，只能通过数据库函数访问，
而函数会校验站点保护密码。拿着 key 没有密码一样读不到数据。
