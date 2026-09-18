#!/usr/bin/env node
// Regression: a Hermes reply must reach EVERY /__chatws connection, not just the
// one that sent chat.send.
//
// Desktop notifications come solely from <Notifier>, which holds its own
// /__chatws socket (separate from ChatPage's). The real gateway broadcasts `chat`
// events to every operator connection, which is why OpenClaw replies notify.
// Foreign (Hermes) sends are served locally by the proxy and used to reply only to
// the originating socket — so Hermes chat notifications never fired.
//
// Deltas must stay on the originating socket (volume; nothing else consumes them).

import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { startProxyGateway } from "../app/core/proxy-gateway.js";
import { BackendRegistry } from "../app/core/backend-registry.js";
import { AgentBackend } from "../app/core/agent-backend.js";

class MockHermes extends AgentBackend {
  get id() { return "hermes"; }
  get name() { return "Hermes (mock)"; }
  ownsAgentId(id) { return String(id).startsWith("hermes"); }
  getAgents() { return [{ id: "hermes-default", name: "Hermes" }]; }
  async sendMessage(_key, _msg, _runId, hooks) {
    hooks.delta("partial");
    hooks.final("partial reply");
  }
}

const upstream = createServer();
const upstreamWss = new WebSocketServer({ server: upstream });
upstreamWss.on("connection", (sock) => {
  sock.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n1" } }));
  sock.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "req" && frame.method === "connect") {
      sock.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok" } }));
    }
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

const registry = new BackendRegistry();
registry.register(new MockHermes());
const proxy = await startProxyGateway({
  port: 0,
  getUpstreamUrl: () => `ws://127.0.0.1:${upstream.address().port}`,
  registry,
});

// Each browser socket completes the device-auth handshake (the broker does this).
async function connectClient() {
  const ws = new WebSocket(proxy.url);
  const frames = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "req", id: "c0", method: "connect", params: {} }));
  await new Promise((r) => setTimeout(r, 150));
  return { ws, frames };
}

const chatPage = await connectClient();
const notifier = await connectClient();

chatPage.ws.send(
  JSON.stringify({
    type: "req",
    id: "s1",
    method: "chat.send",
    params: { sessionKey: "agent:hermes-default:main", message: "hi", idempotencyKey: "run-1" },
  }),
);
await new Promise((r) => setTimeout(r, 400));

const chatEvents = (frames, state) =>
  frames.filter((f) => f.type === "event" && f.event === "chat" && f.payload?.state === state);

const results = [];
const check = (name, cond) => results.push({ name, ok: !!cond });

const senderFinal = chatEvents(chatPage.frames, "final");
const notifierFinal = chatEvents(notifier.frames, "final");

check("sender receives the final", senderFinal.length === 1);
check("second connection (Notifier) also receives the final", notifierFinal.length === 1);
check("final carries assistant text", notifierFinal[0]?.payload?.message?.content?.[0]?.text === "partial reply");
check("final carries a timestamp (Notifier dedups on sessionKey:timestamp)",
  typeof notifierFinal[0]?.payload?.message?.timestamp === "number");
check("final carries the sessionKey", notifierFinal[0]?.payload?.sessionKey === "agent:hermes-default:main");
check("deltas stay on the originating socket", chatEvents(chatPage.frames, "delta").length === 1);
check("deltas are NOT broadcast", chatEvents(notifier.frames, "delta").length === 0);

chatPage.ws.close();
notifier.ws.close();
await proxy.close();
await new Promise((r) => upstream.close(r));

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
