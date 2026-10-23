// The exported preflight policies only depend on the original fresh-usage
// reader. Provider payload construction and the embedded agent runner are not
// part of this entry point; their unused imports fail closed if ever retained.
export { resolveFreshSessionTotalTokens } from "upstream:src/config/sessions/types.ts";
const unavailable = () => { throw new Error("Embedded compaction runtime is not part of the memory timing entry point"); };
export const resolveAnthropicServerCompactionPlan = unavailable;
export const resolveOpenAIResponsesServerCompactionPlan = unavailable;
export const estimateMessagesTokens = unavailable;
export const resolveModelExtraParamSources = unavailable;
export const normalizeStaticProviderModelId = unavailable;
export const normalizeProviderId = unavailable;
export const findConfiguredProviderModel = unavailable;
export const resolveMergedModelProviderConfig = unavailable;
