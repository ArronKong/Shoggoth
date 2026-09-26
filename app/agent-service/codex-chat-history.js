"use strict";

const crypto = require("node:crypto");
const {
  federationInputProvenanceForOperationId,
} = require("../federation-chat-provenance");
const { serviceError } = require("./security");
const {
  CODEX_VERSION,
  CodexSchemaContract,
  isCodexSchemaContract,
} = require("./codex-schema-contract");
const {
  containsRegisteredSecret,
  redactDiagnostic,
  validateRegisteredSecrets,
} = require("./codex-rpc-safety");

const MAX_HISTORY_PAGE_BYTES = 64 * 1024;
const MAX_HISTORY_MESSAGE_BYTES = 48 * 1024;
const MAX_FRAGMENT_DATA_JSON_BYTES = 32 * 1024;
const MAX_HISTORY_INPUT_DEPTH = 64;
const MAX_HISTORY_GRAPH_NODES = 50_000;
const MAX_HISTORY_CONTAINER_WIDTH = 4_096;
const MAX_HISTORY_GRAPH_BYTES = 4 * 1024 * 1024;
const HISTORY_GRAPH_BUDGET = Object.freeze({
  maxBytes: MAX_HISTORY_GRAPH_BYTES,
  maxDepth: MAX_HISTORY_INPUT_DEPTH,
  maxNodes: MAX_HISTORY_GRAPH_NODES,
  maxWidth: MAX_HISTORY_CONTAINER_WIDTH,
});
const MAPPED_GRAPH_BUDGET = Object.freeze({ ...HISTORY_GRAPH_BUDGET, allowUndefined: true });
const CONTRACT_GRAPH_BUDGET = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxDepth: MAX_HISTORY_INPUT_DEPTH,
  maxNodes: 2_000_000,
  maxWidth: MAX_HISTORY_CONTAINER_WIDTH,
});
let pinnedContractReference = null;
let pinnedContractFingerprint = null;

function historyError(code, message) {
  return serviceError(code, message);
}

function normalizeCursorSecret(value) {
  const secret = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : typeof value === "string" ? Buffer.from(value, "utf8") : null;
  if (!secret || secret.length < 32 || secret.length > 1024) {
    throw historyError(
      "CODEX_HISTORY_CURSOR_SECRET_INVALID",
      "Codex history cursor secret 必须为 32..1024 bytes",
    );
  }
  return secret;
}

function contractEntriesFingerprint(entries, kind) {
  if (!entries || typeof entries !== "object") return null;
  return Object.fromEntries(Object.keys(entries).sort().map((name) => {
    const entry = entries[name];
    if (!entry || typeof entry !== "object") return [name, null];
    return [name, kind === "operation" ? {
      method: entry.method,
      paramsDefinition: entry.paramsDefinition,
      responseDefinition: entry.responseDefinition,
      responseRootTitle: entry.responseRoot?.title,
      responseRootDigest: digest(JSON.stringify(entry.responseRoot)),
    } : {
      paramsDefinition: entry.paramsDefinition,
      responseDefinition: entry.responseDefinition,
      rootTitle: entry.root?.title,
      rootDigest: digest(JSON.stringify(entry.root)),
      schemaDigest: digest(entry.schema),
    }];
  }));
}

function contractFingerprint(contract) {
  return digest({
    version: contract.version,
    legacySchema: digest(JSON.stringify(contract.legacySchema)),
    v2Schema: digest(JSON.stringify(contract.v2Schema)),
    operations: contractEntriesFingerprint(contract.operations, "operation"),
    serverRequests: contractEntriesFingerprint(contract.serverRequests, "serverRequest"),
  });
}

function getPinnedContractReference() {
  if (pinnedContractReference) return pinnedContractReference;
  const contract = new CodexSchemaContract();
  const fingerprint = contractFingerprint(contract);
  deepFreezeContract(contract);
  pinnedContractReference = contract;
  pinnedContractFingerprint = fingerprint;
  return contract;
}

function validatorRequired() {
  throw historyError(
    "CODEX_HISTORY_VALIDATOR_REQUIRED",
    "Codex history 需要完整的 pinned 0.149 schema contract",
  );
}

