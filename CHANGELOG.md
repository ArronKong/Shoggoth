# Changelog

## Unreleased

## 0.8.125 — 2026-09-21

- 从内部测试版升级为正式签名版时保留并兼容读取旧凭据，避免原生助理卡在连接中；新保存的凭据使用系统钥匙串加密。
- 正式签名并完成 Apple 公证的 macOS 版本会自动检查 GitHub Releases、后台下载更新，并可在设置页重启安装。
- 开发版、ad-hoc 与本地签名包不连接正式更新通道，避免把无法验证的内部构建分发给用户。
- 新增双架构 ZIP、更新元数据、Developer ID 签名与公证的 GitHub Actions 发布门禁；所有校验通过前仅保留草稿 Release。

## 0.8.124 — 2026-09-21

- OpenClaw 端点重选模型合并为一次配置写入及一次目录回读，避免逐个删除模型时重复等待完整目录刷新。
- 仅修改模型选择时复用已读取的授权摘要，省去保存后重复启动授权 CLI；正常加载与密钥变更仍刷新授权信息。
- 多个移除模型统一展示引用确认，断线重试保留原始操作内容。
- 主模型也可取消选择；保存前列出受影响的助理，确认后保留原主模型绑定，不自动换绑。重新打开不会把已取消的模型重新勾选。

## 0.8.123 — 2026-09-21

- 修复 OpenClaw 部分模型已保存、修改选择后再次保存时的 `operation_reused`；新保存使用独立操作编号，恢复重试沿用原编号。
- 编辑端点时标记并保留正在被助理使用的主模型，其他模型可正常调整；配置刷新后新增的主模型占用也会自动保留。

## 0.8.122 — 2026-09-21

- 修复 OpenClaw 自定义端点重新选择模型时误报引用阻塞；取消选中被回退模型或允许列表引用的模型时，支持确认清理后继续保存。
- 修复仅改变模型顺序的保存误报、重复引用提示，以及多个模型连续确认和断线重试；取消确认后可继续编辑。
- 正在作为助理主模型使用的模型会提前提示切换主模型，避免写入后才失败。

## 0.8.121 — 2026-09-21

- Shoggoth 自定义端点复用 OpenClaw/Hermes 的列表与编辑弹窗，支持自动发现模型、多选保存和按助理设置默认模型。
- 修复 OpenClaw 端点配置已写入、模型目录刷新失败后，旧操作阻塞后续编辑的问题。
- 调整桌面灵感打印机动画和菜单栏图标。

## 0.8.120 — 2026-09-20

- 原生 AI 后端分别拥有 4 路执行额度，同一运行账号默认可使用 4 路；每个后端的后台任务最多占其中 2 路。排队提示明确显示所属后端的额度限制。

## 0.8.119 — 2026-09-20

- 原生后端采用总计 4 路、同账号 2 路、后台最多 2 路的并发额度，超额自动排队；新会话默认目录独立，并显示排队原因、等待时长和连接状态。
- 修复 Codex 子进程代理继承和旧会话恢复后的指令更新，新增通过对话创建原生助理的能力。
- 隐藏已归档助理列表，归档数据保留七天后由后台清理，并保护共享数据、外部工作目录和未完成任务。
- 重整设置页，统一后端连接变更后的页面缓存失效，完善 Dashboard 和用量统计的不完整数据提示。
- 修复桌面灵感打印机首次出现和再次呼出的动画、快捷键取消行为，并调整菜单栏图标。

## 0.8.114 — 2026-09-20

- 原生 Agent 通过对话保存记忆后立即生效，移除待确认队列和记忆确认工具；明确私人事实同样直接保存，凭据和未陈述推测仍拒绝写入。
- 旧待确认记忆启动时迁移，保留来源、置信度及审计历史，避免复活过期、已替换或已遗忘内容。
- 六个原生后端同步更新默认记忆规则，避免引导用户去不可见的设置入口；补充多项人设变更分别写入 IDENTITY、SOUL、AGENTS 的指引。
- 同一 Agent 的直接对话可读取已保存的私人资料，避免新会话误报未记住；后台任务仍不自动注入。明确区分新增项目与纠正旧项目，避免误替换无关记忆。

