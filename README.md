# InCircle

InCircle 是一个面向熟人关系的小圈子协作微信小程序，用于处理微信群好友之间经常发生、但不适合依赖聊天记录长期维护的事务，包括约局报名、AA 账单、投票决策、打卡记录、资料沉淀、成员身份卡、积分勋章和圈内 AI 对话。

项目不提供陌生人匹配、公开广场、附近的人、内容推荐或开放社交能力。所有核心业务都归属于用户主动创建或加入的圈子，圈内数据默认只向有效圈成员开放。

当前仓库同时包含：

- 微信小程序原生客户端，目录为 <code>inCircleClient/</code>。
- Node.js + Fastify 自建后端，目录为 <code>server/</code>。
- PostgreSQL Schema 和版本化迁移。
- Docker Compose 生产运行配置。
- Windows PowerShell 一键部署脚本。
- 圈内 AI 的多供应商适配、流式传输、内容安全与隐私隔离实现。

## 目录

- [产品定位](#产品定位)
- [主要功能](#主要功能)
- [角色与权限](#角色与权限)
- [系统架构](#系统架构)
- [技术栈](#技术栈)
- [仓库结构](#仓库结构)
- [快速开始](#快速开始)
- [本地后端](#本地后端)
- [环境变量](#环境变量)
- [微信平台配置](#微信平台配置)
- [接口约定](#接口约定)
- [圈内 AI](#圈内-ai)
- [数据库与迁移](#数据库与迁移)
- [生产部署](#生产部署)
- [反向代理与流式响应](#反向代理与流式响应)
- [运维与备份](#运维与备份)
- [测试与质量检查](#测试与质量检查)
- [安全与隐私](#安全与隐私)
- [Git 与敏感文件](#git-与敏感文件)
- [常见问题](#常见问题)
- [项目文档](#项目文档)

## 产品定位

### 目标用户

- 已经通过微信、现实生活、同学、同事或兴趣活动互相认识的人。
- 有稳定群聊，但需要比聊天消息更清晰地处理报名、分账、投票和资料的人。
- 希望在多个独立圈子之间切换，并让每个圈子的成员资料、积分和业务互不混用的人。

### 核心原则

1. **圈子隔离**

   活动、账单、投票、打卡、资料、身份卡、积分和 AI 会话都带有圈子归属。服务端不会只凭业务 ID 返回数据，还会验证当前用户是否属于对应圈子。

2. **熟人协作优先**

   页面围绕微信群协作设计，支持分享文案、入圈码、结果摘要、报名状态和提醒记录，不构建公开内容社区。

3. **业务结果可追溯**

   报名、投票、打卡、积分、操作日志和 AI 用量等关键行为落入 PostgreSQL，不依赖小程序本地状态作为最终事实。

4. **北京时间统一**

   截止时间、打卡自然日、积分周期、AI 每日额度和服务端展示时间统一按 Asia/Shanghai 处理。

5. **隐私最小化**

   圈内成员详情只返回当前圈可公开的信息。平台管理信息、账号信息、微信标识和其他圈子关系不会通过普通成员接口暴露。

### 明确不做

- 不做陌生人推荐、匹配或公开搜索。
- AA 只负责记录、分摊和提醒，不代替微信支付，也不会自动转账。
- 积分和勋章是圈内参与记录，不代表货币、信用或平台等级。
- 圈内 AI 第一阶段只提供文字对话，不联网搜索、不生成图片、不调用工具，也不会自动执行圈内业务。

## 主要功能

### 1. 账号、微信绑定与登录

- 使用账号和密码注册、登录。
- 注册或绑定时通过 <code>wx.login</code> 获取 code，由服务端调用微信 <code>jscode2session</code> 验证微信身份。
- 支持账号绑定微信、修改密码、重置密码、退出登录和账号注销。
- 旧版只依赖微信身份的快捷登录已下线，服务端返回 <code>LEGACY_LOGIN_DISABLED</code>。
- JWT 默认有效期为 24 小时。账号封禁、解绑微信和关键登录状态变化会提升 <code>auth_version</code>，使旧令牌失效。
- 用户选择的主题和自定义 RGBA 颜色保存在服务端，重新登录后恢复。

### 2. 我的圈子

- 创建圈子、通过入圈码加入圈子、切换当前圈子。
- 登录重进时优先恢复最近选择且仍有效的圈子；当前圈子不存在时进入“我的圈子”。
- 首页只展示最近进入的 3 个圈子，完整列表在独立页面分页、搜索。
- 普通账号最多同时拥有 10 个仍存在的圈子，正常、冻结和关闭状态都计数；物理删除后释放名额。
- 平台超管不受 10 个圈子的创建限制。
- 创建、加入、切换和自动进入都会更新成员关系的最近进入时间。

### 3. 圈子设置与成员管理

- 维护圈子名称、公告、介绍和入圈信息。
- 生成 8 位入圈码以及微信官方小程序入圈码。
- 查看当前圈成员和成员详情。
- 成员详情只包含本圈头像、昵称、称号、介绍、标签、编号、角色和加入时间。
- 圈主或具有管理权限的超管可以移除普通成员。
- 圈主不能直接退出圈子，也不能被其他人移除；需要由圈主解散圈子。
- 成员退出或被移除后，会同步清理该成员在本圈的 AI 会话、授权和举报关系。

### 4. 五个主 Tab

客户端使用自定义 Tabbar：

1. **首页**：圈子公告、最近活动、待投票、AA 待结清、打卡挑战、资料摘要、成员榜单和身份卡入口。
2. **约局**：活动列表、创建活动、活动详情、报名和复盘。
3. **工具**：AA、投票、打卡、随机决策等圈内工具。
4. **资料**：圈内资料、系统使用手册和勋章达成条件。
5. **成员**：成员图鉴、身份卡、积分、榜单、勋章和友好印象。

圈内 AI 悬浮入口只出现在这五个主页面，并且仅在当前圈已开启 AI 时渲染。

### 5. 约局活动

- 创建、编辑、删除、结束活动。
- 支持主题、明确日期时间、地点、人数、费用说明和地图位置。
- 成员可以报名、待定、拒绝、候补或携带同行人。
- 活动详情展示报名结构、成员状态和照片。
- 活动创建人、圈主或有管理权限的超管可以在活动有效状态下编辑。
- 已结束活动不能继续编辑；提前生成结果代表提前结束。
- 活动结束后可以生成复盘，并从参与成员创建 AA 账单。

### 6. AA 账单

- 单独创建 AA，或从活动详情带入参与成员。
- 支持多笔消费明细、付款人、参与人、自定义分摊、部分人不参与、发起人免单和老板请客等场景。
- 服务端计算并保存账单、分摊结果、未结清成员和提醒次数。
- 支持编辑、删除、标记结清和生成提醒记录。
- 已结清账单不能继续修改。
- 同一活动只能生成一个有效 AA，避免重复账单。
- 当前提醒主要用于站内状态与群内文案。小程序中的订阅模板默认为空，不能把授权结果理解为服务端已经发送微信订阅消息。

### 7. 投票

- 支持普通投票和地点投票。
- 支持实名/匿名、单选/多选、一票否决和组织者权重规则。
- 使用明确的年月日时分秒作为截止时间。
- 到达北京时间截止点后自动进入已截止状态并禁止继续投票。
- 提前生成结果会立即结束投票。
- 零票时不会虚构胜出项。
- 已截止页面和分享入口统一使用结果摘要。
- 选票和否决记录使用独立关系表及唯一约束，避免重复写入和并发覆盖。

### 8. 打卡挑战

- 创建文字、图片或数值打卡挑战。
- 每位成员按北京时间自然日记录打卡。
- 支持请假卡、补签卡和打卡记录媒体修复。
- 支持连续打卡、当日最早和完成情况统计。
- 支持挑战结束后的趣味榜单和惩罚抽签。
- 打卡记录使用独立数据表，避免多人同时提交时覆盖整段 JSON。

### 9. 圈内资料

- 创建、编辑、删除和分类筛选圈内资料。
- 支持标题、摘要、正文、清单、相关资料和分享文案。
- 每个圈子默认内置“InCircle 使用手册”和“勋章达成条件”。
- 系统资料会在数据库迁移时按版本自动补齐或更新，不重复创建。
- 系统资料只描述成员可见业务，不向普通用户暴露平台超管和内部实现。

### 10. 成员身份卡

- 每个用户在每个圈子拥有独立身份卡。
- 支持头像、圈内昵称、称号、介绍、技能、兴趣、可约时间和边界信息。
- 圈内编号由数据库按圈子原子分配，短、稳定且圈内唯一。
- 自己进入身份卡时只展示自己的相关入口；查看他人时遵循圈内公开字段限制。
- 身份卡内可以查看对应成员的积分流水和最近参与。

### 11. 积分、榜单与勋章

默认积分规则：

| 行为 | 默认积分 |
| --- | ---: |
| 发起约局 | +5 |
| 首次表态活动 | +2 |
| 发起投票 | +3 |
| 参与投票 | +1 |
| 发起打卡挑战 | +3 |
| 完成每日打卡 | +2 |
| 发起 AA | +3 |
| 完成结算 | +2 |
| 沉淀圈内资料 | +3 |
| 完善身份卡 | +5 |
| 收到友好印象 | +1 |
| 友好标签上墙 | +2 |

其他规则：

- 积分流水归属于圈子和成员。
- 首页、成员页和身份卡只展示有限条数，更多内容进入分页页面。
- 没有足够可比较数据时不生成虚假排名。
- 勋章根据真实资料、活动、打卡、积分和互动记录自动计算。
- 预置勋章覆盖资料完善、活动组织、活动参与、打卡、积分和友好互动。

### 12. 友好印象与圈友提名

- 可以给其他成员选择预设友好印象。
- 再次点击已选择的印象会取消。
- 同一标签至少获得 2 位圈友认可后自动进入标签墙。
- 票数降到阈值以下时，自动上墙的标签会移除。
- 提名、投票和取消使用独立记录并锁定目标成员，避免并发计数错误。
- 自己不能给自己制造友好印象或提名结果。

### 13. 主题与 UI

- 11 套预设主题：青柚、海盐、樱雾、月白、珊瑚、青瓷、柠霜、青梅、雾霁、蜜杏、丁香。
- 1 套自定义 RGBA 主题，支持实时预览和服务端持久化。
- 自定义 Tabbar 图标和选中状态跟随主题。
- 全局主题弹窗替代大部分系统确认弹窗。
- 统一空状态、键盘避让、底部安全区和减少动态效果策略。
- 列表读取带短期缓存、并发合并和精确失效。只对幂等读取做一次临时错误重试，写请求不会自动重放。

### 14. 平台超管后台

平台超管能力不对普通成员开放：

- 平台概览。
- 分页搜索所有圈子。
- 冻结、解冻和物理删除圈子。
- 分页搜索所有用户。
- 查看用户基本信息及圈子关系。
- 封禁、解封、解绑微信和物理删除用户。
- 查看和删除操作日志。
- 查看 AI 聚合用量、健康状态与举报，不查看普通成员未举报的聊天正文。

封禁会撤销旧登录凭证，但不会自动冻结该用户拥有的圈子。物理删除用户时，会在事务中处理账号、名下圈子和成员关系；该用户在其他人圈子创建的共享业务会尽量保留并匿名化创建者。

## 角色与权限

系统对外只使用三种角色名称：

| 角色 | 主要权限 | 关键限制 |
| --- | --- | --- |
| 圈主 | 管理自己创建的圈子、成员和圈内配置；管理有效业务；配置圈内 AI | 不能直接退出，需先解散圈子；普通账号最多拥有 10 个圈子 |
| 超管 | 按授权范围管理圈子；平台超管还可管理全平台圈子、用户、日志和 AI 举报 | 圈内“超管”角色不会自动获得平台超管权限 |
| 成员 | 使用圈内活动、工具、资料、成员和已开启的 AI | 不能修改圈子级配置、密钥或其他成员私有数据 |

技术实现区分两种授权范围：

- 圈成员关系中的 <code>role = 超管</code> 只对当前圈生效。
- 用户表中的 <code>is_super_admin = true</code> 才是平台级超管。

旧数据中的“管理员”“超级管理员”“admin”等别名会统一归一化为“超管”，但不会因为字符串相似而自动获得平台级权限。

## 系统架构

~~~mermaid
flowchart LR
    M["微信小程序<br/>inCircleClient"] -->|"HTTPS JSON + Bearer JWT"| A["Fastify API<br/>/api/incircle"]
    M -->|"multipart/form-data"| U["图片上传<br/>/api/upload"]
    M -->|"SSE 分块请求"| S["AI 流式接口<br/>/api/ai/chat/stream"]
    A --> P[("PostgreSQL 16")]
    U --> F[("服务器 uploads 目录")]
    A --> W["微信 API<br/>jscode2session / 小程序码"]
    S --> W2["微信文本内容安全"]
    S --> X["AI 供应商 API"]
    S --> P
~~~

### 数据流

1. 小程序调用 <code>wx.login</code> 获取一次性 code。
2. 登录、注册、绑定或重置场景把 code 发送到自建后端。
3. 后端调用微信 <code>jscode2session</code> 获取并验证 OpenID。
4. 账号登录成功后，后端签发自有 HS256 JWT。
5. 后续请求通过 <code>Authorization: Bearer ...</code> 鉴权。
6. 业务写入 PostgreSQL，图片写入服务器挂载目录。
7. AI 对话通过单独 SSE 接口分块返回，并支持断线恢复和幂等 requestId。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 小程序 | 微信原生 JavaScript、WXML、WXSS、自定义 Tabbar |
| 小程序基础库 | <code>3.16.2</code> |
| Markdown | 仓库内置 Marked 构建文件，输出经过安全清理 |
| API | Node.js 20、Fastify 5 |
| 数据库 | PostgreSQL 16、<code>pg</code> 连接池 |
| 图片处理 | Sharp |
| 安全中间件 | Helmet、CORS、Multipart |
| AI 协议 | OpenAI Compatible、Anthropic Messages、Google Gemini、Azure OpenAI |
| AI 传输 | Server-Sent Events，协议标识 <code>sse-v2</code> |
| 部署 | Docker、Docker Compose、PowerShell、SSH |

## 仓库结构

~~~text
InCircle/
├─ inCircleClient/                 微信小程序客户端
│  ├─ components/                  AI 悬浮入口、空状态、主题弹窗
│  ├─ config/
│  │  ├─ backend.example.js        可提交的后端地址模板
│  │  └─ backend.js                本机后端地址，Git 忽略
│  ├─ custom-tab-bar/              五个主 Tab
│  ├─ images/                      图标和图片资源
│  ├─ pages/                       27 个页面
│  ├─ utils/                       API、鉴权、主题、时间、键盘、Markdown
│  ├─ vendor/                      第三方前端构建文件及许可证
│  ├─ app.js
│  ├─ app.json
│  └─ app.wxss
├─ server/
│  ├─ db/
│  │  ├─ schema.sql                当前完整 Schema
│  │  └─ migrations/               不可修改的版本化增量迁移
│  ├─ src/
│  │  ├─ routes/                   incircle、upload、AI stream
│  │  ├─ services/                 业务、微信和 AI 服务
│  │  ├─ auth.js                   JWT
│  │  ├─ config.js                 环境变量和生产校验
│  │  ├─ db.js                     连接池与同连接事务
│  │  ├─ migrate.js                Schema 与迁移执行器
│  │  └─ server.js                 服务入口
│  ├─ test/                        Node.js 测试
│  ├─ docker-compose.yml
│  ├─ Dockerfile
│  └─ package.json
├─ scripts/
│  ├─ deploy-server.example.ps1    可提交的部署脚本模板
│  └─ deploy-server.ps1            本机私有部署脚本，Git 忽略
├─ project.config.example.json      可提交的微信项目配置模板
├─ project.config.json              本机微信项目配置，Git 忽略
├─ project.private.config.json      本机私有配置，不提交
└─ .gitignore
~~~

## 快速开始

### 环境要求

客户端：

- 微信开发者工具。
- 有权使用项目 AppID 的微信开发者账号。

后端：

- Node.js 20 或更高版本。
- npm。
- PostgreSQL 16，或 Docker + Docker Compose。

生产部署：

- Windows PowerShell。
- 本机可用 <code>ssh</code>、<code>tar</code>，可选 <code>scp</code>。
- 安装 Docker 和 Docker Compose 的 Linux 服务器。
- 指向服务器的 HTTPS 域名。

### 获取代码

~~~bash
git clone git@github.com:Tiemoremilk/InCircle.git
cd InCircle
~~~

### 创建本地配置

仓库只保存不含真实标识和域名的模板。首次拉取后执行：

~~~powershell
Copy-Item .\project.config.example.json .\project.config.json
Copy-Item .\inCircleClient\config\backend.example.js .\inCircleClient\config\backend.js
Copy-Item .\scripts\deploy-server.example.ps1 .\scripts\deploy-server.ps1
~~~

然后只在这些本机文件中填写配置：

- 在 <code>project.config.json</code> 中将 <code>touristappid</code> 替换为自己的小程序 AppID。
- 在 <code>inCircleClient/config/backend.js</code> 中将 <code>https://your-api.example.com</code> 替换为自己的 HTTPS API 地址。
- 在 <code>scripts/deploy-server.ps1</code> 中填写本机部署所需的 AppID、API 地址等默认值，或在运行时通过参数传入。

这三份本机文件已由 <code>.gitignore</code> 排除。不要使用 <code>git add -f</code> 强制提交，也不要把 AppSecret、OpenID、服务器地址或数据库凭据写入模板和 Markdown。

### 安装依赖并测试

~~~powershell
Set-Location .\server
npm ci
npm run check
npm test
~~~

### 打开小程序

1. 打开微信开发者工具。
2. 选择“导入项目”。
3. 项目目录选择仓库根目录，不要只选择 <code>inCircleClient/</code>。
4. 工具读取根目录 <code>project.config.json</code>。
5. <code>miniprogramRoot</code> 和 <code>srcMiniprogramRoot</code> 均指向 <code>inCircleClient/</code>。

开发版、体验版和正式版默认都请求本机配置的地址，例如：

~~~text
https://your-api.example.com
~~~

只做客户端预览时不需要启动本地后端，但需要可用的测试账号和服务器数据。

如需让开发版调用本地后端，需要临时调整 <code>inCircleClient/config/backend.js</code> 中 develop 环境的 <code>baseUrl</code>。模拟器可关闭域名检查，真机仍需要 HTTPS 合法域名。不要把个人局域网地址误提交到仓库。

## 本地后端

### Docker Compose

1. 创建本地环境文件：

~~~powershell
Copy-Item .\server\.env.example .\server\.env
~~~

2. 编辑 <code>server/.env</code>，替换数据库密码、微信 AppSecret、JWT Secret 和 AI 加密密钥。

3. 启动：

~~~powershell
Set-Location .\server
docker compose up -d --build
docker compose exec api npm run db:migrate
curl.exe http://127.0.0.1:3000/health
~~~

4. 查看日志：

~~~powershell
docker compose logs --tail=200 api
docker compose logs --tail=100 postgres
~~~

### 直接运行 Node.js

已有本地 PostgreSQL 时：

~~~powershell
Set-Location .\server
npm ci
npm run db:migrate
npm run dev
~~~

此时 <code>DATABASE_URL</code> 必须指向本机 PostgreSQL。开发模式不会执行全部生产密钥强校验，但仍不应使用生产数据库做日常调试。

### 生成随机密钥

AI 加密密钥：

~~~powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
~~~

JWT Secret：

~~~powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
~~~

## 环境变量

| 变量 | 生产要求 | 默认值或说明 |
| --- | --- | --- |
| <code>NODE_ENV</code> | production | 部署脚本自动写入 |
| <code>HOST</code> | 可选 | <code>0.0.0.0</code> |
| <code>PORT</code> | 可选 | <code>3000</code> |
| <code>POSTGRES_PASSWORD</code> | 随机值 | Docker 内部数据库密码 |
| <code>DATABASE_URL</code> | 必填且不能使用默认密码 | Docker 内主机名为 postgres |
| <code>CORS_ORIGINS</code> | 生产限制为真实域名 | 多个来源逗号分隔 |
| <code>PUBLIC_BASE_URL</code> | 必须是 HTTPS | 生成图片和头像公开 URL |
| <code>UPLOAD_DIR</code> | 可选 | <code>/app/uploads</code> |
| <code>WECHAT_APP_ID</code> | 必填 | 小程序 AppID |
| <code>WECHAT_APP_SECRET</code> | 必填，严禁提交 | 登录、小程序码和内容安全 |
| <code>INCIRCLE_SUPER_ADMIN_OPENIDS</code> | 可选 | 多个 OpenID 逗号分隔 |
| <code>JWT_SECRET</code> | 必填，至少 32 字符 | 生产拒绝默认值 |
| <code>JWT_TTL_SECONDS</code> | 可选 | 默认 86400 |
| <code>AI_CREDENTIALS_ENCRYPTION_KEY</code> | 必填 | 32 随机字节 |
| <code>AI_PROVIDER_TIMEOUT_MS</code> | 可选 | 默认 300000，上游空闲超时 |
| <code>AI_CONTENT_SECURITY_ENABLED</code> | 生产必须为 true | 关闭时生产服务拒绝启动 |

生产启动会拒绝：

- 数据库仍使用 <code>change-this-password</code>。
- JWT Secret 为空、过短或仍是示例值。
- 微信 AppID 或 AppSecret 为空。
- <code>PUBLIC_BASE_URL</code> 不是 HTTPS。
- AI 加密密钥不是准确的 32 字节。
- AI 内容安全被关闭。

<code>.env</code> 已被 Git 忽略，<code>server/.env.example</code> 保留为字段说明。

## 微信平台配置

### 基本配置

- 当前 AppID：由 <code>project.config.json</code> 配置。
- 当前基础库：<code>3.16.2</code>。
- 后端域名：由本机 <code>inCircleClient/config/backend.js</code> 配置，不提交真实值。
- 项目不使用云函数作为运行时后端。

### 合法域名

| 类型 | 域名 |
| --- | --- |
| request 合法域名 | <code>https://your-api.example.com</code> |
| uploadFile 合法域名 | <code>https://your-api.example.com</code> |
| downloadFile 合法域名 | <code>https://your-api.example.com</code> |

开发者工具的“关闭域名校验”不能代替公众平台配置和真机验证。

### 隐私能力

<code>app.json</code> 声明 <code>chooseLocation</code>，用于地点投票和约局地点选择。

启用圈内 AI 前，需要在微信隐私保护指引中说明：用户输入和当前会话上下文会发送到圈子配置的 AI 服务商，模型回答需要用户自行核实。同时应完成第三方信息共享、模型服务商及内容安全相关声明，并在发布前重新核对当前微信平台的隐私要求。

## 接口约定

### 健康检查

~~~http
GET /health
~~~

成功时返回后端状态、数据库状态和北京时间。数据库不可用时返回 HTTP 503。

### 统一业务接口

~~~http
POST /api/incircle
Content-Type: application/json
Authorization: Bearer <token>
~~~

请求体使用 <code>type</code> 分发业务：

~~~json
{
  "type": "incircleHome",
  "circleId": "圈子 UUID"
}
~~~

成功：

~~~json
{
  "success": true,
  "data": {}
}
~~~

失败：

~~~json
{
  "success": false,
  "errCode": "稳定错误码",
  "errMsg": "可展示错误信息",
  "details": {}
}
~~~

生产环境不会把未知内部异常堆栈返回客户端。

主要 action 分组：

| 分组 | action |
| --- | --- |
| 账号 | <code>incircleSession</code>、账号登录/注册/绑定、重置/修改密码、退出和注销 |
| 圈子 | 我的圈子、创建、切换、入圈预览、加入、设置、退出、解散、成员详情和移除 |
| 活动 | 列表、详情、创建、编辑、删除、状态、结束和照片 |
| AA | 详情、创建、编辑、删除、活动转账单、结清和提醒 |
| 投票 | 详情、创建、编辑、删除、投票、否决和结束 |
| 打卡 | 详情、创建、编辑、删除、打卡、卡片、媒体修复和惩罚 |
| 资料 | 列表、详情、创建、编辑和删除 |
| 成员 | 成员列表、身份卡、积分流水、友好标签、提名、投票和申诉 |
| 平台超管 | 圈子、用户、日志的列表、详情、状态修改和删除 |
| AI | 设置、供应商、模型、会话、消息、授权、用量和举报 |

### 图片上传

~~~http
POST /api/upload
Content-Type: multipart/form-data
Authorization: Bearer <token>
~~~

约束：

- 单次只允许 1 个文件。
- 最大原始文件大小 8 MiB。
- 服务端读取文件魔数，不信任扩展名或 MIME 声明。
- 支持 JPEG、PNG、GIF、WebP 识别。
- 非头像业务上传必须带圈子 ID，并验证当前用户是有效成员。
- 每个身份每分钟最多 20 次上传。
- 头像统一旋转、裁切为最多 512 × 512 的 WebP，较大时降低质量重压缩。
- 业务图片按类型和日期写入 <code>uploads/</code>。

### AI 流式接口

~~~http
POST /api/ai/chat/stream
Content-Type: application/json
Authorization: Bearer <token>
Accept: text/event-stream
~~~

响应事件：

- <code>start</code>
- <code>reasoning</code>
- <code>delta</code>
- <code>usage</code>
- <code>done</code>
- <code>error</code>
- <code>ping</code>

服务端每 2 秒发送心跳。requestId 用于幂等和断线恢复，客户端按 offset 去重已经展示的内容。

## 圈内 AI

### 默认设置

| 设置 | 默认值 |
| --- | --- |
| 开关 | 关闭 |
| 助手名称 | 圈内 AI |
| 成员每日额度 | 20 次 |
| 全圈每日额度 | 200 次 |
| 单成员分钟限制 | 5 次 |
| 单成员最大会话数 | 200 |
| 单次输入 | 最多 4000 字 |
| 上下文 | 最近 20 条，合计最多约 24000 字 |
| 默认最大输出 | 8192 tokens |
| 文本回答硬上限 | 约 36000 字符 |

每日额度按北京时间归零，同一会话同一时间只允许一个生成任务。

### 供应商

| 配置项 | 展示名称 | 协议 |
| --- | --- | --- |
| openai | OpenAI | OpenAI Compatible |
| deepseek | DeepSeek | OpenAI Compatible |
| moonshot | Moonshot / Kimi | OpenAI Compatible |
| zhipu | 智谱 GLM | OpenAI Compatible |
| doubao | 火山方舟 / 豆包 | OpenAI Compatible |
| qwen | 通义千问 | OpenAI Compatible |
| siliconflow | SiliconFlow | OpenAI Compatible |
| openrouter | OpenRouter | OpenAI Compatible |
| anthropic | Anthropic Claude | Anthropic Messages |
| gemini | Google Gemini | Gemini |
| azure | Azure OpenAI | Azure OpenAI |
| custom | 自定义兼容服务 | OpenAI Compatible |

自定义 Base URL 只允许平台超管配置，所有地址必须使用 HTTPS。

### 模型与思考

- 支持同步模型列表和手动添加模型 ID。
- 测试连接在具体模型上执行。
- 模型可启用、停用、归档和设为默认。
- 历史消息保存模型和供应商快照。
- 思考模式为 <code>auto</code>、<code>on</code>、<code>off</code>。
- 自定义模型结合模型 ID、供应商域名和能力元数据识别思考支持。
- 不支持显式模式的模型会拒绝不兼容选项，不由前端模拟思考。

### 会话隔离

- 会话查询同时校验 <code>circle_id + user_id</code>。
- 同圈不同成员不能读取彼此会话。
- 同一成员在不同圈子的会话互不共享。
- 圈主和超管只能查看聚合用量、模型健康和举报，不能浏览普通聊天正文。
- 成员退出、被移除或圈子删除时，相关 AI 数据按清理规则删除。

### 凭据与网络

- API Key 使用 AES-256-GCM 加密存入 PostgreSQL。
- 加密密钥只存在服务器环境变量中。
- 客户端只获得掩码和末四位。
- URL 校验阻止 HTTP、内嵌账号密码、回环、内网、链路本地、云元数据地址、危险 DNS 和危险重定向。
- 供应商或隐私政策变化后，需要重新取得用户授权。

### 内容安全与流式释放

用户输入和模型输出都接入微信文本内容安全。输出会持续读取供应商流，审核通过后立即释放：

- 首批审核 16 字。
- 前约 1200 字按约 64 字一批。
- 后续按约 128 字一批。
- 附带前文约 160 字作为审核上下文。
- 不足一批最多等待约 110ms。
- 展示帧最多约 10 字。

安全服务临时失败会重试，但不会为了可用性绕过审核。思考内容和正文使用同一 Markdown 安全渲染，原始 HTML、不安全链接和远程追踪图片会被过滤。

## 数据库与迁移

### 表分组

账号和圈子：

- <code>incircle_users</code>
- <code>incircle_circles</code>
- <code>incircle_circle_members</code>
- <code>incircle_member_cards</code>

业务：

- 活动、AA、投票、打卡、资料和随机决策。
- 积分规则、积分流水和操作日志。

并发敏感关系：

- 活动报名。
- 投票选票和否决。
- 打卡记录和卡片使用。
- 友好标签投票、提名、提名投票和申诉。

AI：

- 圈级设置、供应商、模型。
- 会话、消息和用量事件。
- 用户授权和举报。

### 事务

<code>server/src/db.js</code> 使用 AsyncLocalStorage 把事务内查询绑定到同一个 PostgreSQL 客户端。嵌套业务调用复用已有事务，确保 BEGIN、业务 SQL 和 COMMIT 不会分散到不同连接。

### 执行迁移

~~~powershell
Set-Location .\server
npm run db:migrate
~~~

Docker：

~~~bash
docker compose exec api npm run db:migrate
~~~

迁移器会创建迁移记录表、执行幂等 Schema、按文件名应用增量迁移、校验已执行文件的 SHA-256，并补齐系统资料。

### 迁移规则

- 已执行的迁移绝对不能修改或删除。
- 新变更同时更新 <code>schema.sql</code>，并增加下一个编号的 SQL。
- 尽量使用 <code>IF NOT EXISTS</code> 等幂等语句。
- 遇到 <code>Migration ... was changed after it was applied</code> 时恢复原文件，把新改动放入新迁移。
- 不要修改生产数据库 checksum 绕过校验。
- <code>npm run db:backfill-actions</code> 只用于必要的历史 JSON 回填，不是每次部署都执行。

## 生产部署

常规命令（先从 <code>deploy-server.example.ps1</code> 复制并配置本机私有脚本；真实脚本不提交到仓库）：

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-server.ps1 -HostName "your-server-host"
~~~

### 首次部署

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-server.ps1 -HostName "your-server-host" -WechatAppSecret "你的微信 AppSecret" -SuperAdminOpenids "你的 OpenID"
~~~

含真实 AppSecret 的命令可能进入终端历史，不要粘贴到 README、截图、工单或聊天记录。首次部署完成后，后续只运行常规命令。

### 参数

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| <code>-HostName</code> | 必填 | 服务器域名或 IP |
| <code>-User</code> | ubuntu | SSH 用户 |
| <code>-RemoteDir</code> | /home/ubuntu/incircle-server | 远端目录 |
| <code>-Port</code> | 22 | SSH 端口 |
| <code>-IdentityFile</code> | 空 | SSH 私钥 |
| <code>-WechatAppId</code> | 空 | 首次填充，或在本机脚本中配置 |
| <code>-WechatAppSecret</code> | 空 | 服务端为空时填充 |
| <code>-PublicBaseUrl</code> | 空 | HTTPS 公开 API 地址，或在本机脚本中配置 |
| <code>-SuperAdminOpenids</code> | 空 | 平台超管 OpenID |
| <code>-UseSudo</code> | false | Docker 使用 sudo |
| <code>-SkipBackup</code> | false | 跳过部署前备份 |
| <code>-UseScp</code> | false | 使用 scp 上传 |
| <code>-DryRun</code> | false | 只打包 |

默认模式通过一个 SSH 连接发送发布包和远端脚本，密码登录通常只输入一次。

### 脚本流程

1. 把 <code>server/</code> 打包为 <code>incircle-server.tar.gz</code>。
2. 排除依赖、<code>.env</code> 和上传目录。
3. 保留服务器现有 <code>.env</code>。
4. 缺失时生成数据库密码、JWT Secret 和 AI 加密密钥。
5. PostgreSQL 已运行且健康时执行 <code>pg_dump</code>。
6. 解压新版本并重建 API 容器。
7. 自动运行数据库迁移。
8. 最多等待约 60 秒检查 <code>/health</code>。
9. 失败时输出容器状态。

脚本不会删除 PostgreSQL volume，也不会覆盖服务器 uploads。部署压缩包可在发布后删除，下次会重新生成。

Dry Run：

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-server.ps1 -HostName "your-server-host" -DryRun
~~~

## 反向代理与流式响应

普通 API：

~~~nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
}
~~~

AI SSE 必须关闭缓冲：

~~~nginx
location = /api/ai/chat/stream {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    proxy_read_timeout 660s;
    proxy_send_timeout 660s;
}
~~~

还要确认：

- 域名有有效 HTTPS 证书。
- CDN 或代理不缓存 SSE。
- 该路径不启用响应合并或缓冲压缩。
- 微信网关无代码拦截排除 <code>/api/ai/chat/stream</code>。
- 不存在 5 秒级硬请求超时。

## 运维与备份

### 常用命令

~~~bash
cd ~/incircle-server
docker compose ps
docker compose logs --tail=200 api
docker compose logs --tail=100 postgres
docker compose exec api npm run db:migrate
curl http://127.0.0.1:3000/health
~~~

### 数据库备份

部署自动备份目录：

~~~text
/home/ubuntu/incircle-backups/incircle-YYYY-MM-DD-HHMMSS.sql
~~~

手动备份：

~~~bash
mkdir -p ~/incircle-backups
docker compose exec -T postgres pg_dump -U incircle -d incircle > ~/incircle-backups/incircle-manual.sql
~~~

### 图片备份

头像和业务图片位于：

~~~text
/home/ubuntu/incircle-server/uploads
~~~

数据库备份不包含图片。必须单独备份 uploads，并把数据库与图片备份复制到其他服务器或对象存储。同机同盘备份不算完整灾备。

### 恢复原则

- 恢复前进入维护窗口并备份当前数据。
- 数据库和 uploads 使用同一时间点备份。
- 恢复后执行迁移，再检查健康接口和关键业务。
- 定期做真实恢复演练。

### 日志

API Docker 日志单文件最大 10 MiB，最多 3 个文件。操作日志保存在 PostgreSQL，可由平台超管管理。日志不应写入密码、AppSecret、AI API Key 或普通聊天正文。

不要运行：

~~~bash
docker compose down -v
~~~

<code>-v</code> 会删除 PostgreSQL volume。

## 测试与质量检查

~~~powershell
Set-Location .\server
npm run check
npm test
~~~

当前测试集包含 20 个文件、145 项测试，覆盖：

- AI 多协议请求、UTF-8 分块、SSE、重连、恢复和取消。
- AI 思考模式、模型能力、内容安全、Markdown 和凭据加密。
- SSRF、私网地址和危险重定向。
- 圈子创建限制和并发锁。
- 角色归一化、圈内编号和成员权限。
- 友好标签自动上墙。
- 键盘避让、主题、Tabbar、空状态和动效约束。
- 超管圈子与用户管理。
- 临时读取失败重试和写请求不重放。
- 系统使用手册更新。

依赖审计：

~~~powershell
npm audit --omit=dev
~~~

小程序提交前至少检查 27 个页面、五个 Tab、登录切圈和全部业务主链路，并在 Android 与 iPhone 真机检查键盘、安全区、主题和 Tabbar。

## 安全与隐私

### 账号

- 密码使用 PBKDF2-SHA256，310000 次迭代、32 字节派生密钥和独立随机盐。
- JWT 使用 HS256 和常量时间签名比较。
- 登录尝试 10 分钟最多 8 次。
- 封禁、解绑和关键状态变化撤销旧令牌。
- 生产环境隐藏未知内部异常。

### 权限

- 业务读取验证用户、圈子和实体关系。
- 圈内角色不会隐式获得平台超管权限。
- 成员接口不返回其他圈子、账号、手机号或平台权限。
- 圈主不能通过退出或被移除留下无主圈子。
- 创建圈子数量检查在事务内锁定用户行。

### 上传

- 上传必须鉴权。
- 文件名和头像键由服务端生成。
- 使用文件魔数识别图片。
- 业务上传验证圈成员关系。
- 限制数量、大小和频率。

### 数据库

- 多步写操作使用同连接事务。
- 投票、打卡、报名和标签使用唯一约束与规范化表。
- SQL 使用参数绑定。
- 迁移带校验和。

### AI

- API Key 使用 AES-256-GCM。
- 客户端不接收明文凭据。
- 自定义 URL 执行 SSRF 防护。
- 输入和输出接入微信内容安全。
- 会话按圈子和用户隔离。
- requestId 幂等，避免恢复时重复扣费或消息。
- 同一会话只允许一个生成任务。
- 只有显式取消接口终止服务端生成，普通网络断开不会误标为用户停止。

### 隐私

- OpenID、手机号、密码哈希、用户导出和聊天正文属于敏感数据。
- 不提交数据库备份、历史导出、头像包或生产日志。
- 分享链接不能替代服务端成员校验。
- 避免在身份卡、账单、打卡图片、资料和 AI 输入中填写高敏信息。

## Git 与敏感文件

当前 <code>.gitignore</code> 忽略：

- <code>node_modules/</code>
- <code>.idea/</code>
- <code>project.private.config.json</code>
- 精确文件名 <code>.env</code>
- <code>server/uploads/</code>
- <code>incircle-server.tar.gz</code>
- Windows 系统元数据

提交前：

~~~powershell
git status --short
git add --dry-run .
git add .
git diff --cached --name-only
~~~

不应提交 <code>.env</code>、私有配置、依赖、上传文件、部署包、备份、用户导出、私钥或真实 API Key。

小程序 AppID 和公开 API 域名不是密钥；AppSecret、JWT Secret、数据库密码和 AI API Key 绝对不能提交。私人仓库不能替代密钥管理。

## 常见问题

### 微信开发者工具找不到 app.json

导入仓库根目录，并确认：

~~~json
{
  "miniprogramRoot": "inCircleClient/",
  "srcMiniprogramRoot": "inCircleClient/"
}
~~~

不要把官方字段 <code>compileType: miniprogram</code> 或微信 API 的 <code>miniProgram</code> 改成目录名。

### 真机提示域名不合法

- 在微信公众平台配置 request、uploadFile 和 downloadFile。
- 使用 HTTPS 并确保证书链完整。
- 检查 <code>inCircleClient/config/backend.js</code>。
- 不依赖开发者工具关闭域名校验。

### Migration was changed after it was applied

恢复该迁移原始内容，把新改动放入新编号迁移。不要修改生产 checksum 伪造通过。

### 部署后 API 容器反复重启

~~~bash
cd ~/incircle-server
docker compose logs --tail=200 api
~~~

检查数据库密码、微信 AppSecret、JWT Secret、HTTPS Public Base URL、AI 加密密钥和内容安全开关。

### Docker permission denied

~~~bash
sudo usermod -aG docker ubuntu
exit
~~~

重新 SSH 登录后部署，或明确使用 <code>-UseSudo</code>。

### AI 一次性出现而不是流式输出

1. 确认供应商返回真实 stream。
2. 关闭 Nginx 请求和响应缓冲。
3. 检查 CDN、网关和安全产品是否合并响应。
4. 从微信网关规则排除 AI stream 路径。
5. 检查 SSE 响应头和服务端 delta 日志。

安全审核会形成约 16/64/128 字的小批次，但不应等完整回答结束后统一返回。

### AI 长时间正在思考

- 测试具体模型。
- 检查 API Key、模型 ID、额度和供应商错误码。
- 确认上游空闲超时足够。
- 确认 SSE 心跳没有被删除。
- 恢复请求使用原 requestId 时不能改变原输入。

### 上传失败

- 请求需带 Bearer Token。
- 业务图片必须带 circleId。
- 用户必须是有效圈成员。
- 图片需小于 8 MiB。
- 配置 uploadFile 合法域名。
- 检查 uploads 权限和磁盘空间。

### 部署后留下 incircle-server.tar.gz

这是临时发布包，可以删除。下次部署会重新生成，Git 会忽略它。

### 数据库有备份但图片丢失

数据库备份不包含 uploads，二者必须分别备份并同步到异地。

### 推送前检查敏感文件

~~~powershell
git status --short --ignored
git diff --cached --name-only
~~~

若秘密已经进入提交历史，仅删除当前文件不够，还需要轮换密钥并清理历史。

## 许可证

当前仓库未设置开源许可证，按私人项目管理。未经仓库所有者明确授权，不得复制、公开分发、部署或用于商业用途。
