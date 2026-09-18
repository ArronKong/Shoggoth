#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  createBoardWidgetNavigationGuard,
  shouldOpenExternalUrl,
} = require("../app/board-widget-navigation");

let clock = 1000;
const guard = createBoardWidgetNavigationGuard({ now: () => clock });
const main = { frameTreeNodeId: 1, parent: null, url: "http://127.0.0.1:18799/chat" };
const outer = { frameTreeNodeId: 2, parent: main, url: "" };
const inner = { frameTreeNodeId: 3, parent: outer, url: "" };
const grandchild = { frameTreeNodeId: 4, parent: inner, url: "" };
const frameUrl = `http://127.0.0.1:43210/v1/board-widget/${"a".repeat(43)}`;

guard.allowTicket({ ticket: "a".repeat(43), url: frameUrl, ownerId: 7, expiresAt: 2000 });
let prevented = 0;
let result = guard.handle({
  url: frameUrl, frame: outer, initiator: main, isMainFrame: false,
  preventDefault() { prevented += 1; },
}, { ownerId: 7, mainFrame: main });
assert.deepEqual(result, { allowed: true, reason: "ticket", ticket: "a".repeat(43) });
assert.equal(prevented, 0);
assert.equal(guard.isBoardFrame(outer), true);

result = guard.handle({
  url: "about:blank", frame: inner, initiator: outer, isMainFrame: false,
  preventDefault() { prevented += 1; },
}, { ownerId: 7, mainFrame: main });
assert.equal(result.allowed, true);
result = guard.handle({
  url: "about:srcdoc", frame: inner, initiator: outer, isMainFrame: false,
  preventDefault() { prevented += 1; },
}, { ownerId: 7, mainFrame: main });
assert.equal(result.allowed, true);

for (const [url, frame, initiator, isMainFrame] of [
  ["https://evil.example/leak", inner, inner, false],
  ["data:text/html,escape", inner, inner, false],
  ["https://evil.example/frame", grandchild, inner, false],
  ["https://evil.example/top", main, inner, true],
]) {
  result = guard.handle({
    url, frame, initiator, isMainFrame,
    preventDefault() { prevented += 1; },
  }, { ownerId: 7, mainFrame: main });
  assert.equal(result.allowed, false, url);
}
assert.equal(prevented, 4);

result = guard.handle({
  url: "http://127.0.0.1:18799/__widget/openclaw/x", frame: { frameTreeNodeId: 8, parent: main },
  initiator: main, isMainFrame: false, preventDefault() { prevented += 1; },
}, { ownerId: 7, mainFrame: main });
assert.deepEqual(result, { allowed: true, reason: "unmanaged-subframe" });

guard.revokeTicket("a".repeat(43));
assert.equal(guard.isBoardFrame(outer), false);
guard.allowTicket({ ticket: "b".repeat(43), url: frameUrl.replace(/a+$/u, "b".repeat(43)), ownerId: 7, expiresAt: 1100 });
clock = 1200;
result = guard.handle({
  url: frameUrl.replace(/a+$/u, "b".repeat(43)), frame: outer, initiator: main, isMainFrame: false,
  preventDefault() { prevented += 1; },
}, { ownerId: 7, mainFrame: main });
assert.equal(result.allowed, false, "expired ticket navigation must be blocked before the host");

assert.equal(shouldOpenExternalUrl("https://openclaw.ai/docs"), true);
assert.equal(shouldOpenExternalUrl("http://example.com/release"), true);
assert.equal(shouldOpenExternalUrl("https://user:secret@example.com"), false);
assert.equal(shouldOpenExternalUrl("javascript:alert(1)"), false);
assert.equal(shouldOpenExternalUrl("file:///etc/passwd"), false);

console.log("board-widget-navigation-unit: PASS");
