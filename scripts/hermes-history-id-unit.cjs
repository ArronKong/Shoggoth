"use strict";

// Unit: Hermes chat-history messages must carry a stable per-message `id` so the
// chat UI's right-click 置顶 (pin) / 删除（本地隐藏）(local-hide) — both keyed by
// message id and gated by `menu.group.msgs.some(m => m.id)` in ChatPage — show up
// for Hermes the same as OpenClaw. Two sources of ids:
//   1. _fetchHistoricalMessages preserves the dashboard's autoincrement id (real,
//      stable) → `hermes-msg-<id>`.
//   2. getHistory stamps an index-based `hermes-local-<i>` on any live-appended
//      message that has no dashboard id yet, once and stably.

const assert = require("node:assert/strict");
const http = require("node:http");
const { HermesBackend } = require("../app/core/hermes-backend");
const {
  FEDERATION_AGENT_RUN_SOURCE_TOOL,
  annotateFederationPrompt,
  createFederationInputProvenance,
} = require("../app/federation-chat-provenance");

async function testGetHistoryStampsStableIds() {
  const be = new HermesBackend({});
  const sk = "agent:hermes-default:sess-1";
  // Two historical rows (already carry real ids) + two live appends (no id).
  be.transcripts.set(sk, [
    { role: "user", id: "hermes-msg-7", content: [{ type: "text", text: "hist user" }] },
    { role: "assistant", id: "hermes-msg-8", content: [{ type: "text", text: "hist reply" }] },
    { role: "user", content: [{ type: "text", text: "live user" }] },
    { role: "assistant", content: [{ type: "text", text: "live reply" }] },
  ]);

  const h1 = await be.getHistory(sk);
  assert.ok(h1.messages.every((m) => !!m.id), "every message has an id");
  assert.equal(h1.messages[0].id, "hermes-msg-7", "historical real id preserved");
  assert.equal(h1.messages[1].id, "hermes-msg-8", "historical real id preserved");
  assert.equal(h1.messages[2].id, "hermes-local-2", "live append gets index-based local id");
  assert.equal(h1.messages[3].id, "hermes-local-3", "live append gets index-based local id");

  // Stable across the repeated reloads a session does (re-mint guard).
  const snapshot = h1.messages.map((m) => m.id).join(",");
  const h2 = await be.getHistory(sk);
  assert.equal(h2.messages.map((m) => m.id).join(","), snapshot, "ids stable across reload");

  // A new live append is stamped; existing ids untouched.
  be.transcripts.get(sk).push({ role: "user", content: [{ type: "text", text: "another live" }] });
  const h3 = await be.getHistory(sk);
  assert.equal(h3.messages[4].id, "hermes-local-4", "new live append stamped");
  assert.equal(h3.messages[0].id, "hermes-msg-7", "old real id untouched");
  assert.equal(h3.messages[2].id, "hermes-local-2", "old local id untouched");
  assert.equal(new Set(h3.messages.map((m) => m.id)).size, h3.messages.length, "ids unique within session");
}

async function testFetchHistoricalPreservesDashboardId() {
  const provenance = createFederationInputProvenance(FEDERATION_AGENT_RUN_SOURCE_TOOL);
  const federatedPrompt = annotateFederationPrompt("agent-routed input", provenance);
  const server = http.createServer((req, res) => {
    if (/^\/api\/sessions\/.+\/messages$/.test(req.url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        messages: [
          { id: 7, role: "user", content: "hi" },
          { id: 8, role: "assistant", content: "yo" },
          { id: 9, role: "system", content: "filtered out" },
          { id: 10, role: "assistant", content: [{ type: "text", text: "structured" }] },
          { id: 11, role: "user", content: federatedPrompt },
        ],
      }));
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const be = new HermesBackend({});
    be.profileById.set("hermes-default", "default");
    be.dashboards.set("default", { baseUrl: `http://127.0.0.1:${port}`, token: "x" });

    const fetched = await be._fetchHistoricalMessages("agent:hermes-default:abc-uuid");
    assert.equal(fetched.length, 4, "non user/assistant roles filtered");
    assert.equal(fetched[0].id, "hermes-msg-7", "real autoincrement id mapped");
    assert.equal(fetched[1].id, "hermes-msg-8", "real autoincrement id mapped");
    assert.equal(fetched[2].id, "hermes-msg-10", "id kept even for structured content");
    assert.equal(typeof fetched[2].content[0].text, "string", "structured content stringified");
    assert.deepEqual(fetched[3].provenance, provenance,
      "canonical Hermes history restores federation provenance from its durable marker");

    // End-to-end: a fresh session seeds from the dashboard → all real ids, no local stamps.
    const hg = await be.getHistory("agent:hermes-default:abc-uuid");
    assert.ok(hg.messages.every((m) => m.id.startsWith("hermes-msg-")), "fresh seed yields only real ids");
  } finally {
    server.close();
  }
}

async function testSendPersistsFederationProvenance() {
  const be = new HermesBackend({});
  const sessionKey = "agent:hermes-default:sess-federated";
  const provenance = createFederationInputProvenance(FEDERATION_AGENT_RUN_SOURCE_TOOL);
  be.profileById.set("hermes-default", "default");
  be.transcripts.set(sessionKey, []);
  be._gatewayChatEnabled = () => false;
  let submitted;
  be._sendViaAcp = async (args) => { submitted = args.message; };

  await be._sendMessageInner(
    sessionKey,
    "delegated work",
    "federation-idempotency-1",
    {},
    { inputProvenance: provenance },
  );

  assert.equal(submitted.startsWith("[Inter-session message]"), true);
  assert.deepEqual(be.transcripts.get(sessionKey)[0].provenance, provenance);
}

(async () => {
  await testGetHistoryStampsStableIds();
  await testFetchHistoricalPreservesDashboardId();
  await testSendPersistsFederationProvenance();
  console.log("[hermes-history-id-unit] PASS");
})().catch((err) => {
  console.error("[hermes-history-id-unit] FAIL");
  console.error(err);
  process.exit(1);
});
