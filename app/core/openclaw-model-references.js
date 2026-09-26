"use strict";

// OpenClaw 模型引用扫描器：只做完整枚举、纯 patch 计算与条件写契约，preview
// 阶段绝不写入。所有未知分页/路径/并发能力都 fail-closed。

const { createHash } = require("node:crypto");
const {
  OpenClawAgentConfigError,
  readCanonicalAgentEntries,
  readDefaultModelPolicyAllow,
  readAgentModelPolicyAllow,
} = require("./openclaw-agent-config");

const OPENCLAW_SCANNER_VERSION = 2;
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGES = 100;
const SCANNER_METHODS = Object.freeze(["enumerate", "read", "write", "verify", "undo"]);

const OPENCLAW_MODEL_PATHS = Object.freeze([
  "models.providers.*.models[*].id",
  "agents.defaults.model.primary",
  "agents.defaults.model.fallbacks[*]",
  "agents.defaults.modelPolicy.allow[*]",
  "agents.entries.*.model.primary",
  "agents.entries.*.model.fallbacks[*]",
  "agents.entries.*.modelPolicy.allow[*]",
  "agents.defaults.subagents.model",
]);

/** 引用扫描/lease 的稳定错误，调用方按 code fail-closed。 */
class OpenClawReferenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OpenClawReferenceError";
    this.code = code;
    this.status = 409;
    this.details = details;
  }
}

/** 递归排序对象键，保证 fingerprint 不受属性插入顺序影响。 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  const primitive = JSON.stringify(value);
  return primitive === undefined ? "null" : primitive;
}

/** 对不含凭证的公开扫描数据计算内容摘要。 */
function fingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** JSON 数据深拷贝；OpenClaw RPC payload 必须是可序列化对象。 */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 同时兼容 backend.request 与测试中的函数式 RPC。 */
async function requestRpc(rpc, method, params = {}) {
  if (typeof rpc === "function") return rpc(method, params);
  if (rpc && typeof rpc.request === "function") return rpc.request(method, params);
  throw new TypeError("rpc 必须是函数或提供 request(method, params)");
}

/** 读取 adapter 明确声明的分页与 mutation 能力；不根据响应猜测新协议。 */
async function readCapabilities(rpc) {
  if (rpc && typeof rpc.getModelReferenceCapabilities === "function") {
    const value = await rpc.getModelReferenceCapabilities();
    return value && typeof value === "object" ? value : {};
  }
  return rpc?.capabilities && typeof rpc.capabilities === "object" ? rpc.capabilities : {};
}

/** 将页上限限制在安全范围，异常声明退回固定默认值。 */
function pageLimit(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 500 ? value : DEFAULT_PAGE_LIMIT;
}

/** 构造不包含函数、可安全进入 preview/journal 的引用记录。 */
function makeReference(scannerId, store, referenceKey, before, after, extra = {}) {
  const safeBefore = clone(before);
  const safeAfter = clone(after);
  return {
    scannerId,
    store,
    referenceKey,
    before: safeBefore,
    after: safeAfter,
    undo: safeBefore,
    fingerprint: fingerprint({ referenceKey, before: safeBefore }),
    ...extra,
  };
}

/** 创建稳定 blocker；store/referenceKey 便于 UI 指出阻断来源。 */
function blocker(code, store, message, details = {}) {
  return { code, store, message, ...details };
}

/** 从配置 Provider 模型定义建立裸 ID 的 Provider 集合，用于安全消歧。 */
function providersByModelId(parsed) {
  const result = new Map();
  const providers = parsed?.models?.providers;
  if (!providers || typeof providers !== "object") return result;
  for (const [providerKey, provider] of Object.entries(providers)) {
    for (const model of Array.isArray(provider?.models) ? provider.models : []) {
      const id = typeof model?.id === "string" ? model.id : "";
      if (!id) continue;
      if (!result.has(id)) result.set(id, new Set());
      result.get(id).add(providerKey);
    }
  }
  return result;
}

/**
 * 返回模型字符串是否精确指向 source 以及迁移后的等价写法。裸 ID 只有在配置中
 * 唯一属于 source Provider 时才可改；否则返回 ambiguous，绝不猜测。
 */
function createModelMatcher(parsed, safeSpec) {
  const providerKey = String(safeSpec?.providerKey || "");
  const sourceModelId = String(safeSpec?.sourceModelId || "");
  const targetModelId = String(safeSpec?.model?.id || "");
  const owners = providersByModelId(parsed);
  const matchValue = (value) => {
    if (typeof value !== "string" || !sourceModelId || !targetModelId) {
      return { matched: false, ambiguous: false, after: value };
    }
    if (value === `${providerKey}/${sourceModelId}`) {
      return { matched: true, ambiguous: false, after: `${providerKey}/${targetModelId}` };
    }
    if (value !== sourceModelId) return { matched: false, ambiguous: false, after: value };
    const sourceOwners = owners.get(sourceModelId) || new Set();
    if (sourceOwners.size === 1 && sourceOwners.has(providerKey)) {
      return { matched: true, ambiguous: false, after: targetModelId };
    }
    return { matched: false, ambiguous: true, after: value };
  };
  // Session 缺 Provider override 时需要判断是否正好命中 source，不能靠闭包外猜测。
  matchValue.sourceModelId = sourceModelId;
  return matchValue;
}

