import {
  addModelConfig,
  ApiError,
  applyModelBatch,
  getModelChangeOperation,
  listCustomEndpoints,
  removeModelConfig,
  removeModelProvider,
  saveModelProviderDraft,
  revealModelProviderKey,
  updateModelProvider,
  validateCustomEndpoint,
} from "../../api/client";
import type {
  CustomEndpoint,
  CustomEndpointInput,
  CustomEndpointsSnapshot,
  CustomEndpointValidation,
  ModelChangeApplyResult,
  ModelChangeOperation,
} from "../../types";
import {
  canConfirmEndpointRemoval,
  type EndpointController,
  type EndpointMutationOutcome,
  type EndpointMutationSession,
  type EndpointMutationStep,
  type EndpointSafeReference,
} from "./endpoint-controller";
import {
  confirmModelOperationTerminal, getModelOperationRecoverySnapshot, modelOperationRecoveryBlocks, retainModelOperation, retainedProviderModelOperation,
} from "./model-operation-recovery";
import {
  createEndpointMutationState,
  reduceEndpointMutationState,
  type EndpointMutationState,
} from "./endpoint-mutation-state";

export interface OpenClawEndpointDependencies {
  saveModelProviderDraft?: typeof saveModelProviderDraft;
  listCustomEndpoints(backend: string, profile?: string, options?: { refreshAuth?: boolean }): Promise<CustomEndpointsSnapshot>;
  validateCustomEndpoint(
    backend: string,
    profile: string | undefined,
    input: CustomEndpointInput,
  ): Promise<CustomEndpointValidation>;
  addModelConfig(
    backend: string,
    spec: Parameters<typeof addModelConfig>[1],
    operationId?: string,
  ): Promise<ModelChangeApplyResult>;
  updateModelProvider(
    backend: string,
    provider: string,
    patch: Parameters<typeof updateModelProvider>[2],
    operationId?: string,
  ): Promise<ModelChangeApplyResult>;
  applyModelBatch(
    backend: string,
    items: Parameters<typeof applyModelBatch>[1],
    operationId?: string,
    options?: Parameters<typeof applyModelBatch>[3],
  ): Promise<ModelChangeApplyResult>;
  removeModelConfig(
    backend: string,
    provider: string,
    model: string,
    operationId?: string,
    force?: boolean,
  ): Promise<ModelChangeApplyResult>;
  removeModelProvider(
    backend: string,
    provider: string,
    operationId?: string,
    force?: boolean,
  ): Promise<ModelChangeApplyResult>;
  revealModelProviderKey(
    backend: string,
    provider: string,
    signal?: AbortSignal,
  ): Promise<{ apiKey: string | null }>;
  /** 只读核对原操作结论（恢复区同一接口）；不重放写入。 */
  getModelChangeOperation?(
    backend: string,
    operationId: string,
    providerKey: string,
  ): Promise<ModelChangeOperation>;
}

const defaultDependencies: OpenClawEndpointDependencies = {
  listCustomEndpoints,
  validateCustomEndpoint,
  addModelConfig,
  updateModelProvider,
  applyModelBatch,
  removeModelConfig,
  removeModelProvider,
  revealModelProviderKey,
  getModelChangeOperation,
  saveModelProviderDraft,
};

type FrozenPlan = {
  readonly session: EndpointMutationSession;
  readonly source: CustomEndpoint | null;
  readonly target: Omit<CustomEndpointInput, "apiKey">;
  secret?: string;
  state: EndpointMutationState;
  pendingActivation?: ModelChangeApplyResult["activation"];
  blockedRemoval?: { operationId: string; modelId: string; modelIds?: string[] };
  readonly batchModelSelection: boolean;
  readonly singleModelMutations: boolean;
  readonly preservePrimaryRefs: boolean;
  readonly configurationDraft: boolean;
  confirmedRemovals: Set<string>;
  baseline?: CustomEndpoint;
  removeForce?: boolean;
};

type ActivationSink = (activation: NonNullable<ModelChangeApplyResult["activation"]>) => void;

function uniqueModels(input: CustomEndpointInput): string[] {
  return [...new Set((input.models?.length ? input.models : [input.model])
    .map((model) => model.trim())
    .filter(Boolean))];
}

