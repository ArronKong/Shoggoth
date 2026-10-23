// Native model downloads lazily load this SDK subpath. Keep that namespace
// narrow so lazy loading cannot initialize global plugin/provider discovery.
export { fetchWithSsrFGuard } from "./embedding-network.ts";
export { ssrfPolicyFromHttpBaseUrlAllowedOrigin, ssrfPolicyFromHttpBaseUrlAllowedHostname } from "upstream:src/infra/net/ssrf.ts";
export { formatErrorMessage } from "upstream:src/infra/errors.ts";
