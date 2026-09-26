"use strict";

// Hermes 五类模型引用 scanner。所有枚举都按 Profile 形成独立完整性证据；未知
// shape、分页或 owner 一律 blocker，preview 阶段不执行任何写入。

const { createHash } = require("node:crypto");

const HERMES_SCANNER_VERSION = 1;
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGES = 100;
const REQUIRED_METHODS = Object.freeze(["enumerate", "read", "write", "verify", "undo"]);

/** Hermes 引用扫描稳定错误。 */
class HermesModelReferenceError extends Error {
  constructor(code, message, { status = 409, store, profile } = {}) {
    super(message);
    this.name = "HermesModelReferenceError";
    this.code = code;
    this.status = status;
    this.store = store;
    this.profile = profile;
  }
}

/** JSON 隔离副本。 */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 稳定 JSON 用于跨页/回读 fingerprint。 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 内容摘要只覆盖公开模型字段，不含 Provider secret。 */
function fingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** 解析 backend 桥接返回的 JSON body，并拒绝未知形状。 */
function parseBody(response, store, profile) {
  if (!response || Number(response.status) !== 200) {
    throw new HermesModelReferenceError(`${store}_enumeration_incomplete`, `${store} 读取失败`, { store, profile });
  }
  if (response.body && typeof response.body === "object") return clone(response.body);
  try {
    const parsed = JSON.parse(response.body);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // 下方统一抛稳定 shape 错误。
  }
  throw new HermesModelReferenceError(`${store}_enumeration_incomplete`, `${store} 返回未知 shape`, { store, profile });
}

/** 能力只接受非空 ETag 与明确 if-match，不根据成功状态猜测。 */
function capabilityOf(response, store, profile) {
  const headers = response?.headers || {};
  const etag = typeof headers.etag === "string" ? headers.etag.trim() : "";
  const declaration = String(headers["x-hermes-conditional-write"] || "").trim().toLowerCase();
  return {
    store,
    profile,
    etag,
    mutationVersion: String(headers["x-hermes-mutation-version"] || ""),
    supported: Boolean(etag) && declaration === "if-match",
  };
}

/** Provider models 的在野 list/dict 统一为公开条目。 */
function modelEntries(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => typeof item === "string" ? { id: item } : item)
      .filter((item) => item && typeof item === "object" && typeof item.id === "string" && item.id);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([id, meta]) => ({
      id,
      ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}),
    }));
  }
  return [];
}

/** 构造可补偿、无 secret 的引用记录。 */
function reference(scannerId, store, profile, referenceKey, before, after, snapshot, extra = {}) {
  return {
    scannerId,
    store,
    profile,
    referenceKey,
    before: clone(before),
    after: clone(after),
    undo: clone(before),
    fingerprint: fingerprint({ profile, referenceKey, before }),
    snapshot: clone(snapshot),
    ...extra,
  };
}

/** 稳定 blocker。 */
function blocker(code, store, profile, message, extra = {}) {
  return { code, store, profile, message, ...extra };
}

/** 从 backend 当前拓扑捕获排序 Profile；空拓扑同样不允许扫描。 */
function profilesOf(backend) {
  const profiles = backend?.dashboards instanceof Map ? [...backend.dashboards.keys()].sort() : [];
  if (profiles.length === 0) {
    throw new HermesModelReferenceError("hermes_profile_required", "没有可扫描的 Hermes Profile");
  }
  return profiles;
}

/** 调用 backend 受限原始桥接，scanner 不复制 HTTP/Authorization 逻辑。 */
async function readStore(backend, profile, store, options = {}) {
  if (typeof backend?.readHermesModelReferenceStore !== "function") {
    throw new HermesModelReferenceError("hermes_reference_transport_missing", "backend 缺少引用读取桥接", {
      status: 500, store, profile,
    });
  }
  return backend.readHermesModelReferenceStore(profile, store, options);
}

/** 读取单引用由 backend 按 store/referenceKey 回读权威值。 */
async function readReference(backend, item) {
  if (typeof backend?.readHermesModelReference !== "function") return clone(item.before);
  return backend.readHermesModelReference(item);
}

