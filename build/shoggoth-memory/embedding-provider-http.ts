import {
  createProviderHttpError as readProviderHttpError,
  readProviderJsonObjectResponse as readJsonObject,
  readProviderJsonResponse as readJson,
} from "upstream:src/agents/provider-http-errors.ts";

export { readProviderResponseErrorText } from "upstream:src/agents/provider-request-header-redaction.ts";
export { readProviderTextResponse } from "upstream:src/agents/provider-http-errors.ts";

// Keep the original bounded, abortable body reader and Retry-After parsing.
// Only safe transport metadata leaves the Service; bodies may reflect memory.
export async function createProviderHttpError(response: Response, _label: string, options?: Parameters<typeof readProviderHttpError>[2]) {
  const original = await readProviderHttpError(response, "Memory embedding HTTP request failed", options);
  return Object.assign(new Error(`HTTP ${original.status}: Memory embedding request failed`), {
    code: "MEMORY_EMBEDDING_HTTP_FAILED", status: original.status,
    statusCode: original.statusCode, retryAfterMs: original.retryAfterMs,
  });
}

export async function assertOkOrThrowProviderError(response: Response, label: string, options?: Parameters<typeof readProviderHttpError>[2]) {
  if (!response.ok) throw await createProviderHttpError(response, label, options);
}

export function readProviderJsonObjectResponse(response: Response, label: string, options?: Parameters<typeof readJsonObject>[2]) {
  // The original reader drops JSON parser causes for credential-bearing calls.
  // Apply that policy even when a provider omits the optional header argument.
  return readJsonObject(response, label, { ...options, requestHeaders: options?.requestHeaders ?? {} });
}

export function readProviderJsonResponse<T>(response: Response, label: string, options?: Parameters<typeof readJson>[2]) {
  return readJson<T>(response, label, { ...options, requestHeaders: options?.requestHeaders ?? {} });
}
