// This provider has its own narrow SDK surface. In particular, a lazy SDK
// namespace must not retain the full memory/Gateway facade.
import { callHost } from "shoggoth-memory-host";
import { openAICompatibleEmbeddingProviderAdapter } from "upstream:src/plugins/openai-compatible-embedding-provider.ts";
export const getEmbeddingProvider = (id: string, config: unknown) => id === "openai-compatible"
  ? openAICompatibleEmbeddingProviderAdapter : callHost("getEmbeddingProvider", id, config);
export const resolveStateDir = () => callHost("resolveStateDir");
export { createAsyncLock } from "upstream:src/plugin-sdk/async-lock-runtime.ts";
export { ARCHIVE_LIMIT_ERROR_CODE, ArchiveLimitError, extractArchive } from "upstream:src/infra/archive.ts";
export { toErrorObject } from "upstream:src/infra/errors.ts";
export { normalizeOptionalString } from "upstream:packages/normalization-core/src/string-coerce.ts";
export { asOptionalRecord } from "upstream:packages/normalization-core/src/record-coerce.ts";
export { readProviderJsonResponse, readProviderTextResponse } from "./embedding-provider-http.ts";
export { fetchConfiguredLocalOriginWithSsrFGuard } from "upstream:src/infra/net/fetch-guard.ts";
