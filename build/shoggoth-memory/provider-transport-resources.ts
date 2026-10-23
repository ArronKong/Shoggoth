import { callHost } from "shoggoth-memory-host";

// The native local-service supervisor only uses header sentinel unwrapping.
// Its module's additional model-carrier helpers remain Product resources,
// rather than importing global provider/plugin discovery into this bundle.
export const attachModelProviderRequestTransport = (...args: unknown[]) =>
  callHost("attachModelProviderRequestTransport", ...args);
export const getModelProviderRequestTransport = (...args: unknown[]) =>
  callHost("getModelProviderRequestTransport", ...args);