function safeReferences(value: unknown): EndpointSafeReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    if (typeof source.store !== "string") return [];
    return [{
      store: source.store,
      ...(typeof source.referenceKey === "string" ? { referenceKey: source.referenceKey } : {}),
      ...(typeof source.scope === "string" ? { scope: source.scope } : {}),
      ...(typeof source.agent === "string" ? { agent: source.agent } : {}),
      ...(typeof source.profile === "string" ? { profile: source.profile } : {}),
    }];
  });
}

function stepFromResult(operationId: string, result: ModelChangeApplyResult): EndpointMutationStep {
  const extended = result as ModelChangeApplyResult & {
    blockers?: Array<{ code?: string; scope?: string }>;
    references?: unknown;
  };
  return {
    operationId,
    status: result.status,
    code: result.code,
    stage: result.stage,
    blockers: extended.blockers?.flatMap((blocker) =>
      typeof blocker?.code === "string"
        ? [{ code: blocker.code, ...(blocker.scope ? { scope: blocker.scope } : {}) }]
        : []),
    references: safeReferences(extended.references),
    canForce: result.canForce,
    ...(result.configSaved === true ? { configSaved: true } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  };
}

function stepFromError(operationId: string, error: unknown): EndpointMutationStep {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof source.code === "string" ? source.code : "response_lost";
  const status = code === "references_exist" || code.endsWith("_in_use")
    || (typeof source.status === "number" && source.status === 409)
    ? "blocked"
    : "partial";
  const blockers = Array.isArray(source.safeBlockers)
    ? (source.safeBlockers as Array<Record<string, unknown>>).flatMap((blocker) =>
      typeof blocker.code === "string" ? [{ code: blocker.code }] : [])
    : code !== "response_lost" ? [{ code }] : [];
  return {
    operationId,
    status,
    code,
    stage: typeof source.stage === "string" ? source.stage : "request",
    blockers,
    references: safeReferences(source.safeReferences),
    ...(typeof source.canForce === "boolean" ? { canForce: source.canForce } : {}),
  };
}

function sameModels(endpoint: CustomEndpoint | undefined, expected: string[]): boolean {
  if (!endpoint) return false;
  return endpoint.models.length === expected.length
    && endpoint.models.every((model) => expected.includes(model));
}

function endpointMatches(plan: FrozenPlan, endpoint: CustomEndpoint | undefined): boolean {
  if (!endpoint || !sameModels(endpoint, plan.target.models ?? [])) return false;
  if (endpoint.baseUrl !== plan.target.baseUrl) return false;
  if (Object.prototype.hasOwnProperty.call(plan.target, "api") && endpoint.api !== plan.target.api) {
    return false;
  }
  if (plan.secret && !endpoint.hasApiKey) return false;
  return true;
}

function abortable<T>(signal: AbortSignal | undefined, request: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const pending = request();
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createOpenClawEndpointController(
  backend: string,
  dependencies: OpenClawEndpointDependencies = defaultDependencies,
  activationSink?: ActivationSink,
): EndpointController {
  let lastSnapshot: CustomEndpointsSnapshot | null = null;
  let snapshotGeneration = 0;
  const plans = new Map<string, FrozenPlan>();

  const load = async (options?: { refreshAuth?: boolean }) => {
    const generation = ++snapshotGeneration;
    const snapshot = await dependencies.listCustomEndpoints(backend, undefined, options);
    if (generation === snapshotGeneration) lastSnapshot = snapshot;
    return snapshot;
  };

  const planFor = (
    input: CustomEndpointInput,
    session: EndpointMutationSession,
    sourceFallback?: CustomEndpoint,
  ): FrozenPlan => {
    const existing = plans.get(session.rootOperationId);
    if (existing) return existing;
    const models = uniqueModels(input);
    const id = (input.id || input.name).trim();
    const sourceId = sourceFallback?.id ?? id;
    const source = lastSnapshot?.endpoints.find((endpoint) => endpoint.id === sourceId) ?? sourceFallback ?? null;
    if (modelOperationRecoveryBlocks(backend, sourceId) || modelOperationRecoveryBlocks(backend, id)) {
      throw new Error("model_original_operation_pending");
    }
    const { apiKey, ...publicInput } = input;
    const plan: FrozenPlan = {
      session: { ...session },
      // A retry must replay the original operation type and model diff. Do not
      // retain caller-owned arrays or replace this source with a write readback.
      source: source ? { ...source, models: [...source.models],
        ...(source.profiles ? { profiles: [...source.profiles] } : {}),
        ...(source.activeIn ? { activeIn: [...source.activeIn] } : {}),
      } : null,
      target: { ...publicInput, ...(publicInput.advanced ? { advanced: JSON.parse(JSON.stringify(publicInput.advanced)) } : {}), id, model: models[0] ?? "", models },
      ...(apiKey?.trim() ? { secret: apiKey.trim() } : {}),
      state: createEndpointMutationState(session.rootOperationId, backend, session.kind),
      batchModelSelection: lastSnapshot?.form?.batchModelSelection === true
        && lastSnapshot?.form?.singleModelMutations !== true,
      singleModelMutations: lastSnapshot?.form?.singleModelMutations === true,
      preservePrimaryRefs: lastSnapshot?.form?.allowPrimaryModelRemoval === true,
      configurationDraft: lastSnapshot?.form?.configurationDraft === true,
      confirmedRemovals: new Set(),
    };
    plans.set(session.rootOperationId, plan);
    return plan;
  };

  const emitActivation = (
    plan: FrozenPlan,
    activation: ModelChangeApplyResult["activation"],
  ) => {
    if (!activation || plan.state.emittedActivationKinds.includes(activation.kind)) return;
    plan.state = reduceEndpointMutationState(plan.state, {
      type: "activation_emitted",
      kind: activation.kind,
    });
    if (activationSink) {
      // 运行态提示是旁路通知，不能把已成功的配置写误判成响应丢失。
      try { activationSink(activation); } catch { /* UI 生命周期已结束时忽略通知 */ }
    } else plan.pendingActivation = activation;
  };

  const runStep = async (
    plan: FrozenPlan,
    operationId: string,
    request: () => Promise<ModelChangeApplyResult>,
  ): Promise<EndpointMutationStep> => {
    const previous = plan.state.steps.find((step) => step.operationId === operationId);
    if (previous?.status === "applied") return previous;
    const monitored = getModelOperationRecoverySnapshot(backend).required || plan.singleModelMutations || plan.configurationDraft;
    const providerKey = plan.source && operationId.endsWith(":provider") ? plan.source.id : plan.target.id!;
    const original = retainedProviderModelOperation(backend, providerKey);
    if (monitored && (plan.singleModelMutations || plan.configurationDraft) && (previous || original?.operationId === operationId)) {
      throw new Error("model_original_operation_pending");
    }
    if (modelOperationRecoveryBlocks(backend, providerKey, operationId)) throw new Error("model_original_operation_pending");
    if (monitored && !await retainModelOperation({ version: 1, backendId: backend, providerKey, operationId, status: "unconfirmed" })) {
      throw new Error("model_operation_storage_unverified");
    }
    plan.state = reduceEndpointMutationState(plan.state, { type: "request_started", operationId });
    let serverRejected = false;
    // 服务端已给出明确但非「已应用」的结论：只读核对一次原操作。服务端确认终态（含未进
    // journal 的预检拒绝与批量写）就确认并解锁；仍非终态则按服务端状态保留。没有 HTTP 响应的
    // 网络失败结论未知，不走这里，原 ID 继续锁定，留给恢复区检查。
    const settleWithServer = async (fallbackStatus: string): Promise<boolean> => {
      let receipt: ModelChangeOperation | null = null;
      try {
        receipt = await dependencies.getModelChangeOperation?.(backend, operationId, providerKey) ?? null;
      } catch { receipt = null; }
      if (receipt?.terminal) {
        const acknowledged = await confirmModelOperationTerminal(receipt);
        serverRejected = acknowledged && receipt.status === "failed";
        return acknowledged;
      }
      const status = receipt && receipt.status !== "not_found" ? receipt.status : fallbackStatus;
      return retainModelOperation({ version: 1, backendId: backend, providerKey, operationId, status });
    };
    try {
      const result = await request();
      if (monitored && (plan.singleModelMutations || plan.configurationDraft) && (result.receiptIdentityVerified !== true || result.operationId !== operationId
        || !["applied", "failed", "compensated", "in_progress", "partial", "blocked", "needs_secret", "cleanup_pending"].includes(result.status)
        || typeof result.stage !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.stage)
        || result.code !== undefined && (typeof result.code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.code))
        || Object.keys(result).some((key) => !["operationId", "status", "stage", "code", "catalog", "activation", "warnings", "details", "canForce", "receiptIdentityVerified", "configSaved", "catalogPending", "retryable", "needsVerification"].includes(key)))) {
        throw new Error("model_operation_receipt_unverified");
      }
      if (monitored) {
        if (["applied", "failed", "compensated"].includes(result.status)) {
          if (!await confirmModelOperationTerminal({ version: 1, backendId: backend, providerKey, operationId,
            status: result.status as "applied" | "failed" | "compensated", stage: result.stage, terminal: true })) {
            throw new Error("model_operation_storage_unverified");
          }
        } else if (!await settleWithServer(result.status)) {
          throw new Error("model_operation_storage_unverified");
        }
      }
      const step = stepFromResult(operationId, result);
      plan.state = reduceEndpointMutationState(plan.state, { type: "phase_result", step,
        zeroWrite: step.status === "failed" && step.stage === "preflight" });
      if (step.status === "applied" || step.status === "partial" && step.code === "catalog_pending") {
        emitActivation(plan, result.activation);
      }
      return step;
    } catch (error) {
      // HTTP 错误说明服务端已处理并拒绝：核对原操作后解锁。journal_* 是受理后的
      // 锁/记录故障，结论仍需恢复区确认，保持锁定。
      if (monitored && error instanceof ApiError && error.status > 0
        && !String(error.code || "").startsWith("journal_")) {
        await settleWithServer("unconfirmed").catch(() => false);
      }
      const step = stepFromError(operationId, error);
      if (plan.configurationDraft && serverRejected) { step.status = "failed"; step.stage = "preflight"; }
      const provenZeroWrite = step.stage === "preflight"
        && step.code !== "response_lost"
        && step.status !== "needs_secret";
      plan.state = reduceEndpointMutationState(
        plan.state,
        provenZeroWrite
          ? { type: "phase_result", step, zeroWrite: true }
          : { type: "request_lost", step },
      );
      return step;
    }
  };

  const outcome = (
    plan: FrozenPlan,
    step: EndpointMutationStep | null,
    sync: "synced" | "pending",
    snapshot?: CustomEndpointsSnapshot,
    fallbackCode?: string,
  ): EndpointMutationOutcome => {
    const activation = plan.pendingActivation;
    plan.pendingActivation = undefined;
    const status = step?.status ?? "applied";
    const code = step?.code ?? fallbackCode;
    const needsSecret = status === "needs_secret" || code === "needs_secret";
    return {
      operationId: plan.session.rootOperationId,
      status,
      ...(code ? { code } : {}),
      ...(typeof step?.canForce === "boolean" ? { canForce: step.canForce } : {}),
      stage: step?.stage ?? (sync === "synced" ? "snapshot" : "recovery"),
      ...(activation ? { activation } : {}),
      ...(step?.configSaved === true || plan.configurationDraft && status === "applied" ? { configSaved: true } : {}),
      warnings: plan.state.steps.flatMap(item => item.warnings || []),
      sync,
      ...(snapshot ? { snapshot } : {}),
      steps: plan.state.steps,
      ...(status !== "applied" || sync === "pending" && !plan.configurationDraft ? {
        recovery: {
          code: code ?? "snapshot_pending",
          stage: step?.stage ?? "snapshot",
          retryable: status !== "blocked" || Boolean(plan.blockedRemoval),
          locked: Boolean(plan.blockedRemoval) || plan.state.phase !== "editable",
          needsSecret,
          ...(plan.baseline ? { baseline: plan.baseline } : {}),
          references: step?.references,
          ...(plan.blockedRemoval ? { blockedRemoval: plan.blockedRemoval } : {}),
        },
      } : {}),
    };
  };

  const reconcile = async (
    plan: FrozenPlan,
    step: EndpointMutationStep | null,
    predicate: (snapshot: CustomEndpointsSnapshot) => boolean,
    snapshotProvesApplied = false,
  ): Promise<EndpointMutationOutcome> => {
    try {
      const modelOnlyEdit = plan.session.kind === "edit" && Boolean(plan.source)
        && plan.target.id === plan.source?.id
        && !plan.secret && plan.target.baseUrl === plan.source?.baseUrl
        && (!Object.hasOwn(plan.target, "api") || plan.target.api === plan.source?.api);
      const snapshot = await load(modelOnlyEdit ? { refreshAuth: false } : undefined);
      const current = snapshot.endpoints.find((endpoint) => endpoint.id === plan.source?.id)
        ?? snapshot.endpoints.find((endpoint) => endpoint.id === plan.target.id);
      if (current) {
        // This is display/recovery context only. Public config (including
        // hasApiKey) cannot prove that the requested secret or mutation applied.
        plan.baseline = current;
      }
      const synced = predicate(snapshot);
      plan.state = reduceEndpointMutationState(plan.state, { type: "snapshot_refreshed", synced });
      if (plan.configurationDraft && step === null) plan.state = { ...plan.state, phase: "synced" };
      const next = outcome(
        plan,
        synced && (step === null || snapshotProvesApplied) ? null : step,
        synced ? "synced" : "pending",
        snapshot,
        synced ? undefined : "snapshot_mismatch",
      );
      if ((plan.state.phase === "editable" || plan.configurationDraft && plan.state.phase === "synced") && !plan.blockedRemoval) {
        plan.secret = undefined;
        plans.delete(plan.session.rootOperationId);
      }
      return next;
    } catch {
      plan.state = reduceEndpointMutationState(plan.state, {
        type: "snapshot_refreshed",
        synced: false,
      });
      if (plan.configurationDraft && step === null) plan.state = { ...plan.state, phase: "synced" };
      const next = outcome(plan, step, "pending", undefined, "snapshot_unavailable");
      if ((plan.state.phase === "editable" || plan.configurationDraft && plan.state.phase === "synced") && !plan.blockedRemoval) {
        plan.secret = undefined;
        plans.delete(plan.session.rootOperationId);
      }
      return next;
    }
  };

  const addModels = async (
    plan: FrozenPlan, providerKey: string, models: string[],
  ): Promise<EndpointMutationStep | null> => {
    if (!models.length) return null;
    if (!plan.singleModelMutations) {
      const operationId = `${plan.session.rootOperationId}:add`;
      return runStep(plan, operationId, () => dependencies.applyModelBatch(
        backend, models.map((id) => ({ providerKey, model: { id } })), operationId,
      ));
    }
    for (const [index, id] of models.entries()) {
      const operationId = `${plan.session.rootOperationId}:add:${index}`;
      const step = await runStep(plan, operationId, () => dependencies.addModelConfig(
        backend, { providerMode: "existing", providerKey, model: { id } }, operationId,
      ));
      if (step.status !== "applied") return step;
    }
    return null;
  };

  const executeSave = async (plan: FrozenPlan): Promise<EndpointMutationOutcome> => {
    const id = plan.target.id ?? "";
    const models = plan.target.models ?? [];
    const complete = (snapshot: CustomEndpointsSnapshot) =>
      endpointMatches(plan, snapshot.endpoints.find((endpoint) => endpoint.id === id))
      && (!plan.source || plan.source.id === id || !snapshot.endpoints.some((endpoint) => endpoint.id === plan.source?.id));

    if (plan.configurationDraft) {
      if (!dependencies.saveModelProviderDraft) throw new Error("model_config_draft_unavailable");
      const operationId = `${plan.session.rootOperationId}:provider`;
      const step = await runStep(plan, operationId, () => dependencies.saveModelProviderDraft!(backend, {
        providerKey: plan.source?.id || id, models,
        baseUrl: plan.target.baseUrl,
        ...(plan.target.api ? { api: plan.target.api } : {}),
        ...(plan.source && plan.source.id !== id ? { renameTo: id } : {}),
        ...(plan.secret ? { apiKey: plan.secret } : {}),
        ...(plan.target.agentId ? { agentId: plan.target.agentId } : {}),
        ...(plan.target.credentialScope ? { credentialScope: plan.target.credentialScope } : {}),
        ...(plan.target.baseHash ? { baseHash: plan.target.baseHash } : {}),
        ...(plan.target.advanced ? { advanced: plan.target.advanced } : {}),
      }, operationId));
      return reconcile(plan, step.status === "applied" ? null : step, complete);
    }

    if (!plan.source) {
      const providerOperation = `${plan.session.rootOperationId}:provider`;
      const providerStep = await runStep(plan, providerOperation, () =>
        dependencies.addModelConfig(backend, {
          providerKey: id,
          providerMode: "new",
          baseUrl: plan.target.baseUrl,
          ...(plan.target.api ? { api: plan.target.api } : {}),
          ...(plan.secret ? { apiKey: plan.secret } : {}),
          model: { id: models[0] },
        }, providerOperation));
      if (providerStep.status !== "applied") return reconcile(plan, providerStep, complete);

      const addStep = await addModels(plan, id, models.slice(1));
      if (addStep && addStep.status !== "applied") return reconcile(plan, addStep, complete);
    } else {
      const patch: Parameters<typeof updateModelProvider>[2] = {};
      if (id !== plan.source.id) patch.renameTo = id;
      if (plan.target.baseUrl !== plan.source.baseUrl) patch.baseUrl = plan.target.baseUrl;
      if (
        Object.prototype.hasOwnProperty.call(plan.target, "api")
        && plan.target.api !== plan.source.api
      ) {
        patch.api = plan.target.api;
      }
      if (plan.secret) patch.apiKey = plan.secret;
      if (Object.keys(patch).length > 0) {
        const providerOperation = `${plan.session.rootOperationId}:provider`;
        const providerStep = await runStep(plan, providerOperation, () =>
          dependencies.updateModelProvider(backend, plan.source!.id, patch, providerOperation));
        if (providerStep.status !== "applied") return reconcile(plan, providerStep, complete);
      }

      const additions = models.filter((model) => !plan.source?.models.includes(model));
      const deletions = plan.source.models.filter((model) => !models.includes(model));
      if (plan.batchModelSelection && additions.length + deletions.length > 0
        && additions.length + deletions.length <= 100) {
        const selectionOperation = `${plan.session.rootOperationId}:selection`;
        const force = plan.confirmedRemovals.has(selectionOperation);
        const selectionStep = await runStep(plan, selectionOperation, () =>
          dependencies.applyModelBatch(backend, [
            ...additions.map((model) => ({ providerKey: id, model: { id: model } })),
            ...deletions.map((modelId) => ({ op: "delete" as const, providerKey: id, modelId })),
          ], selectionOperation, { confirmReferences: true, force, preservePrimaryRefs: plan.preservePrimaryRefs }));
        if (selectionStep.status !== "applied") {
          plan.blockedRemoval = !force && canConfirmEndpointRemoval(selectionStep)
            ? { operationId: selectionOperation, modelId: deletions[0], modelIds: deletions }
            : undefined;
          return reconcile(plan, selectionStep, complete);
        }
        plan.blockedRemoval = undefined;
        return reconcile(plan, null, complete);
      }
      const addStep = await addModels(plan, id, additions);
      if (addStep && addStep.status !== "applied") return reconcile(plan, addStep, complete);

      for (const [index, model] of deletions.entries()) {
        const deleteOperation = `${plan.session.rootOperationId}:delete:${index}`;
        const force = plan.confirmedRemovals.has(deleteOperation);
        const deleteStep = await runStep(plan, deleteOperation, () =>
          dependencies.removeModelConfig(backend, id, model, deleteOperation, force));
        if (deleteStep.status !== "applied") {
          if (!force && canConfirmEndpointRemoval(deleteStep)) {
            plan.blockedRemoval = { operationId: deleteOperation, modelId: model };
          } else plan.blockedRemoval = undefined;
          return reconcile(plan, deleteStep, complete);
        }
      }
    }

    plan.blockedRemoval = undefined;
    return reconcile(plan, null, complete);
  };

  const executeRemove = async (
    plan: FrozenPlan,
    endpoint: CustomEndpoint,
    force: boolean,
  ): Promise<EndpointMutationOutcome> => {
    plan.removeForce = force;
    const operationId = `${plan.session.rootOperationId}:delete:provider`;
    const step = await runStep(plan, operationId, () =>
      dependencies.removeModelProvider(backend, endpoint.id, operationId, force));
    return reconcile(
      plan,
      step.status === "applied" ? null : step,
      (snapshot) => !snapshot.endpoints.some((item) => item.id === endpoint.id),
      true,
    );
  };

  const executeClear = async (plan: FrozenPlan): Promise<EndpointMutationOutcome> => {
    const endpoint = plan.source;
    if (!endpoint) throw new Error("endpoint_clear_session_missing");
    const operationId = `${plan.session.rootOperationId}:clear-key`;
    const step = await runStep(plan, operationId, () =>
      dependencies.updateModelProvider(backend, endpoint.id, { clearApiKey: true,
        ...(plan.target.credentialScope ? { credentialScope: plan.target.credentialScope } : {}),
        ...(plan.target.baseHash ? { baseHash: plan.target.baseHash } : {}),
        ...(plan.target.agentId ? { agentId: plan.target.agentId } : {}) }, operationId));
    return reconcile(plan, step.status === "applied" ? null : step, (snapshot) => {
      const current = snapshot.endpoints.find((item) => item.id === endpoint.id);
      return Boolean(current && !current.hasApiKey);
    }, true);
  };

  return {
    backend,
    cacheKey: dependencies === defaultDependencies ? `models:endpoints:${backend}` : undefined,
    adoptSnapshot: (snapshot) => { snapshotGeneration += 1; lastSnapshot = snapshot; },
    list: (signal) => abortable(signal, load),
    validate: (input, signal) => abortable(
      signal,
      () => dependencies.validateCustomEndpoint(backend, undefined, input),
    ),
    save(input, session, source) {
      return executeSave(planFor(input, session, source));
    },
    remove(endpoint, session, force) {
      const plan = planFor({
        id: endpoint.id,
        name: endpoint.name,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        models: endpoint.models,
      }, session, endpoint);
      return executeRemove(plan, plan.source ?? endpoint, force);
    },
    async retry(session, patch) {
      const plan = plans.get(session.rootOperationId);
      if (!plan) throw new Error("endpoint_recovery_session_missing");
      const last = [...plan.state.steps].reverse().find((step) => step.status !== "applied");
      const needsSecret = last?.status === "needs_secret" || last?.code === "needs_secret";
      if (needsSecret && patch?.apiKey?.trim()) plan.secret = patch.apiKey.trim();
      plan.state = reduceEndpointMutationState(plan.state, { type: "retry" });
      if (plan.session.kind === "clear-key") return executeClear(plan);
      if (plan.session.kind === "delete" && plan.source) {
        return executeRemove(plan, plan.source, plan.removeForce ?? false);
      }
      return executeSave(plan);
    },
    async confirmBlockedRemoval(session, childOperationId) {
      const plan = plans.get(session.rootOperationId);
      if (!plan || plan.blockedRemoval?.operationId !== childOperationId) {
        throw new Error("endpoint_blocked_removal_session_missing");
      }
      plan.confirmedRemovals.add(childOperationId);
      plan.blockedRemoval = undefined;
      return executeSave(plan);
    },
    async revealApiKey(endpoint, signal) {
      const result = await abortable(
        signal,
        () => dependencies.revealModelProviderKey(backend, endpoint.id, signal),
      );
      return result.apiKey;
    },
    async clearApiKey(endpoint, session, scope) {
      const plan = planFor({
        id: endpoint.id,
        name: endpoint.name,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        models: endpoint.models,
        ...(scope?.agentId ? { agentId: scope.agentId } : {}),
        ...(scope?.credentialScope ? { credentialScope: scope.credentialScope } : {}),
        ...(scope?.baseHash ? { baseHash: scope.baseHash } : {}),
      }, session, endpoint);
      return executeClear(plan);
    },
    release(session) {
      const plan = plans.get(session.rootOperationId);
      if (plan) plan.secret = undefined;
      plans.delete(session.rootOperationId);
    },
  };
}
