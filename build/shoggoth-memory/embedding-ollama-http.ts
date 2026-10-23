import { readProviderResponseErrorText as readBoundedError } from "./embedding-provider-http.ts";
export { readProviderJsonResponse } from "./embedding-provider-http.ts";

// Ollama embeds this text directly into its thrown Error. Preserve its original
// bounded reader and resource release, but discard reflected memory content.
export async function readProviderResponseErrorText(...args: Parameters<typeof readBoundedError>) {
  await readBoundedError(...args);
  return "response body omitted";
}