function createCodexChatHistoryMapper(options = {}) {
  const schemaContract = options.schemaContract;
  if (!isCodexSchemaContract(schemaContract)
    || !(schemaContract instanceof CodexSchemaContract)
    || Object.getPrototypeOf(schemaContract) !== CodexSchemaContract.prototype
    || schemaContract.validateResponse !== CodexSchemaContract.prototype.validateResponse
    || schemaContract.version !== CODEX_VERSION) {
    validatorRequired();
  }
  const cursorSecret = normalizeCursorSecret(options.cursorSecret);
  let pinnedContract;
  try {
    pinnedContract = getPinnedContractReference();
    if (contractFingerprint(schemaContract) !== pinnedContractFingerprint) validatorRequired();
    // 成功注入后冻结调用方合同；实际验证只使用模块私有的同指纹 pinned 副本，
    // 同时关闭注入前和 mapper 生命周期内的 public-state TOCTOU。
    deepFreezeContract(schemaContract);
  } catch (error) {
    if (error?.code === "CODEX_HISTORY_VALIDATOR_REQUIRED") throw error;
    validatorRequired();
  }
  const validateResponse = CodexSchemaContract.prototype.validateResponse.bind(pinnedContract);
  const validatedHandles = new WeakSet();
  return Object.freeze({
    validateCodexThreadRead(response) {
      return validateCodexThreadRead(response, validateResponse, validatedHandles);
    },
    createCodexChatHistoryPage(handle, pageOptions) {
      return createCodexChatHistoryPage(handle, pageOptions, cursorSecret, validatedHandles);
    },
    reassembleCodexHistoryFragments,
  });
}

function graphLimitExceeded(message) {
  throw historyError("CODEX_HISTORY_INPUT_INVALID", message);
}

function addWithinGraphLimit(current, addition, maximum, message) {
  if (!Number.isSafeInteger(addition) || addition < 0 || addition > maximum - current) {
    graphLimitExceeded(message);
  }
  return current + addition;
}

function jsonStringBytes(value, maximum) {
  if (Buffer.byteLength(value, "utf8") > maximum) {
    graphLimitExceeded("Codex history 输入字节超过协议限制");
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > maximum) {
    graphLimitExceeded("Codex history 输入字节超过协议限制");
  }
  return bytes;
}

