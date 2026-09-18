"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  PRODUCT_CAPABILITIES,
  PRODUCT_DOMAIN_NOTES,
  productToolAnnotations,
  productToolDescription,
  publicProductCapabilities,
} = require("./product-capability-manifest");
const { PermissionEngine } = require("./permission-engine");
const { ToolRegistry } = require("./tool-registry");
const { INSPIRATION_MCP_TOOL_DEFINITIONS, INSPIRATION_MCP_WRITE_TOOLS,
  inspirationMcpMethod, inspirationMcpParams, inspirationMcpResult,
  validateInspirationMcpArguments } = require("./inspiration-mcp-tools");

// MCP helper 进程只需要工具 schema 与参数校验，不能因为共享常量而加载
// Native Store / ProductStore。这里固定的值就是对外 MCP 协议上限；领域
// Controller 仍在 Service 侧做第二次权威校验。
const CARD_STATUSES = new Set([
  "backlog", "queued", "running", "waiting", "done", "failed", "canceled",
]);
const MAX_CONTENT_PREVIEW_BYTES = 512;
const MAX_CONTENT_READ_BYTES = 32 * 1024;
const MAX_CURSOR_BYTES = 512;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PAGE_LIMIT = 100;
const MAX_TEXT_BYTES = 1024 * 1024;

const INTERNAL_MCP_PRODUCT_TOOL_NAMES = Object.freeze(PRODUCT_CAPABILITIES.map(({ tool }) => tool));
const MCP_PRODUCT_TOOL_NAMES = Object.freeze(PRODUCT_CAPABILITIES
  .filter(({ modelVisible }) => modelVisible !== false)
  .map(({ tool }) => tool));

const MCP_PRODUCT_TOOL_NAME_SET = new Set(INTERNAL_MCP_PRODUCT_TOOL_NAMES);
const DURABLE_WRITE_TOOL_NAMES = new Set([
  ...INSPIRATION_MCP_WRITE_TOOLS,
  "kanban_update_progress", "kanban_add_comment", "kanban_request_complete",
  "kanban_board_create", "kanban_board_update", "kanban_card_create",
  "kanban_card_update", "kanban_card_move", "kanban_run_dispatch", "kanban_run_retry",
  "cron_create", "cron_update", "cron_set_enabled", "cron_delete",
  "cron_run_now", "cron_run_retry", "run_add_note", "artifact_publish",
  "system_application_launch", "system_open_url", "finder_open_folder",
  "external_agent_create", "external_agent_update", "external_agent_delete",
  "external_agent_file_write", "external_agent_run",
  "federation_agent_run", "federation_agent_message", "federation_task_cancel",
]);
const ACTIVE_RUN_STATUSES = new Set(["starting", "running", "waiting_approval", "waiting_input"]);
const WORK_RUN_STATUSES = new Set([
  "queued", "starting", "running", "waiting_approval", "waiting_input",
  "completed", "failed", "canceled", "interrupted", "skipped",
]);
const EXTERNAL_BACKENDS = new Set(["openclaw", "hermes"]);
const USAGE_RANGES = new Set(["today", "7d", "30d", "90d", "1y", "all"]);
const MISFIRE_POLICIES = new Set(["skip", "latest", "all-bounded"]);
const OVERLAP_POLICIES = new Set(["skip", "queue"]);
const THREAD_POLICIES = new Set(["new", "continue"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const MIME_PATTERN = /^[\x21-\x7e]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_RUN_NOTE_BYTES = 4096;
const MAX_COMMENT_BYTES = 64 * 1024;
const MAX_NOTIFICATION_TITLE_BYTES = 128;
const MAX_NOTIFICATION_BODY_BYTES = 1024;
const MAX_AGENT_FILE_BYTES = 32 * 1024;
const MAX_DELEGATE_PROMPT_BYTES = 16 * 1024;
const MAX_FEDERATION_HANDLE_BYTES = 2048;
const FEDERATION_BACKEND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_NOTIFICATION_RUN_PER_MINUTE = 3;
const MAX_NOTIFICATION_PROFILE_PER_HOUR = 20;
const MAX_SAFE_JSON_NODES = 16_384;
const MAX_SAFE_JSON_DEPTH = 32;
const MAX_RESPONSE_ID_RESERVATION = "\0".repeat(256);
const COMPUTER_TOOL_NAMES = new Set([
  "computer_status", "computer_session_open", "computer_session_resume", "computer_session_close",
  "computer_application_list", "computer_application_focus", "computer_window_list",
  "computer_window_focus", "computer_snapshot", "computer_click", "computer_double_click",
  "computer_drag", "computer_scroll", "computer_type", "computer_key",
]);
const COMPUTER_SAFE_KEYS = new Set([
  "return", "tab", "escape", "backspace", "delete", "up", "down", "left", "right",
  "home", "end", "pageup", "pagedown", "space", "f1", "f2", "f3", "f4", "f5",
  "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
const COMPUTER_MODIFIERS = new Set(["cmd", "shift", "option", "alt", "ctrl", "fn"]);
const PUBLIC_MESSAGES = Object.freeze({
  MCP_TOOL_INVALID_ARGUMENTS: "工具参数无效",
  MCP_TOOL_NOT_FOUND: "请求的资源不存在",
  MCP_TOOL_STATE_CONFLICT: "当前状态不允许该工具操作",
  MCP_TOOL_CAPACITY: "工具持久化容量已满",
  MCP_TOOL_SECRET_REJECTED: "工具输入包含敏感信息",
  MCP_TOOL_PATH_INVALID: "Artifact 路径无效",
  MCP_TOOL_ARTIFACT_TOO_LARGE: "Artifact 超过容量上限",
  MCP_TOOL_RATE_LIMITED: "通知发送过于频繁",
  NOTIFICATION_FAILED: "系统通知发送失败",
  MCP_TOOL_COMMIT_UNCERTAIN: "工具提交结果不确定，必须重启 Service",
  MCP_TOOL_RESPONSE_INVALID: "工具响应无效",
  MCP_TOOL_RESPONSE_TOO_LARGE: "工具响应超过协议上限",
  MCP_TOOL_UNAVAILABLE: "MCP 产品工具暂时不可用",
  MCP_TOOL_FORBIDDEN: "当前 Profile 或 Run 无权调用该工具",
  MCP_TOOL_CONFIRMATION_REQUIRED: "该工具需要本次用户确认",
  APP_HOST_UNAVAILABLE: "Shoggoth App 进程未运行，连接状态查询和跨 Agent 派发暂不可用",
  BACKEND_UNAVAILABLE: "目标后端未连接或已禁用",
});

const PUBLIC_CODES = new Set(Object.keys(PUBLIC_MESSAGES));

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const nullableString = (maxLength) => ({
  anyOf: [{ type: "string", maxLength }, { type: "null" }],
});

const interactiveWorkSourceSchema = () => ({
  source: { type: "string", enum: ["chat", "kanban", "cron", "inspiration"] },
  sourceId: { type: "string", maxLength: 512 },
});

const BASE_MCP_PRODUCT_TOOL_DEFINITIONS = [
  {
    name: "profile_get",
    description: "Read the current authorized Shoggoth Agent Profile.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "skill_catalog",
    description: "List enabled and currently eligible native Skills for this Agent Profile.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["cursor", "limit"],
      additionalProperties: false,
    },
  },
  {
    name: "skill_read",
    description: "Read one bounded UTF-8 chunk of an enabled Skill at a frozen content hash.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
        contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        cursor: { type: "integer", minimum: 0 },
        maxBytes: { type: "integer", minimum: 1, maximum: MAX_CONTENT_READ_BYTES },
      },
      required: ["name", "contentHash", "cursor", "maxBytes"],
      additionalProperties: false,
    },
  },
  {
    name: "system_application_search",
    description: "Search trusted macOS application roots.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 512 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "system_application_launch",
    description: "Launch one validated macOS application.",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$" },
        applicationPath: { type: "string", maxLength: 4096 },
      },
      oneOf: [
        { type: "object", required: ["bundleId"] },
        { type: "object", required: ["applicationPath"] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "system_open_url",
    description: "Open one validated web URL with the macOS default handler.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", maxLength: 4096 } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "finder_open_folder",
    description: "Open one validated folder in Finder and optionally select a direct child.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", maxLength: 4096 },
        select: nullableString(1024),
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_status",
    description: "Read Computer Use availability and macOS permission state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "computer_session_open",
    description: "Open a short-lived Computer Use session scoped to exact bundle IDs.",
    inputSchema: {
      type: "object",
      properties: {
        ...interactiveWorkSourceSchema(),
        allowedApplications: {
          type: "array", minItems: 1, maxItems: 8, uniqueItems: true,
          items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$" },
        },
        expiresInSeconds: { type: "integer", minimum: 60, maximum: 900 },
      },
      required: ["source", "sourceId", "allowedApplications", "expiresInSeconds"],
      additionalProperties: false,
    },
  },
  ...[
    ["computer_session_resume", {}],
    ["computer_session_close", {}],
    ["computer_application_list", {}],
    ["computer_application_focus", {
      bundleId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$" },
      pid: { type: "integer", minimum: 1 },
    }],
    ["computer_window_list", { onScreenOnly: { type: "boolean" } }],
    ["computer_window_focus", {
      bundleId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$" },
      pid: { type: "integer", minimum: 1 },
      windowId: { type: "integer", minimum: 0 },
    }],
    ["computer_snapshot", {
      pid: { type: "integer", minimum: 1 },
      windowId: { type: "integer", minimum: 0 },
    }],
  ].map(([name, extra]) => ({
    name,
    description: `Operate the current WorkRun's Computer Use session: ${name}.`,
    inputSchema: {
      type: "object",
      properties: {
        ...interactiveWorkSourceSchema(),
        sessionId: { type: "string", maxLength: 128 },
        ...extra,
      },
      required: ["source", "sourceId", "sessionId", ...Object.keys(extra)],
      additionalProperties: false,
    },
  })),
  ...[
    ["computer_click", {
      ref: nullableString(128), x: { anyOf: [{ type: "number", minimum: 0, maximum: 20000 }, { type: "null" }] },
      y: { anyOf: [{ type: "number", minimum: 0, maximum: 20000 }, { type: "null" }] },
    }],
    ["computer_double_click", {
      ref: nullableString(128), x: { anyOf: [{ type: "number", minimum: 0, maximum: 20000 }, { type: "null" }] },
      y: { anyOf: [{ type: "number", minimum: 0, maximum: 20000 }, { type: "null" }] },
    }],
    ["computer_drag", {
      fromX: { type: "number", minimum: 0, maximum: 20000 },
      fromY: { type: "number", minimum: 0, maximum: 20000 },
      toX: { type: "number", minimum: 0, maximum: 20000 },
      toY: { type: "number", minimum: 0, maximum: 20000 },
      durationMs: { type: "integer", minimum: 0, maximum: 10000 },
    }],
    ["computer_scroll", {
      ref: nullableString(128), direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "integer", minimum: 1, maximum: 50 },
      by: { type: "string", enum: ["line", "page"] },
    }],
    ["computer_type", { ref: { type: "string", maxLength: 128 }, text: { type: "string", maxLength: 16384 } }],
    ["computer_key", {
      ref: nullableString(128), key: { type: "string", maxLength: 16 },
      modifiers: { type: "array", maxItems: 4, uniqueItems: true, items: { type: "string", enum: ["cmd", "shift", "option", "alt", "ctrl", "fn"] } },
    }],
  ].map(([name, extra]) => ({
    name,
    description: `Perform one revision-bound Computer Use action: ${name}.`,
    inputSchema: {
      type: "object",
      properties: {
        ...interactiveWorkSourceSchema(),
        sessionId: { type: "string", maxLength: 128 },
        snapshotRevision: { type: "string", maxLength: 128 },
        pid: { type: "integer", minimum: 1 },
        windowId: { type: "integer", minimum: 0 },
        ...extra,
      },
      required: ["source", "sourceId", "sessionId", "snapshotRevision", "pid", "windowId", ...Object.keys(extra)],
      additionalProperties: false,
    },
  })),
  {
    name: "runtime_context_get",
    description: "Read the current authorized WorkRun's frozen effective model.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", maxLength: 256 },
        source: { type: "string", enum: ["chat", "kanban", "cron", "inspiration"] },
        sourceId: { type: "string", maxLength: 512 },
      },
      oneOf: [
        { type: "object", required: ["runId"] },
        { type: "object", required: ["source", "sourceId"] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "request_user_input",
    description: "Pause the current run and ask the user one to three bounded questions.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array", minItems: 1, maxItems: 3,
          items: {
            type: "object",
            properties: {
              header: { type: "string", maxLength: 64 },
              id: { type: "string", maxLength: 64 },
              question: { type: "string", maxLength: 1024 },
              options: {
                type: "array", minItems: 2, maxItems: 3,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", maxLength: 128 },
                    description: { type: "string", maxLength: 512 },
                  },
                  required: ["label", "description"],
                  additionalProperties: false,
                },
              },
            },
            required: ["header", "id", "question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    name: "kanban_list",
    description: "List authorized Kanban boards or cards with bounded cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["boards", "cards"] },
        boardId: nullableString(36),
        status: { anyOf: [{ type: "string", enum: [...CARD_STATUSES] }, { type: "null" }] },
        cursor: nullableString(MAX_CURSOR_BYTES),
        limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT },
      },
      required: ["kind", "boardId", "status", "cursor", "limit"],
      additionalProperties: false,
    },
  },
  {
    name: "kanban_get",
    description: "Read one authorized Kanban card and a bounded body chunk.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", maxLength: 36 },
        cursor: nullableString(MAX_CURSOR_BYTES),
        maxBytes: { type: "integer", minimum: 1, maximum: MAX_CONTENT_READ_BYTES },
      },
      required: ["cardId", "cursor", "maxBytes"],
      additionalProperties: false,
    },
  },
  {
    name: "kanban_update_progress",
    description: "Append progress for a Card-bound Run without changing Card or Run state.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", maxLength: 36 },
        runId: { type: "string", maxLength: 256 },
        message: { type: "string", maxLength: MAX_RUN_NOTE_BYTES },
        percent: { anyOf: [{ type: "integer", minimum: 0, maximum: 100 }, { type: "null" }] },
      },
      required: ["cardId", "runId", "message", "percent"],
      additionalProperties: false,
    },
  },
  {
    name: "kanban_add_comment",
    description: "Append an agent-authored comment to an authorized Kanban card.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", maxLength: 36 },
        body: { type: "string", maxLength: MAX_COMMENT_BYTES },
      },
      required: ["cardId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "kanban_request_complete",
    description: "Request Product-side completion review for the latest unique active Card Run.",
    inputSchema: {
      type: "object",
      properties: { cardId: { type: "string", maxLength: 36 } },
      required: ["cardId"],
      additionalProperties: false,
    },
  },
  {
    name: "cron_list",
    description: "List authorized Cron jobs with bounded cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        cursor: nullableString(MAX_CURSOR_BYTES),
        limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT },
      },
      required: ["enabled", "cursor", "limit"],
      additionalProperties: false,
    },
  },
  {
    name: "cron_get",
    description: "Read one authorized Cron job and a bounded prompt chunk.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", maxLength: 36 },
        cursor: nullableString(MAX_CURSOR_BYTES),
        maxBytes: { type: "integer", minimum: 1, maximum: MAX_CONTENT_READ_BYTES },
      },
      required: ["jobId", "cursor", "maxBytes"],
      additionalProperties: false,
    },
  },
  {
    name: "run_get",
    description: "Read a bounded public projection of one authorized WorkRun.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string", maxLength: 256 } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "run_add_note",
    description: "Append a durable note to one authorized WorkRun.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", maxLength: 256 },
        body: { type: "string", maxLength: MAX_RUN_NOTE_BYTES },
      },
      required: ["runId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "artifact_publish",
    description: "Publish a regular file from an authorized Kanban Run workspace.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", maxLength: 256 },
        relativePath: { type: "string", maxLength: 4096 },
        name: { type: "string", maxLength: 1024 },
        kind: { type: "string", maxLength: 64 },
        mimeType: nullableString(256),
      },
      required: ["runId", "relativePath", "name", "kind", "mimeType"],
      additionalProperties: false,
    },
  },
  {
    name: "notification_send",
    description: "Send one bounded native notification for an authorized WorkRun.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", maxLength: 256 },
        title: { type: "string", minLength: 1, maxLength: MAX_NOTIFICATION_TITLE_BYTES },
        body: { type: "string", minLength: 1, maxLength: MAX_NOTIFICATION_BODY_BYTES },
      },
      required: ["runId", "title", "body"],
      additionalProperties: false,
    },
  },
];

