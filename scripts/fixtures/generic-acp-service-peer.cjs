"use strict";
// Minimal ACP peer for actual Service lifecycle and isolation stress tests.
// Ignores optional MCP descriptors; the full App fixture covers real Helper.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), readline = require("node:readline");
const audit = path.join(__dirname, "peer-audit.jsonl"), sessions = new Map(), permissions = new Map(); let permissionId = 900000;
const note = value => fs.appendFileSync(audit, JSON.stringify({ pid: process.pid, ppid: process.ppid, at: Date.now(), ...value }) + "\n", { mode: 0o600 });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
function complete(session, frame, token, control) {
  if (control.includes("[ACP_WAIT]")) return;
  const answer = control.includes("[ACP_EMPTY_FINAL]") ? "" : control.includes("[ACP_SILENT_FINAL]") ? "NO_REPLY" : `ACP answer ${token} session=${frame.params.sessionId}`;
  if (answer) {
    send({ method: "session/update", params: { sessionId: frame.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } });
    note({ kind: "first-text", sessionId: frame.params.sessionId, token });
  }
  if (control.includes("[ACP_TEXT_THEN_WAIT]")) return;
  const stopReason = /\[ACP_STOP:(max_tokens|max_turn_requests|refusal)\]/u.exec(control)?.[1] || "end_turn";
  send({ id: frame.id, result: { stopReason } }); note({ kind: "terminal", sessionId: frame.params.sessionId, token, stopReason }); session.prompt = null;
}
note({ kind: "started", home: process.env.HOME });
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  let frame; try { frame = JSON.parse(line); } catch { process.exit(2); }
  if (!frame.method) {
    const pending = permissions.get(frame.id); if (!pending) return; permissions.delete(frame.id);
    const { session, prompt, token, control } = pending;
    note({ kind: "permission-response", sessionId: prompt.params.sessionId, token,
      outcome: frame.result?.outcome?.outcome || null, optionId: frame.result?.outcome?.optionId || null });
    if (session.prompt !== prompt) return;
    const allowed = frame.result?.outcome?.outcome === "selected" && frame.result.outcome.optionId === "controlled-allow-once";
    if (allowed || control.includes("[ACP_IGNORE_DENY]")) {
      if (!allowed) note({ kind: "ignored-deny-still-end-turn", sessionId: prompt.params.sessionId, token, controlledNoOperation: true });
      return complete(session, prompt, token, control);
    }
    send({ id: prompt.id, result: { stopReason: "cancelled" } }); session.prompt = null;
    note({ kind: "terminal", sessionId: prompt.params.sessionId, token, stopReason: "cancelled" }); return;
  }
  let result;
  if (frame.method === "initialize") result = { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {} } };
  else if (frame.method === "session/new" || frame.method === "session/load") {
    const sessionId = frame.params.sessionId || crypto.randomUUID(); sessions.set(sessionId, { prompt: null });
    note({ kind: frame.method, sessionId }); result = frame.method === "session/new" ? { sessionId } : {};
  } else if (frame.method === "session/prompt") {
    const session = sessions.get(frame.params.sessionId); if (!session) return send({ id: frame.id, error: { code: -32602, message: "Unknown controlled session" } });
    session.prompt = frame;
    const text = (frame.params.prompt || []).filter(item => item.type === "text").map(item => item.text).join("\n");
    const probe = [...text.matchAll(/\[ACP_PROBE:([a-z0-9-]+)\]/gu)].at(-1), token = probe?.[1] || "untagged", control = probe ? text.slice(probe.index) : "";
    note({ kind: "prompt", sessionId: frame.params.sessionId, token, bytes: Buffer.byteLength(text), fingerprint: crypto.createHash("sha256").update(text).digest("hex") });
    if (control.includes("[ACP_EXIT]")) { note({ kind: "exit-after-write", sessionId: frame.params.sessionId, token }); process.exit(23); }
    if (control.includes("[ACP_APPROVAL]")) {
      const id = ++permissionId; permissions.set(id, { session, prompt: frame, token, control });
      note({ kind: "permission-request", sessionId: frame.params.sessionId, token, id });
      send({ id, method: "session/request_permission", params: { sessionId: frame.params.sessionId,
        toolCall: { toolCallId: `controlled-${token}`, title: "Run controlled Generic ACP command", kind: "execute", status: "pending", rawInput: { command: "printf controlled-acp" }, locations: [] },
        options: [{ optionId: "controlled-allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "controlled-deny-once", name: "Deny", kind: "reject_once" }] } }); return;
    }
    return complete(session, frame, token, control);
  } else if (frame.method === "session/cancel") {
    const session = sessions.get(frame.params.sessionId);
    if (session?.prompt) { send({ id: session.prompt.id, result: { stopReason: "cancelled" } }); session.prompt = null; }
    note({ kind: "cancel", sessionId: frame.params.sessionId }); return;
  } else return send({ id: frame.id, error: { code: -32601, message: "Unsupported controlled operation" } });
  send({ id: frame.id, result });
});
lines.once("close", () => { note({ kind: "stdin-closed" }); process.exit(0); });
process.on("SIGTERM", () => { note({ kind: "stopped" }); process.exit(0); });