/** 可写 store 的条件写统一委托 backend。 */
async function writeReference(backend, item, value = item.after) {
  if (typeof backend?.writeHermesModelReference !== "function") {
    throw new HermesModelReferenceError("hermes_reference_transport_missing", "backend 缺少引用写入桥接", {
      status: 500, store: item.store, profile: item.profile,
    });
  }
  return backend.writeHermesModelReference(item, clone(value));
}

/** 写后权威回读比较。 */
async function verifyReference(backend, item) {
  return stableJson(await readReference(backend, item)) === stableJson(item.after);
}

/** 补偿写回 before。 */
async function undoReference(backend, item) {
  return writeReference(backend, item, item.undo);
}

/** Session 是永久 blocker store，write/undo 不允许伪装可迁移。 */
async function unsupportedSessionWrite(_backend, item) {
  throw new HermesModelReferenceError(
    "hermes_session_write_unsupported",
    "Hermes Session 模型引用不可安全改写",
    { store: "sessions", profile: item?.profile },
  );
}

/** Provider 定义 scanner。 */
const providerConfigScanner = {
  id: "hermes.provider.v1",
  store: "provider",
  async enumerate(backend, safeSpec, profiles) {
    const rows = [];
    const references = [];
    const blockers = [];
    const meta = {};
    for (const profile of profiles) {
      try {
        const response = await readStore(backend, profile, "provider");
        const body = parseBody(response, "provider", profile);
        const providers = body.providers && typeof body.providers === "object" ? body.providers : {};
        const provider = providers[safeSpec.providerKey];
        const models = modelEntries(provider?.models);
        const snapshot = capabilityOf(response, "provider", profile);
        const source = models.find((model) => model.id === safeSpec.sourceModelId);
        if (source) {
          const before = { profile, provider: safeSpec.providerKey, modelId: source.id, model: clone(source) };
          const afterModel = { ...clone(source), ...clone(safeSpec.model), id: safeSpec.model.id };
          const after = { profile, provider: safeSpec.providerKey, modelId: afterModel.id, model: afterModel };
          references.push(reference(this.id, this.store, profile, `${profile}:${safeSpec.providerKey}:${source.id}`, before, after, snapshot, { definition: true }));
          if (!snapshot.supported) blockers.push(blocker(
            "hermes_conditional_write_unsupported", this.store, profile, "Provider store 不支持 If-Match",
          ));
        }
        const publicRows = Object.entries(providers).map(([providerKey, entry]) => ({
          provider: providerKey,
          // 端点与 API mode 只进入摘要，journal/fingerprint 永不保存原始 URL。
          providerConfigDigest: fingerprint({
            baseUrl: String(entry?.base_url || entry?.baseUrl || entry?.url || ""),
            apiMode: String(entry?.api_mode || ""),
          }),
          models: modelEntries(entry?.models).map((model) => ({
            id: model.id,
            ...(typeof model.name === "string" ? { name: model.name } : {}),
            ...(Number(model.context_length || model.contextLength) > 0
              ? { contextWindow: Number(model.context_length || model.contextLength) }
              : {}),
            ...(Number(model.max_tokens || model.maxTokens) > 0
              ? { maxTokens: Number(model.max_tokens || model.maxTokens) }
              : {}),
            ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
          })),
        }));
        rows.push(...publicRows.map((row) => ({ profile, ...row })));
        meta[profile] = {
          complete: true,
          count: publicRows.reduce((total, row) => total + row.models.length, 0),
          pagination: "single",
          endReached: true,
          fingerprint: fingerprint(publicRows),
          capability: snapshot,
        };
      } catch (error) {
        blockers.push(blocker("provider_enumeration_incomplete", this.store, profile, "Provider 枚举不完整"));
        meta[profile] = { complete: false, count: 0, pagination: "single", endReached: false, fingerprint: fingerprint(null) };
      }
    }
    return { rows, references, blockers, meta };
  },
  read: readReference,
  write: writeReference,
  verify: verifyReference,
  undo: undoReference,
};

