import type { McpToolDescription } from "../api/mcpConnectors";
import presets from "../../../agent-service/data/mcp-featured-presets.json";
import official from "../../../agent-service/data/official-skill-connectors.json";

export interface ConnectorToolPreview {
  items: McpToolDescription[];
  sourceUrl: string;
  kind: "tools" | "operations";
}

// Display-only examples from the bundled connector summaries and setup guides.
// Remote entries use purpose labels, not invented MCP tool identifiers. Entries
// with fixed local definitions keep their actual names; neither grants access.
// Loaded on demand by connector details, outside the initial UI bundle.
type Row = readonly [englishName: string, chineseName: string, englishPurpose: string, chinesePurpose: string];
const previews: Record<string, readonly Row[]> = {
  github: [
    ["Search repositories", "搜索代码仓库", "Find repositories and inspect their code.", "查找代码仓库并查看代码内容。"],
    ["Work with issues", "处理 Issue", "Find and review repository issues.", "查找和查看仓库中的问题与需求。"],
    ["Review pull requests", "查看 Pull Request", "Inspect proposed code changes and reviews.", "查看代码变更和评审记录。"],
  ],
  notion: [
    ["Search workspace", "搜索工作区", "Find pages and databases in your workspace.", "查找工作区中的页面和数据库。"],
    ["Read pages", "读取页面", "Read documents and notes.", "读取文档与笔记内容。"],
    ["Organize databases", "整理数据库", "Work with database records and their properties.", "整理数据库记录及其属性。"],
  ],
  linear: [
    ["Find issues", "查找工作事项", "Find issues and review their current status.", "查找 Issue 并查看当前处理状态。"],
    ["Track projects", "跟进项目", "Review projects and development progress.", "查看项目与开发进度。"],
  ],
  figma: [
    ["Read design context", "读取设计上下文", "Inspect design files and component information for implementation.", "读取设计文件与组件信息，辅助界面实现。"],
    ["Inspect components", "查看设计组件", "Understand component structure and design details.", "了解组件结构与设计细节。"],
  ],
  "figma-desktop": [
    ["Read selected design", "读取当前设计选区", "Read design context from the open Figma desktop file.", "读取 Figma 桌面应用当前文件与选区的设计上下文。"],
    ["Inspect local components", "查看本地组件", "Inspect selected components for implementation; this mode does not write to the canvas.", "查看选中组件以辅助实现；本地模式不支持直接写入画布。"],
  ],
  supabase: [
    ["Inspect projects", "查看项目", "Find projects and inspect their database structure.", "查找项目并查看数据库结构。"],
    ["Query databases", "查询数据库", "Query project data to support development.", "查询项目数据，辅助应用开发。"],
  ],
  atlassian: [
    ["Find Jira work", "查找 Jira 工作事项", "Find issues and review project work.", "查找 Issue 与项目工作事项。"],
    ["Find Confluence pages", "查找 Confluence 文档", "Search and read team documentation.", "搜索和阅读团队文档。"],
  ],
  stripe: [
    ["Look up payments", "查询支付", "Review payment information for business operations.", "查看支付信息，辅助业务运营。"],
    ["Look up customers", "查询客户", "Find customer records.", "查找客户记录。"],
    ["Review subscriptions", "查看订阅", "Inspect subscription information.", "查看订阅信息。"],
  ],
  huggingface: [
    ["Search models", "搜索模型", "Find machine learning models.", "查找机器学习模型。"],
    ["Search datasets", "搜索数据集", "Find datasets for your task.", "查找适合当前任务的数据集。"],
    ["Search Spaces", "搜索 Spaces", "Discover hosted demos and applications.", "查找托管的演示与应用。"],
  ],
  composio: [
    ["Find connected apps", "查找已连接应用", "Discover the SaaS apps available to your account.", "了解账号已连接的 SaaS 应用。"],
    ["Use app actions", "使用应用操作", "Work across the apps you have authorized.", "在已授权的应用之间协作处理任务。"],
  ],
  cloudflare: [
    ["Inspect accounts", "查看账号资源", "Review available Cloudflare account resources.", "查看 Cloudflare 账号可用资源。"],
    ["Work with Workers", "管理 Workers", "Inspect and manage Workers and cloud services.", "查看和管理 Workers 与云服务。"],
  ],
  clickup: [
    ["Manage tasks", "管理任务", "Find and organize tasks and projects.", "查找和整理任务与项目。"],
    ["Work with documents", "处理文档", "Review project documentation.", "查看项目文档。"],
    ["Track time", "查看工时", "Work with time tracking records.", "处理工时记录。"],
  ],
  monday: [
    ["Work with boards", "处理项目看板", "Inspect project boards and their items.", "查看项目看板及其中的事项。"],
    ["Manage workflows", "管理业务流程", "Organize project and business work.", "整理项目与业务流程。"],
  ],
  todoist: [
    ["Manage tasks", "管理待办", "Find and organize personal and team tasks.", "查找和整理个人与团队待办。"],
    ["Organize projects", "整理项目", "Group work into projects.", "按项目组织工作。"],
  ],
  miro: [
    ["Inspect boards", "查看白板", "Read collaborative whiteboard content.", "读取协作白板内容。"],
    ["Work with diagrams", "处理流程图", "Work with diagrams and collaborative content.", "处理流程图与协作内容。"],
  ],
  airtable: [
    ["Query records", "查询记录", "Find records in your bases and tables.", "查找数据库与数据表中的记录。"],
    ["Update records", "更新记录", "Change business records in authorized bases.", "更新已授权数据库中的业务记录。"],
  ],
  webflow: [
    ["Manage sites", "管理网站", "Review website resources.", "查看网站资源。"],
    ["Work with CMS", "处理 CMS 内容", "Manage site content collections.", "管理网站内容集合。"],
    ["Design operations", "设计操作", "Work with the site's design tools.", "使用网站设计操作。"],
  ],
  granola: [
    ["Find meetings", "查找会议", "Search meeting notes and discussions.", "搜索会议笔记与讨论记录。"],
    ["Read summaries", "阅读会议摘要", "Review the recorded meeting summaries.", "查看已记录的会议摘要。"],
  ],
  attio: [
    ["Find contacts", "查找客户与联系人", "Look up customer and contact records.", "查询客户与联系人资料。"],
    ["Track follow-ups", "跟进销售事项", "Manage sales follow-ups.", "管理销售跟进事项。"],
  ],
  intercom: [
    ["Search conversations", "搜索客服对话", "Find relevant support conversations.", "查找相关客服对话。"],
    ["Find customers", "查询客户资料", "Look up customer records for support.", "查询客服所需的客户资料。"],
  ],
  neon: [
    ["Inspect projects", "查看数据库项目", "Review Postgres projects and databases.", "查看 Postgres 项目与数据库。"],
    ["Manage branches", "管理数据库分支", "Work with database branches.", "处理数据库分支。"],
    ["Run SQL", "执行 SQL", "Query a selected database.", "查询指定数据库。"],
  ],
  sentry: [
    ["Find errors", "查询错误", "Find errors and affected issues.", "查找错误与受影响的问题。"],
    ["Investigate issues", "分析问题", "Inspect error details to troubleshoot failures.", "查看错误详情并辅助排障。"],
  ],
  netlify: [
    ["Inspect projects", "查看网站项目", "Review sites, projects and team resources.", "查看网站、项目与团队资源。"],
    ["Manage deployments", "管理部署", "Work with site deployments.", "处理网站部署。"],
  ],
  posthog: [
    ["Analyze events", "分析产品事件", "Explore product events and user behavior.", "分析产品事件与用户行为。"],
    ["Review experiments", "查看实验", "Inspect product experiment information.", "查看产品实验信息。"],
  ],
  amplitude: [
    ["Analyze metrics", "分析产品指标", "Explore product analytics metrics.", "查看和分析产品指标。"],
    ["Explore behavior", "分析用户行为", "Review how people use your product.", "了解用户如何使用产品。"],
  ],
  plaid: [
    ["Diagnose connections", "诊断银行连接", "Inspect Plaid connection issues.", "查看 Plaid 银行连接问题。"],
    ["Review conversion", "查看连接转化", "Review Link conversion and product usage.", "查看 Link 转化率与产品用量。"],
  ],
  readwise: [
    ["Search highlights", "搜索阅读划线", "Find saved reading and highlights.", "查找阅读收藏与划线。"],
    ["Find Reader documents", "查找 Reader 文档", "Search documents saved in Reader.", "搜索保存在 Reader 中的文档。"],
  ],
  raindrop: [
    ["Find bookmarks", "查找书签", "Find pages you previously saved.", "找回曾经保存的网页。"],
    ["Organize collections", "整理收藏夹", "Organize bookmarks and collections.", "整理书签与收藏夹。"],
  ],
  pocket: [
    ["Find recordings", "查找录音", "Search Pocket recordings and transcripts.", "搜索 Pocket 录音与转录。"],
    ["Read meeting summaries", "阅读会议摘要", "Find summaries of recorded meetings.", "查找录制会议的摘要。"],
  ],
  "home-assistant": [
    ["Query devices", "查询设备", "Check devices exposed by your Home Assistant instance.", "查询自己的 Home Assistant 实例已公开的设备。"],
    ["Control devices", "控制设备", "Control the devices you have made available.", "控制已开放访问的设备。"],
  ],
  kiwi: [
    ["Search flights", "搜索航班", "Find flights and compare itineraries.", "查找航班并比较行程。"],
    ["Get booking links", "获取预订链接", "Open the provider's booking flow for a selected itinerary.", "获取所选行程的预订入口。"],
  ],
  fantastical: [
    ["Read calendars", "查看日历", "Inspect calendars in Fantastical on this Mac.", "查看本机 Fantastical 中的日历。"],
    ["Manage events", "管理日程", "Work with calendar events.", "处理日历日程。"],
  ],
  "day-one": [
    ["Search journal", "搜索日记", "Find and review entries in Day One on this Mac.", "查找和回顾本机 Day One 日记。"],
    ["Write entries", "记录日记", "Add entries to your journal.", "向日记中添加记录。"],
  ],
  amap: [
    ["Find places", "查找地点", "Search places and travel information.", "搜索地点与出行信息。"],
    ["Plan routes", "规划路线", "Compare routes for a journey.", "查询出行路线。"],
    ["Check weather", "查询天气", "Look up weather information.", "查询天气信息。"],
  ],
  strava: [
    ["Review activities", "查看运动记录", "Explore authorized activity data.", "查看已授权的运动数据。"],
    ["Explore training trends", "了解训练趋势", "Review training trends provided by the connector.", "查看连接器提供的训练趋势。"],
  ],
  calendly: [
    ["View bookings", "查看预约", "Review booked meetings.", "查看已预约的会议。"],
    ["Check availability", "查询空闲时间", "Look up available meeting times.", "查询可预约的会议时间。"],
  ],
  evernote: [
    ["Find notes", "查找笔记", "Search notes and notebooks.", "搜索笔记与笔记本。"],
    ["Organize notes", "整理笔记", "Organize saved notes in notebooks.", "按笔记本整理笔记。"],
  ],
  klaviyo: [
    ["View profiles", "查看客户资料", "Look up customer profiles.", "查询客户资料。"],
    ["Review campaigns", "查看营销活动", "Review campaigns and marketing analytics.", "查看营销活动与分析数据。"],
  ],
  withings: [
    ["View devices", "查看健康设备", "Find your Withings devices.", "查看自己的 Withings 设备。"],
    ["Read health records", "查询健康记录", "Read the health records authorized for this account.", "读取当前账号已授权的健康记录。"],
  ],
  healthex: [
    ["Read authorized records", "读取已授权记录", "Read your authorized health records.", "读取自己已授权的健康记录。"],
  ],
  replit: [
    ["Inspect apps", "查看应用", "Find and inspect Replit applications.", "查找和查看 Replit 应用。"],
    ["Create apps", "创建应用", "Create and manage applications.", "创建与管理应用。"],
  ],
  lovable: [
    ["Inspect projects", "查看项目", "Find and review Lovable projects.", "查找和查看 Lovable 项目。"],
    ["Create apps", "创建应用", "Create and manage projects and apps.", "创建和管理项目与应用。"],
  ],
  zapier: [
    ["Find app actions", "查找应用操作", "Discover actions available through your connected apps.", "了解已连接应用提供的操作。"],
    ["Run automations", "执行自动化动作", "Run the actions you have authorized.", "执行自己已授权的应用动作。"],
  ],
  gmail: [
    ["Search mail", "搜索邮件", "Find messages in your authorized mailbox.", "查找已授权邮箱中的邮件。"],
    ["Work with drafts", "处理邮件草稿", "Review and prepare mail drafts.", "查看和准备邮件草稿。"],
  ],
  "google-calendar": [
    ["Read calendars", "查看日历", "Read calendars and events.", "查看日历与事件。"],
    ["Check availability", "查询空闲时间", "Find available time for scheduling.", "查询可安排日程的时间。"],
  ],
  "google-contacts": [
    ["Find contacts", "查找联系人", "Look up contacts and directory entries.", "查询联系人与组织目录。"],
  ],
  "google-docs": [
    ["Read documents", "读取文档", "Read Google document content.", "读取 Google 文档内容。"],
    ["Edit documents", "编辑文档", "Update document content.", "修改文档内容。"],
  ],
  "google-drive": [
    ["Search files", "搜索云端文件", "Find files in Google Drive.", "查找 Google Drive 中的文件。"],
    ["Manage files", "管理文件", "Work with authorized cloud files.", "处理已授权的云端文件。"],
  ],
  "google-sheets": [
    ["Read spreadsheets", "读取电子表格", "Read spreadsheet data.", "读取电子表格数据。"],
    ["Edit spreadsheets", "编辑电子表格", "Update spreadsheet content.", "修改电子表格内容。"],
  ],
  "google-slides": [
    ["Read presentations", "读取演示文稿", "Read presentation content.", "读取演示文稿内容。"],
    ["Edit presentations", "编辑演示文稿", "Update slides in a presentation.", "修改演示文稿中的幻灯片。"],
  ],
  zoom: [
    ["Work with meetings", "处理会议", "Use authorized Zoom meeting and collaboration tools.", "使用已授权的 Zoom 会议与协作工具。"],
  ],
  asana: [
    ["Manage tasks", "管理任务", "Find and organize team tasks.", "查找和整理团队任务。"],
    ["Track projects", "跟进项目", "Review projects and team work.", "查看项目与团队工作。"],
  ],
  box: [
    ["Search files", "搜索文件", "Find Box files and content.", "查找 Box 文件与内容。"],
    ["Work with content", "处理文件内容", "Work with authorized Box content.", "处理已授权的 Box 内容。"],
  ],
  dropbox: [
    ["Search files", "搜索文件", "Find files in Dropbox.", "查找 Dropbox 文件。"],
    ["Manage files", "管理文件", "Work with authorized Dropbox files.", "处理已授权的 Dropbox 文件。"],
  ],
  canva: [
    ["Find designs", "查找设计", "Search your Canva designs.", "搜索 Canva 设计。"],
    ["Create designs", "创建设计", "Create new designs.", "创建新的设计。"],
    ["Edit designs", "编辑设计", "Update existing designs.", "修改已有设计。"],
  ],
  highlevel: [
    ["Manage contacts", "管理联系人", "Find and manage contact records.", "查找和管理联系人记录。"],
    ["Track opportunities", "跟进商机", "Work with opportunities and customer workflows.", "处理商机与客户流程。"],
  ],
  tessie: [
    ["Query vehicle data", "查询车辆数据", "Read authorized vehicle data.", "读取已授权的车辆数据。"],
    ["Control vehicle", "使用车辆控制", "Use the vehicle controls you have authorized.", "使用自己已授权的车辆控制工具。"],
  ],
  "google-places": [
    ["Find places", "搜索地点", "Search places and location information.", "搜索地点与位置信息。"],
    ["Plan routes", "规划路线", "Look up travel routes.", "查询出行路线。"],
    ["Check weather", "查询天气", "Look up weather information.", "查询天气信息。"],
  ],
  shopify: [
    ["Search products", "搜索商品", "Find and compare Shopify products.", "查找和比较 Shopify 商品。"],
    ["Build carts", "建立购物车", "Collect selected products in a cart.", "将选中的商品加入购物车。"],
  ],
  "shopify-ucp": [
    ["Work with checkout", "处理店铺结账", "Use the selected store's UCP checkout tools.", "使用指定店铺的 UCP 结账工具。"],
  ],
  tailscale: [
    ["Connect tailnet tools", "连接 tailnet 工具", "Use tools exposed through your tailnet and Aperture.", "使用自己的 tailnet 与 Aperture 提供的工具。"],
    ["Use SSH tools", "使用 SSH 工具", "Use authorized SSH operations.", "使用已授权的 SSH 操作。"],
  ],
  "link-by-stripe": [
    ["Use Link wallet", "使用 Link 钱包", "Work with your authorized Link wallet.", "使用自己已授权的 Link 钱包。"],
    ["Read financial data", "读取财务数据", "Read financial data you have authorized.", "读取自己已授权的财务数据。"],
  ],
  quickbooks: [
    ["Query company data", "查询公司账务", "Look up QuickBooks Online company accounting data.", "查询 QuickBooks Online 公司账务数据。"],
    ["Manage accounting data", "管理账务数据", "Work with authorized company accounting records.", "处理已授权的公司账务记录。"],
  ],
  "1password": [
    ["Manage environments", "管理开发环境", "Work with developer environments.", "处理开发环境。"],
    ["Mount environment variables", "挂载环境变量", "Manage authorized environment-variable mounts.", "管理已授权的环境变量挂载。"],
  ],
  "outlook-mail": [
    ["Enterprise mail tools", "企业邮件工具", "Available mail operations depend on the configured Microsoft MCP service.", "可用邮件操作取决于所配置的 Microsoft MCP 服务。"],
  ],
  "outlook-calendar": [
    ["Enterprise calendar tools", "企业日历工具", "Available calendar operations depend on the configured Microsoft MCP service.", "可用日历操作取决于所配置的 Microsoft MCP 服务。"],
  ],
  vercel: [
    ["Inspect projects", "查看项目", "Review projects exposed by the deployment service.", "查看部署服务提供的项目。"],
    ["Work with deployments", "处理部署", "Use the deployment tools available to your account.", "使用当前账号可用的部署工具。"],
  ],
  "shop-pay": [
    ["Shop sign-in", "连接 Shop 账号", "Connect a personal Shop account.", "连接个人 Shop 账号。"],
    ["Shop Pay checkout", "使用 Shop Pay 结账", "Use supported Shop Pay checkout flows.", "使用受支持的 Shop Pay 结账流程。"],
  ],
  runway: [
    ["Generate images", "生成图像", "Create images from a creative request.", "根据创作要求生成图像。"],
    ["Generate video", "生成视频", "Create video and save results to your Runway library.", "生成视频并将结果保存到 Runway 素材库。"],
  ],
  higgsfield: [
    ["Create visual media", "生成和编辑图像视频", "Generate and edit images and video.", "生成和编辑图像与视频。"],
    ["Create audio", "生成音频", "Generate audio for creative work.", "为创作生成音频。"],
    ["Organize assets", "整理创作素材", "Organize creative assets.", "整理创作素材。"],
  ],
  hyperframes: [
    ["Create and revise scenes", "制作和修改动画", "Create or revise animated compositions from a prompt.", "根据文字描述制作动画或修改已有作品。"],
    ["Render video", "渲染视频", "Render a composition in the cloud as MP4, WebM, or MOV.", "在云端将作品渲染为 MP4、WebM 或 MOV。"],
  ],
  "black-forest-labs": [
    ["Create images", "生成和编辑图像", "Generate and edit images with FLUX.", "通过 FLUX 生成和编辑图像。"],
    ["Create video", "生成视频", "Use the video capabilities described by the service.", "使用服务提供的视频能力。"],
    ["Browse history", "查看历史作品", "Find previous creative results.", "查找以往的创作结果。"],
  ],
  "fal-ai": [
    ["Find models", "查找生成模型", "Review available models and pricing.", "查看可用模型与价格。"],
    ["Generate media", "生成媒体", "Generate images, video and audio.", "生成图像、视频与音频。"],
    ["Get job results", "查询任务结果", "Check and retrieve generation results.", "查询并获取生成任务结果。"],
  ],
  "blender-lab": [
    ["Inspect scenes", "分析场景", "Read Blender scene information.", "读取 Blender 场景信息。"],
    ["Edit objects", "编辑对象", "Work with objects in the open Blender scene.", "操作当前 Blender 场景中的对象。"],
    ["Use Blender Python", "使用 Blender Python API", "Use Blender's Python API for scene operations.", "通过 Blender Python API 操作场景。"],
  ],
  mijia: [
    ["Query Xiaomi devices", "查询米家设备", "Read exposed devices through the official Home Assistant integration.", "通过官方 Home Assistant 集成查询已公开的米家设备。"],
    ["Control Xiaomi devices", "控制米家设备", "Use controls exposed by your own Home Assistant instance.", "使用自己的 Home Assistant 实例已公开的设备控制。"],
  ],
  didi: [
    ["Find ride options", "查询出行方案", "Explore ride options and estimated fares.", "查询出行方案与预估费用。"],
    ["Request a ride", "发起打车", "Request a ride after confirmation.", "确认后发起打车。"],
  ],
  uber: [
    ["Compare rides", "比较车型与车费", "Compare ride options, fares and pickup times in the US.", "比较美国境内的车型、车费与接驾时间。"],
    ["Get booking handoff", "获取叫车入口", "Complete the booking in the Uber app.", "在 Uber App 中完成叫车。"],
  ],
  "uber-eats": [
    ["Search restaurants", "搜索餐厅", "Find restaurants, menus and dishes in the US.", "查找美国境内的餐厅、菜单与菜品。"],
    ["Get order handoff", "获取点餐入口", "Complete ordering and payment in the Uber Eats app.", "在 Uber Eats App 中完成下单与付款。"],
  ],
  luckin: [
    ["Find stores", "查找门店", "Find nearby stores and browse drinks.", "查找门店并浏览饮品。"],
    ["Review offers", "查看优惠", "Review available offers before ordering.", "下单前查看可用优惠。"],
    ["Place orders", "确认后下单", "Place the selected order after confirmation.", "确认后提交选定的订单。"],
  ],
  mcdonalds: [
    ["Find promotions", "查询活动与优惠券", "Review promotions and available coupons.", "查看活动与可用优惠券。"],
    ["Find stores and menus", "查询门店与餐品", "Look up stores and menu information.", "查询门店与餐品信息。"],
  ],
  "chrome-devtools": [
    ["Inspect requests", "查看网络请求", "Inspect browser network requests.", "查看浏览器网络请求。"],
    ["Read console output", "读取控制台", "Review console output for website debugging.", "查看控制台输出，辅助网站调试。"],
    ["Analyze performance", "分析页面性能", "Inspect page performance.", "检查页面性能。"],
  ],
  context7: [
    ["Find libraries", "查找开发库", "Find the relevant library or framework documentation.", "查找相关开发库与框架文档。"],
    ["Read docs and examples", "查询文档与示例", "Look up current documentation and code examples.", "查询最新文档与代码示例。"],
  ],
  storybook: [
    ["Read components", "读取组件", "Inspect the project's components and documentation.", "查看项目组件与文档。"],
    ["Write stories and tests", "辅助编写 Stories 和测试", "Use component context when writing stories and tests.", "根据组件上下文辅助编写 Stories 与测试。"],
  ],
  filesystem: [
    ["Read files", "读取文件", "Read files inside a directory you choose.", "读取你指定目录中的文件。"],
    ["Search files", "搜索文件", "Find files in the allowed directory.", "在允许的目录中查找文件。"],
    ["Edit files", "编辑文件", "Update files within the allowed directory.", "修改允许目录内的文件。"],
  ],
  fetch: [
    ["Fetch pages", "抓取网页", "Fetch a public page and extract readable content.", "抓取公开网页并提取适合阅读的内容。"],
  ],
  time: [
    ["Look up time", "查询当前时间", "Get the current time in a time zone.", "查询指定时区的当前时间。"],
    ["Convert time zones", "换算时区", "Convert dates and times between time zones.", "在不同时区之间换算日期与时间。"],
  ],
  n8n: [
    ["Find nodes", "查询节点", "Find node documentation for a workflow.", "查找工作流所需的节点说明。"],
    ["Find templates", "查找模板", "Discover workflow templates.", "查找工作流模板。"],
    ["Validate workflows", "验证工作流", "Assist with building and validating workflows.", "辅助构建与验证工作流。"],
  ],
  "baidu-maps": [
    ["place", "place", "Find places from a natural-language request.", "按自然语言需求查找地点。"],
    ["direction", "direction", "Plan a trip and resolve ambiguous places.", "规划出行路线，并澄清同名地点。"],
    ["geocoding", "geocoding", "Resolve an address to coordinates.", "将地址解析为坐标。"],
    ["reverse_geocoding", "reverse_geocoding", "Look up an address from coordinates.", "根据坐标查询地址。"],
    ["weather", "weather", "Read weather and forecasts.", "查询天气与预报。"],
    ["map_render", "map_render", "View query results on a map.", "在地图上查看查询结果。"],
  ],
  variflight: [
    ["Check flight status", "查询航班动态", "Look up flight status and airport weather.", "查询航班动态与机场天气。"],
    ["Find fares and connections", "查询机票与中转", "Look up fares and transfer information.", "查询机票与中转信息。"],
  ],
  stockmap: [
    ["Research stocks", "研究美股走势", "Review two-week US stock research.", "查看美股两周走势研究。"],
    ["Compare markets", "比较个股与板块", "Compare stocks and sectors.", "比较个股与板块。"],
    ["Explore crypto analysis", "查看加密市场分析", "Read crypto market analysis.", "查看加密市场分析。"],
  ],
  eastmoney: [
    ["Query market data", "查询证券行情", "Look up securities market data.", "查询证券行情数据。"],
    ["Read financial statements", "查询财务数据", "Review company financial statements.", "查询公司财务数据。"],
    ["Find financial news", "查找金融资讯", "Find relevant financial news.", "查找相关金融资讯。"],
  ],
  ifind: [
    ["Query stocks and funds", "查询股票与基金", "Look up professional stock and fund data.", "查询专业股票与基金数据。"],
    ["Read macro data", "查询宏观数据", "Query macroeconomic data and announcements.", "查询宏观数据与公告。"],
  ],
  wind: [
    ["Query financial data", "查询金融数据", "Use the Wind data services authorized for your account.", "使用当前账号已授权的 Wind 数据服务。"],
    ["Analyze market data", "分析市场数据", "Use available financial analysis tools.", "使用可用的金融分析工具。"],
  ],
  "rollinggo-hotel": [
    ["hotel_tags", "hotel_tags", "Read available hotel filter tags.", "读取可用的酒店筛选标签。"],
    ["search_hotels", "search_hotels", "Find hotels using dates, tags, brands and budget.", "按日期、标签、品牌与预算查找酒店。"],
    ["hotel_detail", "hotel_detail", "Read live room rates and cancellation policies.", "查看实时房型价格与退改政策。"],
    ["price_confirm", "price_confirm", "Lock the selected room price after confirmation.", "确认后锁定选中房型的价格。"],
    ["book", "book", "Confirm an unpaid order and get the official payment link.", "确认创建待支付订单并取得官方支付链接。"],
    ["orders", "orders", "Read hotel orders and their current status.", "查询酒店订单及当前状态。"],
    ["order_detail", "order_detail", "Read one order's booking and payment details.", "读取单笔订单的预订与支付详情。"],
    ["pre_cancel", "pre_cancel", "Review cancellation eligibility and penalties.", "查询退订资格与取消罚金。"],
    ["confirm_cancel", "confirm_cancel", "Cancel only after the user confirms the penalty.", "用户确认罚金后再取消对应订单。"],
  ],
  "lark-cli": [
    ["Work with messages", "处理消息", "Use authorized messaging operations.", "使用已授权的消息操作。"],
    ["Work with calendars", "处理日历", "Work with calendars and meetings.", "处理日历与会议。"],
    ["Work with documents", "处理文档与表格", "Work with documents, spreadsheets and bases.", "处理文档、电子表格与多维表格。"],
    ["Manage tasks", "管理任务", "Use task operations supported by the installed skills.", "使用已安装技能支持的任务操作。"],
  ],
  // Selected actual tool names from official-skill-runtime and its adapters.
  doordash: [
    ["search_stores", "search_stores", "Find restaurants for a delivery address.", "查找配送地址附近的餐厅。"],
    ["get_menu", "get_menu", "Read a restaurant's menu.", "读取餐厅菜单。"],
    ["add_cart_items", "add_cart_items", "Add selected dishes to a cart.", "将选中的菜品加入购物车。"],
    ["preview_order", "preview_order", "Review pricing, fees, tip and delivery details before ordering.", "下单前查看价格、费用、小费与配送详情。"],
    ["submit_order", "submit_order", "Submit the exact order after the user confirms it.", "用户确认后提交对应订单。"],
    ["order_status", "order_status", "Check the status of an order.", "查询订单状态。"],
  ],
  shop: [
    ["search_catalog", "search_catalog", "Search and compare products.", "搜索和比较商品。"],
    ["get_product", "get_product", "Read details of a selected product.", "查看选定商品的详细信息。"],
    ["create_cart", "create_cart", "Build a cart with selected products.", "为选中的商品建立购物车。"],
    ["create_checkout", "create_checkout", "Prepare checkout for the selected cart.", "为选定购物车准备结账。"],
    ["complete_checkout", "complete_checkout", "Complete supported checkout after explicit confirmation.", "明确确认后完成受支持的结账。"],
    ["search_orders", "search_orders", "Find orders for the connected Shop account.", "查询已连接 Shop 账号的订单。"],
  ],
  "quark-drive": [
    ["list_files", "list_files", "Browse files in an authorized directory.", "浏览已授权目录中的文件。"],
    ["search_files", "search_files", "Find files in Quark Drive.", "查找夸克网盘文件。"],
    ["upload_file", "upload_file", "Upload a local file explicitly selected by the user.", "上传用户明确选中的本地文件。"],
    ["download_file", "download_file", "Download a selected cloud file.", "下载选中的网盘文件。"],
    ["summarize_files", "summarize_files", "Summarize files using available account AI features.", "使用账号可用的 AI 能力总结文件。"],
    ["rename_files", "rename_files", "Rename selected files after confirmation.", "确认后重命名选中的文件。"],
  ],
  fliggy: [
    ["travel_search", "travel_search", "Search flights, hotels, attractions and travel products with official booking links.", "搜索机票、酒店、景点与旅行商品并获取官方预订入口。"],
  ],
  weread: [
    ["search_books", "search_books", "Search books in a selected scope.", "在指定范围内搜索书籍。"],
    ["bookshelf", "bookshelf", "Read your personal bookshelf.", "读取个人书架。"],
    ["book_info", "book_info", "Read metadata for a selected book.", "查看选定书籍的信息。"],
    ["book_notes", "book_notes", "Read a book's highlights.", "读取一本书的划线内容。"],
    ["reading_stats", "reading_stats", "Review weekly, monthly, annual or overall reading statistics.", "查看每周、每月、年度或总体阅读统计。"],
  ],
  "meituan-paotui": [
    ["search_address", "search_address", "Find a delivery address without placing an order.", "查询配送地址，不会提交订单。"],
    ["address_book", "address_book", "Read saved delivery addresses.", "读取已保存的配送地址。"],
    ["delivery_preview", "delivery_preview", "Preview delivery pricing and details.", "预览跑腿费用与详情。"],
    ["submit_order", "submit_order", "Submit the exact unexpired preview after confirmation.", "确认后提交对应且未过期的预览订单。"],
    ["order_status", "order_status", "Check delivery order status.", "查询跑腿订单状态。"],
  ],
  alipay: [
    ["submit_payment", "submit_payment", "Submit an Alipay cashier payment after explicit confirmation.", "明确确认后提交支付宝收银台付款。"],
    ["payment_status", "payment_status", "Check a payment initiated by this connection using its receipt; historical statements are not supported.", "通过收据查询本次连接发起的支付；不支持历史账单查询。"],
  ],
  ticketmaster: [
    ["ticketmaster_search_events", "ticketmaster_search_events", "Find concerts, sports and other public events.", "搜索演唱会、赛事与其他公开活动。"],
    ["ticketmaster_get_event_details", "ticketmaster_get_event_details", "Read event details, public price ranges and official links.", "查看活动详情、公开票价区间与官方链接。"],
    ["ticketmaster_search_attractions", "ticketmaster_search_attractions", "Find artists, bands and teams.", "搜索艺人、乐队与球队。"],
    ["ticketmaster_search_venues", "ticketmaster_search_venues", "Find venues.", "搜索场馆。"],
  ],
  flightaware: [
    ["flightaware_get_flight", "flightaware_get_flight", "Read flight status; AeroAPI queries may be metered.", "读取航班状态；AeroAPI 查询可能计费。"],
    ["flightaware_get_track", "flightaware_get_track", "Read flight track points with metered-query permission.", "在允许计费查询时读取航班轨迹点。"],
    ["flightaware_get_usage", "flightaware_get_usage", "Read account usage information.", "查看账号用量信息。"],
  ],
};

