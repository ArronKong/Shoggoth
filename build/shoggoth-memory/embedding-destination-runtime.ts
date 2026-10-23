// The generic HTTP adapter lazily imports only these pure destination helpers.
// Do not load the SDK barrel's auth-store listeners or provider discovery.
export { embeddingProviderOwnsDestination, resolveEmbeddingEndpointUrl } from "upstream:packages/memory-host-sdk/src/host/embeddings-remote-client.ts";
