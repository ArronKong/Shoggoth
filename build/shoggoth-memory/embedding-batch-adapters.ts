import { openAiMemoryEmbeddingProviderAdapter as openAi } from "upstream:extensions/openai/memory-embedding-adapter.ts";
import { geminiMemoryEmbeddingProviderAdapter as gemini } from "upstream:extensions/google/memory-embedding-adapter.ts";
import { voyageMemoryEmbeddingProviderAdapter as voyage } from "upstream:extensions/voyage/memory-embedding-adapter.ts";
import { EmbeddingBatchUnavailableError, isEmbeddingBatchUnavailableError } from "upstream:packages/memory-host-sdk/src/host/batch-error-utils.ts";

// Native runners keep their upload, splitting, retry, polling and result rules.
// Their errors can contain reflected memory from status/error/output files; only
// the control classification leaves this boundary, never provider text or causes.
function privateBatchAdapter(adapter: typeof openAi) {
  return { ...adapter, create: async (options: Parameters<typeof adapter.create>[0]) => {
    const created = await adapter.create(options), batchEmbed = created.runtime?.batchEmbed;
    if (!batchEmbed) return created;
    return { ...created, runtime: { ...created.runtime!, batchEmbed: async (batch: Parameters<typeof batchEmbed>[0]) => {
      try { return await batchEmbed({ ...batch, debug: undefined }); }
      catch (error) {
        if (isEmbeddingBatchUnavailableError(error)) throw new EmbeddingBatchUnavailableError("Memory embedding batch is unavailable");
        const timedOut = error instanceof Error && /timed out/i.test(error.message);
        const safe = Object.assign(new Error(timedOut ? "Memory embedding batch timed out" : "Memory embedding batch failed"), {
          code: "MEMORY_EMBEDDING_BATCH_FAILED",
        });
        const fields = error as { status?: unknown; retryAfterMs?: unknown } | null;
        if (Number.isInteger(fields?.status) && Number(fields?.status) >= 100 && Number(fields?.status) <= 599) Object.assign(safe, { status: fields?.status });
        if (Number.isSafeInteger(fields?.retryAfterMs) && Number(fields?.retryAfterMs) >= 0) Object.assign(safe, { retryAfterMs: fields?.retryAfterMs });
        throw safe;
      }
    } } };
  } };
}

export const openAiMemoryEmbeddingProviderAdapter = privateBatchAdapter(openAi);
export const geminiMemoryEmbeddingProviderAdapter = privateBatchAdapter(gemini);
export const voyageMemoryEmbeddingProviderAdapter = privateBatchAdapter(voyage);