const scheduleSchema = {
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "at" }, at: { type: "integer", minimum: 0 } },
      required: ["kind", "at"], additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "every" },
        everyMs: { type: "integer", minimum: 60_000 },
        anchorMs: { type: "integer", minimum: 0 },
      },
      required: ["kind", "everyMs", "anchorMs"], additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "cron" },
        expr: { type: "string", maxLength: 256 },
        tz: { type: "string", maxLength: 128 },
      },
      required: ["kind", "expr", "tz"], additionalProperties: false,
    },
  ],
};

const externalAgentSpecProperties = {
  name: { type: "string", maxLength: 256 },
  workspace: { type: "string", maxLength: 4096 },
  model: { type: "string", maxLength: 512 },
  emoji: { type: "string", maxLength: 32 },
  cloneFromDefault: { type: "boolean" },
  noSkills: { type: "boolean" },
};

// cloneFromDefault/noSkills 只在创建时有语义。更新时接受它们会造成后端静默
// 忽略字段，但 Agent 误以为修改成功，因此更新契约只暴露真实可变字段。
const externalAgentPatchProperties = {
  name: externalAgentSpecProperties.name,
  workspace: externalAgentSpecProperties.workspace,
  model: externalAgentSpecProperties.model,
  emoji: externalAgentSpecProperties.emoji,
};

const ADDITIONAL_MCP_PRODUCT_TOOL_DEFINITIONS = [
  { name: "app_capabilities", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "app_status", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "usage_get",
    inputSchema: {
      type: "object", properties: { range: { type: "string", enum: [...USAGE_RANGES] } },
      required: ["range"], additionalProperties: false,
    },
  },
  {
    name: "kanban_board_get",
    inputSchema: {
      type: "object", properties: { boardId: { type: "string", maxLength: 36 } },
      required: ["boardId"], additionalProperties: false,
    },
  },
  {
    name: "kanban_board_create",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", maxLength: 64 },
        name: { type: "string", maxLength: 512 },
        description: nullableString(16 * 1024),
      },
      required: ["slug", "name", "description"], additionalProperties: false,
    },
  },
  {
    name: "kanban_board_update",
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", maxLength: 36 },
        patch: {
          type: "object", minProperties: 1,
          properties: { name: { type: "string", maxLength: 512 }, description: nullableString(16 * 1024) },
          additionalProperties: false,
        },
      },
      required: ["boardId", "patch"], additionalProperties: false,
    },
  },
  {
    name: "kanban_card_create",
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", maxLength: 36 }, title: { type: "string", maxLength: 2048 },
        body: nullableString(MAX_TEXT_BYTES), position: { type: "integer", minimum: 0 },
      },
      required: ["boardId", "title", "body", "position"], additionalProperties: false,
    },
  },
  {
    name: "kanban_card_update",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", maxLength: 36 },
        patch: {
          type: "object", minProperties: 1,
          properties: {
            title: { type: "string", maxLength: 2048 }, body: nullableString(MAX_TEXT_BYTES),
            position: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      required: ["cardId", "patch"], additionalProperties: false,
    },
  },
  {
    name: "kanban_card_move",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", maxLength: 36 },
        status: { type: "string", enum: [...CARD_STATUSES].filter((value) => value !== "done") },
      },
      required: ["cardId", "status"], additionalProperties: false,
    },
  },
  {
    name: "kanban_run_list",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", maxLength: 36 },
        status: { anyOf: [{ type: "string", enum: [...WORK_RUN_STATUSES] }, { type: "null" }] },
        cursor: nullableString(MAX_CURSOR_BYTES), limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT },
      },
      required: ["cardId", "status", "cursor", "limit"], additionalProperties: false,
    },
  },
  {
    name: "kanban_run_dispatch",
    inputSchema: {
      type: "object",
      properties: { cardId: { type: "string", maxLength: 36 }, workspace: nullableString(4096) },
      required: ["cardId", "workspace"], additionalProperties: false,
    },
  },
  {
    name: "kanban_run_retry",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", maxLength: 36 }, runId: { type: "string", maxLength: 256 },
        workspace: nullableString(4096),
      },
      required: ["cardId", "runId", "workspace"], additionalProperties: false,
    },
  },
  {
    name: "cron_create",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 512 }, prompt: { type: "string", maxLength: MAX_TEXT_BYTES },
        workspace: nullableString(4096), schedule: scheduleSchema, enabled: { type: "boolean" },
        misfirePolicy: { type: "string", enum: [...MISFIRE_POLICIES] },
        maxCatchUp: { type: "integer", minimum: 1, maximum: 100 },
        overlapPolicy: { type: "string", enum: [...OVERLAP_POLICIES] },
        threadPolicy: { type: "string", enum: [...THREAD_POLICIES] }, threadId: nullableString(256),
      },
      required: ["name", "prompt", "workspace", "schedule", "enabled", "misfirePolicy", "maxCatchUp", "overlapPolicy", "threadPolicy", "threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "cron_update",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", maxLength: 36 },
        patch: {
          type: "object", minProperties: 1,
          properties: {
            name: { type: "string", maxLength: 512 }, prompt: { type: "string", maxLength: MAX_TEXT_BYTES },
            workspace: nullableString(4096), schedule: scheduleSchema,
            misfirePolicy: { type: "string", enum: [...MISFIRE_POLICIES] },
            maxCatchUp: { type: "integer", minimum: 1, maximum: 100 },
            overlapPolicy: { type: "string", enum: [...OVERLAP_POLICIES] },
            threadPolicy: { type: "string", enum: [...THREAD_POLICIES] }, threadId: nullableString(256),
          },
          additionalProperties: false,
        },
      },
      required: ["jobId", "patch"], additionalProperties: false,
    },
  },
  ...["cron_set_enabled", "cron_delete", "cron_run_now"].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", maxLength: 36 },
        ...(name === "cron_set_enabled" ? { enabled: { type: "boolean" } } : {}),
      },
      required: name === "cron_set_enabled" ? ["jobId", "enabled"] : ["jobId"],
      additionalProperties: false,
    },
  })),
  {
    name: "cron_run_list",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", maxLength: 36 },
        status: { anyOf: [{ type: "string", enum: [...WORK_RUN_STATUSES] }, { type: "null" }] },
        cursor: nullableString(MAX_CURSOR_BYTES), limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT },
      },
      required: ["jobId", "status", "cursor", "limit"], additionalProperties: false,
    },
  },
  {
    name: "cron_run_retry",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", maxLength: 36 }, runId: { type: "string", maxLength: 256 } },
      required: ["jobId", "runId"], additionalProperties: false,
    },
  },
  {
    name: "backend_status",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "federation_agent_list",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "federation_agent_get",
    inputSchema: {
      type: "object",
      properties: {
        backendId: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
        agentId: { type: "string", maxLength: 128 },
      },
      required: ["backendId", "agentId"], additionalProperties: false,
    },
  },
  {
    name: "federation_agent_run",
    inputSchema: {
      type: "object",
      properties: {
        backendId: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
        agentId: { type: "string", maxLength: 128 },
        prompt: { type: "string", maxLength: MAX_DELEGATE_PROMPT_BYTES },
        timeoutMs: { type: "integer", minimum: 5_000, maximum: 120_000 },
      },
      required: ["backendId", "agentId", "prompt", "timeoutMs"], additionalProperties: false,
    },
  },
  {
    name: "federation_agent_message",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string", maxLength: MAX_FEDERATION_HANDLE_BYTES },
        message: { type: "string", maxLength: MAX_DELEGATE_PROMPT_BYTES },
        timeoutMs: { type: "integer", minimum: 5_000, maximum: 120_000 },
      },
      required: ["handle", "message", "timeoutMs"], additionalProperties: false,
    },
  },
  ...["federation_task_get", "federation_task_cancel"].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", maxLength: MAX_FEDERATION_HANDLE_BYTES } },
      required: ["handle"], additionalProperties: false,
    },
  })),
  {
    name: "external_cron_list",
    inputSchema: {
      type: "object",
      properties: {
        backendId: { type: "string", enum: [...EXTERNAL_BACKENDS] },
        enabled: { anyOf: [{ type: "boolean" }, { type: "null" }] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["backendId", "enabled", "limit"],
      additionalProperties: false,
    },
  },
  ...["external_agent_list"].map((name) => ({
    name,
    inputSchema: {
      type: "object", properties: { backendId: { type: "string", enum: [...EXTERNAL_BACKENDS] } },
      required: ["backendId"], additionalProperties: false,
    },
  })),
  ...["external_agent_get", "external_agent_file_list", "external_agent_channels", "external_agent_artifacts"].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: {
        backendId: { type: "string", enum: [...EXTERNAL_BACKENDS] },
        agentId: { type: "string", maxLength: 128 },
        ...(name === "external_agent_artifacts" ? { limit: { type: "integer", minimum: 1, maximum: 100 } } : {}),
      },
      required: name === "external_agent_artifacts" ? ["backendId", "agentId", "limit"] : ["backendId", "agentId"],
      additionalProperties: false,
    },
  })),
  {
    name: "external_agent_create",
    inputSchema: {
      type: "object",
      properties: {
        backendId: { type: "string", enum: [...EXTERNAL_BACKENDS] },
        spec: { type: "object", minProperties: 1, properties: externalAgentSpecProperties, additionalProperties: false },
      },
      required: ["backendId", "spec"], additionalProperties: false,
    },
  },
  ...["external_agent_update"].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: {
        backendId: { type: "string", enum: [...EXTERNAL_BACKENDS] }, agentId: { type: "string", maxLength: 128 },
        patch: { type: "object", minProperties: 1, properties: externalAgentPatchProperties, additionalProperties: false },
      },
      required: ["backendId", "agentId", "patch"], additionalProperties: false,
    },
  })),
  {
    name: "external_agent_delete",
    inputSchema: {
      type: "object",
      properties: { backendId: { type: "string", enum: [...EXTERNAL_BACKENDS] }, agentId: { type: "string", maxLength: 128 } },
      required: ["backendId", "agentId"], additionalProperties: false,
    },
  },
  {
    name: "external_agent_file_read",
    inputSchema: {
      type: "object",
      properties: {
        backendId: { type: "string", enum: [...EXTERNAL_BACKENDS] }, agentId: { type: "string", maxLength: 128 },
        file: { type: "string", maxLength: 256 },
      },
      required: ["backendId", "agentId", "file"], additionalProperties: false,
    },
  },
  {
    name: "external_agent_file_write",
    inputSchema: {
      type: "object",
      properties: {
        backendId: { type: "string", enum: [...EXTERNAL_BACKENDS] }, agentId: { type: "string", maxLength: 128 },
        file: { type: "string", maxLength: 256 }, content: { type: "string", maxLength: MAX_AGENT_FILE_BYTES },
      },
      required: ["backendId", "agentId", "file", "content"], additionalProperties: false,
    },
  },
  {
    name: "external_agent_run",
    inputSchema: {
      type: "object",
      properties: {
        backendId: { type: "string", enum: [...EXTERNAL_BACKENDS] }, agentId: { type: "string", maxLength: 128 },
        prompt: { type: "string", maxLength: MAX_DELEGATE_PROMPT_BYTES }, timeoutMs: { type: "integer", minimum: 5_000, maximum: 120_000 },
      },
      required: ["backendId", "agentId", "prompt", "timeoutMs"], additionalProperties: false,
    },
  },
];

const MCP_TOOL_DEFINITION_BY_NAME = new Map([
  ...BASE_MCP_PRODUCT_TOOL_DEFINITIONS,
  ...ADDITIONAL_MCP_PRODUCT_TOOL_DEFINITIONS,
  ...INSPIRATION_MCP_TOOL_DEFINITIONS,
].map((definition) => [definition.name, definition]));
const MCP_PRODUCT_TOOL_DEFINITION_INPUTS = INTERNAL_MCP_PRODUCT_TOOL_NAMES.map((name) => ({
  ...MCP_TOOL_DEFINITION_BY_NAME.get(name),
  description: productToolDescription(name),
  annotations: productToolAnnotations(name),
}));

const productProjection = publicProductCapabilities();
const DEFAULT_TOOL_REGISTRY = new ToolRegistry({
  capabilities: PRODUCT_CAPABILITIES,
  definitions: MCP_PRODUCT_TOOL_DEFINITION_INPUTS,
  domainNotes: PRODUCT_DOMAIN_NOTES,
  lifecycle: productProjection.lifecycle,
});
const MCP_PRODUCT_TOOL_DEFINITIONS = deepFreeze(DEFAULT_TOOL_REGISTRY.mcpDefinitions());

if (MCP_TOOL_DEFINITION_BY_NAME.size !== INTERNAL_MCP_PRODUCT_TOOL_NAMES.length
  || MCP_PRODUCT_TOOL_DEFINITIONS.some((definition) => !definition.inputSchema)) {
  throw new Error("产品能力清单与 MCP 工具定义不一致");
}

function toolError(code) {
  const error = new Error(PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.MCP_TOOL_UNAVAILABLE);
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return Object.freeze(error);
}

function ownDataObject(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function productRunDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const result = {};
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (["codexThreadId", "codexTurnId"].includes(key)) {
        if (!descriptor || descriptor.enumerable !== false || descriptor.configurable !== false
          || typeof descriptor.get !== "function" || descriptor.set !== undefined) return null;
        continue;
      }
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
        return null;
      }
      result[key] = descriptor.value;
    }
  } catch { return null; }
  return result;
}

function exactObject(value, fields) {
  if (!ownDataObject(value)) return false;
  let keys;
  try { keys = Object.keys(value); } catch { return false; }
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function ownValue(value, field) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && Object.hasOwn(descriptor, "value")
      ? { ok: true, found: true, value: descriptor.value }
      : { ok: descriptor === undefined, found: descriptor !== undefined, value: undefined };
  } catch {
    return { ok: false, found: false, value: undefined };
  }
}