// 同时统计唯一对象与 JSON 逻辑展开量：WeakMap 使共享 DAG 只扫描一次，
// ancestors 单独识别真正循环，缓存的 bytes/nodes 又能在常数时间内拒绝指数展开。
function assertBoundedJsonGraph(value, budget = HISTORY_GRAPH_BUDGET) {
  const ancestors = new WeakSet();
  const memo = new WeakMap();
  let uniqueNodes = 0;

  const visit = (current, depth) => {
    if (depth > budget.maxDepth) {
      graphLimitExceeded("Codex history 输入层级超过协议限制");
    }
    if (current === null || typeof current === "boolean") {
      return { bytes: current === null ? 4 : (current ? 4 : 5), height: 0, nodes: 1 };
    }
    if (typeof current === "string") {
      return { bytes: jsonStringBytes(current, budget.maxBytes), height: 0, nodes: 1 };
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        graphLimitExceeded("Codex history 输入不是有限 JSON 数字");
      }
      return { bytes: Buffer.byteLength(JSON.stringify(current), "utf8"), height: 0, nodes: 1 };
    }
    if (current === undefined && budget.allowUndefined === true) {
      return { bytes: 4, height: 0, nodes: 1 };
    }
    if (!current || typeof current !== "object") {
      graphLimitExceeded("Codex history 输入不是稳定 JSON");
    }
    if (ancestors.has(current)) {
      graphLimitExceeded("Codex history 输入不是稳定 JSON");
    }
    const cached = memo.get(current);
    if (cached) {
      if (depth + cached.height > budget.maxDepth) {
        graphLimitExceeded("Codex history 输入层级超过协议限制");
      }
      return cached;
    }

    uniqueNodes += 1;
    if (uniqueNodes > budget.maxNodes) {
      graphLimitExceeded("Codex history 输入节点超过协议限制");
    }
    ancestors.add(current);
    try {
      let keys;
      let bytes = 2;
      let height = 0;
      let nodes = 1;
      if (Array.isArray(current)) {
        if (current.length > budget.maxWidth) {
          graphLimitExceeded("Codex history 输入容器宽度超过协议限制");
        }
        keys = Object.keys(current);
        if (Reflect.ownKeys(current).length !== current.length + 1
          || keys.length !== current.length) {
          graphLimitExceeded("Codex history 输入数组不连续");
        }
        if (keys.length > 1) bytes = addWithinGraphLimit(
          bytes, keys.length - 1, budget.maxBytes,
          "Codex history 输入字节超过协议限制",
        );
        for (let index = 0; index < keys.length; index += 1) {
          if (keys[index] !== String(index)) {
            graphLimitExceeded("Codex history 输入数组不连续");
          }
          const descriptor = Object.getOwnPropertyDescriptor(current, keys[index]);
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            graphLimitExceeded("Codex history 输入包含访问器");
          }
          const child = visit(descriptor.value, depth + 1);
          bytes = addWithinGraphLimit(
            bytes, child.bytes, budget.maxBytes,
            "Codex history 输入字节超过协议限制",
          );
          nodes = addWithinGraphLimit(
            nodes, child.nodes, budget.maxNodes,
            "Codex history 输入节点超过协议限制",
          );
          height = Math.max(height, child.height + 1);
        }
      } else {
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) {
          graphLimitExceeded("Codex history 输入对象类型无效");
        }
        keys = Reflect.ownKeys(current);
        if (keys.length > budget.maxWidth) {
          graphLimitExceeded("Codex history 输入容器宽度超过协议限制");
        }
        if (keys.some((key) => typeof key !== "string")) {
          graphLimitExceeded("Codex history 输入字段无效");
        }
        if (keys.length > 1) bytes = addWithinGraphLimit(
          bytes, keys.length - 1, budget.maxBytes,
          "Codex history 输入字节超过协议限制",
        );
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            graphLimitExceeded("Codex history 输入包含访问器");
          }
          bytes = addWithinGraphLimit(
            bytes, jsonStringBytes(key, budget.maxBytes) + 1, budget.maxBytes,
            "Codex history 输入字节超过协议限制",
          );
          const child = visit(descriptor.value, depth + 1);
          bytes = addWithinGraphLimit(
            bytes, child.bytes, budget.maxBytes,
            "Codex history 输入字节超过协议限制",
          );
          nodes = addWithinGraphLimit(
            nodes, child.nodes, budget.maxNodes,
            "Codex history 输入节点超过协议限制",
          );
          height = Math.max(height, child.height + 1);
        }
      }
      const result = { bytes, height, nodes };
      memo.set(current, result);
      return result;
    } finally {
      ancestors.delete(current);
    }
  };

  return visit(value, 0);
}

function clonePageOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw historyError("CODEX_HISTORY_INPUT_INVALID", "Codex history options 必须是稳定 JSON 对象");
  }
  let normalized = value;
  try {
    const cursorDescriptor = Object.getOwnPropertyDescriptor(value, "cursor");
    if (cursorDescriptor?.enumerable
      && "value" in cursorDescriptor
      && cursorDescriptor.value === undefined) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      descriptors.cursor = { ...cursorDescriptor, value: null };
      normalized = Object.create(Object.getPrototypeOf(value), descriptors);
    }
    assertBoundedJsonGraph(normalized);
    return structuredClone(normalized);
  } catch {
    throw historyError("CODEX_HISTORY_INPUT_INVALID", "Codex history options 无法建立稳定快照");
  }
}

function deepFreeze(value, budget = HISTORY_GRAPH_BUDGET) {
  assertBoundedJsonGraph(value, budget);
  const visited = new WeakSet();
  const freeze = (current) => {
    if (!current || typeof current !== "object" || visited.has(current)) return;
    visited.add(current);
    for (const key of Reflect.ownKeys(current)) {
      if (Array.isArray(current) && key === "length") continue;
      freeze(Object.getOwnPropertyDescriptor(current, key).value);
    }
    Object.freeze(current);
  };
  freeze(value);
  return value;
}

function deepFreezeContract(contract) {
  for (const value of Object.values(contract)) deepFreeze(value, CONTRACT_GRAPH_BUDGET);
  return Object.freeze(contract);
}

