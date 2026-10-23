"use strict";

const crypto = require("node:crypto");

function action(id, zh, en, tool = null, options = {}) {
  return { id, labels: { "zh-CN": zh, en }, tool, ...options };
}
function feature(id, aliases, href, zh, en, actions) {
  return { id, aliases, uiTarget: { href }, content: { "zh-CN": zh, en }, actions };
}

// Product explanations ship with the App. Tool IDs are references to the live
// ToolRegistry, not a second authority for permissions, risks or execution.
const PRODUCT_HELP_CATALOG = [
  feature("web", ["联网", "搜索网页", "读取网页", "web_search", "web_fetch", "web search", "web fetch", "Exa", "Brave", "Tavily", "TinyFish"], "#/chat",
    { title: "联网搜索与网页读取", summary: "Agent 可以搜索公开网页，或直接读取指定网页的正文和来源链接。",
      guide: "在聊天中请求联网查询即可。在设置的“联网搜索与网页读取”中分别选择服务并保存 API Key。web_search 支持 Exa、Brave、Tavily、TinyFish；Exa 未配置密钥时使用免密托管搜索。web_fetch 支持直接读取及 Exa、Tavily、TinyFish 正文提取。查询或 URL 会发送给所选服务，受其额度与计费规则约束。第三方服务可能执行网页脚本，不携带本机浏览器登录状态。需要登录或交互时使用 Browser Use。结果包含来源、读取时间和截断状态。每个原生 Agent 可通过 web_settings_get 查看独立选择、统一默认和实际生效服务；web_settings_set 保存自己的搜索/读取偏好，null 恢复该项跟随默认。web_defaults_set 经单次确认修改统一默认，保留其他 Agent 的独立选择。密钥仍只在设置中配置一次供所有原生 Agent 共用。聊天和该 Agent 的 HEARTBEAT 使用同一选择。",
      examples: ["搜索这个项目最新的发布说明。", "读取这个网页并给出来源。"] },
    { title: "Web search and reading", summary: "Agents can search public pages or read a URL's text with source links.",
      guide: "Ask in chat. Choose providers and save API keys in Settings > Web search and page reading. web_search supports Exa, Brave, Tavily and TinyFish; Exa without a key uses keyless hosted search. web_fetch supports direct reading or Exa, Tavily and TinyFish extraction. Queries or URLs go to the selected service, subject to its quotas and billing. Hosted services may execute page scripts, without local browser cookies. Use Browser Use for authenticated or interactive pages. Results carry sources, retrieval time and truncation state. Native Agents use web_settings_get to inspect overrides and effective choices; web_settings_set persists own search/fetch preferences, with null restoring inheritance. The confirmed web_defaults_set changes shared defaults while preserving explicit Agent choices. Keys remain shared and configured only in Settings UI. Chat and each Agent's HEARTBEAT use the same preferences.",
      examples: ["Find the latest release notes for this project.", "Read this page and cite its source."] },
    [action("search", "搜索公开网页", "Search public pages", "web_search"),
      action("fetch", "读取公开网页", "Read a public page", "web_fetch"),
      action("settings", "查看我的联网选择", "Read my web preferences", "web_settings_get"),
      action("preferences", "修改我的联网选择", "Change my web preferences", "web_settings_set"),
      action("defaults", "修改统一联网默认", "Change shared web defaults", "web_defaults_set")]),
  feature("heartbeat", ["心跳", "主动检查", "HEARTBEAT.md", "heartbeat", "monitor scratch"], "#/agents",
    { title: "心跳检查", summary: "按每个 Agent 的 HEARTBEAT.md 规则定期检查，在有值得关注的变化时提醒。",
      guide: "可以直接在与当前 Agent 的对话中查看或修改心跳开关、检查间隔、每天最多检查次数、每日 Token 预算、活跃时段、时区和系统通知。Agent 先读取当前设置和版本，再按你的要求修改指定项；对话与设置页使用同一份配置，其他项和其他 Agent 保留。默认开启，每 30 分钟、每天最多 24 次、每日 Token 预算 1000 万、08:00–22:00，时区跟随电脑；可指定 IANA 时区，也可恢复跟随电脑。也可在 Agent 设定文件的 HEARTBEAT.md 上方保存检查设置。规则正文另行保存；开头的 YAML web 列表可声明最多四个公开网页或搜索查询。空规则跳过模型。检查笔记单独保存，可查看或清空；设置修改不会改写规则或笔记。保存配置不代表 Runtime 已就绪或检查已执行；当前受限检查需要 Codex Runtime。",
      examples: ["把你的心跳改为每 15 分钟一次，每天最多 20 次，预算 500 万。", "把活跃时间改为 09:00 到 20:00，时区跟随电脑。", "关闭你的心跳检查。"] },
    { title: "Heartbeat checks", summary: "Periodically review each Agent's HEARTBEAT.md and notify about meaningful changes.",
      guide: "Ask the current Agent in chat to read or change heartbeat enabled state, interval, daily check count, daily token budget, active hours, time zone or system notifications. It reads the current settings and revision before patching only the requested fields. Chat and the settings page share one saved configuration; other fields and Agents stay unchanged. Defaults are enabled, every 30 minutes, up to 24 checks and 10 million tokens per day, active 08:00–22:00 in the computer's time zone. You can select an IANA zone or restore system time. The same settings are above HEARTBEAT.md in Agent setup. Rules are saved separately; an optional YAML web list declares up to four public URLs or search queries. Empty rules skip model calls. Working notes remain separate and can be viewed or cleared. Saving settings does not prove Runtime readiness or a completed check. Restricted reviews currently require Codex Runtime.",
      examples: ["Check every 15 minutes, up to 20 times and 5 million tokens per day.", "Use active hours 09:00–20:00 and follow my computer's time zone.", "Turn off your heartbeat."] },
    [action("settings", "查看心跳设置", "Read heartbeat settings", "heartbeat_settings_get"),
      action("configure", "修改心跳设置", "Change heartbeat settings", "heartbeat_settings_set"),
      action("scratch", "查看或清空检查笔记", "View or clear working notes")]),

  feature("overview", ["Shoggoth", "功能介绍", "功能列表", "产品说明", "有哪些功能", "你能做什么", "你能操作什么", "你能帮我做什么", "能帮我操作什么", "what can you do", "app features"], "#/chat",
    { title: "Shoggoth 功能概览", summary: "Shoggoth 将多个 Agent 和执行 Runtime 放在同一应用中，提供聊天、灵感便签、定时任务、看板、记忆与技能/MCP 管理。",
      guide: "在聊天中描述目标即可请求 Agent 帮忙。询问功能时可以先了解用途、操作范围和设置入口。Agent 的身份、执行 Runtime、模型和产品所属后端分别管理；目录中存在一个 Agent 不代表它已连接。当前 Agent 能否执行某项操作需要查询权限和状态。",
      examples: ["灵感便签和看板有什么区别？", "你现在能帮我操作什么？"] },
    { title: "Shoggoth overview", summary: "Shoggoth brings Agents and execution Runtimes into one App, with chat, SparkNotes, schedules, Kanban, memory and shared Skills/MCP.",
      guide: "Describe your goal in chat to request help. Ask about a feature's purpose, available operations and settings entry. Agent identity, execution Runtime, model and product backend are separate. A configured Agent is not evidence of a live connection. Query current permissions and state before promising an operation.",
      examples: ["How is SparkNotes different from Kanban?", "What can you currently do for me?"] },
    [action("state", "查看应用状态", "Read App state", "app_state_get"),
      action("agents", "查看 Agent 目录", "List Agents", "federation_agent_list")]),
  feature("agents", ["Agent", "代理", "助理", "助手", "运行时", "Runtime", "Bindings"], "#/agents",
    { title: "Agent 与运行时", summary: "Agent 保存身份、职责和工作配置，通过绑定的 Runtime 执行任务；多个 Agent 可以使用相同 Runtime。",
      guide: "在代理页选择 Agent 查看详情。可以通过聊天请求创建原生 Agent 或修改其身份与职责。改名、工作目录变更和归档走产品确认；归档后的产品数据保留 7 天，工作区文件和共享账号保留。运行时绑定、账号登录和权限在应用界面设置。原生 Agent 创建不会自动启动任务。",
      examples: ["创建一个负责资料整理的助理。", "Agent 和模型有什么区别？"] },
    { title: "Agents and Runtimes", summary: "An Agent keeps its identity, responsibilities and work settings, and executes tasks through a Runtime Binding. Multiple Agents may share a Runtime.",
      guide: "Open Agents for details. Request creation of a native Agent or edits to its identity and responsibilities in chat. Renaming, workspace changes and archiving use product confirmation. Archived product data is retained for 7 days; workspace files and shared accounts remain. Configure Runtime Bindings, sign-in and permissions in the App UI. Creating an Agent does not start work.",
      examples: ["Create an assistant for organizing research.", "How does an Agent differ from a model?"] },
    [action("list", "查看 Agent", "List Agents", "federation_agent_list"),
      action("create", "创建原生 Agent", "Create a native Agent", "native_agent_create", { nativeTarget: true, currentRun: true }),
      action("identity", "修改当前 Agent 身份与职责", "Edit the current Agent identity", "agent_definition_update", { userConversation: true, nativeTarget: true }),
      action("update", "修改原生 Agent 名称或工作目录", "Edit a native Agent", "native_agent_update", { nativeTarget: true, currentRun: true }),
      action("archive", "归档原生 Agent", "Archive a native Agent", "native_agent_archive", { nativeTarget: true, currentRun: true }),
      action("bindings", "设置运行时、账号与权限", "Configure Bindings, accounts and permissions")]),
  feature("chat", ["聊天", "对话", "会话", "Chat", "conversation", "派发", "委派", "delegation"], "#/chat",
    { title: "聊天与任务委派", summary: "聊天用于向选定 Agent 提出问题或请求执行工作，也可以显式把任务交给另一个已连接的 Agent。",
      guide: "在聊天页选择 Agent 和会话，输入目标。委派前先查询目标 Agent 的连接状态；收到任务句柄后可查进度、继续沟通或取消。需要用户回答或审批时，在目标会话处理。任务完成后答案和文件位于目标 Agent 的会话；状态回执没有结果正文不代表任务没有输出。停止、追加指令和原生上下文压缩的支持情况取决于当前 Runtime。",
      examples: ["让资料助理调研这个问题。", "查看刚才委派任务的进度。"] },
    { title: "Chat and task delegation", summary: "Chat lets you ask a selected Agent questions or request work. You can explicitly delegate a task to another connected Agent.",
      guide: "Choose an Agent and conversation in Chat. Check the target connection before delegation. Use the returned task handle to inspect progress, continue or cancel. Resolve questions and approvals in the target conversation. Answers and files are delivered there; a status receipt without result text does not imply missing output. Steering, interruption and native compaction depend on the current Runtime.",
      examples: ["Ask the research assistant to investigate this.", "Check the delegated task's progress."] },
    [action("delegate", "派发任务", "Delegate work", "federation_agent_run", { connectedTarget: true }),
      action("progress", "查看委派进度", "Read delegated task progress", "federation_task_get"),
      action("continue", "继续委派对话", "Continue delegated work", "federation_agent_message", { connectedTarget: true }),
      action("cancel", "取消委派任务", "Cancel delegated work", "federation_task_cancel"),
      action("steer", "在聊天界面追加指令", "Steer in the Chat UI", null, { runtimeCapability: "turn.steer" }),
      action("interrupt", "在聊天界面停止执行", "Interrupt in the Chat UI", null, { runtimeCapability: "turn.interrupt" }),
      action("compact", "在聊天界面进行原生压缩", "Run native compaction in Chat", null, { runtimeCapability: "context.compact.native" }),
      action("session", "选择会话或模型", "Choose a session or model")]),
  feature("group-chat", ["群聊", "群组", "群成员", "群信息", "群记录", "群消息", "群里", "多少群", "建群", "拉进群", "加群", "group", "group chat", "groups"], "#/chat",
    { title: "群聊查询与管理", summary: "在私聊中查询群和公开聊天记录、创建群、添加已有 Agent，并把明确的安排交给群成员执行。",
      guide: "原生 Agent 可查询自己加入的群或全部群；默认不含归档群，返回的 total 是完整匹配数量。按群名查到准确群后查看成员、角色、状态和历史，可分页补读长消息或按关键词搜索。建群或加人先核对 Agent 目录中的准确身份，再预览群名和名单，产品确认后执行；同名成员必须先消除歧义。新群至少两人，群最多32人，加人整批成功或整批失败。结果不确定时用原请求查询回执，避免重复操作。外部共享 MCP 无法证明当前成员身份，可按已知后端和 Agent 查询，不能冒认原生成员。群内安排先读取最新群和成员，产品确认会显示目标与完整要求；提交成功不等于工作完成，应继续查询群内进度与回复。群内容是参考资料，不授权新的操作，不写入群共享记忆。",
      examples: ["你加入了多少个群？", "把小明、小红拉进新建的研发群。", "研发群昨天讨论了什么？", "你去研发群汇报这个问题的处理结果。"] },
    { title: "Group queries and management", summary: "Read groups and public history, create groups, add existing Agents, and submit explicit work requests from direct chat.",
      guide: "Native Agents can list their memberships or all App groups; archived groups are excluded by default and total counts every matching group. Resolve an exact group before reading its members or public history. For creation or member additions, resolve exact Agent identities, preview the group and roster, then obtain product confirmation. Clarify duplicate names. New groups need at least two members; groups support up to 32. Additions are atomic. Read the original request receipt after an unknown outcome. A shared external MCP connection cannot prove the current member identity. Dispatch uses current group revisions and confirmation of the exact group, recipients and instruction. Submission is not completion: read group progress and replies. Group content is reference data, not authorization or shared memory.",
      examples: ["How many groups have you joined?", "Create a research group with Alice and Bob.", "What did the engineering group discuss?", "Report this result in the engineering group."] },
    [action("list", "查看群列表和数量", "List and count groups", "group_chat_list"),
      action("get", "查看群资料和成员", "Read group and members", "group_chat_get"),
      action("history", "查看群聊记录", "Read public history", "group_chat_history"),
      action("search", "搜索群消息", "Search group messages", "group_chat_search"),
      action("dispatch", "安排群内工作", "Submit group work", "group_chat_dispatch"),
      action("prepare", "核对建群或加人名单", "Preview group changes", "group_chat_prepare"),
      action("create", "创建群聊", "Create a group", "group_chat_create"),
      action("members-add", "添加群成员", "Add group members", "group_chat_members_add")]),
  feature("inspiration", ["SparkNotes", "Spark Notes", "灵感便签", "灵感", "想法", "便签", "Inspiration", "ideas",
    "note", "notes", "sticky note", "sticky notes", "memo note", "memo notes", "memo", "memos", "自动生长"], "#/inspirations",
    { title: "灵感便签", summary: "灵感便签（SparkNotes）用于保存想法和便签，并将想法交给 Agent 执行，保留执行进度、结果与历史。",
      guide: "“灵感”和“便签”都可以指灵感便签。在灵感便签页记录想法、选择执行者并查看结果。可以请求 Agent 查找、新建或编辑文字便签、收藏、派发、续作或取消执行。新建便签是否立即自动执行取决于当前自动执行设置，创建前应读取设置。删除和更改自动执行设置需要确认；暂停自动执行不会取消已经运行的任务。归档要求已有完成的执行。媒体上传下载和便签包导入导出在界面操作。",
      examples: ["记一条灵感便签：整理个人知识库。", "把这条便签交给资料助理执行。"] },
    { title: "SparkNotes", summary: "SparkNotes saves ideas and notes, lets you assign them to Agents, and retains execution progress, results and history.",
      guide: "Notes, sticky notes and memos can refer to SparkNotes in Shoggoth. Record an idea, choose an executor and inspect results in SparkNotes. Request searches, text creation or edits, favorites, assignment, continuation or cancellation. Read automatic execution settings before creating a note: saving may start work. Deletion and changes to automatic execution require confirmation. Pausing automation does not cancel active work. Archiving requires a completed execution. Uploads, downloads and archive import/export use the UI.",
      examples: ["Save a note: organize my knowledge library.", "Assign this memo to the research assistant."] },
    [action("search", "查找灵感便签", "Find notes", "inspiration_list"),
      action("create", "保存文字灵感", "Save a text note", "inspiration_create"),
      action("update", "编辑、收藏或归档", "Edit, favorite or archive", "inspiration_update"),
      action("start", "派发或继续执行", "Start or continue execution", "inspiration_start", { connectedTarget: true }),
      action("cancel", "取消指定执行", "Cancel an execution", "inspiration_cancel"),
      action("delete", "删除灵感便签", "Delete a note", "inspiration_delete"),
      action("automation", "设置自动执行", "Configure automatic execution", "inspiration_growth_set"),
      action("media", "上传下载、导入导出", "Upload, download, import or export")]),
  feature("cron", ["定时任务", "定时执行", "定时", "计划任务", "提醒", "Cron", "schedule", "scheduled tasks", "reminder"], "#/cron",
    { title: "定时任务", summary: "定时任务按指定时间或重复规则调用 Agent 执行工作，可查看下一次执行时间、运行记录与失败原因。",
      guide: "在定时任务页新建一次性、固定间隔或 Cron 计划，明确提示词与时区。可以请求创建、修改、启停、立即运行和删除。当前 Agent 的原生任务用 cron 工具；跨 Agent 或 OpenClaw/Hermes 的管理使用全局管理工具并确认。外部 Hermes 只支持整分钟间隔，部分外部操作不支持重试。执行结果未知时先回读，不能重复发送。原生调度由常驻 Service 执行，关闭应用窗口不等于停止调度。",
      examples: ["每周一上午九点整理本周待办。", "暂停这个定时任务。"] },
    { title: "Scheduled tasks", summary: "Schedules run Agent work at a specific time or on a recurring rule, with next-run times, execution history and failure details.",
      guide: "Create a one-time, interval or Cron schedule with an explicit prompt and timezone. Request creation, edits, enable/disable, immediate runs or deletion. Native current-Agent tasks use cron tools; cross-Agent and OpenClaw/Hermes management uses confirmed global management. Hermes intervals use whole minutes; external retry operations are unsupported. Read back unknown outcomes instead of resending. Native scheduling is owned by the persistent Service; closing the App window does not stop it.",
      examples: ["Summarize my tasks every Monday at 9 AM.", "Pause this scheduled task."] },
    [action("list", "查看定时任务", "List schedules", "cron_list", { externalTool: "external_cron_list" }),
      ...[["create", "创建", "Create", "cron_create"], ["update", "修改", "Edit", "cron_update"],
        ["enable", "启停", "Enable or disable", "cron_set_enabled"], ["run", "立即运行", "Run now", "cron_run_now"],
        ["delete", "删除", "Delete", "cron_delete"]].map(([id, zh, en, tool]) => action(id, zh, en, tool, { externalTool: "app_manage", operation: tool })),
      action("retry", "重试失败的原生执行", "Retry a failed native run", "cron_run_retry", { nativeTarget: true })]),
  feature("kanban", ["看板", "任务卡", "任务板", "Kanban", "board", "task cards"], "#/tasks",
    { title: "看板", summary: "看板将工作组织成可跟踪的任务卡，保存任务内容、状态、执行历史和产物。",
      guide: "看板内部页面仍可访问，当前主导航暂时隐藏入口。灵感便签偏向记录想法，看板用于持续跟踪工作状态。可以创建任务卡、编辑内容、移动状态并派发原生执行；跨 Agent 或外部卡片管理走全局管理。创建卡片不会自动证明任务已经执行或完成，完成需要真实执行结果。卡片和运行记录必须按各自所属 Agent 操作。",
      examples: ["把这个目标拆成任务卡。", "查看任务的执行记录。"] },
    { title: "Kanban", summary: "Kanban organizes work into trackable task cards with content, status, execution history and artifacts.",
      guide: "The internal Kanban page remains available while its main navigation entry is hidden. SparkNotes captures ideas; Kanban tracks work over time. Create, edit or move cards and dispatch native execution. Cross-Agent or external card management uses global management. Creating a card does not prove execution or completion; completion needs actual results. Respect the owning Agent of each card and run.",
      examples: ["Split this goal into task cards.", "Show the task's execution history."] },
    [action("list", "查看看板与卡片", "Read boards and cards", "kanban_list", { externalTool: "app_state_get" }),
      action("create", "创建任务卡", "Create a card", "kanban_card_create", { externalTool: "app_manage", operation: "kanban_card_create" }),
      action("update", "编辑任务卡", "Edit a card", "kanban_card_update", { externalTool: "app_manage", operation: "kanban_card_update" }),
      action("move", "移动卡片状态", "Move a card", "kanban_card_move", { externalTool: "app_manage", operation: "kanban_card_move" }),
      action("dispatch", "派发原生卡片执行", "Dispatch a native card", "kanban_run_dispatch", { nativeTarget: true }),
      action("history", "查看原生卡片执行历史", "Read native card runs", "kanban_run_list", { nativeTarget: true })]),
  feature("memory", ["记忆", "长期记忆", "记住", "忘记", "Memory", "remember", "forget", "历史检索"], "#/agents",
    { title: "记忆与历史检索", summary: "记忆保存当前 Agent 的长期事实与用户偏好；历史检索用于找回符合访问条件的原始对话。",
      guide: "在当前用户对话中明确说“记住”或“忘记”，Agent 可保存或停止召回相应记忆。记忆按 Agent 和工作区隔离，后台候选需要用户审阅，不能被当成已生效记忆。忘记属于逻辑撤回，不删除原始对话和审计历史。身份、语气与工作约定通过 Agent 定义管理。外部 OpenClaw/Hermes 的个人记忆由其自身后端管理，Shoggoth 帮助工具不会授予它们原生 Agent 的私人记忆权限。",
      examples: ["记住我希望回答简洁一些。", "忘记之前那条偏好。"] },
    { title: "Memory and conversation recall", summary: "Memory keeps durable facts and preferences for the current Agent. Conversation recall retrieves eligible original dialogue.",
      guide: "Explicitly request remembering or forgetting in the current user conversation. Memory is isolated by Agent and workspace. Background candidates require user review and are not active memories. Forgetting stops recall without erasing original transcripts or audit history. Manage identity, tone and operating rules through Agent definitions. OpenClaw/Hermes retain their own personal memory authority; product help grants no access to native Agents' private memories.",
      examples: ["Remember that I prefer concise answers.", "Forget that earlier preference."] },
    [action("search", "查看当前 Agent 记忆", "Search this Agent's memories", "memory_search", { userConversation: true, nativeTarget: true }),
      action("save", "保存明确表达的偏好", "Save an explicit preference", "memory_save", { userConversation: true, nativeTarget: true }),
      action("forget", "停止召回指定记忆", "Forget a memory", "memory_forget", { userConversation: true, nativeTarget: true }),
      action("history", "检索可访问的历史对话", "Search eligible conversation history", "conversation_search", { userConversation: true, nativeTarget: true })]),
  feature("skills", ["技能", "Skill", "Skills", "工作流", "workflow"], "#/skills",
    { title: "技能", summary: "技能是可按需读取的工作流说明及配套文件，帮助 Agent 按约定完成特定任务。",
      guide: "在技能页管理技能包与各 Agent 的启用状态。同一技能包可以共享，各 Agent 分别启用；是否可用还取决于工具依赖、权限和 Runtime 能力。Agent 可搜索、读取已启用技能，并在确认后安装本地技能包供当前和未来原生 Agent 使用。卸载和权限变更在界面进行。读取脚本只获取文本，不代表执行或授予系统权限。插件中的技能也需要正确绑定和依赖。",
      examples: ["你有哪些可用的技能？", "这个技能为什么不可用？"] },
    { title: "Skills", summary: "Skills are on-demand workflow instructions and supporting files that guide an Agent through specific tasks.",
      guide: "Manage packages and per-Agent enablement in Skills. Packages are shared, but each Agent has its own enablement; eligibility depends on tool dependencies, permissions and Runtime capabilities. Agents can discover and read enabled Skills, and install a local package for current and future native Agents after confirmation. Removal and permission changes use the UI. Reading a script returns text, not execution or system permission. Plugin Skills also require valid Bindings and dependencies.",
      examples: ["Which Skills are available to you?", "Why is this Skill unavailable?"] },
    [action("catalog", "查找可用技能", "Find eligible Skills", "skill_catalog"),
      action("read", "读取技能及配套文件", "Read Skill instructions", "skill_read"),
      action("install", "安装本地技能包", "Install a local Skill package", "skill_install_global"),
      action("permissions", "启停、卸载和调整权限", "Enable, remove or change permissions")]),
  feature("mcp", ["MCP", "工具服务", "工具服务器", "插件", "Plugin", "Plugins", "扩展", "创建插件", "插件创建", "打包插件", "create plugin", "plugin authoring"], "#/plugins",
    { title: "MCP 与插件", summary: "MCP 服务向 Agent 提供工具；插件可以组合技能、MCP 服务、应用界面和连接配置。",
      guide: "在聊天中说“帮我创建插件”，Agent 会先确定任务目标、产品及已有接入资料：MCP 需要公开端点或启动配置；CLI 需要可执行文件位置、命令帮助、参数和输出格式；已有 Skills 需要 SKILL.md 及引用文件。只补问缺失的阻塞信息，不要求在聊天中提供密钥。plugin_create 默认生成 Codex 格式 .codex-plugin/plugin.json，输入 files 包含 skills/<name>/SKILL.md（YAML name、description 和任务步骤）、可选 .mcp.json（mcpServers 对象）及支持文件。stdio 使用包内可执行文件或 node/python 包内脚本；npx、uv、任意 CLI 裸命令不受此启动器支持，CLI 需包内 MCP 适配器。单次最多 64 个文件、48 KiB 输入。先修复返回的 diagnostics，再用精确 draftId、previewDigest、expectedRevision 和 enable 调用 plugin_install；安装由产品确认，不重复提问确认。要修改已有插件，用同一 name、更高的 version 再调 plugin_create，然后 plugin_install：同一安装在一次确认内更新（已启用的旧版本会先停用并等待调用结束），之后用 plugin_activate 重新授权工具。确认安装后插件出现在插件页；enable=true 的合格 Skills 在下一轮供原生 Agent 和已桥接 Hermes/OpenClaw 共享。优先使用远程 MCP 端点（.mcp.json 里 type 为 http 的 url），不要自写本地桥接。凭据一律写成 ${secret:NAME}（NAME 只用大写字母、数字和下划线）：stdio 的 env 值写 \"${secret:NAME}\"，http 的 headers 值写 \"Bearer ${secret:NAME}\" 之类；包文件里不能出现令牌或要求用户写令牌文件的说明。安装后读 plugin_status 拿 installationId，再读 plugin_setup_get：每个 provide_secret:NAME 调 plugin_secret_request，Shoggoth 在对话里弹出密码卡片，用户填写后直接加密保存并只注入到声明的进程或端点，Agent 拿不到值；然后用返回的 releaseDigest 调 plugin_activate（需用户确认），它会启用插件、固定本机 Node/Python、连接 MCP、发现工具并授权给所有助理，标注为破坏性的工具每次调用仍询问。新工具从下一条消息起可用。需要服务商账号登录（OAuth）的服务显示 configure_in_plugins，仍在插件页完成。用户也可以在插件页的“快速设置”里一键启用和填写凭据。不修改各 Runtime 的配置；报告源包路径和剩余设置。",
      examples: ["帮我把这个产品的 MCP 和使用步骤做成插件。", "把现有 CLI 包成原生 Agent、Hermes 和 OpenClaw 共用的插件。", "这个插件还需要什么设置？"] },
    { title: "MCP and plugins", summary: "MCP servers expose tools to Agents. Plugins can combine Skills, MCP servers, application views and connection settings.",
      guide: "Ask an Agent to create a plugin. Collect the task, product, and only missing public MCP endpoint/start configuration, CLI executable/help/argument/output schema, or existing Skills and referenced files. Never ask for credentials in chat. plugin_create generates the default Codex .codex-plugin/plugin.json; supply files with standard skills/<name>/SKILL.md (YAML name/description and workflow), optional .mcp.json containing mcpServers, and supporting UTF-8 files. Use contained executables or contained Node/Python MCP adapters for CLI integration; npx/uv/arbitrary bare CLI launchers are unsupported. A call supports up to 64 files and 48 KiB input. Repair diagnostics, then plugin_install with the exact draftId, previewDigest, expectedRevision and enable. Product confirmation is the install decision. To change an existing plugin, call plugin_create again with the same name and a higher version, then plugin_install: the same installation is updated in one confirmation (an enabled old version is drained first), and plugin_activate re-allows its tools. The installed package appears in Plugins; enable=true shares eligible Skills with native Agents and bridged Hermes/OpenClaw on their next turn. Prefer a remote MCP endpoint (an http url in .mcp.json) over writing a local bridge. Declare every credential as ${secret:NAME} (NAME in A-Z, 0-9 and _): a stdio env value \"${secret:NAME}\" or an http header value such as \"Bearer ${secret:NAME}\"; package files never contain tokens or instructions to write token files. After install, read plugin_status for the installationId, then plugin_setup_get: for each provide_secret:NAME call plugin_secret_request, which shows the user a Shoggoth password card; the value is stored encrypted and injected only into the declared process or endpoint, and the Agent never receives it. Then call plugin_activate with the returned releaseDigest (user confirmation): it enables the plugin, pins a local Node/Python, connects the MCP servers, discovers their tools and allows them for all Agents; tools annotated destructive still ask per call. New tools are available from the next message. Servers needing a provider OAuth sign-in report configure_in_plugins and are finished in Plugins, where users can also use Quick setup to enable and enter credentials. Do not edit Runtime-owned configuration; report sourcePath and remaining setup.",
      examples: ["Create a plugin from this MCP server and workflow.", "Package this CLI for native Agents, Hermes and OpenClaw.", "What setup remains for my plugin?"] },
    [action("list", "查看 MCP 服务", "List MCP servers", "mcp_server_list"),
      action("tools", "读取实际工具目录", "Read live tool catalogs", "mcp_server_tools"),
      action("register", "注册本地 MCP 服务", "Register a local MCP server", "mcp_server_register"),
      action("create", "创建 Codex 格式插件", "Create a Codex-format plugin", "plugin_create"),
      action("install", "安装创建的插件", "Install an authored plugin", "plugin_install"),
      action("status", "核对插件状态", "Read authored plugin status", "plugin_status"),
      action("setup", "查看插件剩余设置", "Read plugin setup state", "plugin_setup_get"),
      action("secret", "请用户填写插件凭据", "Ask the user for a plugin credential", "plugin_secret_request", { currentRun: true }),
      action("activate", "一键启用插件", "Activate a plugin", "plugin_activate"),
      action("connect", "连接插件、登录和调整权限", "Connect plugins, sign in or change permissions")]),
  feature("models", ["模型", "供应商", "Provider", "models", "model", "API Key", "密钥", "端点"], "#/models",
    { title: "模型与供应商", summary: "模型页管理供应商、模型目录和端点；Agent 默认模型与当前会话实际使用的模型可能不同。",
      guide: "在模型页配置供应商与 API Key，在设置页处理账号登录。可以询问已配置的模型和供应商元数据，也可以查询当前执行冻结的实际模型。当前模型不能仅凭 Runtime 品牌或 Agent 默认配置推断。敏感凭据、模型配置和端点修改需要在应用界面处理；Agent 的产品工具不读取或展示密钥。",
      examples: ["你现在实际使用哪个模型？", "在哪里修改 API Key？"] },
    { title: "Models and providers", summary: "Models manages providers, catalogs and endpoints. An Agent's default model can differ from the model used by the current conversation.",
      guide: "Configure providers and API keys in Models; handle account sign-in in Settings. Ask for configured model/provider metadata or the current execution's frozen effective model. Runtime branding and Agent defaults do not prove the effective model. Sensitive credentials, model settings and endpoint edits use the App UI; product tools do not read or reveal API keys.",
      examples: ["Which model are you actually using now?", "Where can I change my API key?"] },
    [action("catalog", "查看模型与供应商元数据", "Read model and provider metadata", "app_state_get"),
      action("current", "查询当前执行的实际模型", "Read the current effective model", "runtime_context_get", { currentRun: true }),
      action("credentials", "修改密钥、供应商与端点", "Change keys, providers or endpoints")]),
  feature("settings", ["设置", "Settings", "登录", "OAuth", "连接", "通知", "浏览器", "Browser Use", "Computer Use", "电脑控制"], "#/settings",
    { title: "设置与连接", summary: "设置页管理应用偏好、后端连接、账号登录、通知及浏览器和电脑控制权限。",
      guide: "在设置页调整主题、语言、通知和连接。CLI 已安装不代表账号已经验证，Agent 已配置也不代表后端已连接。浏览器操作与电脑控制使用各自授权会话；需要人工登录时，只在浏览器输入密码或验证码，并完成对应等待卡片。敏感凭据、连接开关、系统授权和应用更新在界面处理。查询应用状态本身不需要屏幕录制或辅助功能授权。",
      examples: ["为什么这个 Agent 没有连接？", "在哪里打开浏览器操作功能？"] },
    { title: "Settings and connections", summary: "Settings manages App preferences, backend connections, account sign-in, notifications, and browser/computer-control permissions.",
      guide: "Adjust theme, language, notifications and connections in Settings. An installed CLI does not prove authenticated access; a configured Agent does not prove connectivity. Browser and computer control use separately authorized sessions. For manual login, enter passwords or codes only in the browser and resolve the waiting card. Sensitive credentials, connection switches, system permissions and App updates use the UI. Reading App state does not require screen recording or accessibility access.",
      examples: ["Why is this Agent disconnected?", "Where can I enable browser interaction?"] },
    [action("state", "查看非敏感设置状态", "Read non-sensitive settings", "app_state_get"),
      action("connections", "查看后端连接状态", "Read backend connections", "backend_status"),
      action("configure", "修改设置、登录、授权或更新", "Change settings, sign in, authorize or update")]),
];

