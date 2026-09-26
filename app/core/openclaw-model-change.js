"use strict";

// OpenClaw 模型变更适配器。所有公开入口都经 ModelChangeCoordinator 调用；本模块
// 负责引用扫描、分阶段写入、运行时收敛和崩溃恢复，不持有 HTTP/UI 状态。

const { createHash } = require("node:crypto");

const {
  MODEL_REFERENCE_SCANNERS,
  validateReferenceScanners,
  scanOpenClawReferences,
  acquireReferenceMutationLeases,
} = require("./openclaw-model-references");
const {
  readCanonicalAgentEntries,
  writeCanonicalAgentEntries,
  readDefaultModelPolicyAllow,
  readAgentModelPolicyAllow,
} = require("./openclaw-agent-config");

/** 模型变更依赖或状态机错误，code/stage 可安全返回协调器。 */
class OpenClawModelChangeError extends Error {
  constructor(code, message, { stage = "preflight", status = 409, details } = {}) {
    super(message);
    this.name = "OpenClawModelChangeError";
    this.code = code;
    this.stage = stage;
    this.status = status;
    this.details = details;
  }
}

/** JSON 数据隔离副本；配置与 scanner 行都必须可序列化。 */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Provider 恢复只比较端点/API mode 摘要，原始 URL 与凭证绝不持久化。 */
function providerPublicDigest(provider) {
  return createHash("sha256").update(stableJson({
    baseUrl: String(provider?.baseUrl || ""),
    api: String(provider?.api || ""),
  })).digest("hex");
}

/** 只投影模型编辑允许持久化的公共字段。 */
function publicSourceModel(model) {
  if (!model || typeof model !== "object") return undefined;
  return Object.fromEntries(Object.entries(model).filter(([key]) => (
    ["id", "name", "contextWindow", "maxTokens", "reasoning"].includes(key)
  )));
}

/** 稳定序列化用于 fingerprint 快照比较，不受对象键插入顺序影响。 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 构造只含稳定 code/stage 的 blocked 结果，避免把上游错误正文公开。 */
function blocked(code, stage = "preflight", extra = {}) {
  return { status: "blocked", code, stage, ...extra };
}

/** 取得 config.get 的完整 parsed/hash；缺任一字段都禁止继续。 */
async function getConfigSnapshot(backend) {
  const response = await backend.request("config.get", {});
  if (!response?.parsed || typeof response.parsed !== "object" || typeof response.hash !== "string" || !response.hash) {
    throw new OpenClawModelChangeError("config_enumeration_incomplete", "config.get 缺少 parsed/hash");
  }
  return { parsed: clone(response.parsed), hash: response.hash };
}

/** 把 scanner 的 `a.b[0].c` 精确路径写回隔离配置副本。 */
function setConfigPath(root, path, value) {
  const segments = String(path).match(/[^.[\]]+/g) || [];
  if (segments.length === 0) throw new OpenClawModelChangeError("invalid_reference_path", "config 引用路径为空");
  let cursor = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = /^\d+$/.test(segments[index]) ? Number(segments[index]) : segments[index];
    if (!cursor || typeof cursor !== "object" || !(segment in cursor)) {
      throw new OpenClawModelChangeError("invalid_reference_path", "config 引用路径已变化");
    }
    cursor = cursor[segment];
  }
  const last = /^\d+$/.test(segments.at(-1)) ? Number(segments.at(-1)) : segments.at(-1);
  if (!cursor || typeof cursor !== "object" || !(last in cursor)) {
    throw new OpenClawModelChangeError("invalid_reference_path", "config 引用叶子已变化");
  }
  cursor[last] = clone(value);
}

/** 返回 Provider 与模型数组；不存在时保留 null 供各 kind 明确判定。 */
function providerState(parsed, providerKey) {
  const provider = parsed?.models?.providers?.[providerKey];
  return {
    provider: provider && typeof provider === "object" ? provider : null,
    models: Array.isArray(provider?.models) ? provider.models : [],
  };
}

