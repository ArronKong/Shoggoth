// The production Host grants this process a session-specific, local-only
// projection endpoint. It never sends provider headers to the endpoint.
const MAX_BYTES = 64 * 1024 * 1024;
export function installSecretProjection(pi, endpoint = process.env.SHOGGOTH_PI_SECRET_PROJECTION) {
  if (!endpoint) return;
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{64}$/u.test(endpoint)) {
    throw new Error("SECRET_MODEL_ROUTE_INVALID");
  }
  pi.on("before_provider_request", async event => {
    try {
      const body = JSON.stringify(event.payload);
      if (!body || Buffer.byteLength(body) > MAX_BYTES) throw new Error("SECRET_MODEL_INPUT_INVALID");
      const response = await fetch(`${endpoint}/project`, { method: "POST", redirect: "error",
        headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error("SECRET_MODEL_PROJECTION_UNAVAILABLE");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_BYTES) throw new Error("SECRET_MODEL_INPUT_INVALID");
      const safe = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (!safe || typeof safe !== "object" || Array.isArray(safe)) throw new Error("SECRET_MODEL_INPUT_INVALID");
      return safe;
    } catch {
      // Pi 1.3.0 logs and ignores an exception from this hook, then sends the
      // original payload. End only this owned worker synchronously instead.
      // The Host reconciles already completed tools; it never retries the turn.
      process.stderr.write("SECRET_MODEL_PROJECTION_UNAVAILABLE\n");
      process.exit(78);
    }
  });
}
export default function secretProjectionExtension(pi) { installSecretProjection(pi); }