function normalizeThreadDefaults(thread) {
  for (const turn of thread.turns) {
    turn.itemsView ??= "full";
    for (const item of turn.items) {
      if (item.type === "reasoning") {
        item.summary ??= [];
        item.content ??= [];
      } else if (item.type === "mcpToolCall") {
        item.error ??= null;
        item.result ??= null;
      } else if (item.type === "dynamicToolCall") {
        item.contentItems ??= null;
      } else if (item.type === "webSearch") {
        item.results ??= null;
      } else if (item.type === "imageGeneration") {
        item.failure ??= null;
      } else if (item.type === "commandExecution") {
        item.source ??= "agent";
      }
    }
  }
}

function stableJson(value) {
  assertBoundedJsonGraph(value);
  return serializeStableJson(value);
}

function serializeStableJson(value) {
  if (Array.isArray(value)) return `[${value.map(serializeStableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${serializeStableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value))
    .digest("hex");
}

function redactJson(value, registeredSecrets) {
  assertBoundedJsonGraph(value, MAPPED_GRAPH_BUDGET);
  const ancestors = new WeakSet();
  const memo = new WeakMap();
  const redact = (current) => {
    if (typeof current === "string") return redactDiagnostic(current, registeredSecrets);
    if (current === undefined) return undefined;
    if (current === null || typeof current === "boolean" || typeof current === "number") {
      return current;
    }
    if (ancestors.has(current)) {
      graphLimitExceeded("Codex history DTO 输入不是稳定 JSON");
    }
    const cached = memo.get(current);
    if (cached) return cached;
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const output = [];
        memo.set(current, output);
        for (const entry of current) output.push(redact(entry) ?? null);
        return output;
      }
      const output = Object.create(Object.getPrototypeOf(current) === null
        ? null : Object.prototype);
      memo.set(current, output);
      for (const [rawKey, rawValue] of Object.entries(current)) {
        const child = redact(rawValue);
        if (child === undefined) continue;
        const keyBase = redactDiagnostic(rawKey, registeredSecrets) || "redacted";
        let key = keyBase;
        for (let suffix = 2; Object.hasOwn(output, key); suffix += 1) key = `${keyBase}#${suffix}`;
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: child,
          writable: true,
        });
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  };
  const output = redact(value);
  assertBoundedJsonGraph(output);
  return output;
}

function signCursor(cursorSecret, payload) {
  return crypto.createHmac("sha256", cursorSecret).update(payload).digest();
}

function encodeCursor(cursorSecret, threadBinding, revision, before) {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, t: threadBinding, r: revision, b: before }),
    "utf8",
  );
  return `${payload.toString("base64url")}.${signCursor(cursorSecret, payload).toString("base64url")}`;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function jsonlBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
}

function splitJsonString(value, maxEncodedBytes) {
  const chunks = [];
  let current = "";
  let used = 0;
  for (const codePoint of value) {
    const encodedBytes = Buffer.byteLength(JSON.stringify(codePoint), "utf8") - 2;
    if (encodedBytes > maxEncodedBytes) {
      throw historyError("CODEX_HISTORY_FRAGMENT_LIMIT", "Codex history fragment 无法编码");
    }
    if (current && used + encodedBytes > maxEncodedBytes) {
      chunks.push(current);
      current = "";
      used = 0;
    }
    current += codePoint;
    used += encodedBytes;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function fragmentMessage(message) {
  if (jsonBytes(message) < MAX_HISTORY_MESSAGE_BYTES) return [message];
  const serialized = JSON.stringify(message);
  const chunks = splitJsonString(serialized, MAX_FRAGMENT_DATA_JSON_BYTES);
  const sha256 = digest(serialized);
  return chunks.map((data, index) => {
    const fragment = {
      kind: "fragment",
      id: message.id,
      role: message.role,
      fragment: {
        messageId: message.id,
        index,
        count: chunks.length,
        encoding: "gateway-message-json-utf8",
        sha256,
      },
      data,
    };
    if (jsonBytes(fragment) >= MAX_HISTORY_MESSAGE_BYTES) {
      throw historyError("CODEX_HISTORY_FRAGMENT_LIMIT", "Codex history fragment 超过协议限制");
    }
    return fragment;
  });
}

function decodeCursor(value, cursorSecret) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw historyError("CODEX_HISTORY_CURSOR_INVALID", "Codex history cursor 无效");
  }
  try {
    const parts = value.split(".");
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) {
      throw new Error("invalid cursor envelope");
    }
    const payload = Buffer.from(parts[0], "base64url");
    const signature = Buffer.from(parts[1], "base64url");
    if (payload.toString("base64url") !== parts[0]
      || signature.toString("base64url") !== parts[1]
      || signature.length !== 32
      || !crypto.timingSafeEqual(signature, signCursor(cursorSecret, payload))) {
      throw new Error("invalid cursor signature");
    }
    const cursor = JSON.parse(payload.toString("utf8"));
    if (!cursor || Object.getPrototypeOf(cursor) !== Object.prototype
      || Object.keys(cursor).sort().join(",") !== "b,r,t,v"
      || cursor.v !== 1 || typeof cursor.t !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.t)
      || typeof cursor.r !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.r)
      || !Number.isSafeInteger(cursor.b) || cursor.b <= 0) {
      throw new Error("invalid cursor");
    }
    return cursor;
  } catch (error) {
    if (error?.code === "CODEX_HISTORY_CURSOR_INVALID") throw error;
    throw historyError("CODEX_HISTORY_CURSOR_INVALID", "Codex history cursor 无效");
  }
}

