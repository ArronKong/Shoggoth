"use strict";

// Hermes 多 Profile 模型变更 saga。Provider CRUD 复用 backend 的 coordinator
// capability 与 per-profile gate；Main/Aux/Cron 引用按 scanner 条件写并可逆补偿。

const { createHash } = require("node:crypto");

const {
  HERMES_REFERENCE_SCANNERS,
  validateHermesReferenceScanners,
  scanHermesReferences,
} = require("./hermes-model-references");

/** Hermes adapter 依赖/状态机稳定错误。 */
class HermesModelChangeError extends Error {
  constructor(code, message, { stage = "preflight", status = 409 } = {}) {
    super(message);
    this.name = "HermesModelChangeError";
    this.code = code;
    this.stage = stage;
    this.status = status;
  }
}

/** 稳定 JSON 仅用于公开 fingerprint 比较。 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 对 journal 公开 JSON 摘要做隔离拷贝，避免恢复过程改写持久对象。 */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Hermes Provider 端点/API mode 的跨 Profile 安全摘要，不记录原始 URL。 */
function providerStateDigest(rows) {
  return createHash("sha256").update(stableJson(rows.map(({ profile, provider }) => ({
    profile,
    baseUrl: String(provider?.base_url || provider?.baseUrl || provider?.url || ""),
    apiMode: String(provider?.api_mode || ""),
  })))).digest("hex");
}

/** 单个 Profile 的 Provider 公开状态摘要，恢复时据此识别部分 before/after。 */
function providerProfileDigest(profile, provider) {
  return createHash("sha256").update(stableJson({
    profile: String(profile || ""),
    baseUrl: String(provider?.base_url || provider?.baseUrl || provider?.url || ""),
    apiMode: String(provider?.api_mode || ""),
  })).digest("hex");
}

/** Hermes 当前可持久化模型字段的公开投影。 */
function publicSourceModel(model) {
  if (!model || typeof model !== "object") return undefined;
  return {
    id: model.id,
    ...(Number(model.context_length || model.contextLength) > 0
      ? { contextWindow: Number(model.context_length || model.contextLength) }
      : {}),
  };
}

/** blocked 结果统一 shape。 */
function blocked(code, stage = "preflight", extra = {}) {
  return { status: "blocked", code, stage, ...extra };
}

/** 从引用完整行投影 journal 白名单字段。 */
function projectDiff(store, value) {
  if (store === "provider") {
    return {
      profile: String(value?.profile || "unknown"),
      provider: String(value?.provider || "unknown"),
      modelId: String(value?.modelId || value?.model?.id || "unknown"),
      model: value?.model && typeof value.model === "object"
        ? Object.fromEntries(Object.entries(value.model).filter(([key]) => ["id", "name", "contextWindow", "maxTokens", "reasoning"].includes(key)))
        : { id: String(value?.modelId || "unknown") },
    };
  }
  if (store === "main") return { profile: String(value?.profile || "unknown"), provider: String(value?.provider || "unknown"), model: String(value?.model || "unknown") };
  if (store === "auxiliary") return { profile: String(value?.profile || "unknown"), provider: String(value?.provider || "unknown"), model: String(value?.model || "unknown") };
  return {
    profile: String(value?.profile || "unknown"),
    provider: String(value?.provider || "unknown"),
    model: String(value?.model || "unknown"),
    fallbacks: Array.isArray(value?.fallbacks) ? value.fallbacks.map(String) : [],
  };
}

/** 构造 journal 固定 schema step。 */
function journalStep(reference, writeStatus, value = reference.after) {
  const now = Date.now();
  return {
    scannerId: reference.scannerId,
    store: reference.store,
    referenceKey: reference.referenceKey,
    stage: "migrate-references",
    before: projectDiff(reference.store, reference.before),
    after: projectDiff(reference.store, reference.after),
    undo: projectDiff(reference.store, reference.undo),
    writeStatus,
    readback: projectDiff(reference.store, value),
    error: null,
    startedAt: now,
    finishedAt: now,
  };
}

/** 根据 scannerId/store 找唯一 scanner。 */
function scannerFor(scanners, reference) {
  const scanner = scanners.find((item) => item.id === reference.scannerId && item.store === reference.store);
  if (!scanner) throw new HermesModelChangeError("scanner_missing", "Hermes 引用 scanner 不存在", { stage: "migrate-references", status: 500 });
  return scanner;
}

