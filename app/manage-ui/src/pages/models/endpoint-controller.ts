import {
  deleteCustomEndpoint,
  listCustomEndpoints,
  saveCustomEndpoint,
  validateCustomEndpoint,
} from "../../api/client";
import type {
  CustomEndpoint,
  CustomEndpointInput,
  CustomEndpointsSnapshot,
  CustomEndpointValidation,
  ModelChangeApplyResult,
} from "../../types";

export interface EndpointSafeReference {
  store: string;
  referenceKey?: string;
  scope?: string;
  agent?: string;
  profile?: string;
}

export interface EndpointMutationBlocker {
  code: string;
  scope?: string;
}

export type EndpointMutationStep = {
  operationId: string;
  status: ModelChangeApplyResult["status"];
  code?: string;
  stage?: string;
  blockers?: EndpointMutationBlocker[];
  references?: EndpointSafeReference[];
};

// UI 只消费结构化、安全字段；controller 不把配置正文、密钥或任意后端消息放进恢复视图。
export interface EndpointRecoveryView {
  code: string;
  stage?: string;
  retryable?: boolean;
  locked?: boolean;
  needsSecret?: boolean;
  /** 写后重新读取到的安全公共基线；关闭恢复弹窗再打开时据此进入 edit。 */
  baseline?: CustomEndpoint;
  references?: EndpointSafeReference[];
  blockedRemoval?: {
    operationId: string;
    modelId: string;
  };
}

export type EndpointMutationOutcome = {
  /** 整次用户操作冻结的根 operation id；多阶段 controller 的子步骤另放在 steps。 */
  operationId: string;
  status: ModelChangeApplyResult["status"];
  code?: string;
  stage?: string;
  activation?: ModelChangeApplyResult["activation"];
  sync: "synced" | "pending";
  snapshot?: CustomEndpointsSnapshot;
  steps: EndpointMutationStep[];
  recovery?: EndpointRecoveryView;
};

export type EndpointMutationSession = {
  rootOperationId: string;
  backend: string;
  kind: "create" | "edit" | "delete" | "clear-key";
};

export interface EndpointController {
  readonly backend: string;
  list(signal?: AbortSignal): Promise<CustomEndpointsSnapshot>;
  validate(
    input: CustomEndpointInput,
    signal?: AbortSignal,
  ): Promise<CustomEndpointValidation>;
  save(
    input: CustomEndpointInput,
    session: EndpointMutationSession,
  ): Promise<EndpointMutationOutcome>;
  remove(
    endpoint: CustomEndpoint,
    session: EndpointMutationSession,
    force: boolean,
  ): Promise<EndpointMutationOutcome>;
  revealApiKey?(
    endpoint: CustomEndpoint,
    signal?: AbortSignal,
  ): Promise<string | null>;
  clearApiKey?(
    endpoint: CustomEndpoint,
    session: EndpointMutationSession,
  ): Promise<EndpointMutationOutcome>;
  retry?(
    session: EndpointMutationSession,
    patch?: { apiKey?: string },
  ): Promise<EndpointMutationOutcome>;
  confirmBlockedRemoval?(
    session: EndpointMutationSession,
    childOperationId: string,
  ): Promise<EndpointMutationOutcome>;
  release?(session: EndpointMutationSession): void;
}

export function createEndpointRootOperationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `endpoint-${uuid}`;
  return `endpoint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createEndpointMutationSession(
  backend: string,
  kind: EndpointMutationSession["kind"],
  rootOperationId = createEndpointRootOperationId(),
): EndpointMutationSession {
  return { rootOperationId, backend, kind };
}

export function isEndpointMutationComplete(
  outcome: EndpointMutationOutcome,
): outcome is EndpointMutationOutcome & {
  status: "applied";
  sync: "synced";
  snapshot: CustomEndpointsSnapshot;
} {
  return (
    outcome.status === "applied"
    && outcome.sync === "synced"
    && outcome.snapshot !== undefined
  );
}

function withAbortSignal<T>(
  signal: AbortSignal | undefined,
  request: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const pending = request();
  if (!signal) return pending;

  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function appliedSnapshot(
  session: EndpointMutationSession,
  snapshot: CustomEndpointsSnapshot,
): EndpointMutationOutcome {
  return {
    operationId: session.rootOperationId,
    status: "applied",
    stage: "commit",
    sync: "synced",
    snapshot,
    steps: [],
  };
}

export function createHermesEndpointController(backend: string): EndpointController {
  return {
    backend,
    list: (signal) =>
      withAbortSignal(signal, () => listCustomEndpoints(backend)),
    validate: (input, signal) =>
      withAbortSignal(signal, () =>
        validateCustomEndpoint(backend, undefined, input)),
    async save(input, session) {
      const snapshot = await saveCustomEndpoint(backend, undefined, input);
      return appliedSnapshot(session, snapshot);
    },
    async remove(endpoint, session, force) {
      // Hermes 端点 API 本身是跨 profile 原子删除，没有 coordinator force 语义。
      void force;
      const snapshot = await deleteCustomEndpoint(backend, undefined, endpoint.id);
      return appliedSnapshot(session, snapshot);
    },
  };
}