## 0.8.112 — 2026-09-20

- 修复原生 Agent 空记忆文件读取报错，以及对话记忆和设定工具未能正确关联当前聊天记录的问题。
- 隐藏 AI 助理设定页的版本、导入、导出及历史管理入口，保留文件查看与编辑能力。
- 补齐六个原生后端的六文件回归验证，覆盖对话修改、下一轮生效、记忆隔离、权限和重启保留。

## 0.8.111 — 2026-09-20

- 原生 Agent 采用按各自名称生成的默认设定，支持对话修改身份、性格和工作约定，保存有来源的长期记忆；保留历史、自定义内容和各 Agent 的数据隔离。
- 明确运行时加载的设定来源，区分 Agent 名字、后端和模型；隔离 OpenClaw/Hermes 外部 MCP 的身份、记忆及原生专用工具。
- 完善 Dashboard 的用量、费用和任务状态统计，以及 Hermes Cron 历史和 Grok 用量对账，保留数据不完整时的状态提示。
- 优化 AI 助理设定、聊天及 Dashboard 布局，修复执行轨迹连接线和桌面便签菜单栏图标。

## 0.8.108 — 2026-09-18

- Dashboard 将实时执行和待授权状态合并到动态列表，并通过轻量刷新及时更新，保留请求失败时的有效状态。
- 统一 AI 助理头像组件和默认纹理，修复透明头像叠色、加载失败与缓存图片显示。
- 原生模型菜单等待完整目录发现，保留刷新失败前的模型选项，并提供加载状态和重试。
- 修复原生服务启动调度、会话工作区别名归属与重复迁移写入，完善服务恢复提示及 Antigravity 完整输入确认。
- 调整定时任务时间显示和多处界面细节，移除组件页背景着色器依赖；补齐自有代码 MIT 许可与随包运行时声明。

## 0.8.107 — 2026-09-18

- 本会话产物改为按 AI 输出来源收录，排除用户附件、只读引用、失败写入与共享工作区其他文件；保留旧会话交付文件的恢复能力。
- 修复 Antigravity 查询和后台辅助进程启动时 Dock 图标闪现，合并重复控制查询，并避免钥匙串工作进程主动抢焦点。
- DeepSeek Harness 将认证失败准确传递到聊天提示；灵感会话在启动失败后可沿原绑定恢复，保留历史和幂等保护。
- 统一默认 AI 助理头像的黑白配色，调整聊天列表边缘、消息菜单和灵感问候退场；精简 AI 助理页签、聊天状态及部分入口与提示。

## 0.8.106 — 2026-09-18

- 优化长聊天输入与执行轨迹切换，复用消息身份计算并保留滚动和沉浸展开状态。
- 灵感便签减少草稿、搜索和拖拽时的无关卡片渲染；全局滚动条减少指针移动时的重复布局测量。
- Hermes CLI 与技能统计改为异步历史扫描，保持计数、缓存和后端切换隔离，减少界面及本地接口停顿。
- 合入灵感执行会话历史与 OpenClaw 凭据同步修复，以及执行轨迹状态与卡片外观调整。

## 0.8.105 — 2026-09-18

- 模型页集中管理运行时账号、登录状态与 Provider 配置；设置页切换后端连接时保留当前页面和未保存内容。
- 聊天支持识别并打开回复中的本地文件路径，完善附件路径、权限模式中文说明和长消息渲染。
- 联邦 MCP 增加灵感读写、执行与自动培育工具，保留修订冲突检查、操作重放和敏感操作确认。
- 调整 Codex 冷启动签名校验与会话初始化超时，提供明确且不泄露敏感信息的启动诊断。
- 完善模型修改被阻塞或部分完成时的提示，避免将尚未完成的变更显示为成功。

## 0.8.104 — 2026-09-18