/** 只合并模型公开字段；显式 false 必须覆盖，未提交字段保留旧值。 */
function mergeModelEntry(before, model) {
  const next = before && typeof before === "object" ? clone(before) : {};
  for (const field of ["id", "name", "contextWindow", "maxTokens", "reasoning"]) {
    if (Object.prototype.hasOwnProperty.call(model || {}, field)) next[field] = clone(model[field]);
  }
  if (!next.name) next.name = next.id;
  if (!Array.isArray(next.input)) next.input = ["text"];
  if (!next.cost || typeof next.cost !== "object") {
    next.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  return next;
}

/** 将配置 patch 作为单次条件写发送；replacePaths 去重后保持确定顺序。 */
async function patchConfig(backend, context, snapshot, patch, replacePaths = []) {
  context.assertProviderLease?.();
  await backend.request("config.patch", {
    raw: JSON.stringify(patch),
    baseHash: snapshot.hash,
    replacePaths: [...new Set(replacePaths)].sort(),
  });
}

/** 比较 journal/preview 与首写前 fresh scanner fingerprint。 */
function fingerprintsEqual(expected, current) {
  return expected && typeof expected === "object"
    && Object.keys(expected).length > 0
    && stableJson(expected) === stableJson(current);
}

/** 根据 kind 构造 scanner 输入；删除也必须把 source 当作匹配目标枚举未来引用。 */
function scannerSpec(safeSpec, modelId = safeSpec?.sourceModelId) {
  if (["delete-model", "delete-provider"].includes(safeSpec?.kind)) {
    // delete-provider 的 sourceModelId 为 null，必须逐个换成枚举到的模型才有匹配键。
    const id = String(modelId || safeSpec.sourceModelId || "");
    return { ...safeSpec, sourceModelId: id, model: { id } };
  }
  return safeSpec;
}

/** 对 delete-provider 聚合其全部模型引用，其它 kind 只扫描一次。 */
async function scanForKind(scan, backend, safeSpec, parsed) {
  if (safeSpec.kind !== "delete-provider") return scan(backend, scannerSpec(safeSpec));
  const { models } = providerState(parsed, safeSpec.providerKey);
  const scans = [];
  for (const model of models) scans.push(await scan(backend, scannerSpec(safeSpec, model?.id)));
  if (scans.length === 0) return scan(backend, scannerSpec(safeSpec, "__missing__"));
  const first = scans[0];
  const referencesByKey = new Map();
  const duplicateBlockers = [];
  for (const reference of scans.flatMap((item) => item.references || [])) {
    const key = `${reference.store}:${reference.referenceKey}`;
    const previous = referencesByKey.get(key);
    if (previous && stableJson(previous) !== stableJson(reference)) {
      duplicateBlockers.push({
        code: "duplicate_reference_conflict",
        store: reference.store,
        message: "Provider 引用扫描结果互相冲突",
        referenceKey: reference.referenceKey,
      });
      continue;
    }
    if (!previous) referencesByKey.set(key, reference);
  }
  const references = [...referencesByKey.values()];
  const stores = Object.fromEntries(["config", "sessions", "cron"].map((store) => {
    const metas = scans.map((item) => item.stores?.[store]).filter(Boolean);
    const base = clone(first.stores?.[store] || {});
    return [store, {
      ...base,
      complete: metas.every((meta) => meta.complete === true),
      endReached: metas.every((meta) => meta.endReached !== false),
      count: references.filter((reference) => reference.store === store).length,
      ...(store === "config" ? {
        replacePaths: [...new Set(metas.flatMap((meta) => meta.replacePaths || []))].sort(),
      } : {}),
    }];
  }));
  return {
    ...first,
    stores,
    references,
    blockers: [...scans.flatMap((item) => item.blockers || []), ...duplicateBlockers],
    // Provider 删除必须把全部子扫描 fingerprint 纳入 token，不能只信第一项。
    fingerprints: { ...first.fingerprints, providerModels: stableJson(scans.map((item) => item.fingerprints)) },
  };
}

/** 从完整 scanner 行投影 journal 白名单 diff，禁止把 Session/Cron 原对象落盘。 */
function projectReferenceDiff(store, value) {
  if (store === "config") {
    if (typeof value === "string") return { model: value };
    return { model: String(value?.model || value?.modelId || "unknown") };
  }
  if (store === "sessions") {
    const projected = {};
    for (const field of ["model", "provider", "modelId"]) {
      if (typeof value?.[field] === "string" && value[field]) projected[field] = value[field];
    }
    return Object.keys(projected).length > 0 ? projected : { model: "unknown" };
  }
  const projected = {};
  for (const field of ["provider", "model"]) {
    if (typeof value?.[field] === "string" && value[field]) projected[field] = value[field];
  }
  if (Array.isArray(value?.fallbacks)) projected.fallbacks = value.fallbacks.filter((item) => typeof item === "string" && item);
  return Object.keys(projected).length > 0 ? projected : { model: "unknown" };
}

/** 构造 journal 固定 schema 的引用迁移 step。 */
function journalStep(reference, writeStatus, { readback, error = null, startedAt = Date.now() } = {}) {
  return {
    scannerId: reference.scannerId,
    store: reference.store,
    referenceKey: reference.referenceKey,
    stage: "migrate-references",
    before: projectReferenceDiff(reference.store, reference.before),
    after: projectReferenceDiff(reference.store, reference.after),
    undo: projectReferenceDiff(reference.store, reference.undo),
    writeStatus,
    readback: projectReferenceDiff(reference.store, readback ?? reference.after),
    error,
    startedAt,
    finishedAt: Date.now(),
  };
}

/** 找到 scanner；registry 已校验唯一 id/store，缺失属于实现错误。 */
function scannerFor(scanners, reference) {
  const scanner = scanners.find((item) => item.id === reference.scannerId && item.store === reference.store);
  if (!scanner) throw new OpenClawModelChangeError("scanner_missing", "引用 scanner 不存在", { stage: "migrate-references" });
  return scanner;
}

/** 按 config references 生成同一 stage-target patch，不迁移 source 模型定义。 */
function applyConfigReferences(parsed, references) {
  const next = clone(parsed);
  const migrated = [];
  for (const reference of references.filter((item) => item.store === "config" && item.definition !== true)) {
    setConfigPath(next, reference.referenceKey, reference.after);
    migrated.push(reference);
  }
  return { agents: next.agents, migrated };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 对 defaults/per-agent 的 models settings map 做精确 key 变换。返回的是
 * RFC7386 patch：被删除 key 显式写 null，其它 alias/settings 原样保留。
 */
function transformAgentModelSettings(parsed, transform) {
  let next = clone(parsed);
  let changed = false;
  const apply = (owner, path) => {
    if (owner?.models === undefined) return;
    if (!isRecord(owner.models)) {
      throw new OpenClawModelChangeError("invalid_agent_model_settings", `${path}.models 必须是对象`);
    }
    const before = clone(owner.models);
    const after = transform(clone(before), path);
    if (!isRecord(after)) {
      throw new OpenClawModelChangeError("invalid_agent_model_settings", `${path}.models 变换结果无效`);
    }
    if (stableJson(before) === stableJson(after)) return;
    const patch = clone(after);
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) patch[key] = null;
    }
    owner.models = patch;
    changed = true;
  };

  if (next.agents?.defaults) apply(next.agents.defaults, "agents.defaults");
  const entries = readCanonicalAgentEntries(next);
  for (const entry of entries) apply(entry, `agents.entries.${entry.id}`);
  if (entries.length > 0) next = writeCanonicalAgentEntries(next, entries);
  return { agents: next.agents, changed };
}

/** rename 搬迁精确 oldRef；newRef 显式字段优先，旧设置只补缺失字段。 */
function renameAgentModelSettings(parsed, oldRef, newRef) {
  return transformAgentModelSettings(parsed, (models, path) => {
    if (!Object.hasOwn(models, oldRef)) return models;
    const oldSettings = models[oldRef];
    const newSettings = models[newRef];
    if (!isRecord(oldSettings) || (newSettings !== undefined && !isRecord(newSettings))) {
      throw new OpenClawModelChangeError("invalid_agent_model_settings", `${path}.models 包含无效设置`);
    }
    models[newRef] = newSettings === undefined
      ? clone(oldSettings)
      : { ...clone(oldSettings), ...clone(newSettings) };
    delete models[oldRef];
    return models;
  });
}

/** delete 只移除调用方已证明的精确 provider/model key，不匹配 alias 或 wildcard。 */
function deleteAgentModelSettings(parsed, exactRefs) {
  return transformAgentModelSettings(parsed, (models) => {
    for (const ref of exactRefs) delete models[ref];
    return models;
  });
}

function exactProviderModelSettingRefs(parsed, providerKey) {
  const refs = new Set();
  const collect = (owner, path) => {
    if (owner?.models === undefined) return;
    if (!isRecord(owner.models)) {
      throw new OpenClawModelChangeError("invalid_agent_model_settings", `${path}.models 必须是对象`);
    }
    for (const ref of Object.keys(owner.models)) {
      const separator = ref.indexOf("/");
      if (separator <= 0) continue;
      const modelId = ref.slice(separator + 1);
      if (ref.slice(0, separator) === providerKey && modelId && !modelId.includes("*")) refs.add(ref);
    }
  };
  collect(parsed?.agents?.defaults, "agents.defaults");
  for (const agent of readCanonicalAgentEntries(parsed)) collect(agent, `agents.entries.${agent.id}`);
  return refs;
}

function exactModelSettingRefsForDelete(safeSpec, parsed) {
  if (safeSpec.kind === "delete-model") {
    return new Set([`${safeSpec.providerKey}/${safeSpec.sourceModelId}`]);
  }
  return exactProviderModelSettingRefs(parsed, safeSpec.providerKey);
}

