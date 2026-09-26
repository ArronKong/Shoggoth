"use strict";

const { providerPublicDigest } = require("./openclaw-model-change");
const { createHash } = require("node:crypto");

function renameDigest(provider) {
  return createHash("sha256").update(JSON.stringify({
    endpoint: providerPublicDigest(provider), models: provider?.models || [],
  })).digest("hex");
}

function renameError(code, message) {
  return Object.assign(new Error(message), { code, status: 409 });
}

function modelRef(value, from, to) {
  return typeof value === "string" && value.startsWith(`${from}/`)
    ? `${to}/${value.slice(from.length + 1)}` : value;
}

function profileRef(value, from, to) {
  if (typeof value !== "string") return value;
  if (value === from || value.startsWith(`${from}:`)) return `${to}${value.slice(from.length)}`;
  if (value.startsWith(`profile:${from}:`)) return `profile:${to}${value.slice(8 + from.length)}`;
  return value;
}

// Only model-bearing config fields are rewritten. Prompts, transcripts, URLs,
// model IDs inside provider definitions, and usage history are never rewritten.
function configReferences(parsed, from, to) {
  const replacePaths = [];
  function visit(value, key, at) {
    if (["model", "imageModel", "pdfModel"].includes(key)) {
      if (typeof value === "string") return modelRef(value, from, to);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const result = { ...value };
        if (typeof result.primary === "string") result.primary = modelRef(result.primary, from, to);
        if (Array.isArray(result.fallbacks)) result.fallbacks = result.fallbacks.map(ref => modelRef(ref, from, to));
        return result;
      }
    }
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item, i) => visit(item, "", `${at}.${i}`));
    if (key === "models") {
      const result = { ...value };
      // Existing target settings win on overlap; old settings fill gaps.
      for (const [ref, settings] of Object.entries(value)) {
        const target = modelRef(ref, from, to);
        if (target !== ref) {
          delete result[ref];
          result[target] = { ...settings, ...value[target] };
        }
      }
      return result;
    }
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name,
      key === "modelPolicy" && name === "allow" && Array.isArray(item)
        ? [...new Set(item.map(ref => modelRef(ref, from, to)))]
        : visit(item, name, `${at}.${name}`),
    ]));
  }
  // A merge-patch diff preserves unrelated fields and removes moved map keys.
  function diff(before, after, at) {
    if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
    if (Array.isArray(after)) { replacePaths.push(at); return after; }
    if (!after || typeof after !== "object") return after;
    const out = {};
    for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after)])) {
      const next = Object.hasOwn(after, key) ? diff(before?.[key], after[key], `${at}.${key}`) : null;
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  const patch = {};
  for (const key of ["agents", "tools", "hooks", "messages"]) {
    if (!parsed[key]) continue;
    const next = diff(parsed[key], visit(parsed[key], key, key), key);
    if (next) patch[key] = next;
  }
  if (parsed.auth) {
    const auth = structuredClone(parsed.auth);
    if (auth.profiles) {
      for (const [id, item] of Object.entries(auth.profiles)) {
        if (item?.provider !== from) continue;
        delete auth.profiles[id];
        auth.profiles[profileRef(id, from, to)] = { ...item, provider: to };
      }
    }
    if (auth.order?.[from]) {
      auth.order[to] = auth.order[from].map(id => profileRef(id, from, to));
      delete auth.order[from];
    }
    const next = diff(parsed.auth, auth, "auth");
    if (next) patch.auth = next;
  }
  return { patch, replacePaths };
}