- Antigravity 1.2.5 及以上版本支持通过原生终端显示并响应工具授权，严格保留 CLI 提供的一次性与持久授权范围；安装包加入对应的 PTY 和无头终端运行时。
- 设置页支持断开与重新连接全部九类后端，并保护最后一个可用连接；原生后端重连后会恢复事件订阅和运行状态。
- 聊天中的 `/reset` 可清空当前桌面会话上下文，切换会话时隔离迟到结果；上下文占用只在当前会话提供明确窗口时显示。
- Cron 与 Dashboard 隐藏系统 heartbeat 任务和运行噪声，同时保留用户创建的同名任务、详情访问和底层调度记录。

## 0.8.103 — 2026-09-17

- 按设计统一各页面的 Agent 图标与排列顺序，自动培育浮层使用同一套 Tab 滑动动效。
- 优化长聊天的 Markdown 渲染和历史缓存，减少输入、切换面板及流式回复时的重复计算。
- 原生定时任务的运行记录关联独立聊天会话，可查看执行轨迹并继续对话；完善历史回填、会话分类与删除后的隔离。
- 完善原生聊天附件和模型参数控制，保留附件发送及模型设置的跨会话一致性。

## 0.8.102 — 2026-09-17

- 灵感统一使用英文任务提示词，引导 Agent 综合理解内容、按自身能力直接推进；保留用户原文与限制，不额外规定回复语言。灵感列表支持按后端和 Agent 筛选。
- 定时任务使用统一创建弹窗与必选 AI 助理选择器，切换助理保留内容和时间；简化表单，编辑旧任务仍保留高级参数。
- 完善 Grok 请求接收回执与额度错误识别，以及 Pi 失败进程结束记录、历史迁移和原会话继续执行。
- 登录失效、账号受限、额度不足和 Antigravity 无法弹出原生审批时提供明确错误说明；已归档或删除的灵感会话显示对应原因。
- 聊天历史隐藏审批请求和审批决定，仍保留审计记录与实时审批卡片；已登录 ChatGPT 的 Agent 可以沿用默认模型完成配置。
- Dashboard 动态和统计排除系统健康记录；设置与首次启动引导收起远程连接和存储清理入口，保留底层能力及已有配置。

## 0.8.101 — 2026-09-16

- 新增菜单栏入口与桌面便签打印机，默认 Option + S 呼出，支持在设置中修改全局快捷键。
- 主窗口与桌面便签共享草稿；保存时纸张飞向菜单栏图标，完善跨窗口保存与媒体草稿保留。
- 按设计更新打印机圆角、机身高度、纸张字体及 SD 卡导出动画。
- SD 卡弹出后直接打开系统保存窗口，移除中间弹窗与导入入口；导出名称包含本地日期和时分秒。
- 麦克风权限改为首次点击录音时申请，进入灵感页面不再触发授权。

## 0.8.100 — 2026-09-16

- 灵感支持导出和追加导入归档，保留便签、草稿、原始附件与纸色；导入重试不会重复生成便签。
- 支持文档附件及正文中的附件位置，完善媒体预览、便签高度调整和拖拽收起行为。
- Spark Notes 导航改用 Figma 种子图标，进入页面和刷新时播放舒展回摆动画；四阶段生长图标连续变形。
- 完善取消运行、执行器就绪和服务重启后的审批状态；统一审批预设与一次性拒绝行为。
- 停止后台服务前显示受影响任务，执行时重新核对影响范围。

## 0.8.98 — 2026-09-15

- 灵感便签支持图片、GIF、实况图、视频和音频附件，支持粘贴、拖入与语音录制；媒体随便签和执行快照持久保存。
- 媒体预览按 Figma 调整文件名、图片比例与音频频谱；列表中的视频和实况图可见时静音循环播放，媒体便签与文字便签统一限制预览高度。
- 打字机便签最高 460px，与筛选栏间距 64px，悬停工具栏只保留语音入口。
- 便签提供八种加权随机纸色，连续保存避免重复颜色，草稿刷新与失败重试保留原纸色。
- 更新自动培育的 Agent 选择、运行时筛选、滚动提示和生长图标，优化搜索入口、头像投递区域与便签墨色。

