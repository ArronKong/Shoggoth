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

/** Tab 与分组的固定顺序：先人跑的，再自动跑的，系统兜底殿后。 */
export const SESSION_KIND_ORDER: SessionKind[] = [
  "main",
  "web",
  "channel",
  "cron",
  "subagent",
  "dream",
  "system",
  "other",
];

/** i18n key（`chat.sessionFilter.<kind>`）——调用方 t() 时拼，省得各处写死。 */
export function sessionKindI18nKey(kind: SessionKind): string {
  return `chat.sessionFilter.${kind}`;
}

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
