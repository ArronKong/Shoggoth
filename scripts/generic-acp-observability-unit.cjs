"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { openFixture, sendAndDrain } = require("./shoggoth-work-run-coordinator-unit.cjs");

test("public diagnostics count exact unbound overflow without changing ownership or exposing event content", async () => {
  const value = await openFixture({ getNativeRuntimeConfig: () => ({ enabled: false, flags: {}, startupConcurrency: 2 }) });
  try {
    const { ack } = await sendAndDrain(value);
    const before = value.dispatcher.getRun(ack.run.id);
    const event = { known: true, type: "text_delta", threadId: "PRIVATE-UNBOUND-SESSION", turnId: "PRIVATE-UNBOUND-TURN", delta: "PRIVATE-UNTRUSTED-TEXT" };
    for (let i = 0; i < 320; i++) value.host.emit(event);
    const snapshot = value.coordinator.getRuntimeObservability();
    assert.deepEqual(snapshot.stageSamples.unbound_event_dropped, { count: 64, success: 0, error: 0, unknown: 64 });
    assert.equal(snapshot.events.filter(v => v.stage === "unbound_event_dropped").every(v => v.code === "RUNTIME_EVENT_BUFFER_DROPPED" && v.count === 1), true);
    assert.equal(JSON.stringify(snapshot).includes("PRIVATE-"), false);
    assert.equal([...value.coordinator.hostObservers.values()][0].pendingEvents.length, 256);
    assert.deepEqual(value.dispatcher.getRun(ack.run.id), before);
    const record = value.coordinator.telemetry.record.bind(value.coordinator.telemetry);
    value.coordinator.telemetry.record = (name, input) => { if (input.stage === "unbound_event_dropped") throw Error("diagnostic sink unavailable"); return record(name, input); };
    assert.doesNotThrow(() => value.host.emit(event));
    assert.equal([...value.coordinator.hostObservers.values()][0].pendingEvents.length, 256);
    assert.deepEqual(value.dispatcher.getRun(ack.run.id), before);
  } finally { await value.coordinator.close(); }
});
