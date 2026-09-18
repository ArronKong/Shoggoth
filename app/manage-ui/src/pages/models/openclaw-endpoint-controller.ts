import {
  addModelConfig,
  applyModelBatch,
  listCustomEndpoints,
  removeModelConfig,
  removeModelProvider,
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
} from "../../types";
import {
  type EndpointController,
  type EndpointMutationOutcome,
  type EndpointMutationSession,
  type EndpointMutationStep,
  type EndpointSafeReference,
} from "./endpoint-controller";
import {
  createEndpointMutationState,
  reduceEndpointMutationState,
  type EndpointMutationState,
} from "./endpoint-mutation-state";

export interface OpenClawEndpointDependencies {
  listCustomEndpoints(backend: string): Promise<CustomEndpointsSnapshot>;
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
};

type FrozenPlan = {
  readonly session: EndpointMutationSession;
  readonly source: CustomEndpoint | null;
  readonly target: Omit<CustomEndpointInput, "apiKey">;
  secret?: string;
  state: EndpointMutationState;
  pendingActivation?: ModelChangeApplyResult["activation"];
  blockedRemoval?: { operationId: string; modelId: string };
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
  };
}

function sameModels(endpoint: CustomEndpoint | undefined, expected: string[]): boolean {
  if (!endpoint) return false;
  return endpoint.models.length === expected.length
    && endpoint.models.every((model, index) => model === expected[index]);
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
  const plans = new Map<string, FrozenPlan>();

  const load = async () => {
    const snapshot = await dependencies.listCustomEndpoints(backend);
    lastSnapshot = snapshot;
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
    const source = lastSnapshot?.endpoints.find((endpoint) => endpoint.id === id) ?? sourceFallback ?? null;
    const { apiKey, ...publicInput } = input;
    const plan: FrozenPlan = {
      session: { ...session },
      // A retry must replay the original operation type and model diff. Do not
      // retain caller-owned arrays or replace this source with a write readback.
      source: source ? { ...source, models: [...source.models],
        ...(source.profiles ? { profiles: [...source.profiles] } : {}),
        ...(source.activeIn ? { activeIn: [...source.activeIn] } : {}),
      } : null,
      target: { ...publicInput, id, model: models[0] ?? "", models },
      ...(apiKey?.trim() ? { secret: apiKey.trim() } : {}),
      state: createEndpointMutationState(session.rootOperationId, backend, session.kind),
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
    plan.state = reduceEndpointMutationState(plan.state, { type: "request_started", operationId });
    try {
      const result = await request();
      const step = stepFromResult(operationId, result);
      plan.state = reduceEndpointMutationState(plan.state, { type: "phase_result", step });
      if (step.status === "applied") emitActivation(plan, result.activation);
      return step;
    } catch (error) {
      const step = stepFromError(operationId, error);
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
      stage: step?.stage ?? (sync === "synced" ? "snapshot" : "recovery"),
      ...(activation ? { activation } : {}),
      sync,
      ...(snapshot ? { snapshot } : {}),
      steps: plan.state.steps,
      ...(status !== "applied" || sync === "pending" ? {
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
      const snapshot = await load();
      const current = snapshot.endpoints.find((endpoint) => endpoint.id === plan.target.id);
      if (current) {
        // This is display/recovery context only. Public config (including
        // hasApiKey) cannot prove that the requested secret or mutation applied.
        plan.baseline = current;
      }
      const synced = predicate(snapshot);
      plan.state = reduceEndpointMutationState(plan.state, { type: "snapshot_refreshed", synced });
      const next = outcome(
        plan,
        synced && (step === null || snapshotProvesApplied) ? null : step,
        synced ? "synced" : "pending",
        snapshot,
        synced ? undefined : "snapshot_mismatch",
      );
      if (plan.state.phase === "editable" && !plan.blockedRemoval) {
        plan.secret = undefined;
        plans.delete(plan.session.rootOperationId);
      }
      return next;
    } catch {
      plan.state = reduceEndpointMutationState(plan.state, {
        type: "snapshot_refreshed",
        synced: false,
      });
      const next = outcome(plan, step, "pending", undefined, "snapshot_unavailable");
      if (plan.state.phase === "editable" && !plan.blockedRemoval) {
        plan.secret = undefined;
        plans.delete(plan.session.rootOperationId);
      }
      return next;
    }
  };

  const executeSave = async (plan: FrozenPlan): Promise<EndpointMutationOutcome> => {
    const id = plan.target.id ?? "";
    const models = plan.target.models ?? [];
    const complete = (snapshot: CustomEndpointsSnapshot) =>
      endpointMatches(plan, snapshot.endpoints.find((endpoint) => endpoint.id === id));

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

      if (models.length > 1) {
        const addOperation = `${plan.session.rootOperationId}:add`;
        const addStep = await runStep(plan, addOperation, () =>
          dependencies.applyModelBatch(
            backend,
            models.slice(1).map((model) => ({ providerKey: id, model: { id: model } })),
            addOperation,
          ));
        if (addStep.status !== "applied") return reconcile(plan, addStep, complete);
      }
    } else {
      const patch: Parameters<typeof updateModelProvider>[2] = {};
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
          dependencies.updateModelProvider(backend, id, patch, providerOperation));
        if (providerStep.status !== "applied") return reconcile(plan, providerStep, complete);
      }

      const additions = models.filter((model) => !plan.source?.models.includes(model));
      if (additions.length > 0) {
        const addOperation = `${plan.session.rootOperationId}:add`;
        const addStep = await runStep(plan, addOperation, () =>
          dependencies.applyModelBatch(
            backend,
            additions.map((model) => ({ providerKey: id, model: { id: model } })),
            addOperation,
          ));
        if (addStep.status !== "applied") return reconcile(plan, addStep, complete);
      }

      const deletions = plan.source.models.filter((model) => !models.includes(model));
      for (const [index, model] of deletions.entries()) {
        const deleteOperation = `${plan.session.rootOperationId}:delete:${index}`;
        const deleteStep = await runStep(plan, deleteOperation, () =>
          dependencies.removeModelConfig(backend, id, model, deleteOperation, false));
        if (deleteStep.status !== "applied") {
          const blockerCodes = (deleteStep.blockers ?? []).map((blocker) => blocker.code);
          if (
            (deleteStep.code === "references_exist" || blockerCodes.includes("references_exist"))
            && blockerCodes.every((code) => code === "references_exist")
          ) {
            plan.blockedRemoval = { operationId: deleteOperation, modelId: model };
          }
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
      dependencies.updateModelProvider(backend, endpoint.id, { clearApiKey: true }, operationId));
    return reconcile(plan, step.status === "applied" ? null : step, (snapshot) => {
      const current = snapshot.endpoints.find((item) => item.id === endpoint.id);
      return Boolean(current && !current.hasApiKey);
    }, true);
  };

  return {
    backend,
    list: (signal) => abortable(signal, load),
    validate: (input, signal) => abortable(
      signal,
      () => dependencies.validateCustomEndpoint(backend, undefined, input),
    ),
    save(input, session) {
      return executeSave(planFor(input, session));
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
      const { modelId } = plan.blockedRemoval;
      const step = await runStep(plan, childOperationId, () =>
        dependencies.removeModelConfig(
          backend,
          plan.target.id ?? "",
          modelId,
          childOperationId,
          true,
        ));
      if (step.status !== "applied") {
        return reconcile(plan, step, () => false);
      }
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
    async clearApiKey(endpoint, session) {
      const plan = planFor({
        id: endpoint.id,
        name: endpoint.name,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        models: endpoint.models,
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