/**
 * 补偿写回原 agents 快照时，为 stage 新增而原快照没有的 settings key 加 tombstone，
 * 否则 RFC7386 merge 会把 rename 产生的 newRef 残留在配置里。
 */
function agentSnapshotCompensationPatch(originalParsed, currentParsed) {
  let patchRoot = clone(originalParsed);
  const addTombstones = (patchOwner, originalOwner, currentOwner) => {
    if (!isRecord(currentOwner?.models)) return;
    const originalModels = isRecord(originalOwner?.models) ? originalOwner.models : {};
    const extra = Object.keys(currentOwner.models).filter((key) => !Object.hasOwn(originalModels, key));
    if (extra.length === 0) return;
    patchOwner.models = clone(originalModels);
    for (const key of extra) patchOwner.models[key] = null;
  };

  if (patchRoot.agents?.defaults) {
    addTombstones(
      patchRoot.agents.defaults,
      originalParsed?.agents?.defaults,
      currentParsed?.agents?.defaults,
    );
  }
  const originalEntries = readCanonicalAgentEntries(originalParsed);
  const currentById = new Map(readCanonicalAgentEntries(currentParsed).map((entry) => [entry.id, entry]));
  for (const entry of originalEntries) addTombstones(entry, entry, currentById.get(entry.id));
  if (originalEntries.length > 0) patchRoot = writeCanonicalAgentEntries(patchRoot, originalEntries);
  return patchRoot.agents;
}

/**
 * config.patch 补偿会写回完整 agents 快照；所有 8.1 canonical 数组路径都必须
 * 显式声明 replace，避免网关把 policy/fallbacks 的删减判成未授权破坏性写入。
 */
function agentConfigArrayReplacePaths(parsed) {
  const paths = [];
  if (Array.isArray(parsed?.agents?.defaults?.model?.fallbacks)) {
    paths.push("agents.defaults.model.fallbacks");
  }
  if (readDefaultModelPolicyAllow(parsed) !== undefined) {
    paths.push("agents.defaults.modelPolicy.allow");
  }
  for (const agent of readCanonicalAgentEntries(parsed)) {
    if (Array.isArray(agent?.model?.fallbacks)) {
      paths.push(`agents.entries.${agent.id}.model.fallbacks`);
    }
    if (readAgentModelPolicyAllow(parsed, agent.id) !== undefined) {
      paths.push(`agents.entries.${agent.id}.modelPolicy.allow`);
    }
  }
  return paths;
}

/** 从 error 生成不包含上游消息的稳定结果字段。 */
function safeError(error) {
  return { code: typeof error?.code === "string" ? error.code : "openclaw_apply_failed" };
}

/** 校验组合根注入的唯一 backend/scanner/runtime 依赖，禁止模块内部另建实例。 */
function validateDependencies({ backend, scanners, runtimeApply }) {
  try {
    if (!backend || typeof backend.request !== "function") throw new TypeError("backend.request 缺失");
    validateReferenceScanners(scanners);
    if (!runtimeApply
      || typeof runtimeApply.inspect !== "function"
      || typeof runtimeApply.acquireForApply !== "function"
      || typeof runtimeApply.recoverLease !== "function") {
      throw new TypeError("runtimeApply 契约不完整");
    }
  } catch (error) {
    throw new OpenClawModelChangeError(
      "invalid_model_change_dependency",
      "OpenClaw model-change 依赖不完整",
      { status: 500, details: { reason: error?.message || String(error) } },
    );
  }
}

