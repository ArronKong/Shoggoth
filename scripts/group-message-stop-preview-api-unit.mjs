// Verify the isolated preview speaks the real send/lookup contract without dispatching any Agent.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const { build } = require("esbuild");
const { outputFiles } = await build({ entryPoints: [new URL("./fixtures/group-message-stop-preview-api.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent" });
const module = { exports: {} };
vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, require, crypto, Response, URL,
  TextEncoder, structuredClone, setTimeout, clearTimeout, console });
const { getSnapshot } = require(new URL("./fixtures/group-message-stop-preview-data.cjs", import.meta.url).pathname);
const snapshot = getSnapshot("background-stop", 0), { view, messages } = snapshot;
view.ownerScope = "isolated-preview-test";
const api = module.exports.createPreviewSendApi(view, messages), originalTurns = structuredClone(view.activeTurns);
const input = { clientMessageId: "preview-original", ownerScope: view.ownerScope, expectedPolicyVersion: view.group.policyVersion,
  body: "这是一条预览新消息", mentions: [], attachments: [] };
const send = body => api(new URL(`http://preview/__api/group-chats/messages?id=${view.group.id}`), { method: "POST", body: JSON.stringify(body) });
const lookup = (id, digest = "unknown") => api(new URL(`http://preview/__api/group-chats/messages/lookup?id=${view.group.id}&ownerScope=${view.ownerScope}&clientMessageId=${id}&payloadDigest=${digest}`), {});
const before = messages.length;
const missing = await (await lookup(input.clientMessageId)).json();
assert.deepEqual([missing.status, missing.ownerScope, missing.groupId, missing.clientMessageId],
  ["not_found", view.ownerScope, view.group.id, input.clientMessageId], "even absent receipts retain exact identity");
const first = await (await send(input)).json();
assert.equal(first.duplicate, false);
assert.equal(messages.length, before + 1);
assert.equal(messages.at(-1).body, input.body);
const found = await (await lookup(input.clientMessageId)).json();
assert.equal(found.status, "found"); assert.equal(found.payloadMatches, false);
const matched = await (await lookup(input.clientMessageId, found.payloadDigest)).json();
assert.equal(matched.payloadMatches, true); assert.equal(matched.message.id, first.message.id);
const duplicate = await (await send(input)).json();
assert.equal(duplicate.duplicate, true); assert.equal(duplicate.message.id, first.message.id);
assert.equal(messages.length, before + 1, "same-ID retry never appends or dispatches again");
assert.equal((await send({ ...input, body: "changed payload" })).status, 409);
assert.equal((await send({ ...input, clientMessageId: "wrong-owner", ownerScope: "foreign" })).status, 409);
await send({ ...input, clientMessageId: "preview-next", body: "继续发另一条" });
assert.equal(messages.length, before + 2, "active or stopping runs do not block a fresh preview message");
assert.deepEqual(view.activeTurns, originalTurns, "sending does not restart the old Agent runs");
const source = fs.readFileSync(new URL("./fixtures/group-message-stop-preview.tsx", import.meta.url), "utf8");
assert.ok(source.indexOf("await sendApi(request, init)") < source.indexOf('init.method && init.method !== "GET"'),
  "send and lookup run before the unsupported-action fallback");
console.log("PASS preview send/lookup: exact receipts, fresh messages, same-ID dedup, payload and owner fences; zero Provider calls");
