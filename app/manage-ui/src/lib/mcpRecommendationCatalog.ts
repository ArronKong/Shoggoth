import type { McpServer } from "../api/mcpConnectors";

// Editorial order by broad familiarity and approximate adoption, not an audited user-count ranking.
// Keep the same order in both languages and across registry/remote/desktop entries.
export const mcpRecommendationOrder = [
  "gmail", "google-drive", "outlook-mail", "google-calendar", "google-docs", "google-sheets",
  "google-slides", "google-places", "amap", "outlook-calendar", "zoom", "canva", "github",
  "google-contacts", "lark-cli", "mijia", "didi", "uber", "luckin", "mcdonalds", "doordash", "uber-eats", "fliggy", "meituan-paotui", "weread", "alipay", "netease-music", "quark-drive", "dropbox", "notion", "figma", "blender-lab", "runway", "higgsfield",
  "ticketmaster", "flightaware", "black-forest-labs", "fal-ai", "shop", "shopify", "stripe", "evernote",
  "atlassian", "asana", "box", "strava", "quickbooks", "monday", "miro", "airtable", "calendly",
  "clickup", "todoist", "1password", "cloudflare", "zapier", "replit", "vercel", "supabase",
  "webflow", "linear", "home-assistant", "huggingface", "intercom", "klaviyo", "shop-pay",
  "shopify-ucp", "sentry", "netlify", "tailscale", "lovable", "plaid", "withings", "kiwi",
  "posthog", "amplitude", "neon", "highlevel", "granola", "readwise", "raindrop", "fantastical",
  "day-one", "attio", "link-by-stripe", "tessie", "pocket", "healthex", "composio",
  "chrome-devtools", "context7", "storybook", "filesystem", "fetch", "time", "n8n", "baidu-maps", "variflight", "stockmap", "eastmoney", "ifind", "wind", "12306", "rollinggo-hotel",
] as const;

export const mcpRegistryBrands: Record<string, string> = {
  "io.github.ComposioHQ/composio": "composio",
  "app.linear/linear": "linear",
  "com.notion/mcp": "notion",
  "com.figma.mcp/mcp": "figma",
  "com.canva.mcp/mcp": "canva",
  "com.supabase/mcp": "supabase",
  "com.atlassian/atlassian-mcp-server": "atlassian",
  "io.github.github/github-mcp-server": "github",
  "com.stripe/mcp": "stripe",
  "co.huggingface/hf-mcp-server": "huggingface",
  "com.monday/monday.com": "monday",
  "net.todoist/mcp": "todoist",
  "io.github.miroapp/mcp-server": "miro",
  "com.airtable/mcp": "airtable",
  "com.webflow/mcp": "webflow",
  "com.neon/mcp": "neon",
  "io.github.getsentry/sentry-mcp": "sentry",
  "com.amplitude/mcp-server": "amplitude",
  "io.stockmap/stockmap": "stockmap",
};

export function mcpBrandId(identity: string): string {
  return mcpRegistryBrands[identity] || identity;
}

// Recommendations for apps aimed primarily at Chinese-language users.
const chineseRecommendationIds = new Set([
  "12306", "alipay", "amap", "baidu-maps", "didi", "eastmoney", "fliggy", "ifind",
  "luckin", "mcdonalds", "meituan-paotui", "mijia", "netease-music",
  "quark-drive", "rollinggo-hotel", "variflight", "weread", "wind",
]);

export function mcpRecommendationVisibleInLocale(identity: string, language: string): boolean {
  return language.startsWith("zh") || !chineseRecommendationIds.has(mcpBrandId(identity));
}

// Curated product labels are presentation only; saved connector identities and
// transport/account settings continue to use their existing records.
const connectorNames: Record<string, string> = {
  didi: "滴滴打车", luckin: "瑞幸咖啡", figma: "Figma", notion: "Notion", canva: "Canva",
  mcdonalds: "麦当劳", kiwi: "Kiwi", amap: "高德地图", mijia: "米家", "baidu-maps": "百度地图",
  variflight: "飞常准", eastmoney: "东方财富", ifind: "同花顺", "rollinggo-hotel": "RollingGo 酒店", monday: "Monday",
};

// Older custom records may lack a catalog ID. Normalize only their exact legacy
// labels; this does not assign an icon, transport identity or account authority.
const legacyConnectorNames: Record<string, string> = {
  "滴滴打车 / DiDi": "滴滴打车", "瑞幸咖啡 / Luckin Coffee": "瑞幸咖啡",
  "Figma MCP Server（本地）": "Figma", "Figma MCP Server (Local)": "Figma", "Figma MCP Server(本地)": "Figma", "Figma MCP Server (本地)": "Figma", "Figma MCP Server": "Figma",
  "com.notion/mcp": "Notion", "Canva MCP": "Canva", "麦当劳 / McDonald’s": "麦当劳", "Kiwi.com": "Kiwi",
  "高德地图 / Amap": "高德地图", "米家 / Xiaomi Home": "米家", "百度地图 / Baidu Maps": "百度地图",
  "飞常准 / VariFlight": "飞常准", "东方财富妙想 / Eastmoney": "东方财富", "同花顺 iFinD": "同花顺",
  "RollingGo 酒店 / RollingGo Hotels": "RollingGo 酒店", "monday.com": "Monday",
};

export function mcpConnectorName(identity: string | undefined, fallback: string): string {
  const brand = identity ? mcpBrandId(identity) : undefined;
  if (brand && Object.hasOwn(connectorNames, brand)) return connectorNames[brand];
  return Object.hasOwn(legacyConnectorNames, fallback) ? legacyConnectorNames[fallback] : fallback;
}