/** 创建固定四方法 adapter；同一闭包持有 scanner/runtime 组合依赖。 */
function createOpenClawModelChange({
  backend,
  scanners = MODEL_REFERENCE_SCANNERS,
  runtimeApply,
  scan = scanOpenClawReferences,
  acquireLeases = acquireReferenceMutationLeases,
} = {}) {
  validateDependencies({ backend, scanners, runtimeApply });
  if (typeof scan !== "function" || typeof acquireLeases !== "function") {
    throw new OpenClawModelChangeError(
      "invalid_model_change_dependency",
      "OpenClaw model-change 扫描依赖不完整",
      { status: 500 },
    );
  }

  /** 返回当前实时能力；unknown 仍可预检，但 apply 会在首写前要求安全 runtime lease。 */
  const getCapabilities = async () => {
    const runtime = await runtimeApply.inspect();
    const runtimeKnown = runtime?.safeApply === true;
    return {
      supported: runtimeKnown,
      create: runtimeKnown,
      update: runtimeKnown,
      rename: runtimeKnown,
      delete: runtimeKnown,
      updateProvider: runtimeKnown,
      blockers: runtimeKnown ? [] : ["runtime_apply_unsupported"],
    };
  };

  /** 只读预检：扫描封闭 store、验证 source/target，并公开 runtime requirement。 */
  const preview = async (safeSpec) => {
    const snapshot = await getConfigSnapshot(backend);
    const scanned = await scanForKind(scan, backend, safeSpec, snapshot.parsed);
    const blockers = [...(Array.isArray(scanned.blockers) ? scanned.blockers : [])];
    const { provider, models } = providerState(snapshot.parsed, safeSpec.providerKey);
    const source = models.find((model) => model?.id === safeSpec.sourceModelId);
    const targetId = safeSpec.model?.id;
    const target = models.find((model) => model?.id === targetId);

    // agents.defaults.models 在 8.1 只保存 alias/settings，既不证明模型存在，
    // 也不参与 source/target 冲突判断；modelPolicy.allow 由引用 scanner 管理。
    if (safeSpec.kind === "create") {
      if (target) {
        blockers.push({ code: "target_conflict", store: "config", message: "目标模型已存在" });
      }
      if (safeSpec.providerMode === "new" && provider) {
        blockers.push({ code: "provider_conflict", store: "config", message: "目标 Provider 已存在" });
      }
      if (safeSpec.providerMode === "new" && !safeSpec.baseUrl) {
        blockers.push({ code: "provider_base_url_required", store: "config", message: "新 Provider 缺少 baseUrl" });
      }
      // alias/policy/凭证都不能替代可安全写入的 Provider 配置定义。
      if (safeSpec.providerMode !== "new" && !provider) {
        blockers.push({ code: "provider_not_found", store: "config", message: "Provider 不存在" });
      }
    }
    if (["update", "rename", "delete-model"].includes(safeSpec.kind) && !source) {
      blockers.push({ code: "source_not_found", store: "config", message: "源模型不存在" });
    }
    if (safeSpec.kind === "rename" && target) {
      blockers.push({ code: "target_conflict", store: "config", message: "目标模型已存在" });
    }
    if (["delete-provider", "update-provider"].includes(safeSpec.kind) && !provider) {
      // config 无条目但本机 auth-profiles 有 api_key 的内置 provider(如 openrouter)
      // 同样可管理:换 Key / 撤销授权走 config-only 的 auth-only 路径。
      let authOnly = false;
      try {
        authOnly = backend._localAuthKeyProviders?.().has(safeSpec.providerKey) === true;
      } catch { /* 授权文件读不到按不存在处理 */ }
      if (!authOnly) {
        blockers.push({ code: "provider_not_found", store: "config", message: "Provider 不存在" });
      }
    }
    if (["delete-model", "delete-provider"].includes(safeSpec.kind)
      && scanned.references?.some((reference) => reference.definition !== true)) {
      blockers.push({ code: "references_exist", store: "all", message: "仍有未来模型引用" });
      // Surface primary usage before confirmation/journaling. Ordinary deletion
      // blocks it; endpoint reselection can explicitly preserve these bindings.
      if (scanned.references.some((reference) => reference.store === "config"
        && reference.referenceKey?.endsWith(".model.primary"))) {
        blockers.push({ code: "primary_model_in_use", store: "config", message: "请先切换正在使用的主模型" });
      }
    }

    let runtimeApplyMode = "unsupported";
    try {
      const runtime = await runtimeApply.inspect();
      runtimeApplyMode = typeof runtime?.mode === "string" ? runtime.mode : "unsupported";
      if (runtime?.safeApply !== true) {
        blockers.push({ code: "runtime_apply_unsupported", store: "runtime", message: "运行时变更能力不可用" });
      }
    } catch {
      blockers.push({ code: "runtime_apply_unsupported", store: "runtime", message: "运行时变更能力不可用" });
    }
    const publicReferences = ["delete-model", "delete-provider"].includes(safeSpec.kind)
      ? (scanned.references || []).filter((reference) => reference.definition !== true)
      : scanned.references;
    return {
      ...scanned,
      references: publicReferences,
      stores: {
        ...scanned.stores,
        config: { ...(scanned.stores?.config || {}), baseHash: snapshot.hash },
      },
      blockers,
      runtimeApply: runtimeApplyMode,
      ...(source ? { sourceSnapshot: publicSourceModel(source) } : {}),
      ...(safeSpec.kind === "update-provider" && provider ? {
        providerDiff: {
          beforeDigest: providerPublicDigest(provider),
          afterDigest: providerPublicDigest({
            ...provider,
            ...(safeSpec.patch?.clearBaseUrl === true ? { baseUrl: "" } : {}),
            ...(Object.prototype.hasOwnProperty.call(safeSpec.patch || {}, "baseUrl")
              ? { baseUrl: safeSpec.patch.baseUrl }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(safeSpec.patch || {}, "api")
              ? { api: safeSpec.patch.api }
              : {}),
          }),
        },
      } : {}),
    };
  };

  /** 迁移 Session/Cron 并逐项回读、journal；config 已在 stage-target 原子迁移。 */
  const migrateExternalReferences = async (references, leaseContext, context, completed) => {
    for (const reference of references.filter((item) => item.store === "sessions" || item.store === "cron")) {
      const scanner = scannerFor(scanners, reference);
      const startedAt = Date.now();
      context.assertProviderLease?.();
      leaseContext[reference.store]?.checkpoint?.();
      const before = await scanner.read(backend, reference, leaseContext[reference.store] || {});
      if (stableJson(before) !== stableJson(reference.before)) {
        throw new OpenClawModelChangeError("reference_fingerprint_changed", "引用在写前发生变化", {
          stage: "migrate-references",
        });
      }
      await scanner.write(backend, reference, leaseContext[reference.store] || {});
      const verified = await scanner.verify(backend, reference, leaseContext[reference.store] || {});
      if (verified !== true) {
        throw new OpenClawModelChangeError("reference_verify_failed", "引用写后回读不一致", {
          stage: "migrate-references",
        });
      }
      completed.push({ reference, scanner, leaseContext: leaseContext[reference.store] || {} });
      await context.recordStep?.(journalStep(reference, "verified", { startedAt }));
    }
  };

  /** 逆序补偿已迁移的 Session/Cron；任何失败都继续尝试其余项。 */
  const undoExternalReferences = async (completed, context) => {
    let failed = false;
    for (const item of [...completed].reverse()) {
      try {
        context.assertProviderLease?.();
        await item.scanner.undo(backend, item.reference, item.leaseContext);
        await context.recordStep?.(journalStep(item.reference, "compensated", {
          readback: item.reference.undo,
        }));
      } catch {
        failed = true;
      }
    }
    return !failed;
  };

  /** 生成 stage-target 的单次 config.patch 与完整回滚 patch。 */
  const stagePatch = (safeSpec, scanned, snapshot, secretEnvelope) => {
    const parsed = snapshot.parsed;
    const { provider, models } = providerState(parsed, safeSpec.providerKey);
    const sourceIndex = models.findIndex((model) => model?.id === safeSpec.sourceModelId);
    const originalProvider = clone(provider);
    let nextProvider = clone(provider);
    let nextModels = clone(models);
    let patch;
    let replacePaths = [];

    if (safeSpec.kind === "create") {
      const entry = mergeModelEntry(null, safeSpec.model);
      if (safeSpec.providerMode === "new") {
        nextProvider = {
          baseUrl: safeSpec.baseUrl,
          api: safeSpec.api || "openai-completions",
          ...(secretEnvelope?.apiKey ? { apiKey: secretEnvelope.apiKey } : {}),
          models: [entry],
        };
      } else {
        nextProvider = { ...clone(provider), models: [...nextModels, entry] };
        replacePaths = [`models.providers.${safeSpec.providerKey}.models`];
      }
      patch = { models: { providers: { [safeSpec.providerKey]: nextProvider } } };
    } else if (safeSpec.kind === "update") {
      nextModels[sourceIndex] = mergeModelEntry(nextModels[sourceIndex], safeSpec.model);
      nextProvider = { ...clone(provider), models: nextModels };
      patch = { models: { providers: { [safeSpec.providerKey]: { models: nextModels } } } };
      replacePaths = [`models.providers.${safeSpec.providerKey}.models`];
    } else if (safeSpec.kind === "rename") {
      const target = mergeModelEntry(nextModels[sourceIndex], safeSpec.model);
      nextModels.push(target);
      nextProvider = { ...clone(provider), models: nextModels };
      const configReferences = applyConfigReferences(parsed, scanned.references || []);
      const settings = renameAgentModelSettings(
        { ...parsed, ...(configReferences.agents ? { agents: configReferences.agents } : {}) },
        `${safeSpec.providerKey}/${safeSpec.sourceModelId}`,
        `${safeSpec.providerKey}/${safeSpec.model.id}`,
      );
      patch = {
        models: { providers: { [safeSpec.providerKey]: { models: nextModels } } },
        ...(settings.agents ? { agents: settings.agents } : {}),
      };
      replacePaths = [
        `models.providers.${safeSpec.providerKey}.models`,
        ...(scanned.stores?.config?.replacePaths || []),
      ];
    } else if (safeSpec.kind === "update-provider") {
      const providerPatch = {};
      if (safeSpec.patch?.clearBaseUrl === true) providerPatch.baseUrl = null;
      for (const field of ["baseUrl", "api"]) {
        if (Object.prototype.hasOwnProperty.call(safeSpec.patch || {}, field)) providerPatch[field] = safeSpec.patch[field];
      }
      if (secretEnvelope?.apiKey) providerPatch.apiKey = secretEnvelope.apiKey;
      nextProvider = { ...clone(provider), ...providerPatch };
      if (providerPatch.baseUrl === null) delete nextProvider.baseUrl;
      patch = { models: { providers: { [safeSpec.providerKey]: providerPatch } } };
    } else {
      throw new OpenClawModelChangeError("invalid_change_kind", "kind 不支持 stage-target");
    }
    return { patch, replacePaths, originalProvider, nextProvider };
  };

  /** 用 fresh baseHash 恢复 Provider 与 Agent 配置；新 Provider 仅在未被外部扩展时整项删除。 */
  const undoStagePatch = async (safeSpec, context, originalSnapshot, stagedProvider) => {
    const fresh = await getConfigSnapshot(backend);
    const currentProvider = providerState(fresh.parsed, safeSpec.providerKey).provider;
    if (originalSnapshot.parsed?.models?.providers?.[safeSpec.providerKey] == null
      && stableJson(currentProvider) !== stableJson(stagedProvider)) {
      return { ok: false, manualCleanup: true };
    }
    const originalProvider = originalSnapshot.parsed?.models?.providers?.[safeSpec.providerKey] ?? null;
    const patch = {
      models: { providers: { [safeSpec.providerKey]: clone(originalProvider) } },
      ...(originalSnapshot.parsed.agents ? {
        agents: agentSnapshotCompensationPatch(originalSnapshot.parsed, fresh.parsed),
      } : {}),
    };
    await patchConfig(backend, context, fresh, patch, [
      `models.providers.${safeSpec.providerKey}.models`,
      ...agentConfigArrayReplacePaths(originalSnapshot.parsed),
    ]);
    return { ok: true, manualCleanup: false };
  };

  /** rename 五阶段；所有 precommit 错误都逆序补偿，source retire 前保持存在。 */
  const applyRename = async (safeSpec, context, secretEnvelope, initialPreview) => {
    const references = initialPreview.references || [];
    const referenceLeases = await acquireLeases(backend, references, {
      safeSpec,
      expectedFingerprints: initialPreview.fingerprints,
      rescan: () => scanForKind(scan, backend, safeSpec, initialPreview._snapshot?.parsed),
    });
    return referenceLeases.run(async (leaseContext) => {
      let runtimeLease = null;
      let originalSnapshot = null;
      let stagedProvider = null;
      const completed = [];
      let committed = false;
      try {
        const fresh = await scanForKind(scan, backend, safeSpec, initialPreview._snapshot?.parsed);
        if (!fingerprintsEqual(context.journalEntry?.fingerprints, fresh.fingerprints)) {
          return blocked("reference_fingerprint_changed");
        }
        originalSnapshot = await getConfigSnapshot(backend);
        if (originalSnapshot.hash !== initialPreview.stores?.config?.baseHash) {
          return blocked("reference_fingerprint_changed");
        }
        runtimeLease = await runtimeApply.acquireForApply({
          operationId: context.operationId,
          mode: initialPreview.runtimeApply,
        });
        await context.recordStage?.("preflight", { fingerprints: initialPreview.fingerprints });

        const staged = stagePatch(safeSpec, initialPreview, originalSnapshot, secretEnvelope);
        stagedProvider = staged.nextProvider;
        await patchConfig(backend, context, originalSnapshot, staged.patch, staged.replacePaths);
        await context.recordStage?.("stage-target", { fingerprints: initialPreview.fingerprints });
        for (const reference of references.filter((item) => item.store === "config" && item.definition !== true)) {
          await context.recordStep?.(journalStep(reference, "verified"));
        }

        await migrateExternalReferences(references, leaseContext, context, completed);
        await context.recordStage?.("migrate-references", { fingerprints: initialPreview.fingerprints });
        const readyScan = await scanForKind(scan, backend, safeSpec, originalSnapshot.parsed);
        const futureReferences = (readyScan.references || []).filter((reference) => reference.definition !== true);
        if (futureReferences.length > 0) {
          throw new OpenClawModelChangeError("references_remain", "旧模型仍有未来引用", { stage: "verify-ready" });
        }
        if (await runtimeLease.verifyTarget(safeSpec, { verify: () => runtimeApply.verifyTarget?.(safeSpec) }) !== true) {
          throw new OpenClawModelChangeError("runtime_target_not_ready", "目标模型未进入运行目录", { stage: "verify-ready" });
        }
        await context.recordStage?.("verify-ready", { fingerprints: readyScan.fingerprints });

        await context.markCommitting?.({ fingerprints: readyScan.fingerprints });
        const retireSnapshot = await getConfigSnapshot(backend);
        const { provider, models } = providerState(retireSnapshot.parsed, safeSpec.providerKey);
        const retiredModels = models.filter((model) => model?.id !== safeSpec.sourceModelId);
        if (retiredModels.length === models.length) {
          // 不确定响应后的幂等重试：source 已不存在即视为提交完成，不再二次删除。
          committed = true;
        } else {
          try {
            await patchConfig(backend, context, retireSnapshot, {
              models: { providers: { [safeSpec.providerKey]: { ...clone(provider), models: retiredModels } } },
            }, [`models.providers.${safeSpec.providerKey}.models`]);
          } catch (error) {
            const readback = await getConfigSnapshot(backend);
            const sourceStillExists = providerState(readback.parsed, safeSpec.providerKey).models
              .some((model) => model?.id === safeSpec.sourceModelId);
            if (sourceStillExists) throw error;
          }
          committed = true;
        }
        await context.markCommitted?.({ fingerprints: readyScan.fingerprints });
        const converged = await runtimeLease.convergeAfterRetire(safeSpec);
        await context.recordStage?.("commit-retire", { fingerprints: readyScan.fingerprints });
        if (converged !== true) return { status: "cleanup_pending", code: "runtime_ghost", stage: "commit-retire" };
        return { status: "applied", stage: "commit-retire" };
      } catch (error) {
        if (committed) return { status: "cleanup_pending", code: safeError(error).code, stage: "commit-retire" };
        const referencesUndone = await undoExternalReferences(completed, context);
        let configUndo = { ok: true, manualCleanup: false };
        if (originalSnapshot && stagedProvider) {
          try { configUndo = await undoStagePatch(safeSpec, context, originalSnapshot, stagedProvider); }
          catch { configUndo = { ok: false, manualCleanup: false }; }
        }
        if (referencesUndone && configUndo.ok) {
          return { status: "compensated", code: safeError(error).code, stage: error?.stage || "apply" };
        }
        return {
          status: "partial",
          code: safeError(error).code,
          stage: error?.stage || "apply",
          ...(configUndo.manualCleanup ? { manualCleanup: true } : {}),
        };
      } finally {
        try { await runtimeLease?.release(); } catch { /* 结果已由主状态机决定，释放失败由恢复重试。 */ }
      }
    });
  };

  /** create/update/update-provider 共用 stage + verify，但绝不执行 rename source retire。 */
  const applyStageOnly = async (safeSpec, context, secretEnvelope, initialPreview) => {
    if (safeSpec.kind === "create"
      && safeSpec.providerMode === "new"
      && context.journalEntry?.secretStep === "pending"
      && !secretEnvelope?.apiKey) {
      return { status: "needs_secret", code: "secret_required", stage: "stage-target" };
    }
    let runtimeLease = null;
    let originalSnapshot = null;
    let stagedProvider = null;
    try {
      const fresh = await scanForKind(scan, backend, safeSpec, initialPreview._snapshot?.parsed);
      // 旧版本的待恢复 create journal 包含 Session/Cron 指纹；新增已不依赖这两项，
      // 续提凭据时同样只移除它们，保留配置及其它指纹的严格比较。
      const expectedFingerprints = safeSpec.kind === "create"
        && !Object.hasOwn(fresh.fingerprints, "sessions")
        && !Object.hasOwn(fresh.fingerprints, "cron")
        ? Object.fromEntries(Object.entries(context.journalEntry?.fingerprints || {})
          .filter(([key]) => key !== "sessions" && key !== "cron"))
        : context.journalEntry?.fingerprints;
      if (!fingerprintsEqual(expectedFingerprints, fresh.fingerprints)) {
        return blocked("reference_fingerprint_changed");
      }
      originalSnapshot = await getConfigSnapshot(backend);
      if (originalSnapshot.hash !== initialPreview.stores?.config?.baseHash) return blocked("reference_fingerprint_changed");
      runtimeLease = await runtimeApply.acquireForApply({ operationId: context.operationId, mode: initialPreview.runtimeApply });
      await context.recordStage?.("preflight", { fingerprints: initialPreview.fingerprints });
      const staged = stagePatch(safeSpec, initialPreview, originalSnapshot, secretEnvelope);
      stagedProvider = staged.nextProvider;
      await patchConfig(backend, context, originalSnapshot, staged.patch, staged.replacePaths);
      await context.recordStage?.("stage-target", {
        fingerprints: initialPreview.fingerprints,
        ...(safeSpec.kind === "create" && safeSpec.providerMode === "new" ? { createdProvider: true } : {}),
        ...(secretEnvelope?.apiKey ? { secretStep: "applied" } : {}),
      });
      if (safeSpec.kind !== "update-provider") {
        if (await runtimeLease.verifyTarget(safeSpec, {}) !== true) {
          throw new OpenClawModelChangeError("runtime_target_not_ready", "目标模型未进入运行目录", { stage: "verify-ready" });
        }
      }
      await context.recordStage?.("verify-ready", { fingerprints: initialPreview.fingerprints });
      // Journal 提交点严格 precommit → committing → committed，即使无 retire 阶段也不能跳级。
      await context.markCommitting?.({ fingerprints: initialPreview.fingerprints });
      await context.markCommitted?.({
        fingerprints: initialPreview.fingerprints,
        ...(secretEnvelope?.apiKey ? { secretStep: "applied" } : {}),
      });
      return { status: "applied", stage: "verify-ready" };
    } catch (error) {
      let undo = { ok: true, manualCleanup: false };
      if (originalSnapshot && stagedProvider) {
        try { undo = await undoStagePatch(safeSpec, context, originalSnapshot, stagedProvider); }
        catch { undo = { ok: false, manualCleanup: false }; }
      }
      if (secretEnvelope?.apiKey) {
        return {
          status: "partial",
          code: safeError(error).code,
          stage: error?.stage || "apply",
          manualCredentialCheck: true,
          ...(!undo.ok && undo.manualCleanup ? { manualCleanup: true } : {}),
        };
      }
      return undo.ok
        ? { status: "compensated", code: safeError(error).code, stage: error?.stage || "apply" }
        : { status: "partial", code: safeError(error).code, stage: error?.stage || "apply", ...(undo.manualCleanup ? { manualCleanup: true } : {}) };
    } finally {
      try { await runtimeLease?.release(); } catch { /* 交由 journal recovery 收敛。 */ }
    }
  };

  /** delete-model/delete-provider 先 committing，条件删除回读后只向前收敛。 */
  const applyDelete = async (safeSpec, context, initialPreview) => {
    let runtimeLease = null;
    try {
      const fresh = await scanForKind(scan, backend, safeSpec, initialPreview._snapshot?.parsed);
      if (!fingerprintsEqual(context.journalEntry?.fingerprints, fresh.fingerprints)) {
        return blocked("reference_fingerprint_changed");
      }
      if ((fresh.references || []).some((reference) => reference.definition !== true)) return blocked("references_exist");
      const snapshot = await getConfigSnapshot(backend);
      if (snapshot.hash !== initialPreview.stores?.config?.baseHash) return blocked("reference_fingerprint_changed");
      runtimeLease = await runtimeApply.acquireForApply({ operationId: context.operationId, mode: initialPreview.runtimeApply });
      await context.recordStage?.("preflight", { fingerprints: initialPreview.fingerprints });
      await context.markCommitting?.({ fingerprints: initialPreview.fingerprints });
      const { provider, models } = providerState(snapshot.parsed, safeSpec.providerKey);
      const settings = deleteAgentModelSettings(
        snapshot.parsed,
        exactModelSettingRefsForDelete(safeSpec, snapshot.parsed),
      );
      const providerPatch = safeSpec.kind === "delete-provider"
        ? null
        : { ...clone(provider), models: models.filter((model) => model?.id !== safeSpec.sourceModelId) };
      try {
        await patchConfig(backend, context, snapshot, {
          models: { providers: { [safeSpec.providerKey]: providerPatch } },
          ...(settings.changed ? { agents: settings.agents } : {}),
        }, [`models.providers.${safeSpec.providerKey}.models`]);
      } catch (error) {
        const readback = await getConfigSnapshot(backend);
        const current = providerState(readback.parsed, safeSpec.providerKey);
        const stillExists = safeSpec.kind === "delete-provider"
          ? current.provider !== null
          : current.models.some((model) => model?.id === safeSpec.sourceModelId);
        if (stillExists) throw error;
      }
      await context.markCommitted?.({ fingerprints: initialPreview.fingerprints });
      const converged = await runtimeLease.convergeAfterRetire(safeSpec);
      await context.recordStage?.("commit-retire", { fingerprints: initialPreview.fingerprints });
      return converged === true
        ? { status: "applied", stage: "commit-retire" }
        : { status: "cleanup_pending", code: "runtime_ghost", stage: "commit-retire" };
    } catch (error) {
      return { status: "blocked", code: safeError(error).code, stage: error?.stage || "commit-retire" };
    } finally {
      try { await runtimeLease?.release(); } catch { /* forward-only recovery 会重试收敛。 */ }
    }
  };

  /** 顶层按 kind 选择显式 handler，禁止把 rename 五阶段复用于其它操作。 */
  const apply = async (safeSpec, context, secretEnvelope) => {
    const initialPreview = await preview(safeSpec);
    if (initialPreview.blockers.length > 0) {
      return blocked(initialPreview.blockers[0].code, "preflight", { blockers: initialPreview.blockers });
    }
    // 只在本次调用栈保存 config snapshot，返回给 coordinator 的公开 preview 不含此字段。
    initialPreview._snapshot = await getConfigSnapshot(backend);
    if (safeSpec.kind === "rename") return applyRename(safeSpec, context, secretEnvelope, initialPreview);
    if (["create", "update", "update-provider"].includes(safeSpec.kind)) {
      return applyStageOnly(safeSpec, context, secretEnvelope, initialPreview);
    }
    if (["delete-model", "delete-provider"].includes(safeSpec.kind)) return applyDelete(safeSpec, context, initialPreview);
    return blocked("invalid_change_kind");
  };

  /** 从 journal 公开 modelDiff 重建不含凭证的最小 safeSpec。 */
  const specFromEntry = (entry) => ({
    kind: entry.kind,
    providerKey: entry.providerKey,
    providerMode: entry.createdProvider ? "new" : "existing",
    sourceModelId: entry.source?.modelId || null,
    model: entry.modelDiff?.after ? clone(entry.modelDiff.after) : undefined,
  });

  /** 只比较 config 模型真实持有的公开字段，忽略 journal 身份辅助字段。 */
  const modelMatchesJournal = (current, expected) => {
    if (!current || !expected) return false;
    for (const field of ["id", "name", "contextWindow", "maxTokens", "reasoning"]) {
      if (Object.prototype.hasOwnProperty.call(expected, field)
        && stableJson(current[field]) !== stableJson(expected[field])) return false;
    }
    return true;
  };

  /** 恢复时使用当前已证明的 runtime mode，避免 hot 后端被错当 unknown 强制要求 supervisor。 */
  const acquireRecoveryRuntimeLease = async (entry) => {
    const inspected = await runtimeApply.inspect();
    return runtimeApply.recoverLease(entry.operationId, { mode: inspected?.mode || "unknown" });
  };

  /** 使用 fresh baseHash 幂等退役 source，不存在视为上次不确定响应已成功。 */
  const retireRecoverySource = async (safeSpec, entry, context) => {
    const snapshot = await getConfigSnapshot(backend);
    const { provider, models } = providerState(snapshot.parsed, safeSpec.providerKey);
    const isProviderDelete = safeSpec.kind === "delete-provider";
    const sourceExists = isProviderDelete
      ? provider !== null
      : models.some((model) => model?.id === safeSpec.sourceModelId);
    const settings = deleteAgentModelSettings(
      snapshot.parsed,
      exactModelSettingRefsForDelete(safeSpec, snapshot.parsed),
    );
    if (sourceExists || settings.changed) {
      if (entry.commitState === "precommit") await context.markCommitting?.({ fingerprints: entry.fingerprints });
      const providerPatch = isProviderDelete
        ? null
        : { ...clone(provider), models: models.filter((model) => model?.id !== safeSpec.sourceModelId) };
      await patchConfig(backend, context, snapshot, {
        ...(sourceExists ? { models: { providers: { [safeSpec.providerKey]: providerPatch } } } : {}),
        ...(settings.changed ? { agents: settings.agents } : {}),
      }, sourceExists ? [`models.providers.${safeSpec.providerKey}.models`] : []);
    }
    await context.markCommitted?.({ fingerprints: entry.fingerprints });
  };

  /**
   * rename 恢复以 fresh source/target 组合判断进度：target 已 stage 则继续迁移，
   * source 已缺失则直接进入 forward convergence。不再比较旧进程全局 fingerprint。
   */
  const recoverRename = async (safeSpec, entry, context) => {
    let snapshot = await getConfigSnapshot(backend);
    let { models } = providerState(snapshot.parsed, safeSpec.providerKey);
    let source = models.find((model) => model?.id === safeSpec.sourceModelId);
    let target = models.find((model) => model?.id === safeSpec.model?.id);
    if (!source && !target) return blocked("recovery_state_inconsistent", "recovery");
    if (target && !modelMatchesJournal(target, safeSpec.model)) {
      return blocked("target_conflict", "recovery");
    }

    let runtimeLease = null;
    try {
      runtimeLease = await acquireRecoveryRuntimeLease(entry);
      if (source && !target) {
        // target 尚未落盘时可仅凭公开 modelDiff 在既有 Provider 内安全重放。
        const scanned = await scanForKind(scan, backend, safeSpec, snapshot.parsed);
        const staged = stagePatch(safeSpec, scanned, snapshot, null);
        await patchConfig(backend, context, snapshot, staged.patch, staged.replacePaths);
        await context.recordStage?.("stage-target", { fingerprints: scanned.fingerprints });
        snapshot = await getConfigSnapshot(backend);
        ({ models } = providerState(snapshot.parsed, safeSpec.providerKey));
        source = models.find((model) => model?.id === safeSpec.sourceModelId);
        target = models.find((model) => model?.id === safeSpec.model?.id);
      }
      if (!target || !modelMatchesJournal(target, safeSpec.model)) {
        return blocked("runtime_target_not_ready", "recovery");
      }

      if (source) {
        const scanned = await scanForKind(scan, backend, safeSpec, snapshot.parsed);
        if ((scanned.blockers || []).length > 0) {
          return blocked(scanned.blockers[0].code, "recovery", { blockers: scanned.blockers });
        }
        const references = scanned.references || [];
        const referenceLeases = await acquireLeases(backend, references, {
          safeSpec,
          expectedFingerprints: scanned.fingerprints,
          rescan: () => scanForKind(scan, backend, safeSpec, snapshot.parsed),
        });
        const migrated = await referenceLeases.run(async (leaseContext) => {
          const completed = [];
          const fresh = await getConfigSnapshot(backend);
          const freshScan = await scanForKind(scan, backend, safeSpec, fresh.parsed);
          const configReferences = (freshScan.references || [])
            .filter((reference) => reference.store === "config" && reference.definition !== true);
          if (configReferences.length > 0) {
            const configPatch = applyConfigReferences(fresh.parsed, configReferences);
            await patchConfig(backend, context, fresh, { agents: configPatch.agents }, freshScan.stores?.config?.replacePaths || []);
            for (const reference of configReferences) {
              await context.recordStep?.(journalStep(reference, "verified"));
            }
          }
          await migrateExternalReferences(freshScan.references || [], leaseContext, context, completed);
          return true;
        });
        if (migrated !== true) return blocked("reference_migration_failed", "recovery");
        const ready = await scanForKind(scan, backend, safeSpec, snapshot.parsed);
        if ((ready.references || []).some((reference) => reference.definition !== true)) {
          return blocked("references_remain", "recovery");
        }
        await context.recordStage?.("verify-ready", { fingerprints: ready.fingerprints });
        if (await runtimeLease.verifyTarget(safeSpec, {}) !== true) {
          return blocked("runtime_target_not_ready", "recovery");
        }
        await retireRecoverySource(safeSpec, entry, context);
      } else {
        // source 已不存在就是权威提交证据；补记 committed 后禁止任何补偿。
        if (entry.commitState === "precommit") await context.markCommitting?.({ fingerprints: entry.fingerprints });
        await context.markCommitted?.({ fingerprints: entry.fingerprints });
      }
      const converged = await runtimeLease.convergeAfterRetire(safeSpec);
      return converged === true
        ? { status: "applied", stage: "recovery" }
        : { status: "cleanup_pending", code: "runtime_ghost", stage: "recovery" };
    } finally {
      try { await runtimeLease?.release(); } catch { /* 保留非终态，下次恢复重试。 */ }
    }
  };

  /** create/update 恢复按 target 公开字段幂等验证，缺失时只重放无凭证写。 */
  const recoverStageOnly = async (safeSpec, entry, context) => {
    if (safeSpec.kind === "update-provider") {
      if (entry.stage === "preflight" && entry.commitState === "precommit") {
        return { status: "compensated", code: "recovery_no_write", stage: "recovery" };
      }
      const snapshot = await getConfigSnapshot(backend);
      const current = providerState(snapshot.parsed, safeSpec.providerKey).provider;
      const currentDigest = providerPublicDigest(current);
      // 仅凭相同公开摘要无法证明 apiKey-only 写已经发生；未记录 secretStep 时必须续提。
      if (entry.providerDiff?.beforeDigest === entry.providerDiff?.afterDigest
        && entry.secretStep !== "applied"
        && entry.commitState === "precommit") {
        return { status: "needs_secret", code: "recovery_input_required", stage: "recovery" };
      }
      if (currentDigest === entry.providerDiff?.afterDigest) {
        if (entry.commitState === "precommit") await context.markCommitting?.({ fingerprints: entry.fingerprints });
        await context.markCommitted?.({ fingerprints: entry.fingerprints });
        return { status: "applied", stage: "recovery" };
      }
      if (currentDigest === entry.providerDiff?.beforeDigest) {
        return { status: "needs_secret", code: "recovery_input_required", stage: "recovery" };
      }
      return blocked("provider_recovery_conflict", "recovery");
    }
    let snapshot = await getConfigSnapshot(backend);
    let { provider, models } = providerState(snapshot.parsed, safeSpec.providerKey);
    let target = models.find((model) => model?.id === safeSpec.model?.id);
    if (safeSpec.kind === "create" && target && !modelMatchesJournal(target, safeSpec.model)) {
      return blocked("target_conflict", "recovery");
    }
    if (!target || !modelMatchesJournal(target, safeSpec.model)) {
      if (safeSpec.kind === "create" && entry.createdProvider && !provider) {
        // 新 Provider 的 baseUrl/凭证不落 journal，必须由原请求重新提交。
        return { status: "needs_secret", code: "recovery_input_required", stage: "recovery" };
      }
      const scanned = await scanForKind(scan, backend, safeSpec, snapshot.parsed);
      const staged = stagePatch(safeSpec, scanned, snapshot, null);
      let runtimeLease = null;
      try {
        runtimeLease = await acquireRecoveryRuntimeLease(entry);
        await patchConfig(backend, context, snapshot, staged.patch, staged.replacePaths);
        await context.recordStage?.("stage-target", { fingerprints: scanned.fingerprints });
        snapshot = await getConfigSnapshot(backend);
        ({ models } = providerState(snapshot.parsed, safeSpec.providerKey));
        target = models.find((model) => model?.id === safeSpec.model?.id);
        if (!modelMatchesJournal(target, safeSpec.model)
          || await runtimeLease.verifyTarget(safeSpec, {}) !== true) {
          return blocked("runtime_target_not_ready", "recovery");
        }
        if (entry.commitState === "precommit") await context.markCommitting?.({ fingerprints: scanned.fingerprints });
        await context.markCommitted?.({ fingerprints: scanned.fingerprints });
        return { status: "applied", stage: "recovery" };
      } finally {
        try { await runtimeLease?.release(); } catch { /* 下次恢复会重新取 lease。 */ }
      }
    }
    const runtimeLease = await acquireRecoveryRuntimeLease(entry);
    try {
      if (await runtimeLease.verifyTarget(safeSpec, {}) !== true) {
        return blocked("runtime_target_not_ready", "recovery");
      }
      if (entry.commitState === "precommit") await context.markCommitting?.({ fingerprints: entry.fingerprints });
      await context.markCommitted?.({ fingerprints: entry.fingerprints });
      return { status: "applied", stage: "recovery" };
    } finally {
      try { await runtimeLease.release(); } catch { /* 下次恢复会重新取 lease。 */ }
    }
  };

  /** delete 只有 committing 才可能已写；precommit 无写直接补偿终态。 */
  const recoverDelete = async (safeSpec, entry, context) => {
    if (entry.commitState === "precommit") {
      return { status: "compensated", code: "recovery_no_write", stage: "recovery" };
    }
    const runtimeLease = await acquireRecoveryRuntimeLease(entry);
    try {
      await retireRecoverySource(safeSpec, entry, context);
      const converged = await runtimeLease.convergeAfterRetire(safeSpec);
      return converged === true
        ? { status: "applied", stage: "recovery" }
        : { status: "cleanup_pending", code: "runtime_ghost", stage: "recovery" };
    } finally {
      try { await runtimeLease.release(); } catch { /* 下次恢复会重新取 lease。 */ }
    }
  };

  /** 恢复以 fresh source/target 为提交真值，按 kind 选择幂等的补偿或前向收敛。 */
  const recover = async (entry, context) => {
    const safeSpec = specFromEntry(entry);
    try {
      if (safeSpec.kind === "rename") return await recoverRename(safeSpec, entry, context);
      if (["create", "update", "update-provider"].includes(safeSpec.kind)) {
        return await recoverStageOnly(safeSpec, entry, context);
      }
      if (["delete-model", "delete-provider"].includes(safeSpec.kind)) {
        return await recoverDelete(safeSpec, entry, context);
      }
      return blocked("invalid_change_kind", "recovery");
    } catch (error) {
      return blocked(safeError(error).code, "recovery");
    }
  };

  return Object.freeze({ getCapabilities, preview, apply, recover });
}

module.exports = {
  OpenClawModelChangeError,
  createOpenClawModelChange,
  providerPublicDigest,
};
