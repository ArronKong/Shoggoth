"use strict";

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const p = require("./group-runtime-host-protocol");
const negotiatedVersions = new Map();

/** Paired host only: TLS verification stays enabled, redirects are refused, credentials stay in headers. */
function requestGroupHost(peer, method, params, authority = null, { timeoutMs = method === "group.external.metadata" ? 2000 : method === "host.models" ? 25_000 : 20_000, protocolVersion = null } = {}) {
  if (!p.validPeer(peer)) return Promise.reject(Object.assign(new Error("GROUP_HOST_CONFIG_INVALID"), { code: "GROUP_HOST_CONFIG_INVALID" }));
  const version = protocolVersion ?? (method === "host.capabilities" ? p.VERSION : negotiatedVersions.get(peer.hostId)) ?? p.VERSION;
  if (version === 1 && method === "group.external.activity") return Promise.reject(Object.assign(new Error("GROUP_HOST_TOOL_UNSUPPORTED"), { code: "GROUP_HOST_TOOL_UNSUPPORTED" }));
  const frame = { version, id: crypto.randomUUID(), hostId: peer.hostId, authority, method, params };
  if (!p.validHostRequest(frame)) return Promise.reject(Object.assign(new Error("GROUP_HOST_REQUEST_INVALID"), { code: "GROUP_HOST_REQUEST_INVALID" }));
  const body = Buffer.from(JSON.stringify(frame));
  if (body.length > p.FRAME_BYTES) return Promise.reject(Object.assign(new Error("GROUP_HOST_REQUEST_INVALID"), { code: "GROUP_HOST_REQUEST_INVALID" }));
  const url = new URL("/group-host/rpc", peer.baseUrl);
  const pending = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; if (error) reject(error); else resolve(value); };
    const request = (url.protocol === "https:" ? https : http).request(url, { method: "POST", headers: {
      authorization: `Bearer ${peer.token}`, "content-type": "application/json", "content-length": body.length,
    } }, response => {
      let size = 0; const chunks = [];
      response.on("data", chunk => { size += chunk.length; if (size > p.FRAME_BYTES) request.destroy(new Error("GROUP_HOST_RESPONSE_INVALID")); else chunks.push(chunk); });
      response.on("error", error => finish(error));
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) p.fail(response.statusCode === 401 ? "GROUP_HOST_AUTH_FAILED" : "GROUP_HOST_UNAVAILABLE");
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!p.exact(value, ["version", "id", "hostId", "ok", value.ok ? "result" : "error"])
            || (value.version !== frame.version && !(value.ok === false && value.version === 1
              && value.error?.code === "GROUP_HOST_REQUEST_INVALID"))
            || value.id !== frame.id || value.hostId !== peer.hostId) p.fail("GROUP_HOST_IDENTITY_MISMATCH");
          if (value.ok !== true) p.fail(typeof value.error?.code === "string" && (/^GROUP_HOST_[A-Z_]+$/u.test(value.error.code)
            || require("./group-member-model").isModelError(value.error.code))
            ? value.error.code : "GROUP_HOST_UNAVAILABLE");
          if (!p.validHostResult(method, value.result)) p.fail("GROUP_HOST_RESPONSE_INVALID");
          if (method === "host.capabilities") {
            if (negotiatedVersions.size >= 512) negotiatedVersions.delete(negotiatedVersions.keys().next().value);
            negotiatedVersions.set(peer.hostId, value.result.version);
          }
          finish(null, value.result);
        } catch (error) { finish(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error("GROUP_HOST_TIMEOUT"), { code: "GROUP_HOST_TIMEOUT" })));
    request.on("error", error => finish(error));
    request.end(body);
  });
  return pending.catch(error => {
    // Only an explicit parser rejection proves that no execution was admitted.
    // Timeouts, disconnects and uncertain responses must never retry a mutation.
    if (frame.version === p.VERSION && error.code === "GROUP_HOST_REQUEST_INVALID") {
      negotiatedVersions.set(peer.hostId, 1);
      return requestGroupHost(peer, method, params, authority, { timeoutMs, protocolVersion: 1 });
    }
    throw error;
  });
}

module.exports = { requestGroupHost };