const exactNames = new Set([...official.map(value => value.id), "ticketmaster", "flightaware"]);
const guideUrls: Record<string, string> = {
  github: "https://github.com/github/github-mcp-server",
  notion: "https://developers.notion.com/docs/mcp",
  linear: "https://linear.app/docs/mcp",
  figma: "https://developers.figma.com/docs/figma-mcp-server/",
  "figma-desktop": "https://developers.figma.com/docs/figma-mcp-server/local-server-installation/",
  supabase: "https://supabase.com/docs/guides/getting-started/mcp",
  atlassian: "https://support.atlassian.com/atlassian-rovo-mcp-server/",
  stripe: "https://docs.stripe.com/mcp",
  huggingface: "https://huggingface.co/docs/hub/en/hf-mcp-server",
  composio: "https://github.com/ComposioHQ/composio",
  "lark-cli": "https://github.com/larksuite/cli",
};

export function getConnectorToolPreview(id: string, language = "en"): ConnectorToolPreview | undefined {
  if (!Object.hasOwn(previews, id)) return undefined;
  const chinese = language.startsWith("zh");
  const sourceUrl = [...official, ...presets].find(value => value.id === id)?.docsUrl || guideUrls[id];
  return {
    items: previews[id].map(([en, zh, purposeEn, purposeZh]) => ({ name: chinese ? zh : en, description: chinese ? purposeZh : purposeEn })),
    sourceUrl,
    kind: exactNames.has(id) ? "tools" : "operations",
  };
}
