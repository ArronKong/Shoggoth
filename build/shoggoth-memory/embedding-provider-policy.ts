// Product owns credentials, attribution and diagnostics. These original plugin
// hooks must not discover another application's registry, keys or log settings.
export const debugEmbeddingsLog = () => {};
export const resolveProviderRequestHeaders = () => undefined;
export const classifyProviderFailoverSignalWithPlugin = () => undefined;
export function getProviderEnvVarsCore(): never {
  throw Object.assign(new Error("Memory provider requires a Service credential"), { code: "MEMORY_EMBEDDING_CREDENTIAL_REQUIRED" });
}