function validateCodexThreadRead(response, validateResponse, validatedHandles) {
  if (typeof validateResponse !== "function") {
    throw historyError("CODEX_HISTORY_VALIDATOR_REQUIRED", "Codex history 需要 schema contract");
  }
  assertBoundedJsonGraph(response);
  let snapshot;
  try {
    snapshot = structuredClone(response);
    validateResponse("threadRead", snapshot);
  } catch (error) {
    if (error?.code) throw error;
    throw historyError("CODEX_HISTORY_SCHEMA_ERROR", "Codex ThreadRead schema 验证失败");
  }
  assertBoundedJsonGraph(snapshot);
  if (!snapshot?.thread || !Array.isArray(snapshot.thread.turns)
    || snapshot.thread.turns.some((turn) => (turn?.itemsView ?? "full") !== "full")) {
    throw historyError("CODEX_HISTORY_INCOMPLETE", "Codex thread/read 未返回完整 turns");
  }
  normalizeThreadDefaults(snapshot.thread);
  const handle = deepFreeze({ thread: snapshot.thread });
  validatedHandles.add(handle);
  return handle;
}

function messageId(threadId, turnId, itemId, itemIndex) {
  return `codex-${digest([threadId, turnId, itemId, itemIndex]).slice(0, 32)}`;
}

function errorCodeOf(error) {
  const value = error?.codexErrorInfo;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return Object.keys(value)[0] || "other";
  return null;
}

function errorTextOf(error) {
  if (!error) return null;
  return [error.message, error.additionalDetails]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n") || null;
}

function turnMetadata(thread, turn, item, itemIndex, options) {
  const secondsToMs = (value) => {
    if (!Number.isSafeInteger(value)) return null;
    const milliseconds = value * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  };
  const supplied = options.usageByTurn?.[turn.id];
  const model = typeof supplied?.model === "string" ? supplied.model : options.model;
  const usage = supplied?.usage && typeof supplied.usage === "object"
    ? structuredClone(supplied.usage) : null;
  const errorMessage = errorTextOf(turn.error);
  return {
    id: messageId(thread.id, turn.id, item.id, itemIndex),
    timestamp: secondsToMs(turn.completedAt) ?? secondsToMs(turn.startedAt),
    model: model ?? null,
    provider: thread.modelProvider,
    usage,
    stopReason: turn.status === "failed" ? "error" : turn.status,
    errorMessage,
    isError: turn.status === "failed",
    codex: {
      threadId: thread.id,
      turnId: turn.id,
      itemId: item.id,
      itemType: item.type,
      status: turn.status,
      errorCode: errorCodeOf(turn.error),
      startedAt: secondsToMs(turn.startedAt),
      completedAt: secondsToMs(turn.completedAt),
      durationMs: turn.durationMs,
    },
  };
}

