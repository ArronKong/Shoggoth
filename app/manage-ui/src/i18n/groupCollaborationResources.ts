// Group chat copy (send journal, recovery, activity) loads with its pages, preserving the initial bundle budget.
import i18next from './index';

type TranslationShape<T> = { [K in keyof T]: T[K] extends string ? string : TranslationShape<T[K]> };
const zhCN = {
  "groupChat": {
    "sendJournal": {
      "pending": "{{count}} 条发送记录待处理",
      "prepared": "发送已保存",
      "submitting": "发送中，等待回执",
      "accepted_awaiting_echo": "已受理，等待群消息确认",
      "observed": "原消息已确认",
      "rejected": "发送未受理",
      "needs_verification": "原发送待核对",
      "check": "核对原发送",
      "checkStorage": "重新核对存储",
      "retry": "按原 ID 重试",
      "new": "明确作为新请求发送",
      "restore": "恢复原输入",
      "saveDraft": "保留为新草稿",
      "recoveryOpen": "查看原输入",
      "recoveryTitle": "只读恢复原输入",
      "recoveryHint": "以下文本来自未核实的发送记录或草稿，仅供手动复制。点击文本框可全选。无法据此确认是否已发送；不会重试发送、修复或清空原日志。附件只显示名称，不授予读取权限。",
      "recoveryRefresh": "从头读取",
      "recoveryLoading": "读取原记录中…",
      "recoveryUnavailable": "无法安全读取原记录，可能已变化、格式不可解析或权限不足。原件保留，请先恢复存储或从备份检修。",
      "recoverySend": "原发送文本 · 未核实",
      "recoveryDraft": "原草稿文本 · 未核实",
      "recoveryText": "可选择并复制的原文本",
      "recoveryTruncated": "这条内容只显示前 32 KiB，完整性未知，原件保留。",
      "recoveryEmpty": "本页没有可安全读取的当前群文本。",
      "recoveryPartial": "部分记录损坏或达到安全读取上限，未读取的原记录保留。",
      "recoveryMore": "继续读取原记录",
      "newHint": "先核对原发送；作为新请求发送会创建一次新的群执行。",
      "otherOwner": "另有 {{count}} 条记录属于原服务，恢复原连接后核对。",
      "scopeUnavailable": "尚未确认群服务身份，原输入已保留。",
      "storageError": "发送日志暂不可写，原输入已保留（{{code}}）。",
      "detail": "核对状态：{{code}}",
      "archived": "群已归档，可以核对原发送；恢复群后才能重试。",
      "previous": "较新记录",
      "next": "较早记录"
    },
    "sync": {
      "recovering": "正在重新读取群状态…",
      "last": "上次读取：{{time}}",
      "check": "重新核对"
    },
    "activity": {
      "phase": {
        "preparing": "正在准备",
        "queued": "等待执行",
        "running": "执行中",
        "tool": "正在调用工具",
        "text": "正在生成正文",
        "compacting": "正在压缩上下文",
        "compacted": "上下文已压缩",
        "waiting_approval": "等待你的审批",
        "waiting_input": "等待你的补充",
        "stopping": "正在请求停止",
        "reconciling": "正在核对原执行",
        "completed": "执行已完成",
        "failed": "执行失败",
        "cancelled": "执行已停止"
      },
      "discussion": "讨论回合",
      "task": "任务 · {{objective}}",
      "lastProgress": "最近进展 {{time}}",
      "compactionDetails": "查看上下文压缩状态",
      "lastCompacting": "最后观察为正在压缩；执行现已结束",
      "detailUnavailable": "当前通道未提供更详细的活动",
      "details": "查看工具过程（{{count}}）",
      "lastRunning": "最后观察为执行中",
      "toolStatus": {
        "running": "执行中",
        "completed": "已完成",
        "failed": "失败"
      },
      "toolName": "工具：{{name}}",
      "input": "参数",
      "progress": "进度",
      "output": "输出",
      "error": "错误"
    }
  }
};
const en: TranslationShape<typeof zhCN> = {
  "groupChat": {
    "sendJournal": {
      "pending": "{{count}} sends need attention",
      "prepared": "Send saved",
      "submitting": "Sending; awaiting receipt",
      "accepted_awaiting_echo": "Accepted; awaiting group confirmation",
      "observed": "Original message confirmed",
      "rejected": "Send not accepted",
      "needs_verification": "Original send needs verification",
      "check": "Check original send",
      "checkStorage": "Check storage again",
      "retry": "Retry with original ID",
      "new": "Send explicitly as a new request",
      "restore": "Restore original input",
      "saveDraft": "Keep as a new draft",
      "recoveryOpen": "View original input",
      "recoveryTitle": "Read original input safely",
      "recoveryHint": "These unverified send and draft texts are for manual copying. Click a text box to select it. They do not prove whether a send was accepted. Recovery never retries sends, repairs or clears the journal. Attachment names grant no file access.",
      "recoveryRefresh": "Read from the start",
      "recoveryLoading": "Reading original records…",
      "recoveryUnavailable": "The original records cannot be read safely. They may have changed, be unparseable or be inaccessible. The original is retained. Restore storage or inspect a backup first.",
      "recoverySend": "Original send text · Unverified",
      "recoveryDraft": "Original draft text · Unverified",
      "recoveryText": "Original text available for selection and copying",
      "recoveryTruncated": "Only the first 32 KiB is shown. Completeness is unknown; the original is retained.",
      "recoveryEmpty": "No safely readable text for this group on this page.",
      "recoveryPartial": "Some records are damaged or exceed the safe read limit. Unread original records are retained.",
      "recoveryMore": "Read more original records",
      "newHint": "Check the original send first. Sending as a new request creates another group execution.",
      "otherOwner": "{{count}} records belong to the original service. Restore that connection to verify them.",
      "scopeUnavailable": "The group service identity is unconfirmed. Your input is preserved.",
      "storageError": "The send journal cannot be written. Your input is preserved ({{code}}).",
      "detail": "Verification status: {{code}}",
      "archived": "This group is archived. Verify the original send now; restore the group before retrying.",
      "previous": "Newer records",
      "next": "Older records"
    },
    "sync": {
      "recovering": "Reading group state again…",
      "last": "Last read: {{time}}",
      "check": "Check again"
    },
    "activity": {
      "phase": {
        "preparing": "Preparing",
        "queued": "Queued",
        "running": "Running",
        "tool": "Calling tools",
        "text": "Generating text",
        "compacting": "Compacting context",
        "compacted": "Context compacted",
        "waiting_approval": "Waiting for approval",
        "waiting_input": "Waiting for your input",
        "stopping": "Requesting stop",
        "reconciling": "Reconciling original execution",
        "completed": "Execution completed",
        "failed": "Execution failed",
        "cancelled": "Execution stopped"
      },
      "discussion": "Discussion turn",
      "task": "Task · {{objective}}",
      "lastProgress": "Last progress {{time}}",
      "compactionDetails": "View context compaction status",
      "lastCompacting": "Last observed compacting; execution has ended",
      "detailUnavailable": "This channel has no further activity detail",
      "details": "View tool process ({{count}})",
      "lastRunning": "Last observed running",
      "toolStatus": {
        "running": "Running",
        "completed": "Completed",
        "failed": "Failed"
      },
      "toolName": "Tool: {{name}}",
      "input": "Arguments",
      "progress": "Progress",
      "output": "Output",
      "error": "Error"
    }
  }
};

export const groupCollaborationResources = { 'zh-CN': zhCN, en };
for (const [language, resources] of Object.entries(groupCollaborationResources)) {
  i18next.addResourceBundle(language, 'translation', resources, true, false);
}
