import { callHost } from "shoggoth-memory-host";
export const resolveAgentConfig = (...args: unknown[]) => callHost("resolveAgentConfig", ...args);
export { requiresClaudeMandatoryAdaptiveThinking } from "upstream:packages/llm-core/src/model-contracts/anthropic.ts";
export { resolveExecModePolicy } from "upstream:src/infra/exec-approvals-core.ts";
export { normalizeOptionalLowercaseString } from "upstream:packages/normalization-core/src/string-coerce.ts";
export { normalizeSortedUniqueTrimmedStringList } from "upstream:packages/normalization-core/src/string-normalization.ts";
