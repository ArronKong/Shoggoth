import type { EndpointMutationOutcome, EndpointMutationSession, EndpointMutationStep } from "./endpoint-controller";

/** 目录读回未匹配不能证明配置已写入；只按服务端确认的步骤解释恢复状态。 */
export function endpointMutationNotice(outcome: EndpointMutationOutcome):
  "syncPending" | "partiallyApplied" | "preflightBlocked" | "writeUnconfirmed" {
  if (outcome.status === "applied") return "syncPending";
  if (outcome.steps.some((step) => step.status === "applied")) return "partiallyApplied";
  if (outcome.status === "blocked" && outcome.stage === "preflight") return "preflightBlocked";
  return "writeUnconfirmed";
}

export interface EndpointMutationState {
  rootOperationId: string;
  backend: string;
  kind: EndpointMutationSession["kind"];
  requestsStarted: number;
  phase: "editable" | "running" | "recoverable" | "synced";
  emittedActivationKinds: string[];
  steps: EndpointMutationStep[];
}

export type EndpointMutationAction =
  | { type: "request_started"; operationId: string }
  | { type: "phase_result"; step: EndpointMutationStep; zeroWrite?: boolean }
  | { type: "request_lost"; step: EndpointMutationStep }
  | { type: "snapshot_refreshed"; synced: boolean }
  | { type: "retry" }
  | { type: "zero_write_unlock" }
  | { type: "activation_emitted"; kind: string };

export function createEndpointMutationState(
  rootOperationId: string,
  backend: string,
  kind: EndpointMutationSession["kind"],
): EndpointMutationState {
  return {
    rootOperationId,
    backend,
    kind,
    requestsStarted: 0,
    phase: "editable",
    emittedActivationKinds: [],
    steps: [],
  };
}

export function reduceEndpointMutationState(
  state: EndpointMutationState,
  action: EndpointMutationAction,
): EndpointMutationState {
  if (action.type === "request_started") {
    return { ...state, phase: "running", requestsStarted: state.requestsStarted + 1 };
  }
  if (action.type === "activation_emitted") {
    if (state.emittedActivationKinds.includes(action.kind)) return state;
    return {
      ...state,
      emittedActivationKinds: [...state.emittedActivationKinds, action.kind],
    };
  }
  if (action.type === "retry") return { ...state, phase: "running" };
  if (action.type === "zero_write_unlock") return { ...state, phase: "editable" };
  if (action.type === "snapshot_refreshed") {
    return {
      ...state,
      phase: action.synced
        ? "synced"
        : state.phase === "editable"
          ? "editable"
          : "recoverable",
    };
  }
  const step = action.step;
  const index = state.steps.findIndex((item) => item.operationId === step.operationId);
  const steps = [...state.steps];
  if (index === -1) steps.push(step);
  else steps[index] = step;
  return {
    ...state,
    phase: action.type === "request_lost" || !action.zeroWrite ? "recoverable" : "editable",
    steps,
  };
}

export function isEndpointStepApplied(
  state: EndpointMutationState,
  operationId: string,
): boolean {
  return state.steps.some(
    (step) => step.operationId === operationId && step.status === "applied",
  );
}