## 0.8.75 — 2026-09-08

### 修复

- 修复内置 Agent 登录 ChatGPT 时 Profile 查询缺少 Shoggoth Backend 作用域，导致尚未打开
  浏览器授权就被 Service 以 `INVALID_PARAMS` 拒绝的问题。
- 首次启动期间设置页会有界等待后台 Service 就绪并同步 Provider 状态，不再保留必须手动点击
  “重新连接”才能消除的过期未连接快照；用户明确停止 Service 时不会自动启动。
- 本机 Codex 登录摘要检测会自动重试瞬时 Service 启动错误，首屏无需手动重新检测即可收敛。

## 0.8.74 — 2026-09-08

### 变更

- Shoggoth 内置 Agent 首次配置 ChatGPT 时会只读检测本机 Codex 登录状态；已登录时可沿用浏览器
  会话为 Shoggoth 建立独立授权，不复制、链接或同步本机 Codex 凭据。
- 内置 Agent 增加独立的“切换账号”和“退出 Shoggoth 登录”入口。相关操作只作用于 Shoggoth
  managed RuntimeAccount，不会退出或改写本机 Codex；多个内置 Agent 继续共享一份内部账号。

## 0.8.70 — 2026-09-07

### 新增

- 引入 RuntimeAccount，把逻辑 Agent/Profile 与 CLI 安装、账号认证和 Runtime Home 解耦；同一种原生
  Backend 的多个 Agent 默认复用本机 CLI/Home，Shoggoth 内置 Agent 则共享一份独立的 bundled Codex Home。
- 设置页增加账号、共享 Agent 数、空间占用、旧 Runtime Home 与历史备份视图，并提供带 TTL、目录身份
  和占用重验的两阶段显式清理。
- 为旧 managed Home、Runtime session ownership 和旧 Codex API Key 增加可恢复迁移 journal、lineage
  证明与崩溃续跑；合法旧 Key 按 Profile 转入独立加密 Provider credential。

### 变更

- Codex、Grok Build、Pi 与 Claude Code 直接使用本机 system binary/native Home；Antigravity 与
  DeepSeek Harness 仅按账号维护一份轻量 integration，不再按 Agent 复制依赖或执行 `pnpm install`。
- Native Skill 改为 content-addressed package 真源及 Context/MCP 注入，不再投影到每个 Codex Home。
- 常规 authority backup 改为 minimal allowlist，不再递归复制逐 Profile Runtime Home 或 integration。
- 发布命令会先构建管理 UI；packaged smoke 会从 `app.asar` 实际加载 Agent Service 模块图，并验证
  arm64/x64 内置 Runtime、桥接模块、签名与 app-server。

### 安全

- Runtime session/turn、MCP、认证、Provider 与 Host invalidation 明确校验 RuntimeAccount/Profile
  ownership，防止共享 Home 后跨 Agent 串会话、权限或凭据。
- native/bundled Home 以及 native/integration root 的相等、祖先和后代路径冲突全部 fail closed；原生
  Home 永不进入 Shoggoth 清理候选。
- 旧 Home 与备份默认保留，只有来源 lineage、Transcript、WorkRun 和目录重验全部成立时才允许用户确认清理。

## 0.8.59 — 2026-09-03

### 修复

- Dashboard、Chat 和 Token 统一从当前 Agent roster 解析展示名；Agent 攡名后切回页面或刷新即可生效，
  历史会话、用量统计、头像与路由继续保留稳定 `agentId`。
- 名称查询失败时保留旧展示名或回退 `agentId`，且不同 Backend 的同名 Agent 不会串名。

## 0.8.58 — 2026-09-02

### 修复

- macOS 上的 Antigravity CLI 隔离 HOME 会在启动前写入仅指向当前用户默认钥匙串的独立
  Keychain 偏好，避免 `agy` 因找不到名为 `antigravity` 的默认钥匙串而反复弹出系统对话框。