function mapItem(thread, turn, item, itemIndex, options) {
  const base = turnMetadata(thread, turn, item, itemIndex, options);
  if (item.type === "userMessage") {
    const provenance = federationInputProvenanceForOperationId(item.clientId);
    return {
      ...base,
      role: "user",
      ...(provenance ? { provenance } : {}),
      content: item.content.map((entry) => entry.type === "text"
        ? { type: "text", text: entry.text }
        : {
          type: "text",
          text: `[${entry.type}] ${entry.url ?? entry.path ?? entry.name ?? ""}`.trim(),
          semanticType: "userInput",
        }),
    };
  }
  if (item.type === "hookPrompt") {
    return {
      ...base,
      role: "system",
      content: [{
        type: "text",
        text: item.fragments.map((fragment) => fragment.text).join("\n"),
        semanticType: "hookPrompt",
      }],
    };
  }
  if (item.type === "agentMessage") {
    return {
      ...base,
      role: "assistant",
      content: [{ type: "text", text: item.text }],
    };
  }
  if (item.type === "reasoning") {
    return {
      ...base,
      role: "assistant",
      content: [
        ...(item.summary ?? []).map((thinking) => ({
          type: "thinking", thinking, reasoningKind: "summary",
        })),
        ...(item.content ?? []).map((thinking) => ({
          type: "thinking", thinking, reasoningKind: "content",
        })),
      ],
    };
  }
  if (item.type === "plan") {
    return {
      ...base,
      role: "assistant",
      content: [{ type: "text", text: item.text, semanticType: "plan" }],
    };
  }
  if (item.type === "commandExecution") {
    const failed = item.status === "failed" || item.status === "declined";
    return {
      ...base,
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolName: "command",
          arguments: {
            command: item.command,
            cwd: item.cwd,
            source: item.source,
            commandActions: item.commandActions,
          },
        },
        {
          type: "tool_result",
          name: "command",
          content: item.aggregatedOutput ?? "",
          is_error: failed,
          status: item.status,
          exitCode: item.exitCode,
          durationMs: item.durationMs,
        },
      ],
    };
  }
  if (item.type === "mcpToolCall") {
    const toolName = `${item.server}/${item.tool}`;
    const error = item.error ?? null;
    const resultValue = item.result ?? null;
    const result = error?.message ?? (resultValue === null ? "" : stableJson(resultValue));
    return {
      ...base,
      role: "assistant",
      content: [
        { type: "toolCall", toolName, arguments: item.arguments },
        {
          type: "tool_result",
          name: toolName,
          content: result,
          is_error: error !== null || item.status === "failed",
          status: item.status,
          durationMs: item.durationMs,
        },
      ],
    };
  }
  if (item.type === "dynamicToolCall") {
    const toolName = item.namespace ? `${item.namespace}/${item.tool}` : item.tool;
    const contentItems = item.contentItems ?? null;
    return {
      ...base,
      role: "assistant",
      content: [
        { type: "toolCall", toolName, arguments: item.arguments },
        {
          type: "tool_result",
          name: toolName,
          content: contentItems === null ? "" : stableJson(contentItems),
          is_error: item.success === false || item.status === "failed",
          status: item.status,
          durationMs: item.durationMs,
        },
      ],
    };
  }
  if (item.type === "fileChange") {
    return {
      ...base,
      role: "assistant",
      content: [
        { type: "toolCall", toolName: "fileChange", arguments: { changes: item.changes } },
        {
          type: "tool_result",
          name: "fileChange",
          content: stableJson(item.changes),
          is_error: item.status === "failed" || item.status === "declined",
          status: item.status,
        },
      ],
    };
  }
  if (item.type === "collabAgentToolCall") {
    const toolName = `collab/${typeof item.tool === "string" ? item.tool : "agent"}`;
    return {
      ...base,
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolName,
          arguments: {
            senderThreadId: item.senderThreadId,
            receiverThreadIds: item.receiverThreadIds,
            prompt: item.prompt,
            model: item.model,
            reasoningEffort: item.reasoningEffort,
          },
        },
        {
          type: "tool_result",
          name: toolName,
          content: stableJson(item.agentsStates),
          is_error: item.status === "failed" || item.status === "declined",
          status: item.status,
        },
      ],
    };
  }
  if (item.type === "subAgentActivity") {
    return {
      ...base,
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolName: "collab/subAgentActivity",
          arguments: {
            kind: item.kind,
            agentThreadId: item.agentThreadId,
            agentPath: item.agentPath,
          },
        },
        {
          type: "tool_result",
          name: "collab/subAgentActivity",
          content: stableJson({ kind: item.kind, agentPath: item.agentPath }),
          is_error: false,
        },
      ],
    };
  }
  if (item.type === "webSearch") {
    const results = item.results ?? null;
    return {
      ...base,
      role: "assistant",
      content: [
        { type: "toolCall", toolName: "webSearch", arguments: { query: item.query, action: item.action } },
        {
          type: "tool_result",
          name: "webSearch",
          content: results === null ? "" : stableJson(results),
          is_error: false,
        },
      ],
    };
  }
  if (item.type === "imageView") {
    return {
      ...base,
      role: "assistant",
      content: [
        { type: "toolCall", toolName: "imageView", arguments: { path: item.path } },
        { type: "tool_result", name: "imageView", content: "viewed", is_error: false },
      ],
    };
  }
  if (item.type === "imageGeneration") {
    const failure = item.failure ?? null;
    return {
      ...base,
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolName: "imageGeneration",
          arguments: { revisedPrompt: item.revisedPrompt },
        },
        {
          type: "tool_result",
          name: "imageGeneration",
          content: failure === null ? item.result : stableJson(failure),
          is_error: failure !== null || item.status === "failed",
          status: item.status,
        },
      ],
    };
  }
  if (item.type === "sleep") {
    return {
      ...base,
      role: "assistant",
      content: [
        { type: "toolCall", toolName: "sleep", arguments: { durationMs: item.durationMs } },
        {
          type: "tool_result",
          name: "sleep",
          content: `Slept ${item.durationMs}ms`,
          is_error: false,
        },
      ],
    };
  }
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return {
      ...base,
      role: "assistant",
      content: [{ type: "text", text: item.review, semanticType: "reviewMode" }],
    };
  }
  if (item.type === "contextCompaction") {
    return {
      ...base,
      role: "assistant",
      content: [{
        type: "text",
        text: "Context compacted",
        semanticType: "contextCompaction",
      }],
    };
  }
  return {
    ...base,
    role: "assistant",
    content: [{ type: "text", text: `[Unsupported Codex item: ${item.type}]` }],
    unsupported: true,
  };
}

