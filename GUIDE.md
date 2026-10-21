# 部署手册

从一台空白电脑，到发出第一条。全程七条命令，不用买服务器、不用绑信用卡。

README 讲「这是什么」，这里只讲**怎么做，以及怎么确认做对了**。
每一步都给了验收标准——做完看不到它说的输出，就先别往下走。

> 想先看成品：README 的「特性」一节列了这个项目的全部能力。

---

## 0. 开工前

| 需要 | 怎么确认 | 没有怎么办 |
| --- | --- | --- |
| Cloudflare 账号 | 能登进 [dash.cloudflare.com](https://dash.cloudflare.com) | 注册一个，邮箱即可，免费，**不用绑卡** |
| Node.js 20+ | `node -v` 看到 v20 / v22 / v24 | [nodejs.org](https://nodejs.org) 下 LTS，一路下一步 |
| 项目文件 | 有个 `memo` 文件夹 | `git clone`，或解压 release 里的 zip |

**终端在哪**：macOS 搜「终端」，Windows 搜「PowerShell」。
下文命令都是跨平台的。两处 Windows 差异会单独标出来。

---

## 1. 装部署工具（只装一次）

```bash
npm i -g wrangler
wrangler --version
```

**验收**：打印 `4.x.x`。

- 报 `permission denied` → macOS / Linux 加 `sudo` 重来
- 报 `wrangler: command not found` → 别去修 PATH，后面所有命令前加 `npx ` 就行，例如 `npx wrangler login`

---

## 2. 登录 Cloudflare

```bash
wrangler login
```

浏览器会自动弹出，选账号，点 **Allow**。

**验收**：终端出现 `Successfully logged in`。

没弹窗就复制终端里那条链接，手动粘到浏览器。

---

## 3. 进项目目录

```bash
cd 你的路径/memo
ls
```

**验收**：能看到 `wrangler.toml`、`schema.sql`、`src`、`public`。

> Windows PowerShell 用 `dir`。
> 这一步最容易翻车。后面每条命令都必须在这个目录下执行，否则报
> `Couldn't find a wrangler.toml`。

---

## 4. 建数据库

```bash
wrangler d1 create memo
```

输出里会有一段配置，重点是这两行：

```
database_name = "memo"
database_id   = "a1b2c3d4-0000-1111-2222-333344445555"
```

打开 `wrangler.toml`，把 `[[d1_databases]]` 下面这两行换成你的值，保存。

**验收**：`wrangler.toml` 里的 `database_id` 不再是一串示例。

> 新版 wrangler 可能反过来问 *"Would you like Wrangler to add it on your behalf?"*，
> 输 `y` 回车，它自己写进去，你不用手动改。
> `binding = "DB"` 那行别动，代码里就是 `env.DB`。

---

## 5. 建表

```bash
wrangler d1 execute memo --remote --file=./schema.sql
```

**验收**：输出里有 `"success": true`。

想再确认一次：

```bash
wrangler d1 execute memo --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

应该能看到 `notes` 和 `settings`；如果还多一行 `sqlite_sequence`，那是 SQLite 自增表的内部记录，正常。

> **`--remote` 绝对不能省。** 省了表会建在你电脑的本地模拟库里，
> 线上还是空的，打开网站只会显示「没能加载出来」。

---

## 6. 设密码

```bash
wrangler secret put ADMIN_PASSWORD
```

提示 `Enter a secret value:` 时，直接输你的密码回车。
**屏幕上不会显示任何字符，这是正常的，不是卡住了。**

再设一个会话密钥：

```bash
wrangler secret put SESSION_SECRET
```

不想自己想，生成一串：

```bash
openssl rand -hex 32
```

> Windows 没有 `openssl`，用这条：
> `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**验收**：

```bash
wrangler secret list
```

看到 `ADMIN_PASSWORD` 和 `SESSION_SECRET` 两个名字。

> 两个值都存在 Cloudflare 的加密环境变量里，不进数据库、不进代码仓库。
> 改密码重跑这一条即可，立即生效，不用重新部署。

---

## 7. 部署

```bash
wrangler deploy
```

首次会问：

```
Would you like to register a workers.dev subdomain?
```

输入一个**全球唯一**的名字（比如 `xiaoming-notes`），回车。

**验收**：终端最后打印

```
https://memo.xiaoming-notes.workers.dev
```

这就是你的站。打开它。

> 这个地址在部分网络下时通时断，打不开不代表部署失败，看下一步。

---

## 8. 绑自己的域名（建议）

`*.workers.dev` 这类共享域名在部分网络下访问不稳定，时通时断，能不能打开看运气。
想让站点长期稳定地打开，绑一个自己的域名最省心。

前提：域名（或它的上级 zone）已经托管在同一个 Cloudflare 账号下。
在 `wrangler.toml` 里加三行：

```toml
[[routes]]
pattern = "memo.你的域名.com"
custom_domain = true
```

再 `wrangler deploy` 一次。

**验收**：部署输出里出现 `memo.你的域名.com (custom domain)`，
浏览器打开能出页面。证书是自动签的，1–2 分钟生效。

> 绑好之后，`[[routes]]` 这三行就要一直留着。部署时 Worker 的路由按这份配置同步，
> 哪天把它注释掉再部署，域名就被解绑了，站点会立刻打不开。

不想改文件，也可以走 Dashboard：
**Workers & Pages → memo → Settings → Domains & Routes → Add → Custom domain**。

---

## 9. 发出第一条

1. 打开你的网址，页面应该是空的，写着「这里还空着 / 第一句话往往最难写。」
2. 拉到底部，点 **登录**
3. 输入第 6 步设的密码，回车
4. 底部升起一条输入框「写点什么…」
5. 写一句，按 **Ctrl + Enter**（macOS 是 **⌘ + Enter**）或点「发布」
6. 内容立刻出现在时间线上，页脚显示「共 1 条」

到这里全流程打通。

---

## 10. 日常操作

| 想做的事 | 怎么做 |
| --- | --- |
| 写一条 | 登录后点底部输入框，或按 `n`；`Ctrl/⌘ + Enter` 发布 |
| 改一条 | 悬停条目，右上角铅笔 |
| 置顶 | 同上的图钉，置顶的浮到最上面 |
| 删除 | 同上的垃圾桶（会二次确认） |
| 按标签看 | 点正文里的 `#标签`，地址变成 `?tag=折腾` |
| 搜索 | 页脚「搜索」，回车 |
| 复制某条链接 | 点那条的时间 |
| 改站点信息 | 登录后点右上角滑杆图标，改标题 / 描述 / 作者 / 语言 / 时区 |
| 备份 / 恢复 | 右上角滑杆图标 → 备份与恢复 |
| 换深色 | 右上角太阳/月亮，选择会记住 |
| 手机当 App | 浏览器 → 分享 → 添加到主屏幕 |
| 让别人订阅 | 把 `/feed.xml` 给对方 |
| 退出登录 | 页脚「退出」 |

正文支持：`**粗**`、`*斜*`、`` `代码` ``、`> 引用`、`- 列表`、自动识别链接、`#标签`。

**补写以前的日记**：

```bash
curl -X POST https://你的域名/api/notes \
  -H "content-type: application/json" \
  -H "cookie: ec_session=<登录后的 cookie>" \
  -d '{"content":"去年今天写的一句话","created_at":"2025-10-20T09:41:00+08:00"}'
```

> Windows PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，参数不通用。
> 用 `curl.exe` 代替 `curl`，其余不变。

cookie 从浏览器 F12 → Application → Cookies → `ec_session` 复制。

---

## 11. 报错对照

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `wrangler: command not found` | 全局目录不在 PATH | 命令前加 `npx ` |
| `Couldn't find a wrangler.toml` | 不在项目目录 | `cd` 到有 `wrangler.toml` 的那层 |
| `Authentication error` | 没登录 / 登录过期 | 重跑 `wrangler login` |
| 部署成功但页面 404 | assets 目录没配好 | 确认 `wrangler.toml` 有 `directory = "./public"`，且在 `memo/` 下部署 |
| 页面显示「没能加载出来」 | 数据库没建表，或表建在了本地 | 重跑第 5 步，务必带 `--remote` |
| 登录点了没反应 | 浏览器拦了 Cookie | 允许本站 Cookie；必须是 https 访问 |
| 忘了密码 | — | 重跑第 6 步的 `ADMIN_PASSWORD` |
| 改了标题没变化 | 没保存，或页面还没刷新 | 在管理面板点保存，刷新页面 |
| `database_id invalid` | ID 没换或复制错了 | 回第 4 步重来，注意别带多余引号 |
| 域名打不开 | 证书还在签 | 等 1–2 分钟；Dashboard → Workers → memo → Settings → Domains |

**看实时日志**（排查 500 最有用）：

```bash
wrangler tail
```

然后浏览器里复现问题，终端会实时打印报错。

---

## 12. 备份与恢复

最省事的办法：登录后点右上角滑杆图标 → **备份与恢复** → **下载备份**。
导出的 JSON 同时包含全部条目和站点配置，建议每月一次，丢进网盘或本地。

**恢复**：同一页选文件，默认「合并」会跳过内容与时间都相同的条目；
勾选「覆盖现有数据」会先清空全部条目再导入，适合整站迁移。
默认会同时恢复站点配置，只想恢复条目就取消「同时恢复站点配置」。
恢复前建议先下载一份当前备份。

也可以在命令行导出（只含条目，不含站点配置）：

```bash
wrangler d1 execute memo --remote \
  --command "SELECT id, content, created_at, updated_at, pinned FROM notes ORDER BY id" \
  --json > backup-$(date +%F).json
```

Windows 没有 `date +%F`，直接写死文件名：`> backup.json`。
管理页面的恢复功能也兼容这种 `wrangler d1 --json` 格式。

---

## 附 A：Windows 一键脚本

仓库里带了三个 `.bat`，双击即用，都在项目根目录：

| 脚本 | 干什么 | 什么时候用 |
| --- | --- | --- |
| `deploy.bat` | 检查登录 → 部署 → 打印地址 | 改了标题、样式、代码之后 |
| `healthcheck.bat` | 逐个请求 9 个端点，打印状态码 | 觉得网站不对劲，先跑它 |
| `backup.bat` | 导出全部条目成 `backup-日期.json` | 每月一次，或大改之前 |

`healthcheck.bat` 输出里：`200` 正常，`000` 连不上（网络/域名），`500` 是 Worker 报错。

---

## 附 B：完全不想碰命令行

走 GitHub 自动部署：

1. 把项目推到 GitHub 仓库（私有也行）
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**，选这个仓库
3. Build command 留空，Deploy command 填 `npx wrangler deploy`
4. 在 **Storage & Databases → D1** 建一个库，把 ID 写进仓库的 `wrangler.toml`，提交
5. 回到 Worker 的 **Settings → Bindings**，加 D1 绑定：变量名 `DB`，选刚建的库
6. **Settings → Variables and Secrets**，加两个 Secret：`ADMIN_PASSWORD`、`SESSION_SECRET`
7. 在 D1 的 **Console** 里粘贴 `schema.sql` 的内容执行
8. 重新 push 一次触发部署

步骤更多，但全程在网页上点。只是自己用的话，还是前面的命令行走法快得多。

---

## 附 C：本地开发

改代码不想碰线上：

```bash
cp .dev.vars.example .dev.vars     # 填本地测试用的密码
wrangler d1 execute memo --local --file=./schema.sql
wrangler dev                       # http://127.0.0.1:8787
```

本地数据在 `.wrangler/` 里，删掉就是重来。满意了再 `wrangler deploy`。

---

## 时间预算

| 步骤 | 耗时 |
| --- | --- |
| 装 Node + wrangler | 3 分钟（一次性） |
| 登录 + 建库 + 建表 + 设密码 + 部署 | 3 分钟 |
| 绑域名 | 2 分钟 + 等证书 |
| 之后每次改代码上线 | `wrangler deploy` 一条命令，10 秒 |

---

**本项目全部内容由 AI 生成** —— Agent：WorkBuddyAI，模型：DeepSeek V4.1 Flash。