/** Main 模型 scanner。 */
const mainModelScanner = {
  id: "hermes.main.v1",
  store: "main",
  async enumerate(backend, safeSpec, profiles) {
    const rows = [];
    const references = [];
    const blockers = [];
    const meta = {};
    for (const profile of profiles) {
      try {
        const response = await readStore(backend, profile, "main");
        const body = parseBody(response, "main", profile);
        const row = { provider: String(body.provider || ""), model: String(body.model || "") };
        const snapshot = capabilityOf(response, "main", profile);
        rows.push({ profile, ...row });
        if (row.provider === safeSpec.providerKey && row.model === safeSpec.sourceModelId) {
          references.push(reference(this.id, this.store, profile, `${profile}:main`,
            { profile, ...row }, { profile, provider: safeSpec.providerKey, model: safeSpec.model.id }, snapshot));
          if (!snapshot.supported) blockers.push(blocker("hermes_conditional_write_unsupported", this.store, profile, "Main store 不支持 If-Match"));
        }
        meta[profile] = { complete: true, count: row.model ? 1 : 0, pagination: "single", endReached: true, fingerprint: fingerprint(row), capability: snapshot };
      } catch {
        blockers.push(blocker("main_enumeration_incomplete", this.store, profile, "Main 枚举不完整"));
        meta[profile] = { complete: false, count: 0, pagination: "single", endReached: false, fingerprint: fingerprint(null) };
      }
    }
    return { rows, references, blockers, meta };
  },
  read: readReference,
  write: writeReference,
  verify: verifyReference,
  undo: undoReference,
};

/** Auxiliary 任务模型 scanner；auto 只用同 Profile main provider 消歧。 */
const auxiliaryModelScanner = {
  id: "hermes.auxiliary.v1",
  store: "auxiliary",
  async enumerate(backend, safeSpec, profiles, context = {}) {
    const rows = [];
    const references = [];
    const blockers = [];
    const meta = {};
    for (const profile of profiles) {
      try {
        const response = await readStore(backend, profile, "auxiliary");
        const body = parseBody(response, "auxiliary", profile);
        if (!Array.isArray(body.tasks)) throw new Error("unknown shape");
        const snapshot = capabilityOf(response, "auxiliary", profile);
        const mainProvider = context.mainProviderByProfile?.[profile] || "";
        for (const task of body.tasks) {
          const row = { task: String(task?.task || ""), provider: String(task?.provider || ""), model: String(task?.model || "") };
          rows.push({ profile, ...row });
          if (row.model !== safeSpec.sourceModelId) continue;
          const provider = row.provider === "auto" ? mainProvider : row.provider;
          if (row.provider === "auto" && provider !== safeSpec.providerKey) {
            blockers.push(blocker("ambiguous_auto_provider", this.store, profile, "Aux auto Provider 无法安全消歧", { referenceKey: row.task }));
            continue;
          }
          if (provider !== safeSpec.providerKey) continue;
          references.push(reference(this.id, this.store, profile, `${profile}:${row.task}`,
            { profile, ...row }, { profile, task: row.task, provider: row.provider, model: safeSpec.model.id }, snapshot));
          if (!snapshot.supported) blockers.push(blocker("hermes_conditional_write_unsupported", this.store, profile, "Aux store 不支持 If-Match"));
        }
        meta[profile] = { complete: true, count: body.tasks.length, pagination: "single", endReached: true, fingerprint: fingerprint(rows.filter((row) => row.profile === profile)), capability: snapshot };
      } catch {
        blockers.push(blocker("auxiliary_enumeration_incomplete", this.store, profile, "Aux 枚举不完整"));
        meta[profile] = { complete: false, count: 0, pagination: "single", endReached: false, fingerprint: fingerprint(null) };
      }
    }
    return { rows, references, blockers, meta };
  },
  read: readReference,
  write: writeReference,
  verify: verifyReference,
  undo: undoReference,
};

