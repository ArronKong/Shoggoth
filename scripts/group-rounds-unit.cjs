"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ROUND_LIMITS, currentOwner, defaultOwner, insertCalls, openingSpeakers } = require("../app/agent-service/group-rounds");

const member = (id, position, extra = {}) => ({ id, position, state: "active", backendId: "shoggoth", profileId: `p-${id}`, ...extra });
const roster = [member("a", 0), member("b", 1), member("c", 2)];
const user = { kind: "user" };

test("plain user message goes to the owner only; @ picks members; @all is everyone with the owner first", () => {
  assert.deepEqual(openingSpeakers({ active: roster, ownerId: "b", author: user }), ["b"]);
  assert.deepEqual(openingSpeakers({ active: roster, ownerId: "b", author: user, mentionIds: ["c", "a", "c"] }), ["c", "a"]);
  assert.deepEqual(openingSpeakers({ active: roster, ownerId: "b", author: user, broadcast: true }), ["b", "a", "c"]);
  // 群主不可用（例如全员离线时没有群主）时普通消息按名单全员。
  assert.deepEqual(openingSpeakers({ active: roster, ownerId: null, author: user }), ["a", "b", "c"]);
});

test("only the owner's @all calls everyone; a member's plain reply opens nobody", () => {
  assert.deepEqual(openingSpeakers({ active: roster, ownerId: "a", author: { kind: "member", memberId: "a" }, broadcast: true }), ["b", "c"]);
  assert.deepEqual(openingSpeakers({ active: roster, ownerId: "a", author: { kind: "member", memberId: "b" }, broadcast: true }), []);
  assert.deepEqual(openingSpeakers({ active: roster, ownerId: "a", author: { kind: "member", memberId: "b" } }), []);
  assert.deepEqual(openingSpeakers({ active: roster, ownerId: "a", author: { kind: "member", memberId: "b" }, mentionIds: ["b", "c"] }), ["c"],
    "a member never calls itself");
});

test("a late result is answered by whoever asked for it, unless it calls someone itself", () => {
  const author = { kind: "member", memberId: "c" };
  assert.deepEqual(openingSpeakers({ active: roster, ownerId: "a", author, late: true, calledBy: "b" }), ["b"]);
  assert.deepEqual(openingSpeakers({ active: roster, ownerId: "a", author, late: true, calledBy: "b", mentionIds: ["a"] }), ["a"]);
  assert.deepEqual(openingSpeakers({ active: roster, ownerId: "a", author, late: true, calledBy: null }), [],
    "work the user asked for is left for the user to read");
});

test("@ inserts the callee right after the speaker, moves a waiting one up, and respects the per-round cap", () => {
  const order = [{ key: "1", memberId: "a", waiting: false }, { key: "2", memberId: "b", waiting: true },
    { key: "3", memberId: "c", waiting: true }];
  const moved = insertCalls(order, 0, ["c"], () => 0, ROUND_LIMITS.memberCallCap);
  assert.deepEqual(moved.order.map(slot => slot.key), ["1", "3", "2"]);
  assert.deepEqual(moved.added, []);
  const added = insertCalls(order, 2, ["a", "b"], id => (id === "a" ? 1 : 0), ROUND_LIMITS.memberCallCap);
  assert.deepEqual(added.order.map(slot => slot.memberId), ["a", "b", "c", "a", "b"]);
  assert.deepEqual(added.added, ["a", "b"]);
  const capped = insertCalls(order, 2, ["a"], () => ROUND_LIMITS.memberCallCap, ROUND_LIMITS.memberCallCap);
  assert.deepEqual(capped.added, [], "a member already at its cap is not called again");
});

test("both ordinary members and the owner can call a ninth-time speaker once more, but never an eleventh time", () => {
  const order = [{ key: "last", memberId: "b", waiting: false }];
  for (const cap of [ROUND_LIMITS.memberCallCap, ROUND_LIMITS.ownerCallCap]) {
    assert.deepEqual(insertCalls(order, 0, ["a"], () => 9, cap).added, ["a"],
      "nine turns already taken leaves exactly one turn");
    assert.deepEqual(insertCalls(order, 0, ["a"], () => 10, cap).added, [],
      "the opening turn is included in the ten-turn cap");
  }
});

test("owner: configured one while available, else the next available member; default prefers built-in Shoggoth", () => {
  const cards = new Map([["b", { availability: "offline" }]]);
  assert.equal(currentOwner({ ownerMemberId: "b" }, roster, new Map()).id, "b");
  assert.equal(currentOwner({ ownerMemberId: "b" }, roster, cards).id, "c");
  assert.equal(currentOwner({ ownerMemberId: "c" }, roster, new Map([["c", { availability: "offline" }]])).id, "a");
  assert.equal(currentOwner({ ownerMemberId: "gone" }, roster, new Map()).id, "a");
  const all = new Map(roster.map(item => [item.id, { availability: "offline" }]));
  assert.equal(currentOwner({ ownerMemberId: "b" }, roster, all).id, "b", "nobody available keeps the configured owner");
  const withPrimary = [...roster, member("s", 3, { profileId: "default" })];
  assert.equal(defaultOwner(withPrimary, "default").id, "s");
  assert.equal(defaultOwner(roster, "default").id, "a");
  assert.equal(defaultOwner([member("x", 0, { backendId: "hermes", profileId: null })], "default").id, "x");
});
