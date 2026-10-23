// The Service owns global transport settings and diagnostics. Requests carry
// their own timeout; importing the core must not install a Gateway dispatcher.
export const globalUndiciStreamTimeoutMs = undefined;
export const logWarn = () => {};
export const logDebug = () => {};
export const createSubsystemLogger = () => ({ debug() {}, info() {}, warn() {}, error() {} });
// Do not create an OpenClaw debugging proxy or record private memory payloads.
export const prepareHttpCaptureForTransport = () => undefined;
export const resolveDebugProxyFetchTransport = (fetchImpl: typeof fetch) => fetchImpl;
