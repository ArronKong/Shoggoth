// Credentials are resolved by the Product Service and passed only in private
// provider create options. Never discover CLI homes, environment keys or OAuth.
export async function resolveApiKeyForProvider(): Promise<never> {
  throw Object.assign(new Error("Memory provider requires a Service credential"), { code: "MEMORY_EMBEDDING_CREDENTIAL_REQUIRED" });
}
export function requireApiKey(): never {
  throw Object.assign(new Error("Memory provider requires a Service credential"), { code: "MEMORY_EMBEDDING_CREDENTIAL_REQUIRED" });
}
export const collectProviderApiKeysForExecution = requireApiKey;
export const resolveConfiguredSecretInputString = requireApiKey;
// Local Ollama permits no authentication. Absence is not permission to discover
// ambient API keys; the Service must supply every real credential explicitly.
export const resolveEnvApiKey = () => undefined;
