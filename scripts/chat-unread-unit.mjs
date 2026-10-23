import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const { build } = require("esbuild");
const { outputFiles } = await build({ entryPoints: [new URL("../app/manage-ui/src/lib/chatUnread.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs" });
const module = { exports: {} };
vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports });
const { readChatUnread, writeChatUnread, sessionReadAt, hasUnreadReply, observeSessionReply,
  readSessionThrough, supportsSessionUnread } = module.exports;
const values = new Map();
const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
const a = "agent:alpha:main", b = "agent:alpha:cron:reminder", c = "agent:beta:main";
let state = readChatUnread(storage, 1000);
state = observeSessionReply(state, a, 900);
assert.equal(hasUnreadReply(state, a), false, "first installation must not mark old history unread");
state = observeSessionReply(state, b, 900);
assert.equal(hasUnreadReply(state, b), false, "first installation must not resurrect old Cron history");
state = observeSessionReply(state, b, 1000);
assert.equal(hasUnreadReply(state, b), false, "the installation cutoff is inclusive");
state = observeSessionReply(state, b, 1100);
state = observeSessionReply(state, a, 1200);
state = observeSessionReply(state, c, 1300);
assert.equal(hasUnreadReply(state, b), true, "new cron replies are unread");
state = readSessionThrough(state, a, 1200);
assert.equal(hasUnreadReply(state, a), false);
assert.equal(hasUnreadReply(state, b), true, "reading another session of the same Agent must not clear the reminder");
assert.equal(hasUnreadReply(state, c), true, "other Agents are independent");
state = observeSessionReply(state, b, 1400);
state = readSessionThrough(state, b, 1100);
assert.equal(hasUnreadReply(state, b), true, "late/stale history cannot mark a newer reply read");
assert.equal(observeSessionReply(state, b, 1100), state, "replayed replies cannot move the cursor backwards");
assert.equal(observeSessionReply(state, b, NaN), state);
writeChatUnread(storage, state);
state = readChatUnread(storage, 2000);
assert.equal(hasUnreadReply(state, b), true, "unread persists across reloads");
state = readSessionThrough(state, b, 1400);
writeChatUnread(storage, state);
assert.equal(hasUnreadReply(readChatUnread(storage, 2100), b), false, "read acknowledgement persists");
state = observeSessionReply(state, "agent:alpha:cron:offline", 1900);
assert.equal(hasUnreadReply(state, "agent:alpha:cron:offline"), true, "a newly discovered offline session uses the original baseline");
values.clear(); values.set("shoggoth.chat.readAt.v1", JSON.stringify({ alpha: 500, beta: "bad" }));
state = readChatUnread(storage, 2000);
assert.equal(sessionReadAt(state, a), 2000, "legacy Agent reads cannot reintroduce pre-installation history");
assert.equal(sessionReadAt(state, b), 2000, "Cron and ordinary sessions share the installation cutoff");
state = readSessionThrough(state, a, 2200);
assert.equal(sessionReadAt(state, b), 2000, "reading another session never advances the Cron watermark");
assert.equal(sessionReadAt(state, c), 2000, "invalid legacy values are ignored");
for (const [key, kind, expected] of [[b, undefined, true], ["agent:alpha:uuid", "cron", true],
  ["agent:alpha:subagent:work", undefined, false], ["agent:alpha:dream:night", undefined, false],
  ["agent:alpha:main:heartbeat", undefined, false], [a, undefined, true]]) {
  assert.equal(supportsSessionUnread(key, kind), expected, key);
}
console.log("PASS chat unread: session isolation, persistence, offline discovery, stale history, installation baseline and internal-session filtering");

const nativeCron = "agent:alpha:00000000-0000-4000-8000-000000000003";
state = observeSessionReply(state, nativeCron, 400);
assert.equal(hasUnreadReply(state, nativeCron, "cron"), false, "native UUID Cron results predating installation must stay quiet");
state = readSessionThrough(state, nativeCron, 400, "cron");
writeChatUnread(storage, state);
assert.equal(hasUnreadReply(readChatUnread(storage, 3000), nativeCron, "cron"), false, "viewed legacy Cron remains read after reload");
console.log("PASS Cron baseline: native UUID and declared Cron sessions ignore pre-installation history");

// Existing v1 red dots are retired exactly once, without touching the old cache.
values.clear();
const oldCache = JSON.stringify({ since: 100, baseline: { alpha: 200 }, read: { [a]: 300 },
  replies: { [a]: 4000, [b]: 4500, [nativeCron]: 4600 } });
values.set("shoggoth.chat.sessionUnread.v1", oldCache);
values.set("shoggoth.chat.readAt.v1", JSON.stringify({ alpha: 10 }));
state = readChatUnread(storage, 5000);
assert.equal(state.since, 5000, "existing installations migrate at first launch of the new policy");
assert.equal(values.get("shoggoth.chat.sessionUnread.v1"), oldCache, "migration preserves the old cache");
for (const key of [a, b, nativeCron]) {
  state = observeSessionReply(state, key, 4900);
  assert.equal(hasUnreadReply(state, key, key === nativeCron ? "cron" : undefined), false,
    "late discovery cannot resurrect old cached or unobserved history: " + key);
}
// Bootstrap persists the cutoff before ChatPage opens or its first reply arrives.
assert.equal(JSON.parse(values.get("shoggoth.chat.sessionUnread.v2")).since, 5000);
state = readChatUnread(storage, 6000);
assert.equal(state.since, 5000, "opening Chat later must retain the app-start cutoff");
state = observeSessionReply(state, b, 5500);
assert.equal(hasUnreadReply(state, b), true, "new replies before the first Chat visit remain unread");
writeChatUnread(storage, state);
state = readChatUnread(storage, 7000);
assert.equal(hasUnreadReply(state, b), true, "refresh, restart and later versions do not reset the cutoff");
assert.equal(sessionReadAt(state, a), 5000);
state = observeSessionReply(state, a, 5600);
state = readSessionThrough(state, a, 5600);
assert.equal(hasUnreadReply(state, b), true, "reading direct chat never clears new Cron unread");
state = readSessionThrough(state, b, 5400);
assert.equal(hasUnreadReply(state, b), true, "stale visible history cannot acknowledge a later reply");
state = readSessionThrough(state, b, 5500);
writeChatUnread(storage, state);
assert.equal(hasUnreadReply(readChatUnread(storage, 8000), b), false);

// Persisted reads older than the cutoff cannot lower it for any session kind.
values.set("shoggoth.chat.sessionUnread.v2", JSON.stringify({ since: 5000,
  read: { [a]: 50, [b]: 100, invalid: "bad" }, replies: { [a]: 4900, [b]: 4999 } }));
state = readChatUnread(storage, 9000);
assert.equal(sessionReadAt(state, a), 5000);
assert.equal(sessionReadAt(state, b), 5000);
assert.equal(hasUnreadReply(state, a), false);
assert.equal(hasUnreadReply(state, b), false);
assert.equal(state.read.invalid, undefined);
values.set("shoggoth.chat.sessionUnread.v2", "corrupt");
state = readChatUnread(storage, 10000);
assert.equal(state.since, 10000, "corrupt storage recovers without showing old history");
const blockedStorage = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } };
assert.equal(readChatUnread(blockedStorage, 11000).since, 11000, "unavailable storage does not block chat");
console.log("PASS unread migration: one-time cutoff, old cached dots, delayed Chat visit, restart, new reminders and unavailable storage");
