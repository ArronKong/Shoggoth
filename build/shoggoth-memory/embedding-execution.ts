import { AsyncLocalStorage } from "node:async_hooks";
import { sleepWithAbort as sleep } from "upstream:packages/retry/src/index.ts";
import { withGuardedFetchRequestAuthority } from "upstream:src/infra/net/fetch-request-authority.ts";

type Execution = { signal?: AbortSignal; assertCurrent: () => void; assertRequestCurrent?: () => void; active: boolean; parent?: Execution };
const executions = new AsyncLocalStorage<Execution>();

export function assertMemoryEmbeddingExecutionCurrent() {
  for (let scope = executions.getStore(); scope; scope = scope.parent) {
    if (!scope.active) throw Object.assign(new Error("Memory embedding operation has ended"), { code: "MEMORY_EMBEDDING_CANCELLED" });
    scope.signal?.throwIfAborted();
    scope.assertCurrent();
  }
}

export function memoryEmbeddingExecutionSignal(signal?: AbortSignal | null) {
  assertMemoryEmbeddingExecutionCurrent();
  const owned = executions.getStore()?.signal;
  return owned && signal && owned !== signal ? AbortSignal.any([owned, signal]) : owned ?? signal ?? undefined;
}

export function assertMemoryEmbeddingRequestCurrent() {
  assertMemoryEmbeddingExecutionCurrent();
  for (let scope = executions.getStore(); scope; scope = scope.parent) scope.assertRequestCurrent?.();
}

export async function withMemoryEmbeddingExecution<T>(
  input: Omit<Execution, "active">, action: () => Promise<T>,
): Promise<T> {
  const parent = executions.getStore();
  const signal = parent?.signal && input.signal && parent.signal !== input.signal
    ? AbortSignal.any([parent.signal, input.signal]) : input.signal ?? parent?.signal;
  const scope = { ...input, signal, parent, active: true };
  return executions.run(scope, () => withGuardedFetchRequestAuthority(assertMemoryEmbeddingExecutionCurrent, async () => {
    try {
      assertMemoryEmbeddingExecutionCurrent();
      const result = await action();
      assertMemoryEmbeddingExecutionCurrent();
      return result;
    }
    finally { scope.active = false; }
  }, assertMemoryEmbeddingRequestCurrent));
}

// The original retry and polling policies still choose the delay. The host
// contributes the invocation's cancellation signal, including index shutdown.
export async function sleepWithAbort(ms: number, signal?: AbortSignal, options?: Parameters<typeof sleep>[2]) {
  await sleep(ms, memoryEmbeddingExecutionSignal(signal), options);
  assertMemoryEmbeddingExecutionCurrent();
}