function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
freeze(PRODUCT_HELP_CATALOG);
const productHelpRevision = crypto.createHash("sha256").update(JSON.stringify(PRODUCT_HELP_CATALOG)).digest("hex");
function normalize(value) { return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ""); }
function words(value) { return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim(); }
function englishPhrase(value) { return /^[a-z0-9]+(?: [a-z0-9]+)*$/u.test(value); }
function containsPhrase(value, phrase) {
  // Callers only pass ASCII words/spaces, so phrase is safe to embed in a RegExp.
  return new RegExp(`(?:^|[^a-z0-9])${phrase}(?:$|[^a-z0-9])`, "u").test(value);
}
function nameScore(rawName, needle, queryWords) {
  const name = normalize(rawName);
  if (name === needle) return 1000;
  const nameWords = words(rawName);
  if (englishPhrase(nameWords)) {
    if (containsPhrase(queryWords, nameWords)) return 100 + name.length;
    return englishPhrase(queryWords) && containsPhrase(nameWords, queryWords) ? 50 + needle.length : 0;
  }
  if (englishPhrase(queryWords)) return containsPhrase(nameWords, queryWords) ? 50 + needle.length : 0;
  return needle.includes(name) ? 100 + name.length : name.includes(needle) ? 50 + needle.length : 0;
}
function searchProductHelp({ query, limit = 20, locale = "zh-CN" }) {
  const needle = normalize(query);
  const queryWords = words(query);
  const matches = PRODUCT_HELP_CATALOG.map((item, index) => {
    const names = [item.id, ...item.aliases, ...Object.values(item.content).map(content => content.title)];
    const score = needle ? Math.max(0, ...names.map(name => nameScore(name, needle, queryWords))) : 1;
    return { item, score, index };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  return { catalogRevision: productHelpRevision, locale, matchedTotal: matches.length,
    truncated: matches.length > limit, items: matches.slice(0, limit).map(({ item }) => ({
      featureId: item.id, title: item.content[locale].title, summary: item.content[locale].summary,
      uiTarget: { ...item.uiTarget },
    })) };
}

module.exports = { PRODUCT_HELP_CATALOG, productHelpRevision, searchProductHelp };