function createCodexChatHistoryPage(handle, options = {}, cursorSecret, validatedHandles) {
  if (!validatedHandles.has(handle)) {
    throw historyError("CODEX_HISTORY_THREAD_NOT_VALIDATED", "Codex history 只接受已验证 Thread");
  }
  options = clonePageOptions(options);
  const limit = options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw historyError("CODEX_HISTORY_LIMIT_INVALID", "Codex history limit 必须为 1..100");
  }
  const registeredSecrets = validateRegisteredSecrets(options.registeredSecrets || []);
  const thread = handle.thread;
  const mappedMessages = [];
  for (const turn of thread.turns) {
    if (turn.items.length === 0 && turn.status === "failed") {
      const synthetic = {
        type: "turnStatus",
        id: `turn-status-${digest([thread.id, turn.id]).slice(0, 24)}`,
      };
      const base = turnMetadata(thread, turn, synthetic, 0, options);
      mappedMessages.push({
        ...base,
        role: "assistant",
        content: [{ type: "text", text: base.errorMessage || "Codex turn failed" }],
      });
      continue;
    }
    for (let itemIndex = 0; itemIndex < turn.items.length; itemIndex += 1) {
      mappedMessages.push(mapItem(thread, turn, turn.items[itemIndex], itemIndex, options));
    }
  }
  const canonicalMessages = redactJson(mappedMessages, registeredSecrets);
  // revision 只绑定实际输出的脱敏 DTO，不嵌入原始 secret 或其无键 digest。
  const revision = digest(canonicalMessages);
  const threadBinding = crypto.createHmac("sha256", cursorSecret)
    .update(String(thread.id), "utf8")
    .digest("hex");
  const messages = canonicalMessages.flatMap(fragmentMessage);
  let end = messages.length;
  if (options.cursor != null) {
    const cursor = decodeCursor(options.cursor, cursorSecret);
    if (cursor.t !== threadBinding) {
      throw historyError("CODEX_HISTORY_CURSOR_THREAD_MISMATCH", "Codex history cursor 属于其他 thread");
    }
    if (cursor.r !== revision) {
      throw historyError("CODEX_HISTORY_CURSOR_STALE", "Codex history 内容已变化");
    }
    if (cursor.b > messages.length) {
      throw historyError("CODEX_HISTORY_CURSOR_INVALID", "Codex history cursor 越界");
    }
    end = cursor.b;
  }
  let start = end;
  let result = null;
  while (start > 0 && end - start < limit) {
    const candidateStart = start - 1;
    const candidateHasMore = candidateStart > 0;
    const candidate = {
      threadId: redactDiagnostic(thread.id, registeredSecrets),
      revision,
      messages: messages.slice(candidateStart, end),
      nextCursor: candidateHasMore
        ? encodeCursor(cursorSecret, threadBinding, revision, candidateStart) : null,
      hasMore: candidateHasMore,
    };
    if (jsonlBytes(candidate) >= MAX_HISTORY_PAGE_BYTES) break;
    start = candidateStart;
    result = candidate;
  }
  if (!result) {
    const hasMore = start > 0;
    result = {
      threadId: redactDiagnostic(thread.id, registeredSecrets),
      revision,
      messages: [],
      nextCursor: hasMore ? encodeCursor(cursorSecret, threadBinding, revision, start) : null,
      hasMore,
    };
    if (end > 0) {
      throw historyError("CODEX_HISTORY_PAGE_LIMIT", "Codex history 单项无法装入响应预算");
    }
  }
  if (jsonlBytes(result) >= MAX_HISTORY_PAGE_BYTES) {
    throw historyError("CODEX_HISTORY_PAGE_LIMIT", "Codex history 响应超过协议限制");
  }
  if (containsRegisteredSecret(JSON.stringify(result), registeredSecrets)) {
    throw historyError("CODEX_HISTORY_SECRET_REJECTED", "Codex history DTO 未通过敏感信息检查");
  }
  return deepFreeze(result);
}

