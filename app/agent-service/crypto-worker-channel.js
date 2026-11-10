"use strict";

const { cryptoError, MAX_MCP_CRYPTO_REQUEST_BYTES, MAX_SAFE_STORAGE_PAYLOAD_BYTES,
  encodeWorkerRequest, decodeWorkerRequestFrame, validateWorkerGate } = require("./mcp-crypto-protocol");
const MAX_FRAME = Math.max(MAX_MCP_CRYPTO_REQUEST_BYTES + 1024, MAX_SAFE_STORAGE_PAYLOAD_BYTES + 41);

function frame(body) {
  if (!Buffer.isBuffer(body) || !body.length || body.length > MAX_FRAME) throw cryptoError();
  const result = Buffer.allocUnsafe(body.length + 4);
  result.writeUInt32BE(body.length); body.copy(result, 4);
  return result;
}

// A private inherited pipe, one request at a time, with bounded binary frames.
// EOF is a session boundary, never the end of an individual request.
class FrameReader {
  constructor(onFrame, onError) { this.onFrame = onFrame; this.onError = onError; this.bytes = Buffer.alloc(0); this.failed = false; }
  push(chunk) {
    if (this.failed) return;
    try {
      if (!Buffer.isBuffer(chunk) || this.bytes.length + chunk.length > MAX_FRAME + 4) throw cryptoError();
      const bytes = Buffer.concat([this.bytes, chunk]); this.bytes.fill(0); this.bytes = bytes;
      while (this.bytes.length >= 4) {
        const size = this.bytes.readUInt32BE(0);
        if (!size || size > MAX_FRAME) throw cryptoError();
        if (this.bytes.length < size + 4) return;
        const body = Buffer.from(this.bytes.subarray(4, size + 4));
        const rest = Buffer.from(this.bytes.subarray(size + 4)); this.bytes.fill(0); this.bytes = rest;
        try { this.onFrame(body); } finally { body.fill(0); }
      }
    } catch { this.failed = true; this.clear(); this.onError(cryptoError()); }
  }
  clear() { this.bytes.fill(0); this.bytes = Buffer.alloc(0); }
}

function encodeRequest(gate, request, payload, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw cryptoError();
  const header = Buffer.from(JSON.stringify({ sequence, nonce: gate.nonce }) + "\n");
  const inner = encodeWorkerRequest({ gate, request, payload });
  const body = Buffer.concat([header, inner]);
  try { return frame(body); } finally { header.fill(0); inner.fill(0); body.fill(0); }
}
function decodeRequest(body, baseGate, expectedSequence) {
  const newline = body.indexOf(10);
  if (newline < 1 || newline > 256) throw cryptoError();
  let header;
  try { header = JSON.parse(body.subarray(0, newline).toString("utf8")); } catch { throw cryptoError(); }
  if (!header || Object.keys(header).sort().join(",") !== "nonce,sequence" || header.sequence !== expectedSequence) throw cryptoError();
  const gate = validateWorkerGate({ ...baseGate, nonce: header.nonce });
  const decoded = decodeWorkerRequestFrame(body.subarray(newline + 1), gate);
  if (gate.callerRole !== "agent-service" || !["safeStorage.encrypt", "safeStorage.decrypt"].includes(decoded.request.operation)) {
    decoded.payload.fill(0); throw cryptoError();
  }
  return { gate, ...decoded };
}

module.exports = { FrameReader, frame, encodeRequest, decodeRequest, MAX_FRAME };