/** 校验组合依赖完整且 mutation gate 与 backend 是同一锁域。 */
function validateDependencies({ backend, mutationGate, scanners, scan }) {
  try {
    if (!backend || typeof backend !== "object"
      || typeof backend._withModelChangeCoordinatorContext !== "function") throw new TypeError("backend 契约不完整");
    if (!mutationGate
      || typeof mutationGate.withProfiles !== "function"
      || typeof mutationGate.withCoordinatorContext !== "function") throw new TypeError("mutationGate 契约不完整");
    validateHermesReferenceScanners(scanners);
    if (typeof scan !== "function") throw new TypeError("scan 必须是函数");
  } catch (error) {
    throw new HermesModelChangeError(
      "invalid_hermes_model_change_dependency",
      "Hermes model-change 依赖不完整",
      { status: 500 },
    );
  }
}

/** 创建固定四方法 adapter。 */
function createHermesModelChange({
  backend,
  mutationGate,
  scanners = HERMES_REFERENCE_SCANNERS,
  scan = scanHermesReferences,
} = {}) {
  validateDependencies({ backend, mutationGate, scanners, scan });

  /** 条件写能力只读取 backend 底层能力，避免 adapter 委托递归。 */
  const getCapabilities = async () => {
    const fields = {
      id: true,
      name: false,
      contextWindow: true,
      maxTokens: false,
      reasoning: false,
    };
    if (typeof backend.getHermesConditionalWriteCapabilities !== "function") {
      return { supported: false, create: false, update: false, rename: false, delete: false, updateProvider: false, fields, blockers: ["hermes_conditional_write_unsupported"] };
    }
    const capabilities = await backend.getHermesConditionalWriteCapabilities();
    return {
      ...capabilities,
      updateProvider: capabilities?.supported === true,
      auxiliary: false,
      fields,
    };
  };

  /** 只读扫描五 store；能力 blocker 仅由实际命中的引用产生。 */
  const preview = async (safeSpec) => {
    let scanned;
    if (safeSpec.kind === "delete-provider" && typeof backend._readProvidersByProfile === "function") {
      const byProfile = await backend._readProvidersByProfile({ fresh: true, requireComplete: true });
      const modelIds = [...new Set([...byProfile.values()].flatMap((providers) => (
        backend._hermesModelEntries(providers?.[safeSpec.providerKey]?.models).map((model) => model.id)
      )))].sort();
      const scans = [];
      for (const modelId of modelIds) {
        scans.push(await scan(backend, { ...safeSpec, sourceModelId: modelId, model: { id: modelId } }, {}));
      }
      scanned = scans[0] || await scan(backend, { ...safeSpec, sourceModelId: "__missing__", model: { id: "__missing__" } }, {});
      if (scans.length > 1) {
        scanned = {
          ...scanned,
          references: scans.flatMap((item) => item.references || []),
          blockers: scans.flatMap((item) => item.blockers || []),
          fingerprints: { ...scanned.fingerprints, providerModels: stableJson(scans.map((item) => item.fingerprints)) },
        };
      }
    } else {
      scanned = await scan(backend, safeSpec, {});
    }
    const capabilities = await getCapabilities();
    const blockers = [...(scanned.blockers || [])];
    // Provider scanner 负责引用定义，但冲突语义必须在首写前按全部 Profile 明确判断。
    let sourceSnapshot;
    let providerDiff;
    let modelProfiles;
    if (typeof backend._readProvidersByProfile === "function") try {
      const byProfile = await backend._readProvidersByProfile({ fresh: true, requireComplete: true });
      const providerRows = [...byProfile.entries()].map(([profile, providers]) => ({
        profile,
        provider: providers?.[safeSpec.providerKey],
      })).sort((left, right) => left.profile.localeCompare(right.profile));
      const occurrences = providerRows.flatMap(({ provider }) => backend._hermesModelEntries(provider?.models));
      sourceSnapshot = publicSourceModel(occurrences.find((model) => model.id === safeSpec.sourceModelId));
      if (["create", "update", "rename"].includes(safeSpec.kind)) {
        modelProfiles = providerRows.map(({ profile, provider }) => {
          const before = backend._hermesModelEntries(provider?.models)
            .find((model) => model.id === safeSpec.sourceModelId);
          return {
            profile,
            before: publicSourceModel(before) || null,
            after: publicSourceModel(safeSpec.model) || null,
          };
        });
      }
      if (safeSpec.kind === "update-provider") {
        const afterRows = providerRows.map(({ profile, provider }) => ({
          profile,
          provider: {
            ...provider,
            ...(safeSpec.patch?.clearBaseUrl === true ? { base_url: "" } : {}),
            ...(Object.prototype.hasOwnProperty.call(safeSpec.patch || {}, "baseUrl")
              ? { base_url: safeSpec.patch.baseUrl }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(safeSpec.patch || {}, "api")
              ? { api_mode: safeSpec.patch.api }
              : {}),
          },
        }));
        providerDiff = {
          beforeDigest: providerStateDigest(providerRows),
          afterDigest: providerStateDigest(afterRows),
          profiles: providerRows.map(({ profile, provider }, index) => ({
            profile,
            beforeDigest: providerProfileDigest(profile, provider),
            afterDigest: providerProfileDigest(profile, afterRows[index]?.provider),
          })),
        };
      }
      const sourceExists = occurrences.some((model) => model.id === safeSpec.sourceModelId);
      const targetExists = occurrences.some((model) => model.id === safeSpec.model?.id);
      if (["update", "rename", "delete-model"].includes(safeSpec.kind) && !sourceExists) {
        blockers.push({ code: "source_not_found", store: "provider", message: "源模型不存在" });
      }
      if (["create", "rename"].includes(safeSpec.kind) && targetExists) {
        blockers.push({ code: "target_conflict", store: "provider", message: "目标模型已存在" });
      }
      if (safeSpec.kind === "update-provider" && providerRows.every(({ provider }) => !provider)) {
        blockers.push({ code: "hermes_env_provider_read_only", store: "provider", message: "Hermes env Provider 当前仅支持只读" });
      }
    } catch {
      blockers.push({ code: "provider_enumeration_incomplete", store: "provider", message: "Provider 枚举不完整" });
    }
    if (!capabilities.supported && !(scanned.references || []).some((reference) => reference.snapshot?.supported === true)) {
      blockers.push({ code: "hermes_conditional_write_unsupported", store: "provider", message: "Hermes dashboard 不支持安全条件写" });
    }
    const publicReferences = ["delete-model", "delete-provider"].includes(safeSpec.kind)
      ? (scanned.references || []).filter((reference) => reference.definition !== true)
      : scanned.references;
    return {
      ...scanned,
      references: publicReferences,
      blockers,
      runtimeApply: capabilities.supported ? "profile-conditional" : "unsupported",
      ...(sourceSnapshot ? { sourceSnapshot } : {}),
      ...(providerDiff ? { providerDiff } : {}),
      ...(modelProfiles ? { modelProfiles } : {}),
    };
  };

  /** 迁移 Main/Aux/Cron，Provider definition 由 stage-target 批量写，Session 永不写。 */
  const migrateReferences = async (references, context, completed) => {
    const latestSnapshots = new Map();
    for (const reference of references.filter((item) => ["main", "auxiliary", "cron"].includes(item.store))) {
      const scanner = scannerFor(scanners, reference);
      const snapshotKey = `${reference.profile}\0${reference.store}`;
      if (latestSnapshots.has(snapshotKey)) reference.snapshot = clone(latestSnapshots.get(snapshotKey));
      context.assertProviderLease?.();
      const before = await scanner.read(backend, reference);
      if (stableJson(before) !== stableJson(reference.before)) {
        throw new HermesModelChangeError("reference_fingerprint_changed", "Hermes 引用写前已变化", { stage: "migrate-references" });
      }
      await scanner.write(backend, reference);
      latestSnapshots.set(snapshotKey, clone(reference.snapshot));
      if (await scanner.verify(backend, reference) !== true) {
        throw new HermesModelChangeError("reference_verify_failed", "Hermes 引用写后回读不一致", { stage: "migrate-references" });
      }
      completed.push({ scanner, reference });
      await context.recordStep?.(journalStep(reference, "verified"));
    }
  };

  /** 逆序补偿已经验证的引用；单项失败不跳过其余项。 */
  const undoReferences = async (completed, context) => {
    let ok = true;
    const latestSnapshots = new Map();
    for (const item of completed) {
      latestSnapshots.set(`${item.reference.profile}\0${item.reference.store}`, clone(item.reference.snapshot));
    }
    for (const item of [...completed].reverse()) {
      try {
        const snapshotKey = `${item.reference.profile}\0${item.reference.store}`;
        if (latestSnapshots.has(snapshotKey)) item.reference.snapshot = clone(latestSnapshots.get(snapshotKey));
        context.assertProviderLease?.();
        await item.scanner.undo(backend, item.reference);
        latestSnapshots.set(snapshotKey, clone(item.reference.snapshot));
        await context.recordStep?.(journalStep(item.reference, "compensated", item.reference.undo));
      } catch {
        ok = false;
      }
    }
    return ok;
  };

  /** 严格目录验证 target 至少存在于每个 Profile 配置快照。 */
  const verifyTarget = async (safeSpec, profiles) => {
    try {
      const byProfile = await backend._readProvidersByProfile({ fresh: true, requireComplete: true });
      const contentReady = profiles.every((profile) => {
        const provider = byProfile.get(profile)?.[safeSpec.providerKey];
        return backend._hermesModelEntries(provider?.models).some((model) => {
          if (model.id !== safeSpec.model?.id) return false;
          // Hermes 当前只持久化 ID 与 context_length；验证必须覆盖全部受支持普通字段。
          if (Object.prototype.hasOwnProperty.call(safeSpec.model || {}, "contextWindow")) {
            return Number(model.context_length || model.contextLength) === Number(safeSpec.model.contextWindow);
          }
          return true;
        });
      });
      if (!contentReady) return false;
      if (typeof backend.verifyHermesModelTarget === "function") {
        return (await backend.verifyHermesModelTarget(safeSpec, profiles)) === true;
      }
      return true;
    } catch {
      return false;
    }
  };

  /** Provider CRUD 返回 warnings 表示逐 Profile partial，不能声明全局 applied。 */
  const assertNoWarnings = (result, stage) => {
    if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
      throw new HermesModelChangeError("hermes_profile_partial", "Hermes 部分 Profile 写入失败", { stage });
    }
  };

  /** rename 五阶段 saga。 */
  const applyRename = async (safeSpec, context, secretEnvelope, initial) => {
    const completed = [];
    let targetStaged = false;
    let committed = false;
    try {
      await context.recordStage?.("preflight", { fingerprints: initial.fingerprints });
      let stageResult;
      try {
        stageResult = await backend.addModelConfig({
          providerKey: safeSpec.providerKey,
          model: safeSpec.model,
          ...(safeSpec.baseUrl ? { baseUrl: safeSpec.baseUrl } : {}),
          ...(safeSpec.api ? { api: safeSpec.api } : {}),
          ...(secretEnvelope?.apiKey ? { apiKey: secretEnvelope.apiKey } : {}),
        });
      } catch (error) {
        // 跨 Profile 条件冲突前可能已有成功写；先持久化阶段再交给恢复前向收敛。
        if (Array.isArray(error?.partialProfiles) && error.partialProfiles.length > 0) {
          targetStaged = true;
          error.partialStageWrite = true;
          await context.recordStage?.("stage-target", { fingerprints: initial.fingerprints });
        }
        throw error;
      }
      targetStaged = true;
      assertNoWarnings(stageResult, "stage-target");
      await context.recordStage?.("stage-target", { fingerprints: initial.fingerprints, ...(secretEnvelope?.apiKey ? { secretStep: "applied" } : {}) });
      await migrateReferences(initial.references || [], context, completed);
      await context.recordStage?.("migrate-references", { fingerprints: initial.fingerprints });
      const rescanned = await scan(backend, safeSpec, {});
      if ((rescanned.references || []).some((reference) => reference.definition !== true)
        || (rescanned.blockers || []).some((item) => item.code === "session_model_reference")) {
        throw new HermesModelChangeError("references_remain", "Hermes 源模型仍有未来引用", { stage: "verify-ready" });
      }
      if (await verifyTarget(safeSpec, initial.profiles || []) !== true) {
        throw new HermesModelChangeError("runtime_target_not_ready", "Hermes target 未在全部 Profile 收敛", { stage: "verify-ready" });
      }
      await context.recordStage?.("verify-ready", { fingerprints: rescanned.fingerprints });
      await context.markCommitting?.({ fingerprints: rescanned.fingerprints });
      const retire = await backend.removeModelConfig({ providerKey: safeSpec.providerKey, modelId: safeSpec.sourceModelId });
      assertNoWarnings(retire, "commit-retire");
      committed = true;
      await context.markCommitted?.({ fingerprints: rescanned.fingerprints });
      await context.recordStage?.("commit-retire", { fingerprints: rescanned.fingerprints });
      await backend.commitVerifiedHermesModelCatalog?.();
      return { status: "applied", stage: "commit-retire" };
    } catch (error) {
      if (committed) return { status: "cleanup_pending", code: error?.code || "hermes_cleanup_failed", stage: "commit-retire" };
      const referencesUndone = await undoReferences(completed, context);
      let targetUndone = !targetStaged;
      if (targetStaged && error?.partialStageWrite !== true) {
        try {
          const result = await backend.removeModelConfig({ providerKey: safeSpec.providerKey, modelId: safeSpec.model.id });
          assertNoWarnings(result, "compensate");
          targetUndone = true;
        } catch {
          targetUndone = false;
        }
      }
      if (error?.partialStageWrite === true) {
        return { status: "partial", code: error?.code || "hermes_apply_failed", stage: "stage-target" };
      }
      return referencesUndone && targetUndone
        ? { status: "compensated", code: error?.code || "hermes_apply_failed", stage: error?.stage || "apply" }
        : { status: "partial", code: error?.code || "hermes_apply_failed", stage: error?.stage || "apply" };
    }
  };

  /** 非 rename kind 使用自身提交边界，绝不执行 rename retire。 */
  const applyOtherKind = async (safeSpec, context, secretEnvelope, initial) => {
    try {
      await context.recordStage?.("preflight", { fingerprints: initial.fingerprints });
      let result;
      if (safeSpec.kind === "create" || safeSpec.kind === "update") {
        result = await backend.addModelConfig({
          providerKey: safeSpec.providerKey,
          providerMode: safeSpec.providerMode,
          baseUrl: safeSpec.baseUrl,
          api: safeSpec.api,
          model: safeSpec.model,
          ...(secretEnvelope?.apiKey ? { apiKey: secretEnvelope.apiKey } : {}),
        });
        assertNoWarnings(result, "stage-target");
        await context.recordStage?.("stage-target", { fingerprints: initial.fingerprints, ...(secretEnvelope?.apiKey ? { secretStep: "applied" } : {}) });
        if (await verifyTarget(safeSpec, initial.profiles || []) !== true) throw new HermesModelChangeError("runtime_target_not_ready", "Hermes target 未收敛", { stage: "verify-ready" });
        await context.recordStage?.("verify-ready", { fingerprints: initial.fingerprints });
        // 无 source retire 的写也必须遵守 journal 的逐级提交状态机。
        await context.markCommitting?.({ fingerprints: initial.fingerprints });
        await context.markCommitted?.({ fingerprints: initial.fingerprints, ...(secretEnvelope?.apiKey ? { secretStep: "applied" } : {}) });
      } else if (safeSpec.kind === "delete-model") {
        await context.markCommitting?.({ fingerprints: initial.fingerprints });
        result = await backend.removeModelConfig({ providerKey: safeSpec.providerKey, modelId: safeSpec.sourceModelId });
        assertNoWarnings(result, "commit-retire");
        await context.markCommitted?.({ fingerprints: initial.fingerprints });
        await context.recordStage?.("commit-retire", { fingerprints: initial.fingerprints });
      } else if (safeSpec.kind === "delete-provider") {
        await context.markCommitting?.({ fingerprints: initial.fingerprints });
        result = await backend.removeModelProvider(safeSpec.providerKey);
        assertNoWarnings(result, "commit-retire");
        await context.markCommitted?.({ fingerprints: initial.fingerprints });
        await context.recordStage?.("commit-retire", { fingerprints: initial.fingerprints });
      } else if (safeSpec.kind === "update-provider") {
        // Hermes providers 是 dict 深合并,改名(搬键+引用迁移)未实现——静默忽略
        // renameTo 会造成假成功,必须显式拒绝。
        if (safeSpec.patch?.renameTo) return blocked("rename_unsupported");
        result = await backend.updateModelProvider(safeSpec.providerKey, { ...safeSpec.patch, ...(secretEnvelope?.apiKey ? { apiKey: secretEnvelope.apiKey } : {}) });
        assertNoWarnings(result, "stage-target");
        await context.recordStage?.("stage-target", { fingerprints: initial.fingerprints, ...(secretEnvelope?.apiKey ? { secretStep: "applied" } : {}) });
        await context.recordStage?.("verify-ready", { fingerprints: initial.fingerprints });
        await context.markCommitting?.({ fingerprints: initial.fingerprints });
        await context.markCommitted?.({ fingerprints: initial.fingerprints, ...(secretEnvelope?.apiKey ? { secretStep: "applied" } : {}) });
      } else return blocked("invalid_change_kind");
      await backend.commitVerifiedHermesModelCatalog?.();
      return { status: "applied", stage: ["delete-model", "delete-provider"].includes(safeSpec.kind) ? "commit-retire" : "verify-ready" };
    } catch (error) {
      // Provider/模型批量写若仅部分 Profile 成功，journal 必须保留 stage 供同 operationId 恢复。
      if (Array.isArray(error?.partialProfiles) && error.partialProfiles.length > 0) {
        await context.recordStage?.("stage-target", { fingerprints: initial.fingerprints });
        return {
          status: safeSpec.kind === "update-provider" ? "needs_secret" : "partial",
          code: error?.code || "hermes_profile_partial",
          stage: "stage-target",
        };
      }
      return { status: "partial", code: error?.code || "hermes_apply_failed", stage: error?.stage || "apply" };
    }
  };

  /** apply 重新扫描 fingerprint 后，在同一 coordinator context + Profile gate 内执行。 */
  const apply = async (safeSpec, context, secretEnvelope) => {
    const initial = await preview(safeSpec);
    if (initial.blockers.length > 0) return blocked(initial.blockers[0].code, "preflight", { blockers: initial.blockers });
    const secretProfileCount = Array.isArray(initial.providerDiff?.profiles)
      ? initial.providerDiff.profiles.length
      : Array.isArray(initial.modelProfiles) ? initial.modelProfiles.length : 0;
    if (secretEnvelope?.apiKey && secretProfileCount > 1) {
      return blocked("hermes_multi_profile_secret_unsupported", "preflight");
    }
    const resumesProviderSecret = safeSpec.kind === "update-provider"
      && context.journalEntry?.status === "needs_secret";
    if (!resumesProviderSecret && context.journalEntry?.fingerprints
      && stableJson(context.journalEntry.fingerprints) !== stableJson(initial.fingerprints)) {
      return blocked("reference_fingerprint_changed");
    }
    const profiles = initial.profiles || [];
    return mutationGate.withCoordinatorContext(context.operationId, () => (
      mutationGate.withProfiles(profiles, context.operationId, async () => {
        // 等锁期间外部 writer 仍可能改变 Provider/引用；首写前必须在同一锁域重新取真值。
        const locked = await preview(safeSpec);
        if (locked.blockers.length > 0) {
          return blocked(locked.blockers[0].code, "preflight", { blockers: locked.blockers });
        }
        if (!resumesProviderSecret && (stableJson(locked.fingerprints) !== stableJson(initial.fingerprints)
          || (context.journalEntry?.fingerprints
            && stableJson(context.journalEntry.fingerprints) !== stableJson(locked.fingerprints)))) {
          return blocked("reference_fingerprint_changed");
        }
        if (resumesProviderSecret) {
          // 部分 Profile 成功后 fingerprint 必然变化；只允许当前值仍命中 journal 的 before/after 摘要。
          const recorded = Array.isArray(context.journalEntry?.providerDiff?.profiles)
            ? context.journalEntry.providerDiff.profiles
            : [];
          const current = Array.isArray(locked.providerDiff?.profiles) ? locked.providerDiff.profiles : [];
          const recognized = recorded.length > 0 && recorded.every((row) => {
            const nowRow = current.find((item) => item.profile === row.profile);
            return nowRow && [row.beforeDigest, row.afterDigest].includes(nowRow.beforeDigest);
          });
          if (!recognized) return blocked("provider_recovery_conflict", "recovery");
        }
        return safeSpec.kind === "rename"
          ? applyRename(safeSpec, context, secretEnvelope, locked)
          : applyOtherKind(safeSpec, context, secretEnvelope, locked);
      })
    ));
  };

  /** 从 journal 公开 modelDiff 重建不含凭证的最小 safeSpec。 */
  const specFromEntry = (entry) => ({
    kind: entry.kind,
    providerKey: entry.providerKey,
    providerMode: entry.createdProvider ? "new" : "existing",
    sourceModelId: entry.source?.modelId || null,
    model: entry.modelDiff?.after ? clone(entry.modelDiff.after) : undefined,
  });

  /** 读取全部 Profile 的 fresh Provider 真值并计算 source/target 存在性。 */
  const recoveryProviderState = async (safeSpec) => {
    const byProfile = await backend._readProvidersByProfile({ fresh: true, requireComplete: true });
    const profiles = [...backend.dashboards.keys()].sort();
    const rows = profiles.map((profile) => {
      const provider = byProfile.get(profile)?.[safeSpec.providerKey];
      const models = backend._hermesModelEntries(provider?.models);
      const target = safeSpec.model?.id
        ? models.find((model) => model.id === safeSpec.model.id)
        : null;
      const targetMatches = !!target && (
        !Object.prototype.hasOwnProperty.call(safeSpec.model || {}, "contextWindow")
        || Number(target.context_length || target.contextLength) === Number(safeSpec.model.contextWindow)
      );
      return {
        profile,
        providerExists: !!provider,
        sourceExists: safeSpec.sourceModelId
          ? models.some((model) => model.id === safeSpec.sourceModelId)
          : false,
        targetExists: !!target,
        targetMatches,
        targetModel: publicSourceModel(target),
        providerDigest: providerProfileDigest(profile, provider),
      };
    });
    return {
      profiles,
      rows,
      providerDigest: providerStateDigest(rows.map((row) => ({
        profile: row.profile,
        provider: byProfile.get(row.profile)?.[safeSpec.providerKey],
      }))),
    };
  };

  /** Provider CRUD 的 warnings 表示跨 Profile 未原子收敛，恢复不得声明 applied。 */
  const assertRecoveryWrite = (result) => {
    assertNoWarnings(result, "recovery");
    return result;
  };

  /** rename 恢复以 source/target 实际存在性判定提交进度，不使用崩溃前 fingerprint。 */
  const recoverRename = async (safeSpec, entry, context) => {
    let state = await recoveryProviderState(safeSpec);
    let commitAdvanced = false;
    const targetEverywhere = () => state.rows.length > 0 && state.rows.every((row) => row.targetMatches);
    const sourceAnywhere = () => state.rows.some((row) => row.sourceExists);
    if (!targetEverywhere()) {
      if (state.rows.some((row) => row.targetExists && !row.targetMatches)) {
        return blocked("target_conflict", "recovery");
      }
      const missingProvider = state.rows.some((row) => !row.providerExists);
      if (entry.createdProvider && missingProvider) {
        // baseUrl/凭证不落 journal，必须由原表单以同 operationId 续提。
        return { status: "needs_secret", code: "recovery_input_required", stage: "recovery" };
      }
      assertRecoveryWrite(await backend.addModelConfig({
        providerKey: safeSpec.providerKey,
        providerMode: safeSpec.providerMode,
        model: safeSpec.model,
      }));
      await context.recordStage?.("stage-target", { fingerprints: entry.fingerprints });
      state = await recoveryProviderState(safeSpec);
      if (!targetEverywhere()) return blocked("runtime_target_not_ready", "recovery");
    }

    if (sourceAnywhere()) {
      const scanned = await scan(backend, safeSpec, {});
      if ((scanned.blockers || []).length > 0) {
        return blocked(scanned.blockers[0].code, "recovery", { blockers: scanned.blockers });
      }
      const completed = [];
      await migrateReferences(scanned.references || [], context, completed);
      const ready = await scan(backend, safeSpec, {});
      if ((ready.references || []).some((reference) => reference.definition !== true)
        || (ready.blockers || []).some((item) => item.code === "session_model_reference")) {
        return blocked("references_remain", "recovery");
      }
      if (await verifyTarget(safeSpec, state.profiles) !== true) {
        return blocked("runtime_target_not_ready", "recovery");
      }
      await context.recordStage?.("verify-ready", { fingerprints: ready.fingerprints });
      if (entry.commitState === "precommit") {
        await context.markCommitting?.({ fingerprints: ready.fingerprints });
        commitAdvanced = true;
      }
      assertRecoveryWrite(await backend.removeModelConfig({
        providerKey: safeSpec.providerKey,
        modelId: safeSpec.sourceModelId,
      }));
    }
    // source 已不存在就是 retire 的权威证据，只补记提交点。
    if (entry.commitState === "precommit" && !commitAdvanced) {
      await context.markCommitting?.({ fingerprints: entry.fingerprints });
    }
    await context.markCommitted?.({ fingerprints: entry.fingerprints });
    await context.recordStage?.("commit-retire", { fingerprints: entry.fingerprints });
    await backend.commitVerifiedHermesModelCatalog?.();
    return { status: "applied", stage: "recovery" };
  };

  /** create/update 按全 Profile target 存在性幂等重放；Provider 新建缺参数时续提。 */
  const recoverStageOnly = async (safeSpec, entry, context) => {
    if (safeSpec.kind === "update-provider") {
      if (entry.stage === "preflight" && entry.commitState === "precommit") {
        return { status: "compensated", code: "recovery_no_write", stage: "recovery" };
      }
      const state = await recoveryProviderState(safeSpec);
      // apiKey-only 更新不会改变公开配置摘要；未记录 secretStep 时不能凭相等摘要宣告成功。
      if (entry.providerDiff?.beforeDigest === entry.providerDiff?.afterDigest
        && entry.secretStep !== "applied"
        && entry.commitState === "precommit") {
        return { status: "needs_secret", code: "recovery_input_required", stage: "recovery" };
      }
      const profileDiffs = Array.isArray(entry.providerDiff?.profiles) ? entry.providerDiff.profiles : [];
      const profileStates = profileDiffs.map((diff) => {
        const current = state.rows.find((row) => row.profile === diff.profile)?.providerDigest;
        if (current === diff.afterDigest) return "after";
        if (current === diff.beforeDigest) return "before";
        return "conflict";
      });
      if (profileStates.length > 0 && profileStates.includes("conflict")) {
        return blocked("provider_recovery_conflict", "recovery");
      }
      if ((profileStates.length > 0 && profileStates.every((value) => value === "after"))
        || (profileStates.length === 0 && state.providerDigest === entry.providerDiff?.afterDigest)) {
        if (entry.commitState === "precommit") await context.markCommitting?.({ fingerprints: entry.fingerprints });
        await context.markCommitted?.({ fingerprints: entry.fingerprints });
        await backend.commitVerifiedHermesModelCatalog?.();
        return { status: "applied", stage: "recovery" };
      }
      if (profileStates.length > 0
        ? profileStates.every((value) => value === "before" || value === "after")
        : state.providerDigest === entry.providerDiff?.beforeDigest) {
        // 端点原文和凭证禁止落 journal；混合状态只能由原表单用同 operationId 续提。
        return { status: "needs_secret", code: "recovery_input_required", stage: "recovery" };
      }
      return blocked("provider_recovery_conflict", "recovery");
    }
    let state = await recoveryProviderState(safeSpec);
    const beforeModel = entry.modelDiff?.before;
    const matchesBefore = (row) => safeSpec.kind === "update"
      && row.targetExists
      && (() => {
        const profileBefore = Array.isArray(entry.modelDiff?.profiles)
          ? entry.modelDiff.profiles.find((item) => item.profile === row.profile)?.before
          : beforeModel;
        return row.targetModel?.id === profileBefore?.id
          && (!Object.prototype.hasOwnProperty.call(profileBefore || {}, "contextWindow")
            || Number(row.targetModel?.contextWindow) === Number(profileBefore.contextWindow));
      })();
    if (state.rows.some((row) => row.targetExists && !row.targetMatches && !matchesBefore(row))) {
      return blocked("target_conflict", "recovery");
    }
    if (!state.rows.every((row) => row.targetMatches)) {
      if (entry.createdProvider && state.rows.some((row) => !row.providerExists)) {
        return { status: "needs_secret", code: "recovery_input_required", stage: "recovery" };
      }
      assertRecoveryWrite(await backend.addModelConfig({
        providerKey: safeSpec.providerKey,
        providerMode: safeSpec.providerMode,
        model: safeSpec.model,
      }));
      await context.recordStage?.("stage-target", { fingerprints: entry.fingerprints });
      state = await recoveryProviderState(safeSpec);
    }
    if (state.rows.length === 0
      || !state.rows.every((row) => row.targetMatches)
      || await verifyTarget(safeSpec, state.profiles) !== true) {
      return blocked("runtime_target_not_ready", "recovery");
    }
    if (entry.commitState === "precommit") await context.markCommitting?.({ fingerprints: entry.fingerprints });
    await context.markCommitted?.({ fingerprints: entry.fingerprints });
    await backend.commitVerifiedHermesModelCatalog?.();
    return { status: "applied", stage: "recovery" };
  };

  /** delete 在 precommit 尚无写；committing/committed 按 fresh source 存在性幂等继续。 */
  const recoverDelete = async (safeSpec, entry, context) => {
    if (entry.commitState === "precommit") {
      return { status: "compensated", code: "recovery_no_write", stage: "recovery" };
    }
    const state = await recoveryProviderState(safeSpec);
    if (state.rows.length === 0) return blocked("provider_enumeration_incomplete", "recovery");
    const exists = safeSpec.kind === "delete-provider"
      ? state.rows.some((row) => row.providerExists)
      : state.rows.some((row) => row.sourceExists);
    if (exists) {
      const result = safeSpec.kind === "delete-provider"
        ? await backend.removeModelProvider(safeSpec.providerKey)
        : await backend.removeModelConfig({ providerKey: safeSpec.providerKey, modelId: safeSpec.sourceModelId });
      assertRecoveryWrite(result);
    }
    await context.markCommitted?.({ fingerprints: entry.fingerprints });
    await context.recordStage?.("commit-retire", { fingerprints: entry.fingerprints });
    await backend.commitVerifiedHermesModelCatalog?.();
    return { status: "applied", stage: "recovery" };
  };

  /** 在与普通 apply 相同的 coordinator context/Profile gate 内执行安全恢复。 */
  const recover = async (entry, context) => {
    const safeSpec = specFromEntry(entry);
    const profiles = [...backend.dashboards.keys()].sort();
    try {
      return await mutationGate.withCoordinatorContext(context.operationId, () => (
        mutationGate.withProfiles(profiles, context.operationId, async () => {
          if (safeSpec.kind === "rename") return recoverRename(safeSpec, entry, context);
          if (["create", "update", "update-provider"].includes(safeSpec.kind)) {
            return recoverStageOnly(safeSpec, entry, context);
          }
          if (["delete-model", "delete-provider"].includes(safeSpec.kind)) {
            return recoverDelete(safeSpec, entry, context);
          }
          return blocked("invalid_change_kind", "recovery");
        })
      ));
    } catch (error) {
      return {
        status: "partial",
        code: error?.code || "hermes_recovery_failed",
        stage: "recovery",
        retryable: true,
      };
    }
  };

  return Object.freeze({ getCapabilities, preview, apply, recover });
}

module.exports = {
  HermesModelChangeError,
  createHermesModelChange,
};
