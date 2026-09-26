"use strict";

// This is a display hint, never an execution capability. Opening the App still
// verifies its durable call, conversation and current Grants in the Service.
function pluginAppCallId(value) {
  return typeof value === "string" && /^runtime-[a-f0-9]{64}$/u.test(value) ? value : null;
}
function extractPluginAppCallId(value) {
  let remaining = 8 * 1024 * 1024, nodes = 128;
  const seen = new WeakSet();
  const own = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
  function visit(node, depth = 0) {
    if (depth > 8 || --nodes < 0) return null;
    if (typeof node === "string") {
      if (node.length > remaining) return null;
      remaining -= node.length;
      try { return visit(JSON.parse(node), depth + 1); } catch { return null; }
    }
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node.slice(0, 64)) { const id = visit(entry, depth + 1); if (id) return id; }
      return null;
    }
    if (Object.getPrototypeOf(node) !== Object.prototype) return null;
    const reference = own(node, "shoggothPluginApp");
    if (reference && typeof reference === "object" && Object.getPrototypeOf(reference) === Object.prototype
      && Object.keys(reference).length === 1) {
      const id = pluginAppCallId(own(reference, "callId")); if (id) return id;
    }
    // Only known MCP/native result containers are traversed. Arguments and
    // arbitrary result fields cannot manufacture a reference by accident.
    if (own(node, "type") === "text") {
      const id = visit(own(node, "text"), depth + 1); if (id) return id;
    }
    for (const field of ["result", "structuredContent", "details", "content", "output"]) {
      const nested = own(node, field);
      if (nested !== undefined) { const id = visit(nested, depth + 1); if (id) return id; }
    }
    return null;
  }
  return visit(value);
}
module.exports = { pluginAppCallId, extractPluginAppCallId };