function validText(value, maxBytes, options = {}) {
  if (options.nullable && value === null) return true;
  return typeof value === "string" && (options.allowEmpty || value.length > 0)
    && !value.includes("\0") && value.isWellFormed()
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function createContentMeta(content) {
  if (!validText(content, MAX_TEXT_BYTES, { allowEmpty: true })) {
    throw toolError("MCP_TOOL_RESPONSE_INVALID");
  }
  let preview = "";
  let previewBytes = 0;
  for (const codePoint of content) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (previewBytes + bytes > MAX_CONTENT_PREVIEW_BYTES) break;
    preview += codePoint;
    previewBytes += bytes;
  }
  return Object.freeze({
    byteLength: Buffer.byteLength(content, "utf8"),
    sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    preview,
  });
}

function validOpaqueId(value) {
  return validText(value, 256) && OPAQUE_ID_PATTERN.test(value);
}

function validCursor(value) {
  return value === null || validText(value, MAX_CURSOR_BYTES);
}

function validPageLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE_LIMIT;
}

function validMaxBytes(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_CONTENT_READ_BYTES;
}

function validSchedule(value) {
  if (!ownDataObject(value)) return false;
  if (value.kind === "at") {
    return exactObject(value, ["kind", "at"])
      && Number.isSafeInteger(value.at) && value.at >= 0;
  }
  if (value.kind === "every") {
    return exactObject(value, ["kind", "everyMs", "anchorMs"])
      && Number.isSafeInteger(value.everyMs) && value.everyMs >= 60_000
      && Number.isSafeInteger(value.anchorMs) && value.anchorMs >= 0;
  }
  return value.kind === "cron" && exactObject(value, ["kind", "expr", "tz"])
    && validText(value.expr, 256) && validText(value.tz, 128);
}

function validPatch(value, validators) {
  if (!ownDataObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => validators[key]?.(value[key]) === true);
}

const BOARD_PATCH_VALIDATORS = Object.freeze({
  name: (value) => validText(value, 512),
  description: (value) => validText(value, 16 * 1024, { nullable: true, allowEmpty: true }),
});
const CARD_PATCH_VALIDATORS = Object.freeze({
  title: (value) => validText(value, 2048),
  body: (value) => validText(value, MAX_TEXT_BYTES, { nullable: true, allowEmpty: true }),
  position: (value) => Number.isSafeInteger(value) && value >= 0,
});
const CRON_PATCH_VALIDATORS = Object.freeze({
  name: (value) => validText(value, 512),
  prompt: (value) => validText(value, MAX_TEXT_BYTES),
  workspace: (value) => value === null || (validText(value, 4096) && path.isAbsolute(value)),
  schedule: validSchedule,
  misfirePolicy: (value) => MISFIRE_POLICIES.has(value),
  maxCatchUp: (value) => Number.isSafeInteger(value) && value >= 1 && value <= 100,
  overlapPolicy: (value) => OVERLAP_POLICIES.has(value),
  threadPolicy: (value) => THREAD_POLICIES.has(value),
  threadId: (value) => value === null || validOpaqueId(value),
});
const EXTERNAL_AGENT_SPEC_VALIDATORS = Object.freeze({
  name: (value) => validText(value, 256),
  workspace: (value) => validText(value, 4096),
  model: (value) => validText(value, 512),
  emoji: (value) => validText(value, 32, { allowEmpty: true }),
  cloneFromDefault: (value) => typeof value === "boolean",
  noSkills: (value) => typeof value === "boolean",
});
const EXTERNAL_AGENT_PATCH_VALIDATORS = Object.freeze({
  name: EXTERNAL_AGENT_SPEC_VALIDATORS.name,
  workspace: EXTERNAL_AGENT_SPEC_VALIDATORS.workspace,
  model: EXTERNAL_AGENT_SPEC_VALIDATORS.model,
  emoji: EXTERNAL_AGENT_SPEC_VALIDATORS.emoji,
});

function validExternalTarget(value) {
  return EXTERNAL_BACKENDS.has(value.backendId) && validOpaqueId(value.agentId);
}

