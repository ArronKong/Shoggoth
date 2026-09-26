#!/usr/bin/env node
// Regression: `session.message` coalescing must flush the TAIL of a burst.
//
// The proxy throttles session.message per sessionKey so the UI doesn't spin on
// chat.history. A pure leading-edge throttle drops the LAST message of a burst
// (cron/background turns end mid-window), stranding the UI on stale history with
// nothing left to re-trigger a reload. Assert: first frame relayed immediately,
// intermediate frames coalesced away, final frame still delivered.

import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { startProxyGateway } from "../app/core/proxy-gateway.js";

const listen = (server, port) => new Promise((r) => server.listen(port, "127.0.0.1", r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SK = "agent:main:main";
const msg = (n) =>
  JSON.stringify({ type: "event", event: "session.message", payload: { sessionKey: SK, seq: n } });

// --- fake upstream gateway ---------------------------------------------------
let upstreamSock = null;
const upstreamHttp = createServer();
const upstreamWss = new WebSocketServer({ server: upstreamHttp });
upstreamWss.on("connection", (sock) => {
  upstreamSock = sock;
  sock.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n1" } }));
  sock.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "req" && frame.method === "connect") {
      sock.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok" } }));
    }
  });
});
await listen(upstreamHttp, 0);
const upstreamUrl = `ws://127.0.0.1:${upstreamHttp.address().port}`;

const proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => upstreamUrl });

// --- client ------------------------------------------------------------------
const client = new WebSocket(proxy.url);
const seen = [];
client.on("message", (data) => {
  const f = JSON.parse(data.toString());
  if (f.type === "event" && f.event === "session.message") seen.push(f.payload.seq);
});
await new Promise((r) => client.on("open", r));
await sleep(150); // let the upstream handshake settle

const results = [];
const check = (name, cond) => results.push({ name, ok: !!cond });

// Burst of 3 inside the 800ms window.
upstreamSock.send(msg(1));
await sleep(30);
upstreamSock.send(msg(2));
await sleep(30);
upstreamSock.send(msg(3));

await sleep(120);
check("leading edge relayed immediately", seen.includes(1));
check("mid-burst frames not relayed yet", !seen.includes(2) && !seen.includes(3));

// Window closes → the LAST held frame must arrive (the whole point of the fix).
await sleep(900);
check("tail of burst flushed after window", seen.includes(3));
check("superseded mid-burst frame never relayed", !seen.includes(2));
check("exactly two frames delivered (leading + tail)", seen.length === 2);

// Once the window has fully elapsed since the last delivery, the next message is
// a fresh leading edge and goes straight through.
await sleep(850);
upstreamSock.send(msg(4));
await sleep(120);
check("isolated later message relayed immediately", seen.includes(4));

client.close();
await proxy.close();
await new Promise((r) => upstreamHttp.close(r));

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
