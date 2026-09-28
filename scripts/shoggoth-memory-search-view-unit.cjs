"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");

const profileId = "profile-1";

function save(fixture, id, content, options = {}) {
  return fixture.engine.propose({
    id, profileId, scope: "user", type: options.validUntil ? "temporary" : "semantic",
    content, sourceRefs: [`event-${id}`], classification: "explicit",
    ...(options.validUntil ? { validUntil: options.validUntil } : {}),
  });
}

function search(fixture, query, now) {
  return fixture.engine.search({ profileId, query, scopes: ["user"],
    ...(now === undefined ? {} : { now }) }).items.map((item) => item.id);
}

test("active view uses IDF and follows writes, expiry, revocation and restart", () => {
  const fixture = memoryFixture();
  try {
    const rare = save(fixture, "rare", "needle");
    for (let index = 0; index < 8; index += 1) {
      save(fixture, `common-${index}`, `alpha item ${index}`);
    }
    assert.equal(search(fixture, "alpha needle")[0], rare.id,
      "a rarer query term should outrank a recent common-only match");
    assert.ok(fixture.engine.searchViews.has(profileId), "the first search should build an active view");

    const added = save(fixture, "added", "delta");
    assert.deepEqual(search(fixture, "delta"), [added.id], "a new revision must rebuild the active view");
    fixture.engine.update({ profileId, id: added.id, content: "gamma" });
    assert.deepEqual(search(fixture, "delta"), []);
    assert.deepEqual(search(fixture, "gamma"), [added.id]);

    save(fixture, "temporary", "chronicle", { validUntil: 5_000 });
    assert.deepEqual(search(fixture, "chronicle", 4_000), ["temporary"]);
    assert.deepEqual(search(fixture, "chronicle", 6_000), [],
      "time filtering must apply even when the store revision has not changed");

    fixture.engine.delete({ profileId, id: added.id, reason: "forgotten" });
    assert.deepEqual(search(fixture, "gamma"), []);
    fixture.close();
    fixture.definitions.open(); fixture.store.open(); fixture.engine.open([profileId]);
    assert.deepEqual(search(fixture, "gamma"), []);
    assert.equal(search(fixture, "alpha needle")[0], rare.id);
  } finally { fixture.cleanup(); }
});