async function listFutureReferences(backend) {
  const sessions = [];
  const seen = new Set();
  let offset = 0;
  for (let page = 0; page < 1000; page++) {
    const response = await backend.request("sessions.list", {
      limit: 500, offset, archived: "all", includeGlobal: true, includeUnknown: true,
    });
    if (!Array.isArray(response?.sessions) || typeof response.hasMore !== "boolean") {
      throw renameError("session_enumeration_incomplete", "无法完整读取会话模型引用，尚未改名");
    }
    for (const row of response.sessions) {
      if (typeof row.key !== "string" || seen.has(row.key)) {
        throw renameError("session_snapshot_changed", "会话列表发生变化，请重试改名");
      }
      seen.add(row.key);
      sessions.push(row);
    }
    if (!response.hasMore) return { sessions, jobs: await backend._listCronJobsSnapshot() };
    if (!Number.isSafeInteger(response.nextOffset) || response.nextOffset <= offset) break;
    offset = response.nextOffset;
  }
  throw renameError("session_enumeration_incomplete", "会话列表不完整，请重试改名");
}

async function migrateFutureReferences(backend, references, from, to, context, availableModels) {
  for (const row of references.sessions) {
    // model/modelProvider describe past execution; only explicit overrides are
    // future routing choices. Session lifecycle guards prevent reset races.
    const oldRef = typeof row.modelOverride === "string"
      ? (row.modelOverride.startsWith(`${from}/`) ? row.modelOverride
        : row.providerOverride === from ? `${from}/${row.modelOverride}` : null)
      // OpenClaw 9.1 lists the selected model plus its provenance instead of
      // exposing raw override fields. A null provenance means inherited config.
      : row.modelOverrideSource && row.modelProvider === from && typeof row.model === "string"
        ? `${from}/${row.model}` : null;
    if (!oldRef) continue;
    // A prior model deselection deliberately leaves unavailable session choices
    // for the user to resolve. The Gateway refuses to select those models;
    // retaining that existing invalid choice must not block provider rename or
    // silently replace it with a different model.
    if (availableModels && !availableModels.has(oldRef.slice(from.length + 1))) continue;
    context?.assertProviderLease?.();
    await backend.request("sessions.patch", {
      key: row.key, model: modelRef(oldRef, from, to),
      ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
      ...(row.lifecycleRevision ? { expectedLifecycleRevision: row.lifecycleRevision } : {}),
    });
  }
  for (const job of references.jobs) {
    const payload = {};
    if (modelRef(job.payload?.model, from, to) !== job.payload?.model) payload.model = modelRef(job.payload.model, from, to);
    if (Array.isArray(job.payload?.fallbacks)) {
      const next = job.payload.fallbacks.map(ref => modelRef(ref, from, to));
      if (JSON.stringify(next) !== JSON.stringify(job.payload.fallbacks)) payload.fallbacks = next;
    }
    if (!Object.keys(payload).length) continue;
    payload.kind = job.payload.kind;
    if (!job.configRevision) throw renameError("cron_snapshot_unversioned", "定时任务缺少版本信息，无法同步改名");
    context?.assertProviderLease?.();
    await backend.request("cron.update", { id: job.id, patch: { payload }, expectedConfigRevision: job.configRevision });
  }
}