/** 严格枚举 Cron；必须显式 has_more=false 或 total 证明终点。 */
const cronModelScanner = {
  id: "hermes.cron.v1",
  store: "cron",
  async enumerate(backend, safeSpec, profiles, context = {}) {
    const rows = [];
    const references = [];
    const blockers = [];
    const meta = {};
    const owners = new Map();
    const limit = context.pageLimit || DEFAULT_PAGE_LIMIT;
    for (const profile of profiles) {
      try {
        const response = await readStore(backend, profile, "cron", { limit, offset: 0 });
        const body = parseBody(response, "cron", profile);
        const jobs = Array.isArray(body) ? body : Array.isArray(body.jobs) ? body.jobs : null;
        if (!jobs) throw new Error("unknown shape");
        const explicitEnd = body.has_more === false
          || (Number.isSafeInteger(body.total) && body.total === jobs.length);
        if (!explicitEnd) throw new Error("cron end unproven");
        const snapshot = capabilityOf(response, "cron", profile);
        for (const job of jobs) {
          const id = String(job?.id || "");
          if (!id) throw new Error("missing id");
          if (!owners.has(id)) owners.set(id, []);
          owners.get(id).push(profile);
          const row = {
            profile,
            id,
            provider: String(job.provider || ""),
            model: String(job.model || ""),
            fallbacks: Array.isArray(job.fallbacks) ? job.fallbacks.map(String) : [],
          };
          rows.push(row);
          const matches = row.provider === safeSpec.providerKey
            && (row.model === safeSpec.sourceModelId || row.fallbacks.includes(safeSpec.sourceModelId));
          if (!matches) continue;
          const after = {
            ...row,
            model: row.model === safeSpec.sourceModelId ? safeSpec.model.id : row.model,
            fallbacks: row.fallbacks.map((model) => model === safeSpec.sourceModelId ? safeSpec.model.id : model),
          };
          references.push(reference(this.id, this.store, profile, `${profile}:${id}`, row, after, snapshot));
          if (!snapshot.supported) blockers.push(blocker("hermes_conditional_write_unsupported", this.store, profile, "Cron store 不支持 If-Match"));
        }
        meta[profile] = { complete: true, count: jobs.length, pagination: "single", endReached: true, fingerprint: fingerprint(jobs), capability: snapshot };
      } catch {
        blockers.push(blocker("cron_enumeration_incomplete", this.store, profile, "Cron 枚举不完整"));
        meta[profile] = { complete: false, count: 0, pagination: "single", endReached: false, fingerprint: fingerprint(null) };
      }
    }
    for (const [id, ownerProfiles] of owners) {
      if (ownerProfiles.length > 1) blockers.push(blocker("cron_owner_ambiguous", this.store, null, "Cron owner 重复", { referenceKey: id }));
    }
    return { rows, references, blockers, meta };
  },
  read: readReference,
  write: writeReference,
  verify: verifyReference,
  undo: undoReference,
};

/** 严格分页枚举 Session；任何 source 引用只产生 blocker，不生成可写 reference。 */
const sessionBlockerScanner = {
  id: "hermes.sessions.v1",
  store: "sessions",
  async enumerate(backend, safeSpec, profiles, context = {}) {
    const rows = [];
    const blockers = [];
    const meta = {};
    const limit = context.pageLimit || DEFAULT_PAGE_LIMIT;
    for (const profile of profiles) {
      const unique = new Map();
      const seenOffsets = new Set();
      let offset = 0;
      let complete = false;
      let failed = false;
      let declaredTotal = null;
      try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          if (seenOffsets.has(offset)) throw new Error("repeated offset");
          seenOffsets.add(offset);
          const response = await readStore(backend, profile, "sessions", { limit, offset });
          const body = parseBody(response, "sessions", profile);
          if (!Array.isArray(body.sessions)) throw new Error("unknown shape");
          if (Number.isSafeInteger(body.total)) {
            if (declaredTotal !== null && declaredTotal !== body.total) throw new Error("total changed");
            declaredTotal = body.total;
          }
          let newRows = 0;
          for (const session of body.sessions) {
            const key = String(session?.key || session?.id || "");
            if (!key) throw new Error("missing key");
            if (!unique.has(key)) {
              unique.set(key, clone(session));
              newRows += 1;
            } else if (stableJson(unique.get(key)) !== stableJson(session)) {
              throw new Error("duplicate changed row");
            }
          }
          if (body.has_more === false || (declaredTotal !== null && unique.size === declaredTotal)) {
            complete = true;
            break;
          }
          if (body.has_more !== true || !Number.isSafeInteger(body.next_offset)
            || body.next_offset <= offset || newRows === 0) throw new Error("pagination incomplete");
          offset = body.next_offset;
        }
        if (!complete || (declaredTotal !== null && unique.size !== declaredTotal)) throw new Error("end not proved");
      } catch {
        failed = true;
        blockers.push(blocker("session_enumeration_incomplete", this.store, profile, "Session 枚举不完整"));
      }
      const profileRows = [...unique.values()].sort((a, b) => String(a.key || a.id).localeCompare(String(b.key || b.id)));
      rows.push(...profileRows.map((row) => ({ profile, ...row })));
      for (const session of profileRows) {
        const model = String(session.model || "");
        if (model === safeSpec.sourceModelId || model === `${safeSpec.providerKey}/${safeSpec.sourceModelId}`) {
          blockers.push(blocker("session_model_reference", this.store, profile, "Session 使用源模型且不可安全改写", {
            referenceKey: String(session.key || session.id),
          }));
        }
      }
      meta[profile] = {
        complete: !failed && complete,
        count: profileRows.length,
        pagination: "offset",
        endReached: !failed && complete,
        fingerprint: fingerprint(profileRows),
      };
    }
    return { rows, references: [], blockers, meta };
  },
  read: readReference,
  write: unsupportedSessionWrite,
  verify: async () => false,
  undo: unsupportedSessionWrite,
};

