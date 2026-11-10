"use strict";

const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");

const MAX_BYTES = 16 * 1024;
const MAX_RECORDS = 32;
const RECENT_METHODS = 6;
const METHOD = /^[a-z][A-Za-z0-9._]{0,63}$/u;

function normalizeRecord(value) {
  if (!value || ![value.timeMs, value.blockedMs].every(number => Number.isSafeInteger(number) && number >= 0)
    || !Array.isArray(value.recentMethods) || value.recentMethods.length > RECENT_METHODS
    || !value.recentMethods.every(method => typeof method === "string" && METHOD.test(method))) return null;
  const samples = Array.isArray(value.samples) ? value.samples.slice(0, 6).flatMap(sample => {
    if (!Number.isSafeInteger(sample?.count) || sample.count < 1 || !Array.isArray(sample.frames)) return [];
    const frames = sample.frames.slice(0, 4).filter(frame => frame
      && /^(?:agent-service|core)\/[a-z0-9/-]+\.(?:js|cjs)$/u.test(frame.file || "")
      && Number.isSafeInteger(frame.line) && frame.line > 0 && Number.isSafeInteger(frame.column) && frame.column > 0)
      .map(({ file, line, column }) => ({ file, line, column }));
    return frames.length ? [{ count: sample.count, frames }] : [];
  }) : [];
  return { timeMs: value.timeMs, blockedMs: value.blockedMs, recentMethods: [...value.recentMethods],
    ...(samples.length ? { samples } : {}) };
}

// Bounded support record of Service loop stalls. Only fixed protocol method
// names are kept: no request body, identifier, path or user text.
function recordServiceStall({ paths, record }) {
  try {
    const normalized = normalizeRecord(record);
    if (!normalized || !path.isAbsolute(paths?.runtimeDir || "") || !path.isAbsolute(paths?.trustedRoot || "")) return false;
    const target = path.join(paths.runtimeDir, "service-stall-diagnostics.json");
    let records = [];
    try {
      const previous = JSON.parse(readPrivateFile(target, { maxBytes: MAX_BYTES }).toString("utf8"));
      if (previous?.version !== 1 || !Array.isArray(previous.records)) return false;
      records = previous.records.slice(-(MAX_RECORDS - 1)).map(normalizeRecord).filter(Boolean);
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    records.push(normalized);
    let body = `${JSON.stringify({ version: 1, records })}\n`;
    while (Buffer.byteLength(body) > MAX_BYTES && records.length > 1) {
      records.shift(); body = `${JSON.stringify({ version: 1, records })}\n`;
    }
    if (Buffer.byteLength(body) > MAX_BYTES) return false;
    atomicWritePrivateFile(target, body, { trustedRoot: paths.trustedRoot });
    return true;
  } catch {
    // Diagnostics never change Service behavior.
    return false;
  }
}

// A timer that should fire every intervalMs fires late by however long the
// loop was blocked. Health probes time out at 1–3s, so a block at or above
// thresholdMs is what the App experiences as a lost connection.
function createServiceStallMonitor({ paths, thresholdMs = 1_000, intervalMs = 100,
  monotonicNow = () => performance.now(), now = Date.now, record = recordServiceStall,
  sampler = require("./service-stall-sampler").createStallSampler() } = {}) {
  let timer = null, expected = 0, generation = 0;
  const recent = [];
  const tick = () => {
    const current = monotonicNow(), blockedMs = Math.round(current - expected);
    expected = current + intervalMs;
    if (blockedMs < thresholdMs) return;
    const recentMethods = [...recent];
    recent.length = 0;
    // Write after this turn so the record itself never extends the stall.
    const timeMs = now(), observedGeneration = generation;
    void sampler.capture(blockedMs + intervalMs).then(samples => {
      if (observedGeneration !== generation) return;
      setImmediate(() => {
        if (observedGeneration === generation) record({ paths, record: { timeMs, blockedMs, recentMethods, samples } });
      }).unref();
    }).catch(() => {});
  };
  return {
    start() {
      if (timer) return;
      generation++;
      void sampler.start();
      expected = monotonicNow() + intervalMs;
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    stop() { generation++; if (timer) clearInterval(timer); timer = null; sampler.stop(); },
    noteMethod(method) {
      const name = typeof method === "string" && METHOD.test(method) ? method : "other";
      const index = recent.indexOf(name);
      if (index !== -1) recent.splice(index, 1);
      recent.push(name);
      if (recent.length > RECENT_METHODS) recent.shift();
    },
  };
}

module.exports = { createServiceStallMonitor, recordServiceStall };
