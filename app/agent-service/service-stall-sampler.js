"use strict";

const inspector = require("node:inspector");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const APP_ROOT = path.resolve(__dirname, "..");

function sourceLocation(frame) {
  try {
    const file = path.relative(APP_ROOT, frame.url.startsWith("file:") ? fileURLToPath(frame.url) : frame.url);
    if (!/^(?:agent-service|core)\/[a-z0-9/-]+\.(?:js|cjs)$/u.test(file)
      || !Number.isSafeInteger(frame.lineNumber) || frame.lineNumber < 0
      || !Number.isSafeInteger(frame.columnNumber) || frame.columnNumber < 0) return null;
    return { file, line: frame.lineNumber + 1, column: frame.columnNumber + 1 };
  } catch { return null; }
}

// Only shipped source coordinates survive. Never serialize a CPU profile,
// function name, eval source, absolute path, argument or user workspace frame.
function projectSamples(profile, { durationMs, endDelayMs = 0 }) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node])), parents = new Map(), counts = new Map();
  for (const node of nodes.values()) for (const child of node.children || []) parents.set(child, node.id);
  const end = profile.endTime - endDelayMs * 1000, start = end - durationMs * 1000;
  let at = profile.startTime;
  for (let i = 0; i < (profile.samples?.length || 0); i++) {
    at += profile.timeDeltas[i] || 0;
    if (at < start || at > end) continue;
    const frames = [], seen = new Set(); let id = profile.samples[i];
    while (nodes.has(id) && !seen.has(id) && frames.length < 4) {
      seen.add(id);
      const frame = sourceLocation(nodes.get(id).callFrame);
      if (frame) frames.push(frame);
      id = parents.get(id);
    }
    if (!frames.length) continue;
    const key = JSON.stringify(frames), row = counts.get(key) || { frames, count: 0 };
    row.count++; counts.set(key, row);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 6);
}

// V8 samples while JavaScript is blocked. A stack captured by the timer after
// the block would only show the timer. Rotate every 30s to bound profiler data.
function createStallSampler({ Session = inspector.Session, rotationMs = 30_000 } = {}) {
  let session = null, running = false, timer = null, flight = Promise.resolve(), epoch = 0;
  const post = (method, params, generation) => new Promise((resolve, reject) => {
    if (!session || !running || generation !== epoch) return reject(new Error("Profiler closed"));
    session.post(method, params || {}, (error, result) => error || generation !== epoch
      ? reject(error || new Error("Profiler closed")) : resolve(result));
  });
  const stop = () => {
    running = false; epoch++; clearInterval(timer); timer = null;
    const current = session; session = null;
    try { current?.disconnect(); } catch {}
  };
  const capture = (durationMs = 0) => {
    const observedAt = performance.now(), generation = epoch;
    const work = flight.then(async () => {
      if (!running || !session || generation !== epoch) return [];
      const { profile } = await post("Profiler.stop", {}, generation);
      const endDelayMs = performance.now() - observedAt;
      if (running && session && generation === epoch) await post("Profiler.start", {}, generation);
      return durationMs ? projectSamples(profile, { durationMs, endDelayMs }) : [];
    }).catch(() => { if (generation === epoch) stop(); return []; });
    flight = work; return work;
  };
  return {
    start() {
      if (running) return flight;
      try { session = new Session(); session.connect(); running = true; } catch { stop(); return Promise.resolve(); }
      const generation = ++epoch;
      flight = (async () => {
        await post("Profiler.enable", {}, generation); await post("Profiler.setSamplingInterval", { interval: 20_000 }, generation);
        await post("Profiler.start", {}, generation);
        if (!running || generation !== epoch) return;
        timer = setInterval(() => { void capture(); }, rotationMs); timer.unref?.();
      })().catch(() => { if (generation === epoch) stop(); });
      return flight;
    }, capture, stop,
  };
}
module.exports = { createStallSampler, projectSamples };
