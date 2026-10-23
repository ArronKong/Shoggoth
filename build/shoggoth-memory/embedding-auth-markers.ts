import manifest from "upstream:extensions/ollama/openclaw.plugin.json";

// Only Ollama calls this facade. Its checked-in manifest supplies marker names;
// neither the user's environment values nor a global plugin registry is read.
export const listOpenClawPluginManifestMetadata = () => [{ origin: "bundled", manifest }];
export const listKnownProviderEnvApiKeyNames = () => [...new Set(manifest.setup.providers.flatMap(provider => provider.envVars))];