/** 对一个精确声明的 config 字符串路径生成引用或歧义 blocker。 */
function inspectConfigValue(value, path, matcher, references, blockers, extra = {}) {
  const match = matcher(value);
  if (match.matched) {
    references.push(makeReference("openclaw.config.v2", "config", path, value, match.after, extra));
  } else if (match.ambiguous) {
    blockers.push(blocker(
      "ambiguous_model_reference",
      "config",
      "裸模型 ID 同时属于多个 Provider，无法安全迁移",
      { referenceKey: path },
    ));
  }
}

/** modelPolicy.allow 可含 alias/wildcard；只迁移精确 provider/model ref。 */
function inspectModelPolicyRef(value, path, safeSpec, references, extra = {}) {
  const source = `${safeSpec.providerKey}/${safeSpec.sourceModelId}`;
  const providerPrefix = `${safeSpec.providerKey}/`;
  const matched = typeof value === "string" && (
    safeSpec.kind === "delete-provider" ? value.startsWith(providerPrefix) : value === source
  );
  if (!matched) return;
  const after = safeSpec.kind === "rename"
    ? `${safeSpec.providerKey}/${safeSpec.model?.id}`
    : value;
  references.push(makeReference(
    "openclaw.config.v2",
    "config",
    path,
    value,
    after,
    extra,
  ));
}

/** 判断 config 叶子路径是否属于版本化白名单。 */
function isKnownConfigModelPath(path) {
  return /^models\.providers\.[^.]+\.models\[\d+\]\.id$/.test(path)
    || path === "agents.defaults.model.primary"
    || /^agents\.defaults\.model\.fallbacks\[\d+\]$/.test(path)
    || /^agents\.defaults\.modelPolicy\.allow\[\d+\]$/.test(path)
    || /^agents\.entries\.[^.]+\.model\.primary$/.test(path)
    || /^agents\.entries\.[^.]+\.model\.fallbacks\[\d+\]$/.test(path)
    || /^agents\.entries\.[^.]+\.modelPolicy\.allow\[\d+\]$/.test(path)
    || path === "agents.defaults.subagents.model";
}