const HERMES_REFERENCE_SCANNERS = Object.freeze([
  Object.freeze(providerConfigScanner),
  Object.freeze(mainModelScanner),
  Object.freeze(auxiliaryModelScanner),
  Object.freeze(cronModelScanner),
  Object.freeze(sessionBlockerScanner),
]);

/** 模块启动门：五个 scanner id/store 唯一且五方法齐全。 */
function validateHermesReferenceScanners(scanners) {
  if (!Array.isArray(scanners) || scanners.length !== 5) {
    throw new HermesModelReferenceError("invalid_hermes_reference_scanner", "Hermes scanner registry 必须恰好五项", { status: 500 });
  }
  const ids = new Set();
  const stores = new Set();
  for (const scanner of scanners) {
    if (!scanner || typeof scanner.id !== "string" || typeof scanner.store !== "string"
      || ids.has(scanner.id) || stores.has(scanner.store)
      || REQUIRED_METHODS.some((method) => typeof scanner[method] !== "function")) {
      throw new HermesModelReferenceError("invalid_hermes_reference_scanner", "Hermes scanner schema 不完整", { status: 500 });
    }
    ids.add(scanner.id);
    stores.add(scanner.store);
  }
  return scanners;
}

validateHermesReferenceScanners(HERMES_REFERENCE_SCANNERS);

/** 按固定顺序扫描五 store，并返回逐 store/Profile 完整性与聚合 fingerprint。 */
async function scanHermesReferences(backend, safeSpec, capabilitySnapshot = {}) {
  if (!safeSpec || typeof safeSpec !== "object") throw new TypeError("safeSpec 必须是对象");
  // 删除扫描仍需 matcher target；使用 source 自身只为枚举引用，adapter 会过滤
  // Provider definition，绝不会把 unchanged after 用于写入。
  if (!safeSpec.model && safeSpec.sourceModelId) {
    safeSpec = { ...safeSpec, model: { id: safeSpec.sourceModelId } };
  }
  const profiles = profilesOf(backend);
  const references = [];
  const blockers = [];
  const stores = {};
  const context = { pageLimit: capabilitySnapshot.pageLimit || DEFAULT_PAGE_LIMIT, mainProviderByProfile: {} };
  for (const scanner of HERMES_REFERENCE_SCANNERS) {
    const result = await scanner.enumerate(backend, safeSpec, profiles, context);
    references.push(...result.references);
    blockers.push(...result.blockers);
    stores[scanner.store] = result.meta;
    if (scanner.store === "main") {
      for (const row of result.rows) context.mainProviderByProfile[row.profile] = row.provider;
    }
  }
  return {
    scannerVersion: HERMES_SCANNER_VERSION,
    profiles,
    references,
    blockers,
    stores,
    fingerprints: {
      scannerVersion: HERMES_SCANNER_VERSION,
      topology: fingerprint(profiles),
      ...Object.fromEntries(Object.entries(stores).map(([store, meta]) => [store, fingerprint(meta)])),
    },
  };
}

module.exports = {
  HERMES_SCANNER_VERSION,
  HERMES_REFERENCE_SCANNERS,
  HermesModelReferenceError,
  validateHermesReferenceScanners,
  scanHermesReferences,
};