- 不复制或修改钥匙串内容，也不修改真实 HOME 的偏好；上下文无法验证时在启动 `agy` 前安全失败。

## 0.8.55 — 2026-09-01

### 主线整合

- 将 `codex-harness-m0`、运行时硬化、Codex/Grok 原生 Backend、OpenClaw 2026.8.1 M0–M8
  与 Session Board 安全宿主的完整提交链统一为新的主线基线；合并提交保留原 `main` 与整合线双历史。
- 补入 `grok/dev` 后续六项有效功能：OpenClaw Agent 只填名称即可创建，中文名稳定转拼音 ID，
  workspace/model 自动使用默认值，创建时随机 Emoji，概览页提供分类 Emoji 选择器，Agent 卡片按创建
  时间稳定编号；旧式本地 `IDENTITY.md` 名称解析未引入，以 OpenClaw 8.1 `agents.list` 为唯一事实源。
- 设置页改为 960px 单列阅读布局，并把 Hermes dashboard 正常退出保活改为默认开启；显式关闭仍会
  持久化，模式切换、断开与自更新继续执行真实回收。
- 根应用与管理界面加入 `pinyin-pro`，打包白名单同步包含该运行时依赖；版本升至 `0.8.55`。

### OpenClaw 2026.8.1 M7/M8

- 聊天支持 8.1 Canvas `show_widget`：由 Backend 契约代理自包含 HTML，Bearer 不进入浏览器；
  固定 CSP/Permissions-Policy、opaque sandbox、同源导航门禁与 2 MiB/8 秒上限。Widget 向聊天
  发 prompt 需精确 iframe/MessagePort、瞬时用户操作、当前会话与普通发送门禁，并按 Widget 文档限流。
- 新增动态 Worker/环境清单与高级会话详情，显示 placement、分支及安全摘要；方法与 scope 每次
  按当前 Gateway 协商结果判断，lease、命令、cwd、内部会话 id 和原始错误不进入浏览器。
- 支持从精确选中的持久 user entry 创建会话分支；成功后切换新会话并预填受限文本/附件，绝不
  自动发送，切会话或迟到响应不会串写当前草稿。其他 Backend 通过通用 capability 明确降级。
- 新增会话级 Session Board 的聊天/分屏/仪表盘视图、布局移动/移除、Canvas 固定与权限决定；所有
  能力由 Backend 契约和当前 Gateway method/scope/capability 驱动，不按后端 ID 分叉。grant 为
  `none|granted` 的自包含 HTML 可经受信主进程 fresh 校验、独立 loopback 单次票据和双层 opaque
  sandbox 静态显示；MCP App、插件、registered 及待定/拒绝内容继续只显示安全元数据占位。
- Board 回包强制绑定请求 session；上游 frame URL/view ticket/sandbox 地址、source/props 与原始错误不进入
  浏览器或日志，HTML 不进入管理面 DTO/preload，只经独立 ticket host 送入静态隔离内容帧。权限申请使用
  严格校验后的完整 HTTPS origin/tool 清单并在最终确认中逐项重复；明细不可完整投影时禁止允许。
  临时刷新失败保留最后已验证快照但冻结 mutation。
- Board HTML 内层固定 `sandbox=""` 与 `script-src 'none'`，阻止 WebRTC 绕过 CSP 发出 UDP；外层只运行
  Shoggoth 生成的 nonce/MessagePort 握手。票据按 owner/scope 绑定，HEAD 不消费、GET 单次认领、ready
  超时即清零，切会话、断线、reload/crash/关窗均撤销；网络、prompt、action、Cron 与 data bridge 未开放。

## 0.8.54 — 2026-08-31

### OpenClaw 2026.8.1

- 将 OpenClaw 最低兼容版本提升到 2026.8.1；连接建立时严格校验 `hello-ok`，仅向浏览器投影协商后的
  methods/events/capabilities/scopes/policy，不再转发设备凭据、连接标识或原始 snapshot。