/** 递归发现白名单外疑似 model-valued 路径；命中 source 时必须阻断。 */
function findUnknownConfigModelPaths(value, matcher, blockers, path = "", modelContext = false) {
  if (typeof value === "string") {
    if (modelContext && !isKnownConfigModelPath(path)) {
      const match = matcher(value);
      if (match.matched || match.ambiguous) {
        blockers.push(blocker(
          "unknown_model_reference_path",
          "config",
          "发现 scanner schema 外的模型引用路径",
          { referenceKey: path },
        ));
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => findUnknownConfigModelPaths(child, matcher, blockers, `${path}[${index}]`, modelContext));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    // model 对象下只继续关注真正承载引用的 id/primary/fallbacks；不能把
    // Provider model 条目的 name="old" 误判成 schema 外模型引用。
    const childModelContext = /^(?:model(?:id)?|primary|fallbacks)$/i.test(key)
      || (modelContext && /^(?:id|primary|fallbacks)$/i.test(key));
    findUnknownConfigModelPaths(child, matcher, blockers, childPath, childModelContext);
  }
}

/** 完整读取并扫描 config.get 的 8.1 canonical 精确路径。 */
async function enumerateConfig(rpc, safeSpec) {
  let response;
  try {
    response = await requestRpc(rpc, "config.get", {});
  } catch (error) {
    return {
      rows: [],
      references: [],
      blockers: [blocker(
        "config_enumeration_incomplete",
        "config",
        `config.get 失败: ${error?.message || error}`,
      )],
      meta: { complete: false, count: 0, pagination: "single", endReached: false, fingerprint: fingerprint(null) },
    };
  }
  const parsed = response?.parsed && typeof response.parsed === "object" ? response.parsed : null;
  const hash = typeof response?.hash === "string" ? response.hash : "";
  if (!parsed || !hash) {
    return {
      rows: [],
      references: [],
      blockers: [blocker("config_enumeration_incomplete", "config", "config.get 缺少 parsed/hash")],
      meta: { complete: false, count: 0, pagination: "single", endReached: false, fingerprint: fingerprint(response) },
    };
  }
  const matcher = createModelMatcher(parsed, safeSpec);
  const references = [];
  const blockers = [];
  const replacePaths = new Set();
  let canonicalAgentConfigComplete = true;
  const provider = parsed?.models?.providers?.[safeSpec.providerKey];
  const models = Array.isArray(provider?.models) ? provider.models : [];
  models.forEach((model, index) => {
    const path = `models.providers.${safeSpec.providerKey}.models[${index}].id`;
    const beforeLength = references.length;
    inspectConfigValue(model?.id, path, matcher, references, blockers, {
      replacePath: `models.providers.${safeSpec.providerKey}.models`,
      definition: true,
    });
    if (references.length > beforeLength) replacePaths.add(`models.providers.${safeSpec.providerKey}.models`);
  });

  const defaults = parsed?.agents?.defaults;
  inspectConfigValue(defaults?.model?.primary, "agents.defaults.model.primary", matcher, references, blockers);
  (Array.isArray(defaults?.model?.fallbacks) ? defaults.model.fallbacks : []).forEach((value, index) => {
    const beforeLength = references.length;
    inspectConfigValue(value, `agents.defaults.model.fallbacks[${index}]`, matcher, references, blockers, {
      replacePath: "agents.defaults.model.fallbacks",
    });
    if (references.length > beforeLength) replacePaths.add("agents.defaults.model.fallbacks");
  });

  try {
    const defaultPolicy = readDefaultModelPolicyAllow(parsed) || [];
    defaultPolicy.forEach((value, index) => {
      const beforeLength = references.length;
      inspectModelPolicyRef(
        value,
        `agents.defaults.modelPolicy.allow[${index}]`,
        safeSpec,
        references,
        { replacePath: "agents.defaults.modelPolicy.allow" },
      );
      if (references.length > beforeLength) replacePaths.add("agents.defaults.modelPolicy.allow");
    });

    for (const agent of readCanonicalAgentEntries(parsed)) {
      const entryPath = `agents.entries.${agent.id}`;
      inspectConfigValue(
        agent?.model?.primary,
        `${entryPath}.model.primary`,
        matcher,
        references,
        blockers,
      );
      (Array.isArray(agent?.model?.fallbacks) ? agent.model.fallbacks : []).forEach((value, fallbackIndex) => {
        const beforeLength = references.length;
        const replacePath = `${entryPath}.model.fallbacks`;
        inspectConfigValue(
          value,
          `${entryPath}.model.fallbacks[${fallbackIndex}]`,
          matcher,
          references,
          blockers,
          { replacePath },
        );
        if (references.length > beforeLength) replacePaths.add(replacePath);
      });

      const policy = readAgentModelPolicyAllow(parsed, agent.id) || [];
      policy.forEach((value, index) => {
        const beforeLength = references.length;
        const replacePath = `${entryPath}.modelPolicy.allow`;
        inspectModelPolicyRef(
          value,
          `${entryPath}.modelPolicy.allow[${index}]`,
          safeSpec,
          references,
          { replacePath },
        );
        if (references.length > beforeLength) replacePaths.add(replacePath);
      });
    }
  } catch (error) {
    canonicalAgentConfigComplete = false;
    blockers.push(blocker(
      error instanceof OpenClawAgentConfigError ? error.code : "invalid_agent_config",
      "config",
      "agents.entries/modelPolicy 配置不符合 OpenClaw 2026.8.1 canonical schema",
    ));
  }

  inspectConfigValue(
    defaults?.subagents?.model,
    "agents.defaults.subagents.model",
    matcher,
    references,
    blockers,
  );
  findUnknownConfigModelPaths(parsed, matcher, blockers);
  const configFingerprint = fingerprint({ hash, parsed });
  return {
    rows: [parsed],
    references,
    blockers,
    meta: {
      complete: canonicalAgentConfigComplete
        && blockers.every(({ code }) => code !== "config_enumeration_incomplete"),
      count: references.length,
      pagination: "single",
      endReached: true,
      fingerprint: configFingerprint,
      baseHash: hash,
      replacePaths: [...replacePaths].sort(),
    },
  };
}

/** 判定页响应是否显式表示可能截断。 */
function hasTruncationSignal(page, collectionLength, limit) {
  return page?.hasMore === true
    || page?.truncated === true
    // 新网关用 null 表示末页；只有非空 continuation 才表示还需要下一页。
    || page?.nextOffset != null
    || page?.nextCursor != null
    || (Number.isFinite(page?.total) && page.total > collectionLength)
    || collectionLength >= limit;
}

/** 按声明协议完整枚举 Session；任何 shape/位置异常都返回 incomplete。 */
async function enumerateSessions(rpc, capabilities) {
  const protocol = capabilities.sessionsPagination || "legacy-single";
  const limit = pageLimit(capabilities.sessionsPageLimit);
  const rowsByKey = new Map();
  const seenPages = new Set();
  const seenCursors = new Set();
  let position = protocol === "offset-v1" ? 0 : undefined;
  let complete = true;
  let endReached = false;
  let reason = "";

  if (!["offset-v1", "cursor-v1", "legacy-single"].includes(protocol)) {
    complete = false;
    reason = "未识别的 Session 分页能力";
  }

  for (let pageIndex = 0; complete && pageIndex < MAX_PAGES; pageIndex += 1) {
    const params = { limit };
    if (protocol === "offset-v1") params.offset = position;
    if (protocol === "cursor-v1" && position !== undefined) params.cursor = position;
    let page;
    try {
      page = await requestRpc(rpc, "sessions.list", params);
    } catch (error) {
      complete = false;
      reason = `sessions.list 失败: ${error?.message || error}`;
      break;
    }
    if (!page || !Array.isArray(page.sessions)) {
      complete = false;
      reason = "sessions.list 返回未知 shape";
      break;
    }
    const pageKeys = page.sessions.map((row) => String(row?.key || ""));
    const pageSignature = fingerprint(pageKeys);
    if (seenPages.has(pageSignature) && page.sessions.length > 0) {
      complete = false;
      reason = "Session 分页返回重复页";
      break;
    }
    seenPages.add(pageSignature);
    let newRows = 0;
    for (const row of page.sessions) {
      const key = typeof row?.key === "string" ? row.key : "";
      if (!key) {
        complete = false;
        reason = "Session 行缺少 key";
        break;
      }
      if (!rowsByKey.has(key)) {
        rowsByKey.set(key, clone(row));
        newRows += 1;
      }
    }
    if (!complete) break;

    if (protocol === "legacy-single") {
      endReached = !hasTruncationSignal(page, page.sessions.length, limit);
      complete = endReached;
      if (!complete) reason = "旧网关单页可能被截断";
      break;
    }
    if (typeof page.hasMore !== "boolean") {
      complete = false;
      reason = "分页响应缺少 hasMore";
      break;
    }
    if ((protocol === "offset-v1" && page.nextCursor !== undefined)
      || (protocol === "cursor-v1" && page.nextOffset !== undefined)) {
      complete = false;
      reason = "Session 分页协议中途切换";
      break;
    }
    if (!page.hasMore) {
      endReached = true;
      break;
    }
    if (newRows === 0) {
      complete = false;
      reason = "分页未产生新 Session";
      break;
    }
    if (protocol === "offset-v1") {
      if (!Number.isSafeInteger(page.nextOffset)
        || page.nextOffset !== position + page.sessions.length) {
        complete = false;
        reason = "Session offset 未前进或协议中途切换";
        break;
      }
      position = page.nextOffset;
    } else {
      if (page.nextOffset !== undefined
        || typeof page.nextCursor !== "string"
        || !page.nextCursor
        || seenCursors.has(page.nextCursor)) {
        complete = false;
        reason = "Session cursor 未前进或协议中途切换";
        break;
      }
      seenCursors.add(page.nextCursor);
      position = page.nextCursor;
    }
    if (pageIndex === MAX_PAGES - 1) {
      complete = false;
      reason = "Session 分页超过安全页数";
    }
  }
  if (complete && !endReached) {
    complete = false;
    reason = reason || "Session 未证明到达末页";
  }
  const rows = [...rowsByKey.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return {
    rows,
    blockers: complete ? [] : [blocker("session_enumeration_incomplete", "sessions", reason)],
    meta: {
      complete,
      count: rows.length,
      pagination: protocol === "offset-v1" ? "offset" : protocol === "cursor-v1" ? "cursor" : "legacy-single",
      endReached,
      fingerprint: fingerprint(rows),
    },
  };
}

/** 将 Session 的 providerOverride/modelOverride 复合身份计算为完整 after 行。 */
function sessionReference(row, matcher, blockers) {
  const after = clone(row);
  let changed = false;
  const inspect = (value, path, assign) => {
    const match = matcher(value);
    if (match.matched) {
      assign(match.after);
      changed = true;
    } else if (match.ambiguous) {
      blockers.push(blocker("ambiguous_model_reference", "sessions", "Session 裸模型 ID 无法消歧", {
        referenceKey: `${row.key}:${path}`,
      }));
    }
  };
  if (typeof row.modelOverride === "string" && row.modelOverride) {
    if (typeof row.providerOverride !== "string" || !row.providerOverride) {
      if (row.modelOverride === matcher.sourceModelId) {
        blockers.push(blocker("ambiguous_model_reference", "sessions", "Session override 缺少 Provider 身份", {
          referenceKey: `${row.key}:modelOverride`,
        }));
      }
    } else {
      inspect(`${row.providerOverride}/${row.modelOverride}`, "modelOverride", (value) => {
        const separator = String(value).indexOf("/");
        after.providerOverride = separator >= 0 ? String(value).slice(0, separator) : row.providerOverride;
        after.modelOverride = separator >= 0 ? String(value).slice(separator + 1) : String(value);
      });
    }
  }
  return changed
    ? makeReference("openclaw.sessions.v1", "sessions", row.key, row, after, {
        expectedVersion: row.version ?? row.revision ?? row.etag ?? null,
      })
    : null;
}

/** 按声明协议完整枚举 Cron；单页上限命中也视为疑似截断。 */
async function enumerateCron(rpc, capabilities) {
  const protocol = capabilities.cronPagination || "single";
  const limit = pageLimit(capabilities.cronPageLimit);
  const rowsById = new Map();
  const seenPages = new Set();
  const seenCursors = new Set();
  let cursor;
  let complete = true;
  let endReached = false;
  let reason = "";
  if (!["single", "cursor-v1"].includes(protocol)) {
    complete = false;
    reason = "未识别的 Cron 分页能力";
  }
  for (let pageIndex = 0; complete && pageIndex < MAX_PAGES; pageIndex += 1) {
    const params = { includeDisabled: true, limit };
    if (protocol === "cursor-v1" && cursor !== undefined) params.cursor = cursor;
    let page;
    try {
      page = await requestRpc(rpc, "cron.list", params);
    } catch (error) {
      complete = false;
      reason = `cron.list 失败: ${error?.message || error}`;
      break;
    }
    if (!page || !Array.isArray(page.jobs)) {
      complete = false;
      reason = "cron.list 返回未知 shape";
      break;
    }
    const ids = page.jobs.map((job) => String(job?.id || ""));
    const signature = fingerprint(ids);
    if (seenPages.has(signature) && page.jobs.length > 0) {
      complete = false;
      reason = "Cron 分页返回重复页";
      break;
    }
    seenPages.add(signature);
    let newRows = 0;
    for (const job of page.jobs) {
      const id = typeof job?.id === "string" ? job.id : "";
      if (!id) {
        complete = false;
        reason = "Cron 行缺少 id";
        break;
      }
      if (!rowsById.has(id)) {
        rowsById.set(id, clone(job));
        newRows += 1;
      }
    }
    if (!complete) break;
    if (protocol === "single") {
      endReached = !hasTruncationSignal(page, page.jobs.length, limit);
      complete = endReached;
      if (!complete) reason = "Cron 单页可能被截断";
      break;
    }
    if (typeof page.hasMore !== "boolean") {
      complete = false;
      reason = "Cron cursor 响应缺少 hasMore";
      break;
    }
    if (page.nextOffset !== undefined) {
      complete = false;
      reason = "Cron cursor 协议中途切换";
      break;
    }
    if (!page.hasMore) {
      endReached = true;
      break;
    }
    if (newRows === 0
      || typeof page.nextCursor !== "string"
      || !page.nextCursor
      || seenCursors.has(page.nextCursor)) {
      complete = false;
      reason = "Cron cursor 未前进";
      break;
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (pageIndex === MAX_PAGES - 1) {
      complete = false;
      reason = "Cron 分页超过安全页数";
    }
  }
  if (complete && !endReached) {
    complete = false;
    reason = reason || "Cron 未证明到达末页";
  }
  const rows = [...rowsById.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    rows,
    blockers: complete ? [] : [blocker("cron_enumeration_incomplete", "cron", reason)],
    meta: {
      complete,
      count: rows.length,
      pagination: protocol === "cursor-v1" ? "cursor" : "single",
      endReached,
      fingerprint: fingerprint(rows),
    },
  };
}

/** 计算 Cron 顶层及完整 payload 内已声明的 model/fallbacks patch。 */
function cronReference(job, matcher, blockers) {
  const after = clone(job);
  let changed = false;
  const inspectContainer = (beforeContainer, afterContainer, prefix) => {
    if (!beforeContainer || typeof beforeContainer !== "object") return;
    const modelMatch = matcher(beforeContainer.model);
    if (modelMatch.matched) {
      afterContainer.model = modelMatch.after;
      changed = true;
    } else if (modelMatch.ambiguous) {
      blockers.push(blocker("ambiguous_model_reference", "cron", "Cron 裸模型 ID 无法消歧", {
        referenceKey: `${job.id}:${prefix}model`,
      }));
    }
    if (Array.isArray(beforeContainer.fallbacks)) {
      beforeContainer.fallbacks.forEach((value, index) => {
        const match = matcher(value);
        if (match.matched) {
          afterContainer.fallbacks[index] = match.after;
          changed = true;
        } else if (match.ambiguous) {
          blockers.push(blocker("ambiguous_model_reference", "cron", "Cron fallback 裸模型 ID 无法消歧", {
            referenceKey: `${job.id}:${prefix}fallbacks[${index}]`,
          }));
        }
      });
    }
  };
  inspectContainer(job, after, "");
  inspectContainer(job.payload, after.payload, "payload.");
  return changed
    ? makeReference("openclaw.cron.v1", "cron", job.id, job, after, {
        expectedVersion: job.version ?? job.revision ?? job.etag ?? null,
      })
    : null;
}

/** 判断布尔值、store 数组或 store 映射是否显式声明某项能力。 */
function declaresStoreCapability(value, store) {
  return value === true
    || (Array.isArray(value) && value.includes(store))
    || value?.[store] === true;
}

/** 判断 store 是否具备 lease 或逐行条件版本，任一都能防止丢更新。 */
function hasStoreConcurrency(capabilities, store, references) {
  const leaseSupported = declaresStoreCapability(capabilities.referenceMutationLeases, store);
  if (leaseSupported) return true;
  const conditionalSupported = declaresStoreCapability(capabilities.conditionalVersions, store);
  return conditionalSupported && references.every((reference) => reference.expectedVersion != null);
}

/**
 * 新增只依赖配置；其它变更扫描 config/Session/Cron 三个封闭 store，并返回显式
 * 完整性、内容 fingerprint 与可补偿引用。preview 阶段写调用数始终为 0。
 */
async function scanOpenClawReferences(rpc, safeSpec) {
  if (!safeSpec || typeof safeSpec !== "object") throw new TypeError("safeSpec 必须是对象");
  const configResult = await enumerateConfig(rpc, safeSpec);
  // 新增不会迁移或删除已有 Session/Cron 引用。把这些动态行纳入指纹会使无关
  // 聊天的 updatedAt/Token 变化触发 preview_stale，甚至在首个配置写入前锁住表单。
  // 仍保留完整配置指纹：Provider/模型冲突与真正的配置变化必须在首写前拦截。
  if (safeSpec.kind === "create") {
    return {
      scannerVersion: OPENCLAW_SCANNER_VERSION,
      stores: { config: configResult.meta },
      references: configResult.references,
      blockers: configResult.blockers,
      fingerprints: {
        scannerVersion: OPENCLAW_SCANNER_VERSION,
        config: configResult.meta.fingerprint,
      },
    };
  }
  const capabilities = await readCapabilities(rpc);
  const matcher = createModelMatcher(configResult.rows[0] || {}, safeSpec);
  const sessionResult = await enumerateSessions(rpc, capabilities);
  const cronResult = await enumerateCron(rpc, capabilities);
  const blockers = [...configResult.blockers, ...sessionResult.blockers, ...cronResult.blockers];
  const sessionReferences = sessionResult.rows
    .map((row) => sessionReference(row, matcher, blockers))
    .filter(Boolean);
  const cronReferences = cronResult.rows
    .map((job) => cronReference(job, matcher, blockers))
    .filter(Boolean);
  if (sessionReferences.length > 0 && !hasStoreConcurrency(capabilities, "sessions", sessionReferences)) {
    blockers.push(blocker(
      "reference_concurrency_unsupported",
      "sessions",
      "Session 引用缺少条件版本或 mutation lease",
    ));
  }
  if (cronReferences.length > 0 && !hasStoreConcurrency(capabilities, "cron", cronReferences)) {
    blockers.push(blocker(
      "reference_concurrency_unsupported",
      "cron",
      "Cron 引用缺少条件版本或 mutation lease",
    ));
  }
  const stores = {
    config: configResult.meta,
    sessions: sessionResult.meta,
    cron: cronResult.meta,
  };
  return {
    scannerVersion: OPENCLAW_SCANNER_VERSION,
    stores,
    references: [...configResult.references, ...sessionReferences, ...cronReferences],
    blockers,
    fingerprints: {
      scannerVersion: OPENCLAW_SCANNER_VERSION,
      config: stores.config.fingerprint,
      sessions: stores.sessions.fingerprint,
      cron: stores.cron.fingerprint,
    },
  };
}

/** 为 scanner 写入构造稳定的 lease/expectedVersion 参数。 */
function mutationContext(reference, context = {}) {
  return {
    ...(context.token ? { mutationLeaseToken: context.token } : {}),
    ...(reference.expectedVersion != null ? { expectedVersion: reference.expectedVersion } : {}),
  };
}

/** 从各版本网关的 mutation 响应中提取下一版行版本。 */
function mutationResultVersion(response, store) {
  const entity = store === "sessions" ? response?.session : response?.job;
  for (const candidate of [entity, response]) {
    if (!candidate || typeof candidate !== "object") continue;
    for (const field of ["version", "revision", "etag"]) {
      if (candidate[field] != null) return candidate[field];
    }
  }
  return null;
}

/** 条件写成功后推进引用版本，使后续补偿不会复用已经消费的旧版本。 */
function advanceExpectedVersion(reference, context, response) {
  if (reference.expectedVersion == null) return;
  const nextVersion = mutationResultVersion(response, reference.store);
  if (nextVersion == null) return;
  reference.expectedVersion = nextVersion;
  if (context.expectedVersions && reference.referenceKey) {
    context.expectedVersions[reference.referenceKey] = nextVersion;
  }
}

/** config scanner 的单项读取；Task 10 会把多个 config 引用合并为一次原子 patch。 */
async function readConfigReference(rpc, reference) {
  const response = await requestRpc(rpc, "config.get", {});
  return { response, reference };
}

/** config 单项写接口仅供完整 batch 上下文调用，禁止缺 baseHash 的盲写。 */
async function writeConfigReference(rpc, reference, context = {}) {
  if (!context.baseHash || !context.raw) {
    throw new OpenClawReferenceError("config_batch_required", "config 引用必须合并为带 baseHash 的原子 patch");
  }
  return requestRpc(rpc, "config.patch", {
    raw: context.raw,
    baseHash: context.baseHash,
    replacePaths: Array.isArray(context.replacePaths) ? context.replacePaths : [],
  });
}

/** config verify 委托调用方提供的批量回读判定，避免单路径解析产生第二套 schema。 */
async function verifyConfigReference(rpc, reference, context = {}) {
  if (typeof context.verifyReference === "function") return context.verifyReference(reference, await readConfigReference(rpc, reference));
  throw new OpenClawReferenceError("config_verify_required", "config verify 需要批量回读判定");
}

/** config undo 与 write 相同，Task 10 传入按逆序合成的原子补偿 raw。 */
async function undoConfigReference(rpc, reference, context = {}) {
  return writeConfigReference(rpc, { ...reference, after: reference.undo }, context);
}

/**
 * 通过网关真实支持的 sessions.list 分页回读单个 Session。读取参数只包含分页
 * 字段；expectedVersion/lease token 属于写 mutation，禁止混入只读请求。
 */
async function readSessionReference(rpc, reference) {
  const capabilities = await readCapabilities(rpc);
  const result = await enumerateSessions(rpc, capabilities);
  if (!result.meta.complete) {
    throw new OpenClawReferenceError(
      "session_read_incomplete",
      "Session 分页回读未证明完整，无法安全验证引用",
      { store: "sessions", referenceKey: reference.referenceKey },
    );
  }
  const row = result.rows.find((candidate) => candidate.key === reference.referenceKey);
  if (!row) {
    throw new OpenClawReferenceError(
      "session_reference_missing",
      "Session 引用在完整分页回读中不存在",
      { store: "sessions", referenceKey: reference.referenceKey },
    );
  }
  return row;
}

/** 使用完整 after 行、lease token 与期望版本更新 Session。 */
async function writeSessionReference(rpc, reference, context = {}) {
  const after = reference.after || {};
  if (typeof after.providerOverride !== "string" || !after.providerOverride
    || typeof after.modelOverride !== "string" || !after.modelOverride) {
    throw new OpenClawReferenceError(
      "session_override_required",
      "Session 只允许条件更新显式 providerOverride/modelOverride",
      { store: "sessions" },
    );
  }
  const model = `${after.providerOverride}/${after.modelOverride}`;
  const response = await requestRpc(rpc, "sessions.patch", {
    key: reference.referenceKey,
    model,
    ...mutationContext(reference, context),
  });
  advanceExpectedVersion(reference, context, response);
  return response;
}

/** 回读 Session 并比较完整目标内容 fingerprint。 */
async function verifySessionReference(rpc, reference, context = {}) {
  const current = await readSessionReference(rpc, reference, context);
  return current?.providerOverride === reference.after?.providerOverride
    && current?.modelOverride === reference.after?.modelOverride;
}

/** 用原始完整行补偿 Session。 */
async function undoSessionReference(rpc, reference, context = {}) {
  const compensation = { ...reference, after: reference.undo };
  const response = await writeSessionReference(rpc, compensation, context);
  reference.expectedVersion = compensation.expectedVersion;
  return response;
}

/** 读取单个 Cron 的权威当前值。 */
async function readCronReference(rpc, reference, context = {}) {
  return requestRpc(rpc, "cron.get", {
    id: reference.referenceKey,
    ...mutationContext(reference, context),
  });
}

/** 使用完整 after job、lease token 与期望版本更新 Cron。 */
async function writeCronReference(rpc, reference, context = {}) {
  const response = await requestRpc(rpc, "cron.update", {
    id: reference.referenceKey,
    patch: clone(reference.after),
    ...mutationContext(reference, context),
  });
  advanceExpectedVersion(reference, context, response);
  return response;
}

/** 回读 Cron 只比较迁移改写过的 model/fallbacks；version/时间戳等易变字段必须忽略。 */
async function verifyCronReference(rpc, reference, context = {}) {
  const response = await readCronReference(rpc, reference, context);
  const current = response?.job ?? response;
  const sameContainer = (a, b) => stableJson(a?.model) === stableJson(b?.model)
    && stableJson(a?.fallbacks) === stableJson(b?.fallbacks);
  return sameContainer(current, reference.after)
    && sameContainer(current?.payload, reference.after?.payload);
}

/** 用原始完整 job 补偿 Cron。 */
async function undoCronReference(rpc, reference, context = {}) {
  const compensation = { ...reference, after: reference.undo };
  const response = await writeCronReference(rpc, compensation, context);
  reference.expectedVersion = compensation.expectedVersion;
  return response;
}

const MODEL_REFERENCE_SCANNERS = Object.freeze([
  Object.freeze({
    id: "openclaw.config.v2",
    store: "config",
    enumerate: enumerateConfig,
    read: readConfigReference,
    write: writeConfigReference,
    verify: verifyConfigReference,
    undo: undoConfigReference,
  }),
  Object.freeze({
    id: "openclaw.sessions.v1",
    store: "sessions",
    enumerate: enumerateSessions,
    read: readSessionReference,
    write: writeSessionReference,
    verify: verifySessionReference,
    undo: undoSessionReference,
  }),
  Object.freeze({
    id: "openclaw.cron.v1",
    store: "cron",
    enumerate: enumerateCron,
    read: readCronReference,
    write: writeCronReference,
    verify: verifyCronReference,
    undo: undoCronReference,
  }),
]);

/** 模块/CI 启动门：每个 scanner 必须声明唯一 id/store 与五个可调用能力。 */
function validateReferenceScanners(scanners) {
  if (!Array.isArray(scanners) || scanners.length === 0) {
    throw new OpenClawReferenceError("invalid_reference_scanner", "scanner registry 不能为空");
  }
  const ids = new Set();
  const stores = new Set();
  for (const scanner of scanners) {
    if (!scanner || typeof scanner.id !== "string" || typeof scanner.store !== "string") {
      throw new OpenClawReferenceError("invalid_reference_scanner", "scanner 缺少 id/store");
    }
    if (ids.has(scanner.id) || stores.has(scanner.store)) {
      throw new OpenClawReferenceError("invalid_reference_scanner", `scanner id/store 重复: ${scanner.id}`);
    }
    ids.add(scanner.id);
    stores.add(scanner.store);
    for (const method of SCANNER_METHODS) {
      if (typeof scanner[method] !== "function") {
        throw new OpenClawReferenceError("invalid_reference_scanner", `${scanner.id} 缺少 ${method}`);
      }
    }
  }
  return scanners;
}

validateReferenceScanners(MODEL_REFERENCE_SCANNERS);

/** 取得一个 store lease，并把 RPC token 协议归一为 renew/release 函数。 */
async function acquireOneLease(rpc, store, ttlMs) {
  let lease;
  if (rpc && typeof rpc.acquireReferenceMutationLease === "function") {
    lease = await rpc.acquireReferenceMutationLease(store, { ttlMs });
  } else {
    lease = await requestRpc(rpc, "references.lease.acquire", { store, ttlMs });
  }
  if (!lease || typeof lease.token !== "string" || !lease.token) {
    throw new OpenClawReferenceError("reference_lease_invalid", `${store} lease 缺少 token`, { store });
  }
  const renew = typeof lease.renew === "function"
    ? () => lease.renew()
    : () => requestRpc(rpc, "references.lease.renew", { store, token: lease.token, ttlMs });
  const release = typeof lease.release === "function"
    ? () => lease.release()
    : () => requestRpc(rpc, "references.lease.release", { store, token: lease.token });
  return {
    store,
    token: lease.token,
    expiresAt: Number.isFinite(lease.expiresAt) ? lease.expiresAt : Date.now() + ttlMs,
    renew,
    release,
  };
}

/**
 * 按 store 取得 mutation lease，TTL/3 自动续租；run 在第一项写之前重扫 fingerprint，
 * 并在成功/失败路径都逆序 release。references 仅决定 sessions/cron 两类写 store。
 */
async function acquireReferenceMutationLeases(rpc, references, opts = {}) {
  const stores = [...new Set(
    (Array.isArray(references) ? references : [])
      .map((reference) => reference?.store)
      .filter((store) => store === "sessions" || store === "cron"),
  )].sort((a, b) => ["sessions", "cron"].indexOf(a) - ["sessions", "cron"].indexOf(b));
  const capabilities = await readCapabilities(rpc);
  const leaseStores = stores.filter((store) => (
    declaresStoreCapability(capabilities.referenceMutationLeases, store)
  ));
  for (const store of stores) {
    const storeReferences = references.filter((reference) => reference?.store === store);
    if (!hasStoreConcurrency(capabilities, store, storeReferences)) {
      throw new OpenClawReferenceError(
        "reference_concurrency_unsupported",
        `${store} 引用缺少条件版本或 mutation lease`,
        { store },
      );
    }
  }
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 15 ? opts.ttlMs : 30_000;
  const leases = [];
  let released = false;
  let heartbeatError = null;

  /** 逆序释放所有已取得 lease；单个失败不跳过其余 release。 */
  const releaseAll = async () => {
    if (released) return;
    released = true;
    const errors = [];
    for (const lease of leases) {
      if (lease.timer) clearInterval(lease.timer);
    }
    for (const lease of [...leases].reverse()) {
      try {
        // 等待已开始的续租完成后再 release，避免慢 renew 在释放后把锁复活。
        await lease.renewalTail;
        await lease.release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new OpenClawReferenceError("reference_lease_release_failed", "引用 mutation lease 释放失败", {
        stores: errors.length,
      });
    }
  };

  try {
    for (const store of leaseStores) {
      const lease = await acquireOneLease(rpc, store, ttlMs);
      lease.renewalTail = Promise.resolve();
      lease.timer = setInterval(() => {
        // 同一 lease 的续租串行化，防止慢网络下多个 renew 并发乱序更新 expiresAt。
        lease.renewalTail = lease.renewalTail.then(() => lease.renew())
          .then((renewed) => {
            lease.expiresAt = Number.isFinite(renewed?.expiresAt) ? renewed.expiresAt : Date.now() + ttlMs;
          })
          .catch((error) => {
            heartbeatError ||= new OpenClawReferenceError(
              "reference_lease_lost",
              `${store} mutation lease 续租失败`,
              { store, reason: error?.message || String(error) },
            );
          });
      }, Math.max(5, Math.floor(ttlMs / 3)));
      if (typeof lease.timer.unref === "function") lease.timer.unref();
      leases.push(lease);
    }
  } catch (error) {
    try { await releaseAll(); } catch { /* 保留原始 acquire 错误 */ }
    throw error;
  }

  const context = {};
  for (const store of stores) {
    const lease = leases.find((candidate) => candidate.store === store);
    const storeReferences = references.filter((reference) => reference?.store === store);
    context[store] = {
      ...(lease ? { token: lease.token, expiresAt: lease.expiresAt } : {}),
      expectedVersions: Object.fromEntries(
        storeReferences
          .filter((reference) => reference.referenceKey && reference.expectedVersion != null)
          .map((reference) => [reference.referenceKey, reference.expectedVersion]),
      ),
      checkpoint() {
        if (lease && heartbeatError) throw heartbeatError;
      },
    };
  }

  /** 重扫、比较后执行写回调；无论结果如何都 release。 */
  const run = async (callback) => {
    if (released) throw new OpenClawReferenceError("reference_lease_released", "mutation lease 已释放");
    let primaryError = null;
    try {
      const rescan = typeof opts.rescan === "function"
        ? await opts.rescan()
        : opts.safeSpec
          ? await scanOpenClawReferences(rpc, opts.safeSpec)
          : null;
      if (!rescan || !rescan.fingerprints) {
        throw new OpenClawReferenceError("reference_rescan_required", "取得 lease 后必须重新扫描 fingerprint");
      }
      for (const store of stores) {
        const expected = opts.expectedFingerprints?.[store];
        if (typeof expected !== "string" || rescan.fingerprints[store] !== expected) {
          throw new OpenClawReferenceError(
            "reference_fingerprint_changed",
            `${store} 引用在取得 lease 后发生变化`,
            { store, expected, current: rescan.fingerprints[store] },
          );
        }
      }
      if (heartbeatError) throw heartbeatError;
      const result = await callback(context);
      if (heartbeatError) throw heartbeatError;
      return result;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await releaseAll();
      } catch (releaseError) {
        if (!primaryError) throw releaseError;
      }
    }
  };

  return Object.freeze({ leases: context, run, release: releaseAll });
}

module.exports = {
  OPENCLAW_SCANNER_VERSION,
  OPENCLAW_MODEL_PATHS,
  MODEL_REFERENCE_SCANNERS,
  OpenClawReferenceError,
  validateReferenceScanners,
  scanOpenClawReferences,
  acquireReferenceMutationLeases,
};
