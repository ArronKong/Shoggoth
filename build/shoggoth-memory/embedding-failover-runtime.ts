// Failover consumes only these original pure helpers, not the AI runtime barrel
// that can discover provider transports or environment credentials.
export { matchesContextOverflowMessage } from "upstream:packages/ai/src/utils/overflow.ts";
export { inspectTlsCertificateError } from "upstream:packages/ai/src/utils/tls-certificate-errors.ts";
