// The Shoggoth Service owns the connection/lifetime, not an OpenClaw Gateway.
import { callHost } from "shoggoth-memory-host";
export const memoryCpuProcessEntrypoints = { entryOrigins: "shoggoth-memory-entry-origins" };
export const runMemoryOriginRows = (...args: unknown[]) => callHost("runMemoryOriginRows", ...args);
export const runMemoryOriginExists = (...args: unknown[]) => callHost("runMemoryOriginExists", ...args);
export const runMemoryTombstoneRows = (...args: unknown[]) => callHost("runMemoryTombstoneRows", ...args);
export const runMemoryCuratedCandidates = (...args: unknown[]) => callHost("runMemoryCuratedCandidates", ...args);
export const runMemoryKeywordSearch = (...args: unknown[]) => callHost("runMemoryKeywordSearch", ...args);
export const runMemoryIndexState = (...args: unknown[]) => callHost("runMemoryIndexState", ...args);
export const runMemoryVectorFallback = (...args: unknown[]) => callHost("runMemoryVectorFallback", ...args);
export const runMemoryRecallMetadata = (...args: unknown[]) => callHost("runMemoryRecallMetadata", ...args);
export const runMemoryForgetIndexPlan = (...args: unknown[]) => callHost("runMemoryForgetIndexPlan", ...args);
export const runMemorySourceState = (...args: unknown[]) => callHost("runMemorySourceState", ...args);
export const readMemoryTranscriptStatsInWorker = (...args: unknown[]) => callHost("readMemoryTranscriptStatsInWorker", ...args);
export { prepareMemoryIndexChunks as prepareMemoryIndexInWorker } from "upstream:extensions/memory-core/src/memory/manager-index-preparation.ts";