function validAgentFileName(value) {
  return validText(value, 256) && !value.startsWith(".")
    && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

function validateQuestions(value) {
  if (!exactObject(value, ["questions"]) || !Array.isArray(value.questions)
    || value.questions.length < 1 || value.questions.length > 3) return false;
  const ids = new Set();
  return value.questions.every((question) => {
    if (!exactObject(question, ["header", "id", "question", "options"])
      || !validText(question.header, 64) || !validText(question.id, 64)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(question.id)
      || ids.has(question.id) || !validText(question.question, 1024)
      || !Array.isArray(question.options) || question.options.length < 2
      || question.options.length > 3) return false;
    ids.add(question.id);
    return question.options.every((option) => exactObject(option, ["label", "description"])
      && validText(option.label, 128) && validText(option.description, 512, { allowEmpty: true }));
  });
}

function validateMcpProductToolArguments(name, args) {
  if (!MCP_PRODUCT_TOOL_NAME_SET.has(name)) return false;
  if (inspirationMcpMethod(name)) return validateInspirationMcpArguments(name, args);
  if (["app_capabilities", "app_status", "profile_get", "backend_status"].includes(name)) {
    return exactObject(args, []);
  }
  if (name === "runtime_context_get") {
    return (exactObject(args, ["runId"]) && validOpaqueId(args.runId))
      || (exactObject(args, ["source", "sourceId"])
        && ["chat", "kanban", "cron", "inspiration"].includes(args.source)
        && validText(args.sourceId, 512));
  }
  if (name === "usage_get") {
    return exactObject(args, ["range"]) && USAGE_RANGES.has(args.range);
  }
  if (name === "skill_catalog") {
    return exactObject(args, ["cursor", "limit"])
      && Number.isSafeInteger(args.cursor) && args.cursor >= 0
      && Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 10;
  }
  if (name === "skill_read") {
    return exactObject(args, ["name", "contentHash", "cursor", "maxBytes"])
      && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(args.name)
      && SHA256_PATTERN.test(args.contentHash)
      && Number.isSafeInteger(args.cursor) && args.cursor >= 0
      && validMaxBytes(args.maxBytes);
  }
  if (name === "system_application_search") {
    return (exactObject(args, ["query"]) || exactObject(args, ["query", "limit"]))
      && validText(args.query, 512)
      && (args.limit === undefined
        || (Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 20));
  }
  if (name === "system_application_launch") {
    return (exactObject(args, ["bundleId"])
      && /^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$/u.test(args.bundleId))
      || (exactObject(args, ["applicationPath"])
        && validText(args.applicationPath, 4096) && path.isAbsolute(args.applicationPath));
  }
  if (name === "system_open_url") {
    return exactObject(args, ["url"]) && validText(args.url, 4096);
  }
  if (name === "finder_open_folder") {
    return (exactObject(args, ["path"]) || exactObject(args, ["path", "select"]))
      && validText(args.path, 4096)
      && (args.select === undefined || args.select === null || validText(args.select, 1024));
  }
  if (COMPUTER_TOOL_NAMES.has(name)) {
    if (name === "computer_status") return exactObject(args, []);
    const source = ["source", "sourceId"];
    if (!["chat", "kanban", "cron", "inspiration"].includes(args.source) || !validText(args.sourceId, 512)) {
      return false;
    }
    if (name === "computer_session_open") {
      return exactObject(args, [...source, "allowedApplications", "expiresInSeconds"])
        && Array.isArray(args.allowedApplications) && args.allowedApplications.length >= 1
        && args.allowedApplications.length <= 8
        && new Set(args.allowedApplications).size === args.allowedApplications.length
        && args.allowedApplications.every((value) => (
          typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$/u.test(value)
        ))
        && Number.isSafeInteger(args.expiresInSeconds)
        && args.expiresInSeconds >= 60 && args.expiresInSeconds <= 900;
    }
    const base = [...source, "sessionId"];
    if (!validOpaqueId(args.sessionId)) return false;
    if (["computer_session_resume", "computer_session_close", "computer_application_list"].includes(name)) {
      return exactObject(args, base);
    }
    if (name === "computer_application_focus") {
      return exactObject(args, [...base, "bundleId", "pid"])
        && /^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$/u.test(args.bundleId)
        && Number.isSafeInteger(args.pid) && args.pid > 0;
    }
    if (name === "computer_window_list") {
      return exactObject(args, [...base, "onScreenOnly"]) && typeof args.onScreenOnly === "boolean";
    }
    if (name === "computer_window_focus") {
      return exactObject(args, [...base, "bundleId", "pid", "windowId"])
        && /^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$/u.test(args.bundleId)
        && Number.isSafeInteger(args.pid) && args.pid > 0
        && Number.isSafeInteger(args.windowId) && args.windowId >= 0;
    }
    if (name === "computer_snapshot") {
      return exactObject(args, [...base, "pid", "windowId"])
        && Number.isSafeInteger(args.pid) && args.pid > 0
        && Number.isSafeInteger(args.windowId) && args.windowId >= 0;
    }
    const actionBase = [...base, "snapshotRevision", "pid", "windowId"];
    if (!validOpaqueId(args.snapshotRevision)
      || !Number.isSafeInteger(args.pid) || args.pid <= 0
      || !Number.isSafeInteger(args.windowId) || args.windowId < 0) return false;
    if (name === "computer_click" || name === "computer_double_click") {
      const byRef = validText(args.ref, 128) && args.x === null && args.y === null;
      const byPoint = args.ref === null && Number.isFinite(args.x) && Number.isFinite(args.y)
        && args.x >= 0 && args.x <= 20_000 && args.y >= 0 && args.y <= 20_000;
      return exactObject(args, [...actionBase, "ref", "x", "y"]) && (byRef || byPoint);
    }
    if (name === "computer_drag") {
      return exactObject(args, [...actionBase, "fromX", "fromY", "toX", "toY", "durationMs"])
        && [args.fromX, args.fromY, args.toX, args.toY].every((value) => (
          Number.isFinite(value) && value >= 0 && value <= 20_000
        )) && Number.isSafeInteger(args.durationMs) && args.durationMs >= 0
        && args.durationMs <= 10_000;
    }
    if (name === "computer_scroll") {
      return exactObject(args, [...actionBase, "ref", "direction", "amount", "by"])
        && (args.ref === null || validText(args.ref, 128))
        && ["up", "down", "left", "right"].includes(args.direction)
        && Number.isSafeInteger(args.amount) && args.amount >= 1 && args.amount <= 50
        && ["line", "page"].includes(args.by);
    }
    if (name === "computer_type") {
      return exactObject(args, [...actionBase, "ref", "text"])
        && validText(args.ref, 128) && validText(args.text, 16 * 1024, { allowEmpty: true });
    }
    return name === "computer_key"
      && exactObject(args, [...actionBase, "ref", "key", "modifiers"])
      && (args.ref === null || validText(args.ref, 128))
      && (COMPUTER_SAFE_KEYS.has(args.key) || /^[a-z0-9]$/u.test(args.key))
      && Array.isArray(args.modifiers) && args.modifiers.length <= 4
      && new Set(args.modifiers).size === args.modifiers.length
      && args.modifiers.every((value) => COMPUTER_MODIFIERS.has(value));
  }
  if (name === "request_user_input") return validateQuestions(args);
  if (name === "kanban_list") {
    return exactObject(args, ["kind", "boardId", "status", "cursor", "limit"])
      && (args.kind === "boards" || args.kind === "cards")
      && (args.boardId === null || UUID_PATTERN.test(args.boardId))
      && (args.status === null || CARD_STATUSES.has(args.status))
      && validCursor(args.cursor) && validPageLimit(args.limit)
      && (args.kind === "boards"
        ? args.boardId === null && args.status === null
        : UUID_PATTERN.test(args.boardId));
  }
  if (name === "kanban_get") {
    return exactObject(args, ["cardId", "cursor", "maxBytes"])
      && UUID_PATTERN.test(args.cardId) && validCursor(args.cursor) && validMaxBytes(args.maxBytes);
  }
  if (name === "kanban_board_get") {
    return exactObject(args, ["boardId"]) && UUID_PATTERN.test(args.boardId);
  }
  if (name === "kanban_board_create") {
    return exactObject(args, ["slug", "name", "description"])
      && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(args.slug)
      && validText(args.name, 512)
      && validText(args.description, 16 * 1024, { nullable: true, allowEmpty: true });
  }
  if (name === "kanban_board_update") {
    return exactObject(args, ["boardId", "patch"]) && UUID_PATTERN.test(args.boardId)
      && validPatch(args.patch, BOARD_PATCH_VALIDATORS);
  }
  if (name === "kanban_card_create") {
    return exactObject(args, ["boardId", "title", "body", "position"])
      && UUID_PATTERN.test(args.boardId) && validText(args.title, 2048)
      && validText(args.body, MAX_TEXT_BYTES, { nullable: true, allowEmpty: true })
      && Number.isSafeInteger(args.position) && args.position >= 0;
  }
  if (name === "kanban_card_update") {
    return exactObject(args, ["cardId", "patch"]) && UUID_PATTERN.test(args.cardId)
      && validPatch(args.patch, CARD_PATCH_VALIDATORS);
  }
  if (name === "kanban_card_move") {
    return exactObject(args, ["cardId", "status"]) && UUID_PATTERN.test(args.cardId)
      && CARD_STATUSES.has(args.status) && args.status !== "done";
  }
  if (name === "kanban_update_progress") {
    return exactObject(args, ["cardId", "runId", "message", "percent"])
      && UUID_PATTERN.test(args.cardId) && validOpaqueId(args.runId)
      && validText(args.message, MAX_RUN_NOTE_BYTES, { allowEmpty: true })
      && (args.percent === null
        || (Number.isSafeInteger(args.percent) && args.percent >= 0 && args.percent <= 100));
  }
  if (name === "kanban_add_comment") {
    return exactObject(args, ["cardId", "body"])
      && UUID_PATTERN.test(args.cardId) && validText(args.body, MAX_COMMENT_BYTES);
  }
  if (name === "kanban_request_complete") {
    return exactObject(args, ["cardId"]) && UUID_PATTERN.test(args.cardId);
  }
  if (name === "kanban_run_list") {
    return exactObject(args, ["cardId", "status", "cursor", "limit"])
      && UUID_PATTERN.test(args.cardId)
      && (args.status === null || WORK_RUN_STATUSES.has(args.status))
      && validCursor(args.cursor) && validPageLimit(args.limit);
  }
  if (name === "kanban_run_dispatch") {
    return exactObject(args, ["cardId", "workspace"]) && UUID_PATTERN.test(args.cardId)
      && validText(args.workspace, 4096, { nullable: true });
  }
  if (name === "kanban_run_retry") {
    return exactObject(args, ["cardId", "runId", "workspace"])
      && UUID_PATTERN.test(args.cardId) && validOpaqueId(args.runId)
      && validText(args.workspace, 4096, { nullable: true });
  }
  if (name === "cron_list") {
    return exactObject(args, ["enabled", "cursor", "limit"])
      && (args.enabled === null || typeof args.enabled === "boolean")
      && validCursor(args.cursor) && validPageLimit(args.limit);
  }
  if (name === "cron_get") {
    return exactObject(args, ["jobId", "cursor", "maxBytes"])
      && UUID_PATTERN.test(args.jobId) && validCursor(args.cursor) && validMaxBytes(args.maxBytes);
  }
  if (name === "cron_create") {
    return exactObject(args, [
      "name", "prompt", "workspace", "schedule", "enabled", "misfirePolicy",
      "maxCatchUp", "overlapPolicy", "threadPolicy", "threadId",
    ]) && validText(args.name, 512) && validText(args.prompt, MAX_TEXT_BYTES)
      && (args.workspace === null || (validText(args.workspace, 4096) && path.isAbsolute(args.workspace)))
      && validSchedule(args.schedule) && typeof args.enabled === "boolean"
      && MISFIRE_POLICIES.has(args.misfirePolicy)
      && Number.isSafeInteger(args.maxCatchUp) && args.maxCatchUp >= 1 && args.maxCatchUp <= 100
      && OVERLAP_POLICIES.has(args.overlapPolicy) && THREAD_POLICIES.has(args.threadPolicy)
      && (args.threadId === null || validOpaqueId(args.threadId))
      && (args.threadPolicy !== "new" || args.threadId === null);
  }
  if (name === "cron_update") {
    return exactObject(args, ["jobId", "patch"]) && UUID_PATTERN.test(args.jobId)
      && validPatch(args.patch, CRON_PATCH_VALIDATORS)
      && (!(Object.hasOwn(args.patch, "threadPolicy") && Object.hasOwn(args.patch, "threadId"))
        || args.patch.threadPolicy !== "new" || args.patch.threadId === null);
  }
  if (name === "cron_set_enabled") {
    return exactObject(args, ["jobId", "enabled"]) && UUID_PATTERN.test(args.jobId)
      && typeof args.enabled === "boolean";
  }
  if (["cron_delete", "cron_run_now"].includes(name)) {
    return exactObject(args, ["jobId"]) && UUID_PATTERN.test(args.jobId);
  }
  if (name === "cron_run_list") {
    return exactObject(args, ["jobId", "status", "cursor", "limit"])
      && UUID_PATTERN.test(args.jobId)
      && (args.status === null || WORK_RUN_STATUSES.has(args.status))
      && validCursor(args.cursor) && validPageLimit(args.limit);
  }
  if (name === "cron_run_retry") {
    return exactObject(args, ["jobId", "runId"])
      && UUID_PATTERN.test(args.jobId) && validOpaqueId(args.runId);
  }
  if (name === "external_agent_list") {
    return exactObject(args, ["backendId"]) && EXTERNAL_BACKENDS.has(args.backendId);
  }
  if (name === "external_cron_list") {
    return exactObject(args, ["backendId", "enabled", "limit"])
      && EXTERNAL_BACKENDS.has(args.backendId)
      && (args.enabled === null || typeof args.enabled === "boolean")
      && Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 100;
  }
  if (["external_agent_get", "external_agent_file_list", "external_agent_channels"].includes(name)) {
    return exactObject(args, ["backendId", "agentId"]) && validExternalTarget(args);
  }
  if (name === "external_agent_artifacts") {
    return exactObject(args, ["backendId", "agentId", "limit"]) && validExternalTarget(args)
      && Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 100;
  }
  if (name === "external_agent_create") {
    return exactObject(args, ["backendId", "spec"]) && EXTERNAL_BACKENDS.has(args.backendId)
      && validPatch(args.spec, EXTERNAL_AGENT_SPEC_VALIDATORS)
      && validText(args.spec.name, 256)
      && (args.backendId !== "openclaw" || validText(args.spec.workspace, 4096));
  }
  if (name === "external_agent_update") {
    return exactObject(args, ["backendId", "agentId", "patch"]) && validExternalTarget(args)
      && validPatch(args.patch, EXTERNAL_AGENT_PATCH_VALIDATORS);
  }
  if (name === "external_agent_delete") {
    return exactObject(args, ["backendId", "agentId"]) && validExternalTarget(args);
  }
  if (name === "external_agent_file_read") {
    return exactObject(args, ["backendId", "agentId", "file"])
      && validExternalTarget(args) && validAgentFileName(args.file);
  }
  if (name === "external_agent_file_write") {
    return exactObject(args, ["backendId", "agentId", "file", "content"])
      && validExternalTarget(args) && validAgentFileName(args.file)
      && validText(args.content, MAX_AGENT_FILE_BYTES, { allowEmpty: true });
  }
  if (name === "external_agent_run") {
    return exactObject(args, ["backendId", "agentId", "prompt", "timeoutMs"])
      && validExternalTarget(args) && validText(args.prompt, MAX_DELEGATE_PROMPT_BYTES)
      && Number.isSafeInteger(args.timeoutMs) && args.timeoutMs >= 5_000 && args.timeoutMs <= 120_000;
  }
  if (name === "federation_agent_list") {
    return exactObject(args, []) || (exactObject(args, ["backendId"])
      && (args.backendId === null || FEDERATION_BACKEND_PATTERN.test(args.backendId)));
  }
  if (name === "federation_agent_get") {
    return exactObject(args, ["backendId", "agentId"])
      && FEDERATION_BACKEND_PATTERN.test(args.backendId) && validOpaqueId(args.agentId);
  }
  if (name === "federation_agent_run") {
    return exactObject(args, ["backendId", "agentId", "prompt", "timeoutMs"])
      && FEDERATION_BACKEND_PATTERN.test(args.backendId) && validOpaqueId(args.agentId)
      && validText(args.prompt, MAX_DELEGATE_PROMPT_BYTES)
      && Number.isSafeInteger(args.timeoutMs) && args.timeoutMs >= 5_000
      && args.timeoutMs <= 120_000;
  }
  if (name === "federation_agent_message") {
    return exactObject(args, ["handle", "message", "timeoutMs"])
      && validText(args.handle, MAX_FEDERATION_HANDLE_BYTES)
      && validText(args.message, MAX_DELEGATE_PROMPT_BYTES)
      && Number.isSafeInteger(args.timeoutMs) && args.timeoutMs >= 5_000
      && args.timeoutMs <= 120_000;
  }
  if (["federation_task_get", "federation_task_cancel"].includes(name)) {
    return exactObject(args, ["handle"]) && validText(args.handle, MAX_FEDERATION_HANDLE_BYTES);
  }
  if (name === "run_get") {
    return exactObject(args, ["runId"]) && validOpaqueId(args.runId);
  }
  if (name === "run_add_note") {
    return exactObject(args, ["runId", "body"]) && validOpaqueId(args.runId)
      && validText(args.body, MAX_RUN_NOTE_BYTES);
  }
  if (name === "artifact_publish") {
    return exactObject(args, ["runId", "relativePath", "name", "kind", "mimeType"])
      && validOpaqueId(args.runId) && validText(args.relativePath, 4096)
      && validText(args.name, 1024) && validText(args.kind, 64)
      && OPAQUE_ID_PATTERN.test(args.kind)
      && validText(args.mimeType, 256, { nullable: true })
      && (args.mimeType === null || MIME_PATTERN.test(args.mimeType));
  }
  return name === "notification_send"
    && exactObject(args, ["runId", "title", "body"])
    && validOpaqueId(args.runId) && validText(args.title, MAX_NOTIFICATION_TITLE_BYTES)
    && validText(args.body, MAX_NOTIFICATION_BODY_BYTES);
}

function validateAuthority(value) {
  const fields = ["profileId", "callId"];
  if (value && Object.hasOwn(value, "confirmation")) fields.push("confirmation");
  if (value && Object.hasOwn(value, "federationClient")) fields.push("federationClient");
  return exactObject(value, fields)
    && validText(value.profileId, 128) && OPAQUE_ID_PATTERN.test(value.profileId)
    && UUID_PATTERN.test(value.callId)
    && (!Object.hasOwn(value, "confirmation") || value.confirmation === true)
    && (!Object.hasOwn(value, "federationClient")
      || EXTERNAL_BACKENDS.has(value.federationClient));
}

function safeJsonClone(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_SAFE_JSON_NODES || depth > MAX_SAFE_JSON_DEPTH) {
    throw toolError("MCP_TOOL_RESPONSE_INVALID");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw toolError("MCP_TOOL_RESPONSE_INVALID");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw toolError("MCP_TOOL_RESPONSE_INVALID");
    return value;
  }
  if (Array.isArray(value)) {
    let keys;
    let lengthDescriptor;
    try {
      keys = Reflect.ownKeys(value);
      lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    } catch { throw toolError("MCP_TOOL_RESPONSE_INVALID"); }
    const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, "value")
      ? lengthDescriptor.value : -1;
    if (keys.some((key) => key !== "length"
      && !(typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)))
      || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
      throw toolError("MCP_TOOL_RESPONSE_INVALID");
    }
    const result = [];
    for (let index = 0; index < length; index += 1) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch {
        throw toolError("MCP_TOOL_RESPONSE_INVALID");
      }
      if (!descriptor || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, "value")) throw toolError("MCP_TOOL_RESPONSE_INVALID");
      result.push(safeJsonClone(descriptor.value, state, depth + 1));
    }
    return result;
  }
  if (!ownDataObject(value)) throw toolError("MCP_TOOL_RESPONSE_INVALID");
  const result = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(result, key, {
      value: safeJsonClone(
        Object.getOwnPropertyDescriptor(value, key).value, state, depth + 1,
      ),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function responseFrameBytes(result) {
  return Buffer.byteLength(JSON.stringify({
    id: MAX_RESPONSE_ID_RESERVATION,
    ok: true,
    result,
  }), "utf8");
}

function compactComputerSnapshotForFrame(result) {
  if (responseFrameBytes(result) <= MAX_FRAME_BYTES) return result;
  if (!result || typeof result !== "object" || !Array.isArray(result.elements)
    || typeof result.tree !== "string") return result;

  const originalElements = result.elements;
  const originalElementCount = originalElements.length;
  let treeTruncated = false;
  let inlineImageTruncated = false;
  const markTruncated = (returnedElementCount = originalElementCount) => {
    result.degraded = true;
    result.outputTruncated = {
      tree: treeTruncated,
      inlineImage: inlineImageTruncated,
      originalElementCount,
      returnedElementCount,
    };
  };

  if (result.tree.length > 0) {
    result.tree = "";
    treeTruncated = true;
    markTruncated();
    if (responseFrameBytes(result) <= MAX_FRAME_BYTES) return result;
  }

  if (result.image && typeof result.image === "object"
    && typeof result.image.thumbnail === "string" && result.image.thumbnail.length > 0) {
    result.image.thumbnail = null;
    inlineImageTruncated = true;
    markTruncated();
    if (responseFrameBytes(result) <= MAX_FRAME_BYTES) return result;
  }

  let low = 0;
  let high = originalElementCount;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    result.elements = originalElements.slice(0, middle);
    markTruncated(middle);
    if (responseFrameBytes(result) <= MAX_FRAME_BYTES) low = middle;
    else high = middle - 1;
  }
  result.elements = originalElements.slice(0, low);
  markTruncated(low);
  return result;
}

function sameJson(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function fingerprintMcpToolCall(name, args) {
  return crypto.createHash("sha256").update(canonicalJson({ name, args })).digest("hex");
}

function sanitizeProfile(profile) {
  if (!ownDataObject(profile)) throw toolError("MCP_TOOL_RESPONSE_INVALID");
  const result = {
    id: profile.id,
    agentId: profile.agentId,
    name: profile.name,
    runtimeProfileId: profile.runtimeProfileId,
    defaultModel: profile.defaultModel,
    defaultCwd: profile.defaultCwd,
    permissionPolicy: profile.permissionPolicy,
    concurrency: profile.concurrency,
    isDefault: profile.isDefault,
    enabled: profile.enabled,
  };
  return safeJsonClone(result);
}

function cardDto(value) {
  if (!ownDataObject(value)) throw toolError("MCP_TOOL_RESPONSE_INVALID");
  const body = value.body;
  return safeJsonClone({
    id: value.id,
    boardId: value.boardId,
    profileId: value.profileId,
    title: value.title,
    bodyMeta: body === null ? null : createContentMeta(body),
    status: value.status,
    position: value.position,
    completionRequest: value.completionRequest,
    completion: value.completion,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

function kanbanCardUiTarget(value, backendId) {
  if (!ownDataObject(value)
    || !UUID_PATTERN.test(value.boardId)
    || !UUID_PATTERN.test(value.id)
    || !FEDERATION_BACKEND_PATTERN.test(backendId)) {
    throw toolError("MCP_TOOL_RESPONSE_INVALID");
  }
  return {
    href: `#/tasks?backend=${encodeURIComponent(backendId)}&board=${encodeURIComponent(value.boardId)}&task=${encodeURIComponent(value.id)}`,
  };
}

function commentDto(value) {
  if (!ownDataObject(value)) throw toolError("MCP_TOOL_RESPONSE_INVALID");
  return safeJsonClone({
    id: value.id,
    cardId: value.cardId,
    authorType: value.authorType,
    authorId: value.authorId,
    bodyMeta: createContentMeta(value.body),
    createdAt: value.createdAt,
  });
}

function runDto(value) {
  if (!ownDataObject(value)) throw toolError("MCP_TOOL_RESPONSE_INVALID");
  return safeJsonClone({
    id: value.id,
    source: value.source,
    sourceId: value.sourceId,
    status: value.status,
    eventSeq: value.eventSeq,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    resultSummary: value.resultSummary,
    errorCode: value.errorCode,
    retryOf: value.retryOf,
  });
}

function artifactDto(value) {
  if (!ownDataObject(value) || !UUID_PATTERN.test(value.id)
    || !UUID_PATTERN.test(value.cardId) || !validOpaqueId(value.runId)
    || !validText(value.name, 1024) || !validText(value.kind, 64)
    || !validText(value.mimeType, 256, { nullable: true })
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0
    || !SHA256_PATTERN.test(value.sha256) || !validText(value.storageKey, 4096)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw toolError("MCP_TOOL_RESPONSE_INVALID");
  }
  return safeJsonClone(value);
}

function systemApplicationDto(value) {
  if (!exactObject(value, ["name", "bundleId", "path"])
    || !validText(value.name, 512)
    || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$/u.test(value.bundleId)
    || !validText(value.path, 4096) || !path.isAbsolute(value.path)
    || !value.path.endsWith(".app")) {
    throw toolError("MCP_TOOL_RESPONSE_INVALID");
  }
  return safeJsonClone(value);
}

function systemHostResult(name, value) {
  if (name === "system_application_search") {
    if (!exactObject(value, ["applications"]) || !Array.isArray(value.applications)
      || value.applications.length > 20) throw toolError("MCP_TOOL_RESPONSE_INVALID");
    return { applications: value.applications.map(systemApplicationDto) };
  }
  if (name === "system_application_launch") {
    if (!exactObject(value, ["application", "launched"]) || value.launched !== true) {
      throw toolError("MCP_TOOL_RESPONSE_INVALID");
    }
    return { application: systemApplicationDto(value.application), launched: true };
  }
  if (name === "system_open_url") {
    if (!exactObject(value, ["url", "opened"]) || value.opened !== true
      || !validText(value.url, 4096)) throw toolError("MCP_TOOL_RESPONSE_INVALID");
    return safeJsonClone(value);
  }
  if (!exactObject(value, ["path", "selected", "opened"]) || value.opened !== true
    || !validText(value.path, 4096) || !path.isAbsolute(value.path)
    || (value.selected !== null
      && (!validText(value.selected, 4096) || !path.isAbsolute(value.selected)))) {
    throw toolError("MCP_TOOL_RESPONSE_INVALID");
  }
  return safeJsonClone(value);
}

function noteId(authority) {
  return `mcp-note-${crypto.createHash("sha256")
    .update(authority.profileId).update("\0").update(authority.callId).digest("hex").slice(0, 48)}`;
}

function requireMethods(value, methods, label) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${label} 缺少所需方法`);
  }
}

function mapToolError(error) {
  const codeProbe = ownValue(error, "code");
  // 依赖即使伪造了公开 code，也绝不能借此透传自带 message/stack/cause。
  if (codeProbe.ok && codeProbe.found && PUBLIC_CODES.has(codeProbe.value)) {
    return toolError(codeProbe.value);
  }
  const code = codeProbe.ok && codeProbe.found && typeof codeProbe.value === "string"
    ? codeProbe.value : "";
  if (code.endsWith("COMMIT_UNCERTAIN") || code === "STORE_COMMIT_UNCERTAIN") {
    return toolError("MCP_TOOL_COMMIT_UNCERTAIN");
  }
  if (code === "INSPIRATION_RESPONSE_INVALID") return toolError("MCP_TOOL_RESPONSE_INVALID");
  if (code.includes("CAPACITY")) return toolError("MCP_TOOL_CAPACITY");
  if (code.includes("NOT_FOUND") || code === "UNKNOWN_AGENT_PROFILE") {
    return toolError("MCP_TOOL_NOT_FOUND");
  }
  if (code.includes("REFERENCE") || code.includes("CONFLICT")
    || code.includes("TRANSITION") || code.includes("NOT_ACTIVE")
    || code.includes("COMPLETION_REQUEST") || code.includes("AMBIGUOUS")
    || code === "COMPUTER_SNAPSHOT_STALE"
    || code === "COMPUTER_SESSION_PAUSED" || code === "COMPUTER_USER_TAKEOVER"
    || code === "COMPUTER_SCREEN_LOCKED" || code === "COMPUTER_SESSION_EXPIRED") {
    return toolError("MCP_TOOL_STATE_CONFLICT");
  }
  if (code === "COMPUTER_SESSION_FORBIDDEN"
    || code === "COMPUTER_TARGET_FORBIDDEN" || code === "COMPUTER_SECURE_INPUT_FORBIDDEN") {
    return toolError("MCP_TOOL_FORBIDDEN");
  }
  if (code === "FEDERATION_HANDLE_FORBIDDEN") return toolError("MCP_TOOL_FORBIDDEN");
  if (["FEDERATION_SELF_DISPATCH", "FEDERATION_TURN_LIMIT", "FEDERATION_TARGET_WAITING",
    "FEDERATION_HANDLE_STALE", "FEDERATION_TASK_STATE_CONFLICT", "INSPIRATION_BUSY",
    "INSPIRATION_AGENT_BUSY", "INSPIRATION_ARCHIVED", "INSPIRATION_NOT_COMPLETED"].includes(code)) {
    return toolError("MCP_TOOL_STATE_CONFLICT");
  }
  if (code.includes("SENSITIVE") || code.includes("SECRET")) {
    return toolError("MCP_TOOL_SECRET_REJECTED");
  }
  if (code === "INVALID_PARAMS" || code.includes("_INVALID") || code.includes("URL_FORBIDDEN")) {
    return toolError("MCP_TOOL_INVALID_ARGUMENTS");
  }
  if (code.includes("UNSAFE") || code.includes("PATH") || code === "ENOENT"
    || code === "ENOTDIR" || code === "ELOOP") return toolError("MCP_TOOL_PATH_INVALID");
  if (code.includes("UNAVAILABLE") || code.includes("CLOSED") || code.includes("POISON")) {
    return toolError("MCP_TOOL_UNAVAILABLE");
  }
  return toolError("MCP_TOOL_UNAVAILABLE");
}

class McpProductToolController {
  constructor(options = {}) {
    requireMethods(options.productStore, [
      "getAgentProfile", "addRunNote", "lookupMcpToolCall",
      "beginMcpToolCall", "completeMcpToolCall",
    ], "ProductStore");
    requireMethods(options.domainController, ["handle"], "NativeDomainServiceController");
    requireMethods(options.kanbanStore, [
      "getBoard", "getCard", "listCardRunLinks", "getCardRunLinkByRunId",
      "addComment", "addArtifact", "listArtifacts",
    ], "NativeKanbanStore");
    requireMethods(options.kanbanRunService, ["requestCompletionFromAgent"], "KanbanRunService");
    requireMethods(options.cronStore, ["getJob"], "NativeCronStore");
    requireMethods(options.workDispatcher, ["getRun"], "WorkDispatcher");
    if (options.usageStore !== undefined) requireMethods(options.usageStore, ["summarize"], "TokenUsageStore");
    if (options.federationClient !== undefined) requireMethods(options.federationClient, ["request"], "FederationHostClient");
    if (options.federationCoordinator !== undefined) requireMethods(options.federationCoordinator,
      ["list", "get", "run", "message", "taskGet", "cancel"], "FederationCoordinator");
    if (options.skillStore !== undefined) requireMethods(options.skillStore, ["catalog", "read"], "NativeSkillStore");
    if (options.inspirationService !== undefined) requireMethods(options.inspirationService, ["handle"], "InspirationService");
    if (options.systemHostController !== undefined && options.systemHostController !== null) {
      requireMethods(options.systemHostController, ["search", "launch", "openUrl", "openFolder"], "SystemHostController");
    }
    if (options.computerUseController !== undefined && options.computerUseController !== null) {
      requireMethods(options.computerUseController, [
        "status", "create", "resume", "closeSession", "applicationList", "windowList",
        "snapshot", "focus", "action",
      ], "ComputerUseController");
    }
    if (typeof options.notificationSender !== "function"
      || typeof options.isSensitiveValue !== "function"
      || (options.getRuntimeContext !== undefined && typeof options.getRuntimeContext !== "function")
      || (options.getServiceStatus !== undefined && typeof options.getServiceStatus !== "function")
      || (options.onFatalError !== undefined && typeof options.onFatalError !== "function")
      || (options.now !== undefined && typeof options.now !== "function")
      || (options.randomUUID !== undefined && typeof options.randomUUID !== "function")
      || typeof options.artifactRoot !== "string" || !path.isAbsolute(options.artifactRoot)) {
      throw new TypeError("McpProductToolController 配置无效");
    }
    this.productStore = options.productStore;
    this.domainController = options.domainController;
    this.kanbanStore = options.kanbanStore;
    this.kanbanRunService = options.kanbanRunService;
    this.cronStore = options.cronStore;
    this.workDispatcher = options.workDispatcher;
    this.usageStore = options.usageStore || null;
    this.federationClient = options.federationClient || null;
    this.federationCoordinator = options.federationCoordinator || null;
    this.skillStore = options.skillStore || null;
    this.inspirationService = options.inspirationService || null;
    this.systemHostController = options.systemHostController || null;
    this.computerUseController = options.computerUseController || null;
    this.getServiceStatus = options.getServiceStatus || null;
    this.getRuntimeContext = options.getRuntimeContext || null;
    this.notificationSender = options.notificationSender;
    this.isSensitiveValue = options.isSensitiveValue;
    this.onFatalError = options.onFatalError || null;
    this.artifactRoot = path.resolve(options.artifactRoot);
    this.fs = options.fs || fs;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.toolRegistry = options.toolRegistry || DEFAULT_TOOL_REGISTRY;
    if (typeof this.toolRegistry.get !== "function"
      || typeof this.toolRegistry.publicProjection !== "function") {
      throw new TypeError("McpProductToolController ToolRegistry 无效");
    }
    this.permissionEngine = options.permissionEngine || new PermissionEngine({
      toolRegistry: this.toolRegistry,
      paths: options.permissionPaths,
    });
    if (typeof this.permissionEngine.authorize !== "function") {
      throw new TypeError("McpProductToolController PermissionEngine 无效");
    }
    this.poisonError = null;
    this.notificationRunWindows = new Map();
    this.notificationProfileWindows = new Map();
    this.ephemeralCalls = new Map();
  }

  async handle(name, rawArgs, authority) {
    if (!validateAuthority(authority) || !validateMcpProductToolArguments(name, rawArgs)
      || name === "request_user_input") {
      throw toolError("MCP_TOOL_INVALID_ARGUMENTS");
    }
    if (this.poisonError) throw this.poisonError;
    try {
      this.permissionEngine.authorize({
        name,
        profileId: authority.profileId,
        confirmed: authority.confirmation === true,
      });
      const fingerprint = fingerprintMcpToolCall(name, rawArgs);
      let result;
      if (DURABLE_WRITE_TOOL_NAMES.has(name)) {
        // 已登记调用的 durable owner/binding 先于可变 Profile/Card 状态；否则响应丢失后
        // Profile 被禁用或实体被删除会破坏 exact replay / pending 对账。
        result = await this.#handleDurable(name, rawArgs, authority, fingerprint);
      } else {
        this.#requireProfile(authority.profileId);
        result = await this.#handleEphemeral(name, rawArgs, authority, fingerprint);
      }
      let safe = safeJsonClone(result);
      if (name === "computer_snapshot") safe = compactComputerSnapshotForFrame(safe);
      const frame = JSON.stringify({ id: MAX_RESPONSE_ID_RESERVATION, ok: true, result: safe });
      if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
        throw toolError("MCP_TOOL_RESPONSE_TOO_LARGE");
      }
      return safe;
    } catch (error) {
      const fatal = this.#isFatal(error);
      let safe = mapToolError(error);
      if (fatal && safe.code !== "MCP_TOOL_COMMIT_UNCERTAIN") {
        safe = toolError("MCP_TOOL_UNAVAILABLE");
      }
      if (fatal) this.#poison(safe);
      throw this.poisonError || safe;
    }
  }

  #handleEphemeral(name, args, authority, fingerprint) {
    const durable = this.productStore.lookupMcpToolCall({
      profileId: authority.profileId, callId: authority.callId, name, fingerprint,
    });
    if (durable) throw toolError("MCP_TOOL_STATE_CONFLICT");
    const key = `${authority.profileId}\0${authority.callId}`;
    const existing = this.ephemeralCalls.get(key);
    if (existing) {
      if (existing.name !== name || existing.fingerprint !== fingerprint) {
        throw toolError("MCP_TOOL_STATE_CONFLICT");
      }
      return existing.promise;
    }
    if (this.ephemeralCalls.size >= 4096) {
      const evictable = [...this.ephemeralCalls.entries()].find(([, record]) => record.settled);
      if (!evictable) throw toolError("MCP_TOOL_CAPACITY");
      this.ephemeralCalls.delete(evictable[0]);
    }
    const record = { name, fingerprint, promise: null, settled: false };
    record.promise = Promise.resolve().then(() => this.#route(name, args, authority, null))
      .finally(() => { record.settled = true; });
    this.ephemeralCalls.set(key, record);
    return record.promise;
  }

  async #handleDurable(name, args, authority, fingerprint) {
    if (this.ephemeralCalls.has(`${authority.profileId}\0${authority.callId}`)) {
      throw toolError("MCP_TOOL_STATE_CONFLICT");
    }
    const lookup = { profileId: authority.profileId, callId: authority.callId, name, fingerprint };
    let call = this.productStore.lookupMcpToolCall(lookup);
    if (call?.status === "completed") return this.#replayOutcome(call.result);
    if (call === null) {
      this.#requireProfile(authority.profileId);
      const binding = await this.#preflightDurable(name, args, authority);
      let createdAt;
      try { createdAt = this.now(); } catch { throw toolError("MCP_TOOL_UNAVAILABLE"); }
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw toolError("MCP_TOOL_UNAVAILABLE");
      }
      call = this.productStore.beginMcpToolCall({ ...lookup, binding, createdAt });
      if (call.status === "completed") return this.#replayOutcome(call.result);
    }
    try {
      const result = safeJsonClone(await this.#route(name, args, authority, call));
      const completed = this.productStore.completeMcpToolCall({
        id: call.id, outcome: { ok: true, result },
      });
      return this.#replayOutcome(completed.result);
    } catch (error) {
      if (this.#isFatal(error)) throw error;
      const safe = mapToolError(error);
      let completed;
      try {
        completed = this.productStore.completeMcpToolCall({
          id: call.id, outcome: { ok: false, publicCode: safe.code },
        });
      } catch (completionError) {
        throw completionError;
      }
      return this.#replayOutcome(completed.result);
    }
  }

  #replayOutcome(outcome) {
    if (!ownDataObject(outcome) || typeof outcome.ok !== "boolean") {
      throw toolError("MCP_TOOL_RESPONSE_INVALID");
    }
    if (outcome.ok === true && exactObject(outcome, ["ok", "result"])) {
      return safeJsonClone(outcome.result);
    }
    if (outcome.ok === false && exactObject(outcome, ["ok", "publicCode"])
      && PUBLIC_CODES.has(outcome.publicCode)) throw toolError(outcome.publicCode);
    throw toolError("MCP_TOOL_RESPONSE_INVALID");
  }

  #isFatal(error) {
    const codeProbe = ownValue(error, "code");
    if (!codeProbe.ok) return true;
    const code = codeProbe.found && typeof codeProbe.value === "string" ? codeProbe.value : "";
    if (code.endsWith("COMMIT_UNCERTAIN") || code.endsWith("POISONED")) return true;
    for (const dependency of [this.productStore, this.kanbanStore]) {
      const probe = ownValue(dependency, "commitUncertain");
      if (!probe.ok) return true;
      if (probe.found && probe.value === true) return true;
    }
    return false;
  }

  #poison(safeError) {
    if (this.poisonError) return;
    this.poisonError = safeError;
    if (!this.onFatalError) return;
    try { Promise.resolve(this.onFatalError(safeError)).catch(() => {}); } catch {}
  }

  #requireProfile(profileId) {
    const profile = this.productStore.getAgentProfile(profileId);
    if (!ownDataObject(profile) || profile.id !== profileId || profile.enabled !== true) {
      throw toolError("MCP_TOOL_NOT_FOUND");
    }
    return profile;
  }

  #requireCard(cardId, profileId) {
    const value = this.kanbanStore.getCard(cardId);
    if (!ownDataObject(value) || value.id !== cardId || value.profileId !== profileId) {
      throw toolError("MCP_TOOL_NOT_FOUND");
    }
    return value;
  }

  #requireBoard(boardId, profileId) {
    const value = this.kanbanStore.getBoard(boardId);
    if (!ownDataObject(value) || value.id !== boardId || value.profileId !== profileId) {
      throw toolError("MCP_TOOL_NOT_FOUND");
    }
    return value;
  }

  #requireRun(runId, profileId) {
    const raw = this.workDispatcher.getRun(runId);
    const value = ownDataObject(raw) ? raw : productRunDataObject(raw);
    if (!ownDataObject(value) || value.id !== runId || value.profileId !== profileId) {
      throw toolError("MCP_TOOL_NOT_FOUND");
    }
    return value;
  }

  async #currentInteractiveRun(args, authority) {
    if (!this.getRuntimeContext) throw toolError("MCP_TOOL_UNAVAILABLE");
    const context = await this.getRuntimeContext(authority.profileId, {
      source: args.source,
      sourceId: args.sourceId,
    });
    if (!ownDataObject(context) || context.profileId !== authority.profileId
      || context.source !== args.source || context.sourceId !== args.sourceId
      || !validOpaqueId(context.runId)) throw toolError("MCP_TOOL_NOT_FOUND");
    const run = this.#requireRun(context.runId, authority.profileId);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) throw toolError("MCP_TOOL_STATE_CONFLICT");
    return run;
  }

  #requireCronJob(jobId, profileId) {
    const value = this.cronStore.getJob(jobId);
    if (!ownDataObject(value) || value.id !== jobId || value.profileId !== profileId) {
      throw toolError("MCP_TOOL_NOT_FOUND");
    }
    return value;
  }

  #requireKanbanBinding(cardValue, runValue) {
    const link = this.kanbanStore.getCardRunLinkByRunId(runValue.id);
    if (runValue.source !== "kanban" || runValue.sourceId !== cardValue.id
      || runValue.profileId !== cardValue.profileId || !ownDataObject(link)
      || link.runId !== runValue.id || link.cardId !== cardValue.id) {
      throw toolError("MCP_TOOL_STATE_CONFLICT");
    }
    return link;
  }

  async #federationRequest(method, params) {
    if (!this.federationClient) throw toolError("APP_HOST_UNAVAILABLE");
    try {
      const result = safeJsonClone(await this.federationClient.request(method, params));
      this.#assertSecretSafe(JSON.stringify(result));
      return result;
    } catch (error) {
      const code = ownValue(error, "code");
      if (code.ok && code.found && PUBLIC_CODES.has(code.value)) throw toolError(code.value);
      if (code.value === "APP_HOST_UNAVAILABLE" || code.value === "SERVICE_DISCONNECTED"
        || code.value === "ENOENT" || code.value === "ECONNREFUSED") {
        throw toolError("APP_HOST_UNAVAILABLE");
      }
      if (code.value === "BACKEND_DISABLED" || code.value === "BACKEND_UNAVAILABLE") {
        throw toolError("BACKEND_UNAVAILABLE");
      }
      throw error;
    }
  }

  async #preflightDurable(name, args, authority) {
    if (inspirationMcpMethod(name)) {
      if (!this.inspirationService) throw toolError("MCP_TOOL_UNAVAILABLE");
      this.#assertSecretSafe(JSON.stringify(args));
      if (name === "inspiration_start") {
        const readiness = await this.#federationRequest("inspiration.executor.ready", {
          backendId: args.backendId, agentId: args.agentId,
        });
        if (!ownDataObject(readiness) || readiness.ready !== true) throw toolError("BACKEND_UNAVAILABLE");
      }
      return null;
    }
    if (["federation_agent_run", "federation_agent_message", "federation_task_cancel"].includes(name)) {
      if (name === "federation_agent_run") this.#assertSecretSafe(args.prompt);
      if (name === "federation_agent_message") this.#assertSecretSafe(args.message);
      return null;
    }
    if (name === "kanban_board_create" || name === "cron_create"
      || ["system_application_launch", "system_open_url", "finder_open_folder"].includes(name)) {
      return null;
    }
    if (name === "kanban_board_update") {
      this.#requireBoard(args.boardId, authority.profileId);
      return null;
    }
    if (name === "kanban_card_create") {
      this.#requireBoard(args.boardId, authority.profileId);
      return null;
    }
    if (["kanban_card_update", "kanban_card_move", "kanban_run_dispatch"].includes(name)) {
      this.#requireCard(args.cardId, authority.profileId);
      return null;
    }
    if (name === "kanban_run_retry") {
      const cardValue = this.#requireCard(args.cardId, authority.profileId);
      const runValue = this.#requireRun(args.runId, authority.profileId);
      this.#requireKanbanBinding(cardValue, runValue);
      return null;
    }
    if (["cron_update", "cron_set_enabled", "cron_delete", "cron_run_now"].includes(name)) {
      this.#requireCronJob(args.jobId, authority.profileId);
      return null;
    }
    if (name === "cron_run_retry") {
      const job = this.#requireCronJob(args.jobId, authority.profileId);
      const run = this.#requireRun(args.runId, authority.profileId);
      if (run.source !== "cron" || run.sourceId !== job.id) {
        throw toolError("MCP_TOOL_STATE_CONFLICT");
      }
      return null;
    }
    if (name.startsWith("external_agent_")) {
      this.#assertSecretSafe(JSON.stringify(args));
      if (name === "external_agent_create") {
        await this.#federationRequest("backend.require", { backendId: args.backendId });
        return { backendId: args.backendId };
      }
      const result = await this.#federationRequest("agent.get", {
        backendId: args.backendId, agentId: args.agentId,
      });
      if (!ownDataObject(result) || !ownDataObject(result.agent)
        || result.agent.id !== args.agentId || result.agent.backendId !== args.backendId) {
        throw toolError("MCP_TOOL_RESPONSE_INVALID");
      }
      return { backendId: args.backendId, agentId: args.agentId };
    }
    if (name === "kanban_add_comment") {
      this.#requireCard(args.cardId, authority.profileId);
      return null;
    }
    if (name === "kanban_update_progress") {
      const cardValue = this.#requireCard(args.cardId, authority.profileId);
      const runValue = this.#requireRun(args.runId, authority.profileId);
      this.#requireKanbanBinding(cardValue, runValue);
      return null;
    }
    if (name === "kanban_request_complete") {
      const cardValue = this.#requireCard(args.cardId, authority.profileId);
      const links = this.kanbanStore.listCardRunLinks(cardValue.id);
      if (!Array.isArray(links) || links.length === 0) throw toolError("MCP_TOOL_STATE_CONFLICT");
      const ordered = links.map((link) => {
        if (!ownDataObject(link) || link.cardId !== cardValue.id || !validOpaqueId(link.runId)
          || !Number.isSafeInteger(link.createdAt) || link.createdAt < 0) {
          throw toolError("MCP_TOOL_RESPONSE_INVALID");
        }
        return { link, run: this.#requireRun(link.runId, authority.profileId) };
      }).sort((left, right) => left.link.createdAt - right.link.createdAt
        || (left.link.id < right.link.id ? -1 : left.link.id > right.link.id ? 1 : 0));
      for (const item of ordered) this.#requireKanbanBinding(cardValue, item.run);
      const active = ordered.filter((item) => ACTIVE_RUN_STATUSES.has(item.run.status));
      if (active.length !== 1 || active[0] !== ordered[ordered.length - 1]) {
        throw toolError("MCP_TOOL_STATE_CONFLICT");
      }
      return { runId: active[0].run.id };
    }
    if (name === "run_add_note") {
      this.#requireRun(args.runId, authority.profileId);
      return null;
    }
    if (name === "artifact_publish") {
      const runValue = this.#requireRun(args.runId, authority.profileId);
      const cardValue = this.#requireCard(runValue.sourceId, authority.profileId);
      this.#requireKanbanBinding(cardValue, runValue);
      const root = this.#validateArtifactRoot();
      const storageLeaf = crypto.createHash("sha256")
        .update(authority.profileId).update("\0").update(authority.callId).digest("hex");
      const storageKey = `${path.basename(root)}/${storageLeaf}`;
      const existing = this.kanbanStore.listArtifacts(cardValue.id).filter((artifact) => (
        ownDataObject(artifact) && artifact.storageKey === storageKey
      ));
      if (existing.length > 1) {
        throw toolError("MCP_TOOL_RESPONSE_INVALID");
      }
      if (existing.length === 1) {
        // durable ledger 不在时不能把历史 storageKey 当作新调用认领。
        throw toolError("MCP_TOOL_STATE_CONFLICT");
      }
      const digest = this.#sourceFileDigest(runValue.workspace, args.relativePath);
      return {
        cardId: cardValue.id,
        runId: runValue.id,
        storageKey,
        name: args.name,
        kind: args.kind,
        mimeType: args.mimeType,
        sizeBytes: digest.sizeBytes,
        sha256: digest.sha256,
      };
    }
    throw toolError("MCP_TOOL_INVALID_ARGUMENTS");
  }

  async #route(name, args, authority, call) {
    if (name === "app_capabilities") return this.toolRegistry.publicProjection();
    if (name === "app_status") {
      if (!this.getServiceStatus) throw toolError("MCP_TOOL_UNAVAILABLE");
      return { service: safeJsonClone(await this.getServiceStatus()) };
    }
    if (name === "profile_get") return sanitizeProfile(this.#requireProfile(authority.profileId));
    if (inspirationMcpMethod(name)) {
      if (!this.inspirationService) throw toolError("MCP_TOOL_UNAVAILABLE");
      this.#assertSecretSafe(JSON.stringify(args));
      const params = inspirationMcpParams(name, args, call?.operationId);
      // growth.set has no domain operationId; its revision guard is the write
      // boundary. On a lost response, refresh settings before a new call.
      const result = inspirationMcpResult(name,
        await this.inspirationService.handle(inspirationMcpMethod(name), params));
      this.#assertSecretSafe(JSON.stringify(result));
      return result;
    }
    if (["system_application_search", "system_application_launch", "system_open_url",
      "finder_open_folder"].includes(name)) {
      if (!this.systemHostController) throw toolError("MCP_TOOL_UNAVAILABLE");
      let value;
      if (name === "system_application_search") {
        value = await this.systemHostController.search({ query: args.query, limit: args.limit || 10 });
      } else if (name === "system_application_launch") {
        value = await this.systemHostController.launch(args);
      } else if (name === "system_open_url") {
        value = await this.systemHostController.openUrl(args);
      } else {
        value = await this.systemHostController.openFolder({
          path: args.path,
          select: args.select === undefined ? null : args.select,
        });
      }
      return systemHostResult(name, value);
    }
    if (COMPUTER_TOOL_NAMES.has(name)) {
      if (!this.computerUseController) throw toolError("MCP_TOOL_UNAVAILABLE");
      if (name === "computer_status") {
        return safeJsonClone(await this.computerUseController.status(authority.profileId));
      }
      const run = await this.#currentInteractiveRun(args, authority);
      const common = {
        sessionId: args.sessionId,
        profileId: authority.profileId,
        workRunId: run.id,
      };
      if (name === "computer_session_open") {
        return safeJsonClone(await this.computerUseController.create({
          profileId: authority.profileId,
          workRunId: run.id,
          allowedApplications: args.allowedApplications,
          expiresInSeconds: args.expiresInSeconds,
        }));
      }
      if (name === "computer_session_resume") {
        return safeJsonClone(this.computerUseController.resume(common));
      }
      if (name === "computer_session_close") {
        return safeJsonClone(await this.computerUseController.closeSession(common));
      }
      if (name === "computer_application_list") {
        return safeJsonClone(await this.computerUseController.applicationList(common));
      }
      if (name === "computer_window_list") {
        return safeJsonClone(await this.computerUseController.windowList({
          ...common, onScreenOnly: args.onScreenOnly,
        }));
      }
      if (name === "computer_snapshot") {
        return safeJsonClone(await this.computerUseController.snapshot({
          ...common, pid: args.pid, windowId: args.windowId,
        }));
      }
      if (name === "computer_application_focus" || name === "computer_window_focus") {
        return safeJsonClone(await this.computerUseController.focus({
          ...common,
          bundleId: args.bundleId,
          pid: args.pid,
          windowId: name === "computer_window_focus" ? args.windowId : null,
        }));
      }
      const actionByTool = {
        computer_click: "click",
        computer_double_click: "double_click",
        computer_drag: "drag",
        computer_scroll: "scroll",
        computer_type: "type",
        computer_key: "key",
      };
      const input = { ...common, ...args, action: actionByTool[name] };
      delete input.source;
      delete input.sourceId;
      return safeJsonClone(await this.computerUseController.action(input));
    }
    if (name === "skill_catalog" || name === "skill_read") {
      if (!this.skillStore) throw toolError("MCP_TOOL_UNAVAILABLE");
      const profile = this.#requireProfile(authority.profileId);
      const projection = this.permissionEngine.profileProjection(authority.profileId);
      const options = {
        availableTools: projection.tools.filter((tool) => tool.enabled).map((tool) => tool.name),
        allowedTools: projection.tools.filter((tool) => tool.enabled && tool.effect !== "deny").map((tool) => tool.name),
        runtimeCapabilities: profile.runtime === "codex" || profile.runtime === undefined
          ? ["mcp", "filesystem", "shell"]
          : ["grok-build", "antigravity", "pi", "claude-code", "deepseek-harness"]
            .includes(profile.runtime)
            ? ["mcp", "filesystem", "shell"] : [],
      };
      const catalog = this.skillStore.catalog(authority.profileId, options);
      if (name === "skill_catalog") {
        const items = catalog.items.slice(args.cursor, args.cursor + args.limit).map((skill) => ({
          id: skill.id,
          name: skill.name,
          version: skill.version,
          description: skill.description,
          source: skill.source,
          contentHash: skill.contentHash,
          requiredTools: skill.requiredTools,
          requiredRuntimeCapabilities: skill.requiredRuntimeCapabilities,
        }));
        const nextCursor = args.cursor + items.length;
        return {
          registryRevision: catalog.registryRevision,
          profileRevision: catalog.profileRevision,
          items,
          nextCursor,
          hasMore: nextCursor < catalog.items.length,
        };
      }
      const selected = catalog.items.find((skill) => (
        skill.name === args.name && skill.contentHash === args.contentHash
      ));
      if (!selected) throw toolError("MCP_TOOL_NOT_FOUND");
      const skill = this.skillStore.read({
        profileId: authority.profileId,
        name: args.name,
        contentHash: args.contentHash,
        recordUsage: args.cursor === 0,
      });
      const points = [...skill.content];
      if (args.cursor > points.length) throw toolError("MCP_TOOL_INVALID_ARGUMENTS");
      let content = "";
      let bytes = 0;
      let nextCursor = args.cursor;
      while (nextCursor < points.length) {
        const size = Buffer.byteLength(points[nextCursor], "utf8");
        if (bytes + size > args.maxBytes) break;
        content += points[nextCursor];
        bytes += size;
        nextCursor += 1;
      }
      if (content.length === 0 && nextCursor < points.length) {
        throw toolError("MCP_TOOL_INVALID_ARGUMENTS");
      }
      return {
        name: skill.name,
        version: skill.version,
        source: skill.source,
        contentHash: skill.contentHash,
        content,
        nextCursor,
        hasMore: nextCursor < points.length,
      };
    }
    if (name === "runtime_context_get") {
      if (!this.getRuntimeContext) throw toolError("MCP_TOOL_UNAVAILABLE");
      const context = await this.getRuntimeContext(authority.profileId, args);
      if (!exactObject(context, [
        "runId", "profileId", "source", "sourceId", "profileDefaultModel",
        "sessionModelOverride", "effectiveModel",
      ]) || context.profileId !== authority.profileId
        || (args.source !== undefined
          && (context.source !== args.source || context.sourceId !== args.sourceId))
        || !validOpaqueId(context.runId)
        || !validText(context.profileDefaultModel, 512, { nullable: true })
        || !validText(context.sessionModelOverride, 512, { nullable: true })
        || !validText(context.effectiveModel, 512, { nullable: true })) {
        throw toolError("MCP_TOOL_NOT_FOUND");
      }
      return {
        runId: context.runId,
        source: context.source,
        profileDefaultModel: context.profileDefaultModel,
        sessionModelOverride: context.sessionModelOverride,
        effectiveModel: context.effectiveModel,
        scope: "current-turn",
      };
    }
    if (name === "usage_get") {
      if (!this.usageStore) throw toolError("MCP_TOOL_UNAVAILABLE");
      const profile = this.#requireProfile(authority.profileId);
      return {
        range: args.range,
        usage: safeJsonClone(this.usageStore.summarize(args.range, {
          backendId: profile.backendId,
          profileIds: new Set([profile.id]),
        })),
      };
    }
    if (name === "kanban_list") {
      if (args.kind === "boards") {
        const page = await this.domainController.handle("kanban.board.list", {
          profileId: authority.profileId, cursor: args.cursor, limit: args.limit,
        });
        return { kind: "boards", ...safeJsonClone(page) };
      }
      const boardValue = this.kanbanStore.getBoard(args.boardId);
      if (!ownDataObject(boardValue) || boardValue.id !== args.boardId
        || boardValue.profileId !== authority.profileId) throw toolError("MCP_TOOL_NOT_FOUND");
      const page = await this.domainController.handle("kanban.card.list", {
        boardId: args.boardId, status: args.status, cursor: args.cursor, limit: args.limit,
      });
      return { kind: "cards", ...safeJsonClone(page) };
    }
    if (name === "kanban_get") {
      this.#requireCard(args.cardId, authority.profileId);
      const [cardResult, body] = await Promise.all([
        this.domainController.handle("kanban.card.get", { cardId: args.cardId }),
        this.domainController.handle("kanban.card.body.read", {
          cardId: args.cardId, cursor: args.cursor, maxBytes: args.maxBytes,
        }),
      ]);
      return { card: safeJsonClone(cardResult.card), body: safeJsonClone(body) };
    }
    if (name === "kanban_board_get") {
      this.#requireBoard(args.boardId, authority.profileId);
      return safeJsonClone(await this.domainController.handle("kanban.board.get", {
        boardId: args.boardId,
      }));
    }
    if (name === "kanban_board_create") {
      return safeJsonClone(await this.domainController.handle("kanban.board.create", {
        operationId: call.operationId,
        profileId: authority.profileId,
        slug: args.slug,
        name: args.name,
        description: args.description,
        createdAt: call.createdAt,
      }));
    }
    if (name === "kanban_board_update") {
      return safeJsonClone(await this.domainController.handle("kanban.board.update", {
        operationId: call.operationId,
        boardId: args.boardId,
        patch: args.patch,
        createdAt: call.createdAt,
      }));
    }
    if (name === "kanban_card_create") {
      const profile = this.#requireProfile(authority.profileId);
      const result = await this.domainController.handle("kanban.card.create", {
        operationId: call.operationId,
        boardId: args.boardId,
        profileId: authority.profileId,
        title: args.title,
        body: args.body,
        status: "backlog",
        position: args.position,
        createdAt: call.createdAt,
      });
      if (!ownDataObject(result) || !ownDataObject(result.card)) {
        throw toolError("MCP_TOOL_RESPONSE_INVALID");
      }
      return safeJsonClone({
        ...result,
        uiTarget: kanbanCardUiTarget(result.card, profile.backendId),
      });
    }
    if (name === "kanban_card_update") {
      return safeJsonClone(await this.domainController.handle("kanban.card.update", {
        operationId: call.operationId,
        cardId: args.cardId,
        patch: args.patch,
        createdAt: call.createdAt,
      }));
    }
    if (name === "kanban_card_move") {
      return safeJsonClone(await this.domainController.handle("kanban.card.status.set", {
        operationId: call.operationId,
        cardId: args.cardId,
        status: args.status,
        createdAt: call.createdAt,
      }));
    }
    if (name === "kanban_add_comment") {
      const comment = await this.kanbanStore.addComment({
        operationId: call.operationId,
        cardId: args.cardId,
        authorType: "agent",
        authorId: authority.profileId,
        body: args.body,
        createdAt: call.createdAt,
      });
      return { comment: commentDto(comment) };
    }
    if (name === "kanban_update_progress") {
      const note = {
        id: noteId(authority),
        runId: args.runId,
        profileId: authority.profileId,
        kind: "progress",
        cardId: args.cardId,
        body: args.message,
        percent: args.percent,
        createdAt: call.createdAt,
      };
      const stored = await this.productStore.addRunNote(note);
      if (!sameJson(stored, note)) throw toolError("MCP_TOOL_RESPONSE_INVALID");
      return { note: safeJsonClone(stored) };
    }
    if (name === "kanban_request_complete") {
      if (!ownDataObject(call.binding) || !validOpaqueId(call.binding.runId)
        || Object.keys(call.binding).length !== 1) throw toolError("MCP_TOOL_RESPONSE_INVALID");
      const completedCard = await this.kanbanRunService.requestCompletionFromAgent({
        operationId: call.operationId,
        cardId: args.cardId,
        runId: call.binding.runId,
        createdAt: call.createdAt,
      });
      return { card: cardDto(completedCard) };
    }
    if (name === "kanban_run_list") {
      this.#requireCard(args.cardId, authority.profileId);
      return safeJsonClone(await this.domainController.handle("kanban.run.list", {
        cardId: args.cardId, status: args.status, cursor: args.cursor, limit: args.limit,
      }));
    }
    if (name === "kanban_run_dispatch") {
      return safeJsonClone(await this.domainController.handle("kanban.run.dispatch", {
        operationId: call.operationId, cardId: args.cardId, workspace: args.workspace,
        createdAt: call.createdAt,
      }));
    }
    if (name === "kanban_run_retry") {
      return safeJsonClone(await this.domainController.handle("kanban.run.retry", {
        operationId: call.operationId, cardId: args.cardId, retryOf: args.runId,
        workspace: args.workspace, createdAt: call.createdAt,
      }));
    }
    if (name === "cron_list") {
      return safeJsonClone(await this.domainController.handle("cron.job.list", {
        profileId: authority.profileId,
        enabled: args.enabled,
        cursor: args.cursor,
        limit: args.limit,
      }));
    }
    if (name === "cron_get") {
      this.#requireCronJob(args.jobId, authority.profileId);
      const [jobResult, prompt] = await Promise.all([
        this.domainController.handle("cron.job.get", { jobId: args.jobId }),
        this.domainController.handle("cron.job.prompt.read", {
          jobId: args.jobId, cursor: args.cursor, maxBytes: args.maxBytes,
        }),
      ]);
      return { job: safeJsonClone(jobResult.job), prompt: safeJsonClone(prompt) };
    }
    if (name === "cron_create") {
      return safeJsonClone(await this.domainController.handle("cron.job.create", {
        operationId: call.operationId,
        name: args.name,
        enabled: args.enabled,
        profileId: authority.profileId,
        prompt: args.prompt,
        workspace: args.workspace,
        schedule: args.schedule,
        misfirePolicy: args.misfirePolicy,
        maxCatchUp: args.maxCatchUp,
        overlapPolicy: args.overlapPolicy,
        threadPolicy: args.threadPolicy,
        threadId: args.threadId,
        createdAt: call.createdAt,
      }));
    }
    if (name === "cron_update") {
      return safeJsonClone(await this.domainController.handle("cron.job.update", {
        operationId: call.operationId, jobId: args.jobId, patch: args.patch,
        createdAt: call.createdAt,
      }));
    }
    if (name === "cron_set_enabled") {
      return safeJsonClone(await this.domainController.handle("cron.job.enabled.set", {
        operationId: call.operationId, jobId: args.jobId, enabled: args.enabled,
        createdAt: call.createdAt,
      }));
    }
    if (name === "cron_delete") {
      return safeJsonClone(await this.domainController.handle("cron.job.delete", {
        operationId: call.operationId, jobId: args.jobId, createdAt: call.createdAt,
      }));
    }
    if (name === "cron_run_list") {
      this.#requireCronJob(args.jobId, authority.profileId);
      return safeJsonClone(await this.domainController.handle("cron.run.list", {
        jobId: args.jobId, status: args.status, cursor: args.cursor, limit: args.limit,
      }));
    }
    if (name === "cron_run_now") {
      return safeJsonClone(await this.domainController.handle("cron.run.trigger", {
        operationId: call.operationId, jobId: args.jobId, createdAt: call.createdAt,
      }));
    }
    if (name === "cron_run_retry") {
      return safeJsonClone(await this.domainController.handle("cron.run.retry", {
        operationId: call.operationId, jobId: args.jobId, retryOf: args.runId,
        createdAt: call.createdAt,
      }));
    }
    if (name === "backend_status") {
      return this.#federationRequest("backend.status", {});
    }
    if (name.startsWith("federation_")) {
      if (!this.federationCoordinator) throw toolError("APP_HOST_UNAVAILABLE");
      const method = {
        federation_agent_list: "list",
        federation_agent_get: "get",
        federation_agent_run: "run",
        federation_agent_message: "message",
        federation_task_get: "taskGet",
        federation_task_cancel: "cancel",
      }[name];
      if (!method) throw toolError("MCP_TOOL_INVALID_ARGUMENTS");
      const normalizedArgs = name === "federation_agent_list" ? { backendId: null } : args;
      const input = call
        ? { ...normalizedArgs, operationId: call.operationId, createdAt: call.createdAt }
        : normalizedArgs;
      const result = safeJsonClone(await this.federationCoordinator[method](input, authority));
      if (typeof result?.task?.result === "string") this.#assertSecretSafe(result.task.result);
      return result;
    }
    if (name === "external_cron_list") {
      return this.#federationRequest("cron.list", args);
    }
    if (name === "external_agent_list") {
      return this.#federationRequest("agent.list", { backendId: args.backendId });
    }
    if (name === "external_agent_get") {
      return this.#federationRequest("agent.get", args);
    }
    if (name === "external_agent_file_list") {
      return this.#federationRequest("agent.file.list", args);
    }
    if (name === "external_agent_file_read") {
      return this.#federationRequest("agent.file.read", args);
    }
    if (name === "external_agent_channels") {
      return this.#federationRequest("agent.channels", args);
    }
    if (name === "external_agent_artifacts") {
      return this.#federationRequest("agent.artifacts", args);
    }
    if (name.startsWith("external_agent_")) {
      const methods = {
        external_agent_create: "agent.create",
        external_agent_update: "agent.update",
        external_agent_delete: "agent.delete",
        external_agent_file_write: "agent.file.write",
        external_agent_run: "agent.run",
      };
      const method = methods[name];
      if (!method || !call || !ownDataObject(call.binding)) {
        throw toolError("MCP_TOOL_RESPONSE_INVALID");
      }
      return this.#federationRequest(method, { ...args, operationId: call.operationId });
    }
    if (name === "run_get") {
      return { run: runDto(this.#requireRun(args.runId, authority.profileId)) };
    }
    if (name === "run_add_note") {
      const note = {
        id: noteId(authority),
        runId: args.runId,
        profileId: authority.profileId,
        kind: "note",
        cardId: null,
        body: args.body,
        percent: null,
        createdAt: call.createdAt,
      };
      const stored = await this.productStore.addRunNote(note);
      if (!sameJson(stored, note)) throw toolError("MCP_TOOL_RESPONSE_INVALID");
      return { note: safeJsonClone(stored) };
    }
    if (name === "artifact_publish") {
      const runValue = this.#requireRun(args.runId, authority.profileId);
      const cardValue = this.#requireCard(runValue.sourceId, authority.profileId);
      this.#requireKanbanBinding(cardValue, runValue);
      return { artifact: await this.#publishArtifact(runValue, cardValue, args, authority, call) };
    }
    if (name === "notification_send") {
      const runValue = this.#requireRun(args.runId, authority.profileId);
      this.#assertSecretSafe(args.title);
      this.#assertSecretSafe(args.body);
      return this.#sendNotification(runValue, args, authority);
    }
    throw toolError("MCP_TOOL_INVALID_ARGUMENTS");
  }

  #assertSecretSafe(value) {
    let matched;
    try { matched = this.isSensitiveValue(value); } catch {
      throw toolError("MCP_TOOL_SECRET_REJECTED");
    }
    if (matched !== false) throw toolError("MCP_TOOL_SECRET_REJECTED");
  }

  #consumeNotificationQuota(profileId, runId) {
    let current;
    try { current = this.now(); } catch { throw toolError("MCP_TOOL_UNAVAILABLE"); }
    if (!Number.isSafeInteger(current) || current < 0) throw toolError("MCP_TOOL_UNAVAILABLE");
    for (const [key, times] of this.notificationRunWindows) {
      const retained = times.filter((time) => time > current - 60_000);
      if (retained.length === 0) this.notificationRunWindows.delete(key);
      else this.notificationRunWindows.set(key, retained);
    }
    for (const [key, times] of this.notificationProfileWindows) {
      const retained = times.filter((time) => time > current - 3_600_000);
      if (retained.length === 0) this.notificationProfileWindows.delete(key);
      else this.notificationProfileWindows.set(key, retained);
    }
    const runKey = `${profileId}\0${runId}`;
    if ((!this.notificationRunWindows.has(runKey) && this.notificationRunWindows.size >= 4096)
      || (!this.notificationProfileWindows.has(profileId)
        && this.notificationProfileWindows.size >= 4096)) {
      throw toolError("MCP_TOOL_RATE_LIMITED");
    }
    const perRun = this.notificationRunWindows.get(runKey) || [];
    const perProfile = this.notificationProfileWindows.get(profileId) || [];
    if (perRun.length >= MAX_NOTIFICATION_RUN_PER_MINUTE
      || perProfile.length >= MAX_NOTIFICATION_PROFILE_PER_HOUR) {
      throw toolError("MCP_TOOL_RATE_LIMITED");
    }
    perRun.push(current);
    perProfile.push(current);
    this.notificationRunWindows.set(runKey, perRun);
    this.notificationProfileWindows.set(profileId, perProfile);
  }

  async #sendNotification(runValue, args, authority) {
    this.#consumeNotificationQuota(authority.profileId, runValue.id);
    try {
      await this.notificationSender(Object.freeze({
        profileId: authority.profileId,
        runId: runValue.id,
        title: args.title,
        body: args.body,
      }));
    } catch {
      throw toolError("NOTIFICATION_FAILED");
    }
    return { delivered: true };
  }

  #validateArtifactRoot() {
    const parent = path.dirname(this.artifactRoot);
    let parentStat;
    try { parentStat = this.fs.lstatSync(parent); } catch {
      throw toolError("MCP_TOOL_PATH_INVALID");
    }
    if (!parentStat.isDirectory?.() || parentStat.isSymbolicLink?.()) {
      throw toolError("MCP_TOOL_PATH_INVALID");
    }
    let stat;
    try { stat = this.fs.lstatSync(this.artifactRoot); } catch (error) {
      const code = ownValue(error, "code");
      if (!code.ok || code.value !== "ENOENT") throw toolError("MCP_TOOL_PATH_INVALID");
      try { this.fs.mkdirSync(this.artifactRoot, { mode: 0o700 }); } catch {
        throw toolError("MCP_TOOL_PATH_INVALID");
      }
      stat = this.fs.lstatSync(this.artifactRoot);
    }
    if (!stat.isDirectory?.() || stat.isSymbolicLink?.()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o077) !== 0) throw toolError("MCP_TOOL_PATH_INVALID");
    return this.fs.realpathSync.native(this.artifactRoot);
  }

  #openSource(workspace, relativePath) {
    if (path.isAbsolute(relativePath) || relativePath.includes("\\")) {
      throw toolError("MCP_TOOL_PATH_INVALID");
    }
    const segments = relativePath.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw toolError("MCP_TOOL_PATH_INVALID");
    }
    if (!validText(workspace, 4096) || !path.isAbsolute(workspace)) {
      throw toolError("MCP_TOOL_PATH_INVALID");
    }
    let workspaceReal;
    let sourceReal;
    const sourcePath = path.join(workspace, ...segments);
    let before;
    let fd;
    try {
      workspaceReal = this.fs.realpathSync.native(workspace);
      before = this.fs.lstatSync(sourcePath);
      if (!before.isFile?.() || before.isSymbolicLink?.() || before.nlink !== 1
        || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
        throw toolError("MCP_TOOL_PATH_INVALID");
      }
      sourceReal = this.fs.realpathSync.native(sourcePath);
      const relative = path.relative(workspaceReal, sourceReal);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) throw toolError("MCP_TOOL_PATH_INVALID");
      fd = this.fs.openSync(sourcePath,
        this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0));
      const opened = this.fs.fstatSync(fd);
      if (!opened.isFile?.() || opened.nlink !== 1 || opened.dev !== before.dev
        || opened.ino !== before.ino
        || (typeof process.getuid === "function" && opened.uid !== process.getuid())) {
        throw toolError("MCP_TOOL_PATH_INVALID");
      }
      if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > MAX_ARTIFACT_BYTES) {
        throw toolError("MCP_TOOL_ARTIFACT_TOO_LARGE");
      }
      return { fd, stat: opened };
    } catch (error) {
      if (fd !== undefined) {
        try { this.fs.closeSync(fd); } catch {}
      }
      if (ownValue(error, "code").value === "MCP_TOOL_ARTIFACT_TOO_LARGE") throw error;
      throw toolError("MCP_TOOL_PATH_INVALID");
    }
  }

  #sourceFileDigest(workspace, relativePath) {
    const source = this.#openSource(workspace, relativePath);
    let buffer;
    let result;
    let failure = null;
    try {
      const hash = crypto.createHash("sha256");
      buffer = Buffer.alloc(64 * 1024);
      let total = 0;
      while (true) {
        const read = this.fs.readSync(source.fd, buffer, 0, buffer.length, null);
        if (!Number.isSafeInteger(read) || read < 0) throw toolError("MCP_TOOL_PATH_INVALID");
        if (read === 0) break;
        total += read;
        if (total > MAX_ARTIFACT_BYTES) throw toolError("MCP_TOOL_ARTIFACT_TOO_LARGE");
        hash.update(buffer.subarray(0, read));
      }
      const after = this.fs.fstatSync(source.fd);
      if (after.size !== source.stat.size || after.mtimeMs !== source.stat.mtimeMs
        || after.ctimeMs !== source.stat.ctimeMs || total !== source.stat.size) {
        throw toolError("MCP_TOOL_PATH_INVALID");
      }
      result = { sizeBytes: total, sha256: hash.digest("hex") };
    } catch (error) {
      failure = error;
    } finally {
      if (buffer) buffer.fill(0);
      try { this.fs.closeSync(source.fd); } catch (error) {
        if (!failure) failure = error;
      }
    }
    if (failure) throw failure;
    return result;
  }

  #fsyncDirectory(target) {
    const fd = this.fs.openSync(target,
      this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0));
    try { this.fs.fsyncSync(fd); } finally { this.fs.closeSync(fd); }
  }

  #removePublishedFile(target, root) {
    try {
      this.fs.unlinkSync(target);
      this.#fsyncDirectory(root);
    } catch {
      const uncertain = toolError("MCP_TOOL_COMMIT_UNCERTAIN");
      throw uncertain;
    }
  }

  #privateFileDigest(target) {
    let fd;
    let buffer;
    try {
      const before = this.fs.lstatSync(target);
      if (!before.isFile?.() || before.isSymbolicLink?.() || before.nlink !== 1
        || (before.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
        throw toolError("MCP_TOOL_STATE_CONFLICT");
      }
      fd = this.fs.openSync(target,
        this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0));
      const opened = this.fs.fstatSync(fd);
      if (!opened.isFile?.() || opened.nlink !== 1 || opened.dev !== before.dev
        || opened.ino !== before.ino || opened.size > MAX_ARTIFACT_BYTES) {
        throw toolError("MCP_TOOL_STATE_CONFLICT");
      }
      const hash = crypto.createHash("sha256");
      buffer = Buffer.alloc(64 * 1024);
      let total = 0;
      while (true) {
        const read = this.fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!Number.isSafeInteger(read) || read < 0) throw toolError("MCP_TOOL_STATE_CONFLICT");
        if (read === 0) break;
        total += read;
        if (total > MAX_ARTIFACT_BYTES) throw toolError("MCP_TOOL_STATE_CONFLICT");
        hash.update(buffer.subarray(0, read));
      }
      const after = this.fs.fstatSync(fd);
      const afterPath = this.fs.lstatSync(target);
      if (total !== opened.size || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || !after.isFile?.() || after.nlink !== 1 || after.dev !== opened.dev
        || after.ino !== opened.ino || !afterPath.isFile?.()
        || afterPath.isSymbolicLink?.() || afterPath.nlink !== 1
        || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
        || afterPath.size !== opened.size || (afterPath.mode & 0o077) !== 0) {
        throw toolError("MCP_TOOL_STATE_CONFLICT");
      }
      return {
        sizeBytes: total,
        sha256: hash.digest("hex"),
        dev: opened.dev,
        ino: opened.ino,
      };
    } catch (error) {
      if (ownValue(error, "code").value === "MCP_TOOL_STATE_CONFLICT") throw error;
      throw toolError("MCP_TOOL_STATE_CONFLICT");
    } finally {
      if (buffer) buffer.fill(0);
      if (fd !== undefined) {
        try { this.fs.closeSync(fd); } catch {}
      }
    }
  }

  async #publishArtifact(runValue, cardValue, args, authority, call) {
    const root = this.#validateArtifactRoot();
    const storageLeaf = crypto.createHash("sha256")
      .update(authority.profileId).update("\0").update(authority.callId).digest("hex");
    const storageKey = `${path.basename(root)}/${storageLeaf}`;
    const target = path.join(root, storageLeaf);
    const binding = call.binding;
    if (!exactObject(binding, [
      "cardId", "runId", "storageKey", "name", "kind", "mimeType", "sizeBytes", "sha256",
    ]) || binding.cardId !== cardValue.id || binding.runId !== runValue.id
      || binding.storageKey !== storageKey || binding.name !== args.name
      || binding.kind !== args.kind || binding.mimeType !== args.mimeType
      || !Number.isSafeInteger(binding.sizeBytes) || binding.sizeBytes < 0
      || binding.sizeBytes > MAX_ARTIFACT_BYTES || !SHA256_PATTERN.test(binding.sha256)) {
      // pending 调用的冻结证据不完整时不能将它完成为普通失败。
      throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
    }
    const durableMatches = this.kanbanStore.listArtifacts(cardValue.id).filter((artifact) => (
      ownDataObject(artifact) && artifact.storageKey === storageKey
    ));
    if (durableMatches.length > 1) throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
    if (durableMatches.length === 1) {
      const durable = artifactDto(durableMatches[0]);
      if (durable.cardId !== cardValue.id || durable.runId !== runValue.id
        || durable.name !== binding.name || durable.kind !== binding.kind
        || durable.mimeType !== binding.mimeType || durable.createdAt !== call.createdAt
        || durable.sizeBytes !== binding.sizeBytes || durable.sha256 !== binding.sha256) {
        throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
      }
      let installed;
      try { installed = this.#privateFileDigest(target); } catch {
        throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
      }
      if (installed.sizeBytes !== durable.sizeBytes || installed.sha256 !== durable.sha256) {
        throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
      }
      return durable;
    }
    let targetExists = false;
    try {
      this.fs.lstatSync(target);
      targetExists = true;
    } catch (error) {
      const code = ownValue(error, "code");
      if (!code.ok || code.value !== "ENOENT") {
        throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
      }
    }
    if (targetExists) {
      let installed;
      try { installed = this.#privateFileDigest(target); } catch {
        throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
      }
      if (installed.sizeBytes !== binding.sizeBytes || installed.sha256 !== binding.sha256) {
        throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
      }
      return this.#storeArtifactReference({
        cardValue, runValue, binding, call, cleanupTarget: target, cleanupRoot: root,
      });
    }
    let tempNonce;
    try { tempNonce = this.randomUUID(); } catch { throw toolError("MCP_TOOL_UNAVAILABLE"); }
    if (!UUID_PATTERN.test(tempNonce)) throw toolError("MCP_TOOL_UNAVAILABLE");
    const source = this.#openSource(runValue.workspace, args.relativePath);
    const temp = path.join(root, `.${storageLeaf}.${tempNonce}.tmp`);
    let targetCreated = false;
    let tempFd;
    let transferBuffer;
    let total = 0;
    const hash = crypto.createHash("sha256");
    try {
      const flags = this.fs.constants.O_CREAT | this.fs.constants.O_EXCL
        | this.fs.constants.O_WRONLY | (this.fs.constants.O_NOFOLLOW || 0);
      tempFd = this.fs.openSync(temp, flags, 0o600);
      this.fs.fchmodSync(tempFd, 0o600);
      transferBuffer = Buffer.alloc(64 * 1024);
      while (true) {
        const read = this.fs.readSync(
          source.fd, transferBuffer, 0, transferBuffer.length, null,
        );
        if (!Number.isSafeInteger(read) || read < 0) throw toolError("MCP_TOOL_PATH_INVALID");
        if (read === 0) break;
        total += read;
        if (total > MAX_ARTIFACT_BYTES) throw toolError("MCP_TOOL_ARTIFACT_TOO_LARGE");
        const chunk = transferBuffer.subarray(0, read);
        hash.update(chunk);
        let offset = 0;
        while (offset < read) {
          const written = this.fs.writeSync(tempFd, chunk, offset, read - offset, null);
          if (!Number.isSafeInteger(written) || written <= 0) {
            throw toolError("MCP_TOOL_UNAVAILABLE");
          }
          offset += written;
        }
      }
      const after = this.fs.fstatSync(source.fd);
      if (after.size !== source.stat.size || after.mtimeMs !== source.stat.mtimeMs
        || after.ctimeMs !== source.stat.ctimeMs || total !== source.stat.size) {
        throw toolError("MCP_TOOL_PATH_INVALID");
      }
      const digest = hash.digest("hex");
      if (total !== binding.sizeBytes || digest !== binding.sha256) {
        throw toolError("MCP_TOOL_PATH_INVALID");
      }
      this.fs.fsyncSync(tempFd);
      const tempIdentity = this.fs.fstatSync(tempFd);
      if (!tempIdentity.isFile?.() || tempIdentity.nlink !== 1
        || tempIdentity.size !== binding.sizeBytes || (tempIdentity.mode & 0o077) !== 0) {
        throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
      }
      const tempStat = this.fs.lstatSync(temp);
      if (!tempStat.isFile?.() || tempStat.isSymbolicLink?.() || tempStat.nlink !== 1
        || tempStat.dev !== tempIdentity.dev || tempStat.ino !== tempIdentity.ino
        || tempStat.size !== tempIdentity.size
        || (tempStat.mode & 0o077) !== 0) throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
      try {
        this.fs.linkSync(temp, target);
        const linked = this.fs.lstatSync(target);
        const linkedFd = this.fs.fstatSync(tempFd);
        if (!linked.isFile?.() || linked.isSymbolicLink?.() || linked.nlink !== 2
          || linkedFd.nlink !== 2 || linked.dev !== tempIdentity.dev
          || linked.ino !== tempIdentity.ino || linkedFd.dev !== tempIdentity.dev
          || linkedFd.ino !== tempIdentity.ino || (linked.mode & 0o077) !== 0) {
          throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
        }
        this.fs.unlinkSync(temp);
        targetCreated = true;
        const installed = this.fs.lstatSync(target);
        const installedFd = this.fs.fstatSync(tempFd);
        if (!installed.isFile?.() || installed.isSymbolicLink?.() || installed.nlink !== 1
          || installedFd.nlink !== 1
          || installed.dev !== tempStat.dev || installed.ino !== tempStat.ino
          || installedFd.dev !== tempIdentity.dev || installedFd.ino !== tempIdentity.ino
          || (installed.mode & 0o077) !== 0) throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
        const verified = this.#privateFileDigest(target);
        if (verified.dev !== tempIdentity.dev || verified.ino !== tempIdentity.ino
          || verified.sizeBytes !== binding.sizeBytes || verified.sha256 !== binding.sha256) {
          throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
        }
        this.#fsyncDirectory(root);
      } catch (error) {
        if (ownValue(error, "code").value !== "EEXIST") throw error;
        const existing = this.#privateFileDigest(target);
        if (existing.sizeBytes !== binding.sizeBytes || existing.sha256 !== binding.sha256) {
          throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
        }
        this.fs.unlinkSync(temp);
        this.#fsyncDirectory(root);
      }
      this.fs.closeSync(tempFd);
      tempFd = undefined;
      return await this.#storeArtifactReference({
        cardValue, runValue, binding, call,
      });
    } catch (error) {
      if (tempFd !== undefined) {
        try { this.fs.closeSync(tempFd); } catch {}
      }
      try { this.fs.closeSync(source.fd); } catch {}
      try { this.fs.unlinkSync(temp); } catch (cleanupError) {
        if (ownValue(cleanupError, "code").value !== "ENOENT") {
          throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
        }
      }
      if (targetCreated && ownValue(error, "code").value !== "MCP_TOOL_COMMIT_UNCERTAIN") {
        this.#removePublishedFile(target, root);
      }
      throw error;
    } finally {
      if (transferBuffer) transferBuffer.fill(0);
      try { this.fs.closeSync(source.fd); } catch {}
    }
  }

  async #storeArtifactReference({
    cardValue, runValue, binding, call, cleanupTarget = null, cleanupRoot = null,
  }) {
    let artifact;
    try {
      artifact = await this.kanbanStore.addArtifact({
        operationId: call.operationId,
        cardId: binding.cardId,
        runId: binding.runId,
        name: binding.name,
        kind: binding.kind,
        mimeType: binding.mimeType,
        sizeBytes: binding.sizeBytes,
        sha256: binding.sha256,
        storageKey: binding.storageKey,
        createdAt: call.createdAt,
      });
    } catch (error) {
      const code = ownValue(error, "code");
      const uncertain = !code.ok || code.value === "KANBAN_COMMIT_UNCERTAIN"
        || ownValue(this.kanbanStore, "commitUncertain").value === true;
      if (uncertain) throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
      if (cleanupTarget !== null) this.#removePublishedFile(cleanupTarget, cleanupRoot);
      throw error;
    }
    const result = artifactDto(artifact);
    if (result.cardId !== cardValue.id || result.runId !== runValue.id
      || result.name !== binding.name || result.kind !== binding.kind
      || result.mimeType !== binding.mimeType || result.sizeBytes !== binding.sizeBytes
      || result.sha256 !== binding.sha256 || result.storageKey !== binding.storageKey
      || result.createdAt !== call.createdAt) {
      throw toolError("MCP_TOOL_COMMIT_UNCERTAIN");
    }
    return result;
  }
}

module.exports = {
  DEFAULT_TOOL_REGISTRY,
  MAX_ARTIFACT_BYTES,
  MCP_PRODUCT_TOOL_DEFINITIONS,
  MCP_PRODUCT_TOOL_NAMES,
  PUBLIC_MESSAGES,
  McpProductToolController,
  fingerprintMcpToolCall,
  sanitizeMcpProfile: sanitizeProfile,
  validateMcpProductToolArguments,
};
