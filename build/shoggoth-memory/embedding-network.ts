import { fetchWithSsrFGuard as guardedFetch } from "upstream:src/infra/net/fetch-guard.ts";
import { memoryEmbeddingExecutionSignal, assertMemoryEmbeddingExecutionCurrent } from "./embedding-execution.ts";

export async function fetchWithSsrFGuard(params: Parameters<typeof guardedFetch>[0]) {
  const result = await guardedFetch({ ...params, signal: memoryEmbeddingExecutionSignal(params.signal ?? params.init?.signal) });
  try { assertMemoryEmbeddingExecutionCurrent(); return result; }
  catch (error) {
    try { await result.response.body?.cancel(); } catch {}
    try { await result.release(); } catch {}
    throw error;
  }
}
export { shouldUseEnvHttpProxyForUrl } from "upstream:src/infra/net/proxy-env.ts";
export { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "upstream:src/infra/net/ssrf.ts";
// Provider response bodies may reflect both credentials and memory text. Keep
// HTTP status for diagnosis but never pass upstream response text to the UI.
export async function createProviderHttpError(response: Response) {
  try { await response.body?.cancel(); } catch {}
  return Object.assign(new Error("Memory embedding HTTP request failed"), {
    code: "MEMORY_EMBEDDING_HTTP_FAILED", status: response.status,
  });
}