async function renameProvider(backend, spec, fields, secretEnvelope, context = {}) {
  const from = spec.providerKey;
  const to = spec.patch.renameTo;
  const snapshot = await backend._configSnapshot();
  const providers = snapshot.parsed?.models?.providers || {};
  const previous = context.journalEntry?.fingerprints?.providerRename;
  const resumed = previous?.from === from && previous?.to === to;
  if (providers[to] && !resumed) throw renameError("provider_exists", `Provider ID ${to} 已存在`);
  if (!providers[from] && !resumed) throw renameError("provider_not_found", `Provider ID ${from} 不存在`);
  if (providers[to] && previous?.digest !== renameDigest(providers[to])) {
    throw renameError("provider_changed", "目标端点已被其他操作修改，请重新打开编辑");
  }

  // Read every future-reference store before making any change. On retry the
  // same scan only returns references that have not moved yet.
  const references = await listFutureReferences(backend);
  const canonical = backend._usesCanonicalModelAuthCli();
  const suppliedKey = String(secretEnvelope?.apiKey || "").trim();
  const auth = canonical ? await backend._readProviderRenameAuth(from, to, suppliedKey, spec.patch.clearApiKey, resumed) : [];
  const entry = { ...(providers[from] || providers[to]), ...fields };
  for (const [key, value] of Object.entries(entry)) if (value === null) delete entry[key];
  if (entry.apiKey !== undefined) {
    // config.get redacts keys. Read the local value only within this backend;
    // it never enters the journal, endpoint snapshot, or a diagnostic message.
    entry.apiKey = await backend._providerRenameConfigKey(from, to, entry.apiKey);
    if (entry.apiKey === undefined || suppliedKey || spec.patch.clearApiKey) delete entry.apiKey;
  }
  const fingerprints = { ...(context.journalEntry?.fingerprints || {}),
    providerRename: { from, to, digest: renameDigest(entry), sourceDigest: previous?.sourceDigest || renameDigest(providers[from]) } };
  await context.recordStage?.("provider-rename", { fingerprints });
  // Keep the old definition working until credentials and future references
  // have moved. This also makes an interrupted rename forward-recoverable.
  let stagedInfo;
  if (providers[from]) stagedInfo = await backend._patchModelProviders((current, parsed) => {
    if (renameDigest(current[from]) !== fingerprints.providerRename.sourceDigest) {
      throw renameError("provider_changed", "原端点已被其他操作修改，请重新打开编辑");
    }
    if (current[to] && (!resumed || renameDigest(current[to]) !== fingerprints.providerRename.digest)) {
      throw renameError("provider_exists", `Provider ID ${to} 已存在`);
    }
    if (current[to]) return null;
    const agents = {};
    const replacePaths = [];
    const allowBoth = (scope, at) => {
      const allow = scope?.modelPolicy?.allow;
      if (!Array.isArray(allow) || !allow.some(ref => modelRef(ref, from, to) !== ref)) return undefined;
      replacePaths.push(`${at}.modelPolicy.allow`);
      return { modelPolicy: { ...scope.modelPolicy, allow: [...new Set([...allow, ...allow.map(ref => modelRef(ref, from, to))])] } };
    };
    const defaults = allowBoth(parsed.agents?.defaults, "agents.defaults");
    if (defaults) agents.defaults = defaults;
    for (const [id, agent] of Object.entries(parsed.agents?.entries || {})) {
      const next = allowBoth(agent, `agents.entries.${id}`);
      if (next) (agents.entries ||= {})[id] = next;
    }
    return { patchProviders: { [to]: entry }, replacePaths,
      patchExtra: Object.keys(agents).length ? { agents } : {} };
  }, { beforeWrite: () => context.assertProviderLease?.() });
  if (canonical) await backend._copyProviderRenameAuth(auth, from, to, context);
  const availableModels = new Set((entry.models || []).map(model => model.id));
  await migrateFutureReferences(backend, references, from, to, context, availableModels);
  const result = await backend._configOnlyRenameProvider(from, to, fields, {
    staged: true, clearMirroredKey: Boolean(suppliedKey) || spec.patch.clearApiKey === true,
    sourceDigest: fingerprints.providerRename.sourceDigest, targetDigest: fingerprints.providerRename.digest,
    beforeWrite: () => context.assertProviderLease?.(),
  });
  // Catch choices made while the initial snapshot was being migrated.
  await migrateFutureReferences(backend, await listFutureReferences(backend), from, to, context, availableModels);
  if (!canonical && suppliedKey) await backend._writeAuthProfileKey(to, suppliedKey);
  if (!canonical && spec.patch.clearApiKey) await backend._dropAuthProfileKeyQuietly(to);
  if (canonical) await backend._finishProviderRenameAuth(auth, from, to, context);
  return { ...result, restart: stagedInfo?.restart === true || result?.restart === true };
}

module.exports = { renameProvider, renameDigest, configReferences, modelRef, profileRef, listFutureReferences, migrateFutureReferences };
