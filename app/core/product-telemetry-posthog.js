"use strict";

const { LIMITS, isProjectToken, validateTelemetryEvent } = require("./product-telemetry-schema");
const ENDPOINTS = Object.freeze({ us: "https://us.i.posthog.com/batch/", eu: "https://eu.i.posthog.com/batch/" });
const MAX_RESPONSE_BYTES = 2048;

function retryAfterMs(raw, nowMs) {
  if (typeof raw !== "string" || raw.length > 128) return 0;
  const delay = /^\d+(?:\.\d+)?$/u.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - nowMs;
  return Number.isFinite(delay) ? Math.max(0, Math.min(LIMITS.retryMaxMs, Math.ceil(delay))) : 0;
}

async function readAck(response) {
  const reader = response.body?.getReader();
  if (!reader) return false;
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) return false;
      chunks.push(Buffer.from(value));
    }
    // Interrupted body reads propagate to the network retry path. Only a fully
    // received but malformed ACK is a protocol failure that pauses this sender.
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return false; }
  } finally { try { await reader.cancel(); } catch { /* never log the response */ } }
}

function createPostHogTransport({ projectToken, region, fetchImpl = globalThis.fetch, clock = globalThis } = {}) {
  if (!isProjectToken(projectToken) || !Object.hasOwn(ENDPOINTS, region) || typeof fetchImpl !== "function") {
    throw new Error("TELEMETRY_TRANSPORT_UNCONFIGURED");
  }

  async function sendBatch(events, { signal } = {}) {
    if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype
      || Reflect.ownKeys(events).length !== events.length + 1 || events.length === 0 || events.length > LIMITS.batch
      || !events.every(validateTelemetryEvent)) return { kind: "pause", code: "protocol_error" };
    if (signal?.aborted) return { kind: "canceled" };
    // Build our own envelope; neither a renderer nor a disk record can add
    // headers, flags, a destination, credentials or fields around the batch.
    const body = JSON.stringify({ api_key: projectToken, batch: events });
    const controller = new AbortController();
    let settleStop;
    const stopped = new Promise((resolve) => { settleStop = resolve; });
    const onAbort = () => { controller.abort(); settleStop({ kind: "canceled" }); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = clock.setTimeout(() => {
      controller.abort();
      settleStop({ kind: "retry", code: "timeout", retryAfterMs: 0 });
    }, LIMITS.timeoutMs);
    timer?.unref?.();
    try {
      const request = async () => {
        try {
          const response = await fetchImpl(ENDPOINTS[region], {
            method: "POST", headers: { "Content-Type": "application/json" }, body,
            redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal,
          });
          if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
            void response.body?.cancel().catch(() => {});
            return { kind: "retry", code: "http_retry", retryAfterMs: retryAfterMs(response.headers.get("retry-after"), clock.now?.() ?? Date.now()) };
          }
          if (response.status !== 200 || response.redirected) {
            void response.body?.cancel().catch(() => {});
            return { kind: "pause", code: response.status >= 400 && response.status < 500 ? "http_rejected" : "protocol_error" };
          }
          const ack = await readAck(response);
          if (Array.isArray(ack?.quota_limited) && ack.quota_limited.length > 0) return { kind: "pause", code: "quota_limited" };
          // Current Rust CaptureResponse serializes the enum as "Ok". Accept
          // legacy numeric status=1 too; arbitrary 200/HTML is not an ACK.
          return ack && (ack.status === "Ok" || ack.status === 1)
            ? { kind: "ok" } : { kind: "pause", code: "protocol_error" };
        } catch { return { kind: "retry", code: "network", retryAfterMs: 0 }; }
      };
      return await Promise.race([request(), stopped]);
    } finally {
      clock.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
  return { sendBatch };
}

module.exports = { ENDPOINTS, createPostHogTransport, retryAfterMs };