function reassembleCodexHistoryFragments(messages) {
  if (!Array.isArray(messages)) {
    throw historyError("CODEX_HISTORY_FRAGMENT_INVALID", "Codex history fragments 必须是数组");
  }
  assertBoundedJsonGraph(messages);
  const output = [];
  for (let index = 0; index < messages.length;) {
    const entry = messages[index];
    if (entry?.kind !== "fragment") {
      output.push(structuredClone(entry));
      index += 1;
      continue;
    }
    const identity = entry.fragment;
    if (!identity || identity.index !== 0 || !Number.isSafeInteger(identity.count)
      || identity.count <= 0 || typeof identity.messageId !== "string"
      || identity.encoding !== "gateway-message-json-utf8"
      || typeof identity.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(identity.sha256)) {
      throw historyError("CODEX_HISTORY_FRAGMENT_INCOMPLETE", "Codex history fragment 不完整");
    }
    const group = messages.slice(index, index + identity.count);
    if (group.length !== identity.count || group.some((fragment, fragmentIndex) => (
      fragment?.kind !== "fragment"
      || fragment.fragment?.messageId !== identity.messageId
      || fragment.fragment?.index !== fragmentIndex
      || fragment.fragment?.count !== identity.count
      || fragment.fragment?.encoding !== identity.encoding
      || fragment.fragment?.sha256 !== identity.sha256
      || typeof fragment.data !== "string"
    ))) {
      throw historyError("CODEX_HISTORY_FRAGMENT_INCOMPLETE", "Codex history fragment 不完整");
    }
    const serialized = group.map((fragment) => fragment.data).join("");
    if (digest(serialized) !== identity.sha256) {
      throw historyError("CODEX_HISTORY_FRAGMENT_CORRUPT", "Codex history fragment 校验失败");
    }
    let message;
    try { message = JSON.parse(serialized); } catch {
      throw historyError("CODEX_HISTORY_FRAGMENT_CORRUPT", "Codex history fragment 无法重组");
    }
    if (message?.id !== identity.messageId) {
      throw historyError("CODEX_HISTORY_FRAGMENT_CORRUPT", "Codex history fragment identity 不匹配");
    }
    assertBoundedJsonGraph(message);
    output.push(message);
    index += identity.count;
  }
  assertBoundedJsonGraph(output);
  return deepFreeze(output);
}

module.exports = {
  MAX_HISTORY_MESSAGE_BYTES,
  MAX_HISTORY_PAGE_BYTES,
  createCodexChatHistoryMapper,
  reassembleCodexHistoryFragments,
};
