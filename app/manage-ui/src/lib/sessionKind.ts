// 会话类型识别（单一事实源）——会话切换器按类型分 Tab 用。
//
// 输入是网关的 session key（`agent:<id>:<tail>`）及后端声明的类型。原先 ChatPage 里
// 的 `isHiddenSession` 把 cron/subagent/dream/heartbeat 从切换器里整片抹掉，
// R266 起改为「全部显示 + 按类型分流」：类型判定收敛到这里一处，ChatPage 与
// 沉浸模式共用，UI 侧不再各自写正则。
//
// 与 lib/notify.ts 的 `sessionTailKind` 分工：那个是「要不要弹桌面通知」的粗四
// 分类（chat/cron/channel/internal），口径由通知策略决定，不宜为了 UI 分组去改
// 它；这里是 UI 展示用的细分类，允许原生 UUID 会话显式声明 Cron 类型。

export type SessionKind =
  | "main" // agent 主会话
  | "web" // 控制台/网页发起（dashboard:<uuid> 或裸 uuid）
  | "channel" // Telegram / Discord / Slack 等外部渠道
  | "cron" // 定时任务
  | "subagent" // 子代理（含工作板卡片跑出来的 subagent:workboard-*）
  | "dream" // 做梦/反刍
  | "system" // 心跳、网关兜底、单次模型试跑等系统会话
  | "other"; // 未识别（保底，永远有个去处）

/** key 尾段（去掉 `agent:<id>:` 前缀）。空 key / 无前缀时退回整串。 */
export function sessionTail(key: string): string {
  const segs = String(key || "").split(":");
  return segs.slice(2).join(":") || segs[0] || "";
}

export function sessionKindOf(key: string, declaredKind?: string): SessionKind {
  if (declaredKind === "cron") return "cron";
  const tail = sessionTail(key);
  if (!tail || tail === "main") return "main";
  // 心跳记账会话（`main:heartbeat`，R153 的 phantom）——只匹配「段名恰为
  // heartbeat」，不误伤名叫 @heartbeat 的真实 TG 群会话。
  if (/(^|:)heartbeat$/i.test(tail)) return "system";
  if (/^cron/i.test(tail)) return "cron";
  if (/^sub-?agent/i.test(tail)) return "subagent";
  if (/^dream/i.test(tail)) return "dream";
  if (/^(telegram|discord|slack|whatsapp|signal|imessage)/i.test(tail)) return "channel";
  if (/^explicit:(gateway-fallback|model-run)/i.test(tail)) return "system";
  if (/^dashboard:/i.test(tail)) return "web";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(tail)) return "web";
  return "other";
}

/** 展示分类独立于后台会话判定，避免改菜单时改变未读和代表会话的选择。 */
export type SessionCategory = "app" | "task" | "inspiration" | "channel" | "subagent" | "dream" | "system" | "other";

export const SESSION_CATEGORY_ORDER: SessionCategory[] = [
  "app", "task", "inspiration", "channel", "subagent", "dream", "system", "other",
];

export interface SessionCategoryRow {
  key: string;
  kind?: string;
  source?: string;
  inspirationId?: string;
  title?: string;
  sub?: string;
}

export function sessionCategoryOf(row: SessionCategoryRow): SessionCategory {
  const tail = sessionTail(row.key);
  const sources = [row.kind, row.source].map((value) => value?.toLowerCase());
  if (row.inspirationId || sources.includes("inspiration")
    || /^(?:dashboard:)?inspiration(?:[:_-]|$)/i.test(tail)) return "inspiration";
  // 旧 Hermes 列表没有灵感关联字段，只兼容产品生成的固定开场，不按普通关键词猜。
  const inspirationPrompt = /^(?:这是用户当前委派的灵感任务[。.]|The user has captured the following idea and entrusted you with moving it forward\.)/;
  if ([row.title, row.sub].some((text) => inspirationPrompt.test(text?.trim() || ""))) return "inspiration";
  if (sources.some((source) => source && ["cron", "kanban", "workboard", "task"].includes(source))
    || /^(?:cron(?:[:_-]|$)|(?:work[:_-])?(?:kanban|workboard)(?:[:_-]|$)|sub-?agent:workboard-)/i.test(tail)
    || /^work kanban task t_[a-z0-9]+$/i.test(row.title?.trim() || "")) return "task";

  if (sources.some((source) => source && ["telegram", "discord", "slack", "whatsapp", "signal", "imessage"].includes(source))) return "channel";
  const kind = sessionKindOf(row.key, row.kind);
  if (kind === "main" || kind === "web") return "app";
  if (kind === "cron") return "task";
  if (kind !== "other") return kind;
  if (sources.some((source) => source && ["direct", "chat", "desktop", "dashboard", "web", "app", "acp", "cli"].includes(source))) return "app";
  return "other";
}

/**
 * 「后台会话」= 不该代表一个 agent 露面的那些。
 *
 * R266 之前这个判定叫 isHiddenSession，用途是把它们从切换器里删掉；现在切换器全量
 * 显示，它只剩两个用途，都不是「藏起来」：
 *  1. 挑 agent 行的代表会话 / 行时间（心跳 phantom 当代表 = 行反复浮顶、点开永远
 *     空白，Vincent 事故，R153）；
 *  2. 未读红点（后台 final 也会广播过来，点亮的红点点开全是旧消息，R245）。
 */
export function isBackgroundSession(key: string, declaredKind?: string): boolean {
  const kind = sessionKindOf(key, declaredKind);
  return kind === "cron" || kind === "subagent" || kind === "dream" || kind === "system";
}