- Agent 配置以 `agents.entries`、defaults/per-agent `modelPolicy.allow` 为唯一写入语义；模型目录改取
  `models.list(view:"all")` 的运行时事实，会话搜索/预览改走 `sessions.search` / `sessions.preview`。
- Cron 支持 `on-exit` 与 `stream`，运行记录分离执行、完成、投递和错误原因；Workboard 只投影插件持有
  的运行状态，刷新不再反向写卡片；Cron 列表按 snapshot revision 完整分页。聊天补齐结构化提问、
  凭证输入、可修订进度卡和 8.1 媒体信封，并在发送前校验完整 WebSocket 请求的协商总字节上限。
- OpenClaw 更新器改为可恢复状态机：更新后核验精确 gateway RPC、执行 post-upgrade doctor，失败时提供
  repair；App 重启后通过官方 update status 继续收敛。新增 capability review 的二次确认，以及常驻
  命令授权的安全摘要与撤销，原始 command/cwd 不进入浏览器。
- 跨会话搜索遵守 8.1 的每请求 200 个 session key / 25 条结果上限，分片合并而不再因默认 limit
  超限退化为 unsupported。

## 0.8.53 — 2026-08-31

### 安全

- 禁用 Backend、Hermes profile 身份碰撞、未知模型作用域、跨任务 Cron transcript、
  未扫描 CLI 可执行文件、超大 Hermes 响应及跨站 loopback 请求现在全部 fail closed。
- CLI 探测改为服务端规范路径白名单并限制并发；浏览器管理面继续执行严格 Origin/Host 校验。
- Vite 5 开发代理和 Kanban 事件桥接都在 WebSocket upgrade 边界校验当前 loopback 页面
  的精确 Origin；恶意网页或无 Origin 请求无法触达带私有 token 的上游连接。

### 修复

- Hermes 新会话使用 canonical 持久身份，首条 prompt 前固定创建 transport，并在 ACP
  降级时真实应用继承模型；聊天发送支持跨连接幂等重放和正确的错误终态。
- Hermes Dashboard 启停、取消、进程组回收、HTTP deadline/响应上限与 updater 单飞状态改为有界且竞态安全。
- Hermes Cron 能显示 session 创建前的失败，并按 execution ledger 避免把结果归到旧会话；
  暂停任务手动运行时明确提示会同时恢复后续调度。
- OpenClaw Cron transcript 增加任务归属和路径边界校验；Kanban 创建任务保留目标 board。
- Chat、Agents、Settings、Tasks、模型和 API Key 写入增加 latest-wins/逐字段回滚保护，
  避免迟到请求覆盖当前 Codex、Grok Build 或其它 Backend 的界面状态。
- Vite 开发态补齐 Chat/Kanban WebSocket 代理；修复 locale 首帧、附件文件名/MIME、
  对话框/开关/滑杆/卡片可访问性及浏览器先断开时的上游连接回收。

### 性能

- Dashboard 并发复用 activity/Cron 数据，对慢 usage 扫描采用有界等待并在完成后刷新；
  Hermes 摘要 fan-out 和管理端初始 JavaScript 都加入确定性预算回归。

## 0.8.43 — 2026-08-31