// Display names for known publishers. A preset's name is used only when it is
// the provider's brand; user-supplied connector names are never publishers.
const connectorDevelopers: Record<string, string> = {
  "day-one": "Bloom Built Inc", fantastical: "Flexibits", "home-assistant": "Open Home Foundation",
  gmail: "Google", "google-calendar": "Google", "google-contacts": "Google", "google-docs": "Google",
  "google-drive": "Google", "google-places": "Google", "google-sheets": "Google", "google-slides": "Google",
  "outlook-calendar": "Microsoft", "outlook-mail": "Microsoft", "link-by-stripe": "Stripe",
  shop: "Shopify", shopify: "Shopify", "shop-pay": "Shopify", "shopify-ucp": "Shopify",
  "uber-eats": "Uber", quickbooks: "Intuit", "blender-lab": "Blender Foundation", "chrome-devtools": "Google",
  context7: "Upstash", filesystem: "Model Context Protocol", fetch: "Model Context Protocol", time: "Model Context Protocol",
  "12306": "Joooook", n8n: "Romuald Czlonkowski", flightaware: "Shoggoth", ticketmaster: "Shoggoth",
  amap: "高德", "baidu-maps": "百度", didi: "滴滴出行", luckin: "瑞幸咖啡", mcdonalds: "麦当劳",
  mijia: "小米", "meituan-paotui": "美团", "netease-music": "网易", weread: "腾讯", "quark-drive": "夸克",
  "rollinggo-hotel": "RollingGo", wind: "万得", variflight: "飞常准", eastmoney: "东方财富", ifind: "同花顺",
  airtable: "Airtable", amplitude: "Amplitude", canva: "Canva", miro: "Miro", monday: "monday.com",
  neon: "Neon", sentry: "Sentry", todoist: "Doist", webflow: "Webflow",
};

export function mcpConnectorDeveloper(identity: string | undefined, catalogName?: string): string | undefined {
  const brand = identity && mcpBrandId(identity);
  return brand && Object.hasOwn(connectorDevelopers, brand) ? connectorDevelopers[brand]
    : catalogName || (identity ? mcpRegistrySummary(identity)?.name : undefined);
}

// App-created registrations retain a display identity even when the separate
// ownership status is loading or unavailable. This never grants install/account
// authority; those operations still require the official controller's record.
export function mcpOfficialSkillBrand(server?: McpServer): string | undefined {
  if (server?.source.kind !== "custom" || server.transport.kind !== "stdio-command") return undefined;
  return /^official-(alipay|baidu-maps|doordash|fliggy|meituan-paotui|netease-music|quark-drive|rollinggo-hotel|shop|weread)-[a-f0-9]{8}$/u.exec(server.id)?.[1];
}

export function mcpRecommendationRank(identity: string): number {
  const rank = mcpRecommendationOrder.indexOf(mcpBrandId(identity) as typeof mcpRecommendationOrder[number]);
  return rank < 0 ? mcpRecommendationOrder.length : rank;
}

// Registry metadata is often English-only. Curated summaries must follow the app language.
const registrySummaries: Record<string, { name: string; iconId?: string; description: { "zh-CN": string; en: string } }> = {
  composio: { name: "Composio", description: { "zh-CN": "连接常用 SaaS 工具，让助理在已授权的应用之间协作。", en: "Connect everyday SaaS tools so agents can work across your authorized apps." } },
  linear: { name: "Linear", description: { "zh-CN": "跟进团队的 Issue、项目与开发进度。", en: "Track team issues, projects, and development progress." } },
  notion: { name: "Notion", description: { "zh-CN": "查找和整理笔记、文档与数据库，让团队知识随时可用。", en: "Find and organize notes, documents, and databases to put team knowledge to work." } },
  figma: { name: "Figma", description: { "zh-CN": "读取设计文件与组件，为界面实现提供设计上下文。", en: "Read design files and components to bring design context into implementation." } },
  supabase: { name: "Supabase", description: { "zh-CN": "连接项目、查询数据库，协助处理应用开发任务。", en: "Connect projects, query databases, and work on app development tasks." } },
  atlassian: { name: "Atlassian", description: { "zh-CN": "连接 Jira 与 Confluence，查找工作事项和团队文档。", en: "Connect Jira and Confluence to find work items and team documentation." } },
  github: { name: "GitHub", description: { "zh-CN": "查看代码仓库、Issue 和 Pull Request，协作处理开发工作。", en: "Explore repositories, issues, and pull requests to collaborate on development." } },
  stripe: { name: "Stripe", description: { "zh-CN": "查询支付、客户与订阅数据，协助处理业务运营。", en: "Look up payments, customers, and subscriptions to support business operations." } },
  huggingface: { name: "Hugging Face", description: { "zh-CN": "搜索模型、数据集与 Spaces，查找可用的机器学习资源。", en: "Search models, datasets, and Spaces to discover machine learning resources." } },
  "io.github.variflight/variflight-mcp": {
    name: "飞常准", iconId: "variflight",
    description: { "zh-CN": "查询航班、天气、出行舒适度和机票价格。", en: "Look up flights, weather, travel comfort, and fares." },
  },
};

export function mcpRegistrySummary(registryName: string) {
  const key = Object.hasOwn(registrySummaries, registryName) ? registryName : mcpBrandId(registryName);
  return Object.hasOwn(registrySummaries, key) ? registrySummaries[key] : undefined;
}