- 新增与 Shoggoth、Hermes、OpenClaw 平级的 Codex 与 Grok Build Backend/Agent；三个原生 Backend facade 共用同一个常驻 Agent Service、Product Store、Cron Scheduler 与 Kanban Service。
- Product Store 升级到 v6，精确迁移既有 Codex/Grok 内置 Profile 的 Backend 归属，同时保留固定 profile/agent id 及其 Chat、Cron、Kanban、WorkRun 引用。
- 后端目录与 UI 能力由 `BackendDescriptor` 驱动；Chat、Cron、Kanban、Usage 与 Dashboard Run 全链路按 `backendId` 做 Service 端归属校验。
- 产品 MCP 的 `usage_get` 进一步限制为当前授权 Agent Profile；Codex、Grok 与 Shoggoth 不能互读 Token usage，返回来源使用各自 Backend 归属。
- 原生 Cron/Kanban 在目标 Agent Profile 停用且尚未开始执行时分别持久化 `CRON_TARGET_DISABLED` / `KANBAN_TARGET_DISABLED` skipped Run；Cron 继续推进计划，Kanban Card 收敛为 canceled，二者都不启动 Runtime，也不再把共享调度服务判为损坏。
- 引入 `RuntimeAdapterRegistry` 与 Grok Build ACP Runtime；按 Profile 隔离 managed home 与模型 scope，Grok 另按 workspace 分片 ledger，并以真实 ACP 成功建立凭据 proof。
- 为 Grok Runtime 增加一次性 MCP 启动 gate、Service 恢复期 MCP-only barrier，以及设置页 device-auth 入口；Grok 的 MCP 子进程改用 `ELECTRON_RUN_AS_NODE` 纯 Node relay，避免继承 Grok sandbox 后启动 Electron GUI/IOKit 并触发“Shoggoth 意外退出”假象。Bootstrap 独立锚定系统账号的规范 Service 路径，Service 在同一 UDS 上消费 gate 后托管 MCP handler/session/crypto，token/refresh 不进入 Runtime wire/env/stdout，Runtime 自报的 `confirmation:true` 不能绕过 handler elicitation；Codex 的 direct Helper 路径保持不变。
- 为 Codex/Grok 增加统一 Runtime 认证状态与 WorkRun 中央门禁；未登录的 Chat、Cron、Kanban 在 session/turn 前以 `RUNTIME_AUTH_REQUIRED` 收敛，Codex 401 与 Grok `AUTH_REQUIRED` 不再退化成不透明或带 Codex 前缀的错误。
- Runtime 登录状态探测遇到瞬时 IPC/IO 故障时会在首个 turn 前安全重试一次；明确未登录仍只探测一次且不会启动 session/turn。
- Runtime 启动/终态错误改用 `RUNTIME_START_*` / `RUNTIME_TURN_FAILED`，并继续兼容显示历史 `CODEX_START_*` / `CODEX_TURN_FAILED` 记录。
- Grok 子进程启动时由后台 Electron `app.resolveProxy()` 解析目标 API 的系统/PAC 代理，严格校验协议、authority、端口、长度与控制字符后只注入当前进程；不把代理写进 LaunchAgent plist，也不记录代理值。解析失败时只继承白名单内且通过相同校验的父进程代理变量。
- Grok 凭据拒绝只缓存到当前 acquire；下一次独立 WorkRun 在同一 Host 上重新验证官方支持热加载的 `auth.json`，不在缺少 Run lease 的前提下自动回收 Host。设置页对安全本地凭据的瞬时验证故障显示 `unverified`，本地完整性错误仍保持可见。
- 已用 Grok 1.0.13 在隔离 HOME 下完成真实 ACP v1 启动与 0.8.42 安装态付费 prompt E2E：默认 Grok workspace 的 Run `completed`、回复 `GROK_OK`，认证由 `unverified` 收敛为 `authenticated`。
- 已知边界：Grok CLI 需由用户安装；执行进程池容量满时安全失败且不会回收可能仍被 Run 使用的 Host；Native Skill filesystem projection 仍仅 Codex 支持。
- Shoggoth Chat 的周期状态探测现在把首个 `REQUEST_TIMEOUT` 视为未知样本，不再撤销正在输出的 ready snapshot；连续超时或权威 not-ready 仍进入恢复，且非消费者取消的发送观察者保证只发出一次 `final` 或 `error`。若同一 `run.subscribe` 已返回绑定当前 Run 的终态，即使健康检查同时切换 Backend generation，也会先结算该终态且不跨代查询历史，避免界面永久“思考中”或把已完成的工具副作用当失败重试。
- `notification_send` 的公开 MCP schema 为 `title` 与 `body` 补齐 `minLength: 1`，与既有运行时非空校验保持一致，避免 Agent 先按错误契约发送空正文再重试。
