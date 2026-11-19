"use strict";
// Real Service/Coordinator/store lifecycle with a controlled native transport.
// This proves local interruption/publication/session renewal, not a live provider.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const PROFILE_FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
const FACT = "The telescope borrowed in-flight fact is aquamarine calibration.";
const LATE = "REVOKED_LATE_BODY_791549";

async function fixture(activeMemory = false) {
  const memoryCoreConfig = { memory: { search: { provider: "none", rememberAcrossConversations: false } },
    agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
    plugins: { entries: { "active-memory": { enabled: activeMemory, config: { enabled: activeMemory, mode: "escalate", model: "literal" } } } } };
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: true, memorySharingFeatureReady: true, memoryCoreConfig } });
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
    flags: { ...config.flags, runtimeContextLifecycleV1: false } });
  const B = "source-b", source = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
  Object.assign(source, { id: B, agentId: B, runtimeProfileId: B, name: B, isDefault: false });
  f.service.productStore.putAgentProfile(source); f.service.agentDefinitionStore.ensureProfile({ profileId: B });
  const owner = f.service.memoryEngine;
  owner.store.ensureProfile(B); owner.recallPolicy.assertReady(B);
  f.service.nativeMemorySharingConfig.apply({ revision: 0, config: { enabled: true, excludedProfiles: [] } });
  const item = await owner.propose({ profileId: B, content: FACT, scope: "agent", classification: "explicit", sourceRefs: ["user-edit:inflight-source"] });
  return { ...f, B, item, owner, memoryCoreConfig };
}
function emitLate(host, run) {
  const common = { known: true, threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId };
  host.emit({ ...common, type: "text_delta", method: "item/agentMessage/delta", itemId: "late-text", delta: LATE });
  host.emit({ ...common, type: "text", method: "item/completed", itemId: "late-final", text: LATE, phase: "final_answer" });
  host.emit({ ...common, type: "tool_result", method: "item/completed", itemId: "late-tool", toolCallId: "late-tool",
    tool: { kind: "function", name: "memory_search", status: "completed", output: LATE } });
  const thread = host.threads.find(value => value.id === run.runtimeSessionRef.sessionId);
  const turn = thread.turns.find(value => value.id === run.runtimeTurnRef.turnId);
  turn.status = "completed"; turn.items.push({ type: "agentMessage", id: "late-final", text: LATE, phase: "final_answer" });
  host.emit({ ...common, type: "complete", method: "turn/completed", status: "completed" });
}

for (const mode of ["available", "withdrawn", "worker unavailable", "edited during handoff"]) {
  test(`handoff validates historical borrowed memory using worker proofs: ${mode}`, { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
      const session = f.createSession();
      const run = await f.send(session.sessionKey, "borrowed-before-handoff", "Find telescope memory");
      const found = await f.callTool(run, "memory_search", { query: "telescope", minScore: 0, ownerProfileId: f.B });
      assert.ok(found.results.some(item => item.ownerProfileId === f.B));
      const answer = "HISTORICAL_BORROWED_ANSWER_50931";
      await f.complete(run, answer);
      const { workRunCoordinator: coordinator, chatSessionStore, transcriptStore } = f.service;
      const old = chatSessionStore.getSession(session.sessionKey);
      assert.ok(transcriptStore.listEvents(old.profileId, old.id).some(event => event.content?.borrowedMemoryRefs?.length));
      if (mode === "withdrawn") f.service.nativeMemorySharingConfig.apply({ revision: 1,
        config: { enabled: true, excludedProfiles: [f.B] } });
      let scans = 0, synchronous = 0, compiled = null, edited = false;
      const readAsync = f.owner.withAsyncMemoryReadView.bind(f.owner);
      f.owner.withAsyncMemoryReadView = (id, ...args) => {
        if (id === f.B) {
          scans++;
          if (mode === "worker unavailable") return Promise.reject(Object.assign(new Error("controlled worker outage"),
            { code: "MEMORY_SCAN_UNAVAILABLE" }));
        }
        return readAsync(id, ...args);
      };
      const readSync = f.owner.withMemoryReadView.bind(f.owner);
      f.owner.withMemoryReadView = (id, read) => {
        if (id === f.B && !f.owner.memoryViewFor(id)) synchronous++;
        return readSync(id, read);
      };
      const compiler = coordinator.contextCompiler, compile = compiler.compile.bind(compiler);
      compiler.compile = input => {
        const snapshot = compile(input);
        if (input.run.id === `handoff-preview-${old.revision}`) {
          compiled = snapshot.dynamicContext;
          if (mode === "edited during handoff") {
            const file = path.join(f.owner.store.workspace(f.B), "MEMORY.md");
            fs.appendFileSync(file, "\nNew owner input invalidates the retained view.\n");
            edited = true;
          }
        }
        return snapshot;
      };
      if (mode === "edited during handoff") {
        await assert.rejects(f.switch(old.sessionKey, "pi"), { code: "CONTEXT_SOURCE_STALE" });
        assert.equal(edited, true);
        assert.deepEqual(chatSessionStore.getSession(old.sessionKey), old);
      } else {
        await f.switch(old.sessionKey, "pi");
        const switched = chatSessionStore.getSession(old.sessionKey);
        assert.equal(switched.runtimeSessionId, null);
        assert.notEqual(switched.runtimeBindingId, old.runtimeBindingId);
        if (mode === "available") assert.match(compiled, new RegExp(answer));
        else assert.doesNotMatch(compiled, new RegExp(answer));
      }
      assert.equal(synchronous, 0);
      assert.equal(scans > 0, mode !== "withdrawn");
    } finally { await f.close(); }
  });
}

test("model-only handoff cannot send a summary after the retained foreign proof changes", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const session = f.createSession();
    const run = await f.send(session.sessionKey, "borrowed-before-summary", "Find telescope memory");
    const found = await f.callTool(run, "memory_search", { query: "telescope", minScore: 0, ownerProfileId: f.B });
    assert.ok(found.results.some(item => item.ownerProfileId === f.B));
    await f.complete(run, "A foreign source informed this answer.");
    const { workRunCoordinator: coordinator, chatSessionStore, transcriptStore, nativeRuntimeConfig } = f.service;
    const old = chatSessionStore.getSession(session.sessionKey);
    const config = nativeRuntimeConfig.read();
    nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
      flags: { ...config.flags, runtimeContextLifecycleV1: true } });
    coordinator.beforeMemoryCompaction = null;
    coordinator.getRuntimeModelContextWindow = (_selected, profile) => profile.runtime === "pi" ? 96_000 : 1_000_000;
    for (let index = 0; index < 10; index++) transcriptStore.appendEvent({ profileId: old.profileId, sessionId: old.id,
      id: `foreign-summary-${index}`, kind: index % 2 ? "assistant" : "user",
      content: { text: `Input ${index} ${"ordinary words ".repeat(3400)}` } });
    let guards = 0, sent = 0, synchronous = 0;
    const readSync = f.owner.withMemoryReadView.bind(f.owner);
    f.owner.withMemoryReadView = (id, read) => {
      if (id === f.B && !f.owner.memoryViewFor(id)) synchronous++;
      return readSync(id, read);
    };
    const manager = coordinator.runtimeManager, acquire = manager.acquire.bind(manager);
    manager.canGenerateModelOnly = runtime => runtime === "pi";
    manager.acquire = async (...args) => {
      const handle = await acquire(...args);
      if (args[0].runtime !== "pi") return handle;
      const facade = Object.create(handle);
      Object.defineProperties(facade, {
        capabilities: { value: { ...handle.capabilities, "model.generate.toolFree": true } },
        generateModelOnly: { value: async input => {
          guards++;
          const file = path.join(f.owner.store.workspace(f.B), "MEMORY.md");
          fs.appendFileSync(file, "\nThe underlying foreign memory changed before dispatch.\n");
          input.assertCurrent();
          sent++;
          throw new Error("stale summary must never be sent");
        } },
      });
      return facade;
    };
    await assert.rejects(f.switch(old.sessionKey, "pi"), { code: "CHECKPOINT_STALE" });
    assert.equal(guards, 1);
    assert.equal(sent, 0);
    assert.equal(synchronous, 0);
    assert.deepEqual(chatSessionStore.getSession(old.sessionKey), old);
    assert.equal(f.service.conversationCheckpointStore.get(old.profileId, old.id), null);
  } finally { await f.close(); }
});

for (const withdraw of [false, true]) {
  test(`queued chat verifies historical borrowing in admission and compilation: ${withdraw ? "withdrawn" : "current"}`,
    { timeout: 30000 }, async () => {
      const f = await fixture();
      let release, firstSend, secondSend;
      try {
        const session = f.createSession(), coordinator = f.service.workRunCoordinator;
        const previous = await f.send(session.sessionKey, "borrowed-before-queued", "Find telescope memory");
        const found = await f.callTool(previous, "memory_search", { query: "telescope", minScore: 0, ownerProfileId: f.B });
        assert.ok(found.results.some(item => item.ownerProfileId === f.B));
        const historical = "BORROWED_HISTORICAL_ANSWER_90631";
        await f.complete(previous, historical);
        const old = f.service.chatSessionStore.getSession(session.sessionKey);
        const foreignRead = f.owner.withAsyncMemoryReadView.bind(f.owner);
        let entered = false;
        f.owner.withAsyncMemoryReadView = async (id, ...args) => {
          if (id === f.B && !entered) {
            entered = true;
            await new Promise(resolve => { release = resolve; });
          }
          return foreignRead(id, ...args);
        };
        const dependenciesCurrent = f.owner.sharing.dependenciesCurrent.bind(f.owner.sharing);
        let phase = null;
        const checks = { admit: [], compile: [] };
        f.owner.sharing.dependenciesCurrent = (profileId, sessionId, refs) => {
          const valid = dependenciesCurrent(profileId, sessionId, refs);
          if (phase && refs.some(ref => ref.ownerProfileId === f.B)) {
            checks[phase].push({ valid, view: Boolean(f.owner.memoryViewFor(f.B)) });
          }
          return valid;
        };
        const checkpoints = f.service.conversationCheckpointStore;
        const nativeSessionStale = checkpoints.nativeSessionStale.bind(checkpoints);
        checkpoints.nativeSessionStale = (...args) => {
          phase = "admit";
          try { return nativeSessionStale(...args); } finally { phase = null; }
        };
        const compiler = coordinator.contextCompiler, compile = compiler.compile.bind(compiler);
        let projected;
        compiler.compile = input => {
          phase = "compile";
          try {
            const value = compile(input);
            if (input.currentOperationId === "borrowed-queued-first") projected = value.dynamicContext;
            return value;
          } finally { phase = null; }
        };
        firstSend = coordinator.send({ sessionKey: old.sessionKey, operationId: "borrowed-queued-first", prompt: "Continue the project" });
        firstSend.catch(() => {});
        await waitUntil(() => entered, 5000, "foreign admission worker wait");
        secondSend = coordinator.send({ sessionKey: old.sessionKey, operationId: "borrowed-queued-second", prompt: "Continue further" });
        secondSend.catch(() => {});
        if (withdraw) f.service.nativeMemorySharingConfig.apply({ revision: 1,
          config: { enabled: true, excludedProfiles: [f.B] } });
        release(); release = null;
        const firstAck = await firstSend;
        await coordinator.waitForIdle(firstAck.run.id);
        await waitUntil(() => coordinator.getRun(firstAck.run.id).status === "running", 5000, "first queued input running");
        const secondAck = await secondSend;
        assert.equal(coordinator.getRun(secondAck.run.id).status, "queued");
        if (withdraw) {
          assert.notEqual(coordinator.getRun(firstAck.run.id).runtimeSessionRef.sessionId, old.runtimeSessionId);
          assert.doesNotMatch(projected, new RegExp(historical));
          assert.ok(checks.admit.every(check => !check.valid && check.view), "the acquired view cannot override exclusion");
          assert.ok(checks.compile.every(check => !check.valid && !check.view), "excluded proof is not acquired for compilation");
        } else {
          assert.equal(coordinator.getRun(firstAck.run.id).runtimeSessionRef.sessionId, old.runtimeSessionId);
          assert.match(projected, new RegExp(historical));
          assert.ok(checks.admit.length > 0 && checks.admit.every(check => check.valid && check.view));
          assert.ok(checks.compile.length > 0 && checks.compile.every(check => check.valid && check.view));
        }
        await f.complete(coordinator.getRun(firstAck.run.id));
        await waitUntil(() => coordinator.getRun(secondAck.run.id).status === "running", 5000, "second queued input running");
        await f.complete(coordinator.getRun(secondAck.run.id));
      } finally {
        release?.();
        await Promise.allSettled([firstSend, secondSend]);
        await f.close();
      }
    });
}

for (const action of ["exclude source", "delete source memory", "remove source file externally"]) {
  test(`in-flight borrowed source withdrawal interrupts real Coordinator and renews native session: ${action}`, { timeout: 30000 }, async () => {
    const f = await fixture(); let subscription;
    try {
      const session = f.createSession();
      const run = await f.send(session.sessionKey, "borrowed-inflight-first", "Find telescope memory");
      assert.equal(run.status, "running", run.errorCode);
      const coordinator = f.service.workRunCoordinator, events = [];
      subscription = coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
      const call = (name, args) => f.callTool(run, name, args);
      const found = await call("memory_search", { query: "telescope", minScore: 0, maxResults: 20, ownerProfileId: f.B });
      const borrowed = found.results.find(value => value.ownerProfileId === f.B);
      assert.ok(borrowed, "actual running chat must borrow through the real MCP controller");
      const read = await call("memory_get", { id: borrowed.sourceRef }); assert.match(read.text, /aquamarine/u);
      const host = f.transport.hosts.get("codex");
      host.emit({ known: true, type: "tool_result", method: "item/completed", threadId: run.runtimeSessionRef.sessionId,
        turnId: run.runtimeTurnRef.turnId, itemId: "borrowed-tool", toolCallId: "borrowed-tool",
        tool: { kind: "function", name: "memory_get", status: "completed", output: read } });
      host.emit({ known: true, type: "text", threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
        itemId: "before-withdrawal", text: "Historical answer before source withdrawal", phase: "final_answer" });
      await coordinator.waitForIdle(run.id);
      assert.ok(f.service.transcriptStore.listEvents(f.profile.id, session.id).some(event => event.content?.borrowedMemoryRefs?.length),
        "actual Coordinator records body-free dependencies before source withdrawal");
      const interruptsBefore = host.turnInterruptCalls;
      if (action === "exclude source") {
        f.service.nativeMemorySharingConfig.apply({ revision: 1, config: { enabled: true, excludedProfiles: [f.B] } });
        await f.owner.sharing.reconcileConfig();
      } else if (action === "delete source memory") {
        await f.owner.delete({ profileId: f.B, id: f.item.id, reason: "forgotten", operationId: "source-delete-inflight" });
      } else {
        fs.unlinkSync(path.join(f.owner.store.workspace(f.B), borrowed.canonicalRelativePath));
      }
      await waitUntil(() => coordinator.getRun(run.id).status === "interrupted", 5000, "borrowed source interruption");
      await coordinator.waitForIdle(run.id);
      assert.equal(host.turnInterruptCalls, interruptsBefore + 1, "the assigned actual Runtime handle receives turnInterrupt");
      assert.equal(host.lastTurnInterruptParams.threadId, run.runtimeSessionRef.sessionId);
      assert.equal(host.lastTurnInterruptParams.turnId, run.runtimeTurnRef.turnId);
      const terminal = coordinator.getRun(run.id);
      assert.equal(terminal.errorCode, "CONTEXT_BORROWED_MEMORY_REVOKED"); assert.equal(terminal.resultSummary, null);
      emitLate(host, run); await coordinator.waitForIdle(run.id);
      assert.doesNotMatch(JSON.stringify(events), new RegExp(LATE), "late text/tools are never published to subscribers");
      assert.equal(events.filter(event => event.type === "terminal").length, 1, "late complete cannot republish completion");
      assert.doesNotMatch(JSON.stringify(f.service.transcriptStore.listEvents(f.profile.id, session.id)), new RegExp(LATE),
        "late source-dependent output never enters replayable Product history");
      assert.doesNotMatch(JSON.stringify([...coordinator.lastErrors.values()].map(error => ({ code: error.code, message: error.message }))), /SERVICE_RECOVERY_REQUIRED|STORE_COMMIT_UNCERTAIN/u);
      const recoveryFile = path.join(f.paths.runtimeDir, "service-recovery.json");
      if (fs.existsSync(recoveryFile)) assert.doesNotMatch(fs.readFileSync(recoveryFile, "utf8"), /SERVICE_RECOVERY_REQUIRED|STORE_COMMIT_UNCERTAIN/u);
      const next = await f.send(session.sessionKey, "borrowed-inflight-next", "Continue with independent facts");
      assert.equal(next.status, "running", next.errorCode);
      assert.notEqual(next.runtimeSessionRef.sessionId, run.runtimeSessionRef.sessionId, "withdrawn dependency retires the old native session before the next turn");
      const contract = f.transport.acquisitions.at(-1).options.executionContract;
      assert.equal(contract.contextFresh, true); assert.doesNotMatch(contract.dynamicContext, /aquamarine|REVOKED_LATE_BODY/u);
      await f.complete(next, "Independent continuation after source withdrawal");
      const stable = await f.send(session.sessionKey, "borrowed-inflight-stable", "Continue again");
      assert.equal(stable.status, "running", stable.errorCode);
      assert.equal(stable.runtimeSessionRef.sessionId, next.runtimeSessionRef.sessionId, "fresh native session remains reusable");
      await f.complete(stable);
    } finally { subscription?.unsubscribe(); await f.close(); }
  });
}

test("a pending source-withdrawal interrupt filters late events and joins one native interruption", { timeout: 30000 }, async () => {
  const f = await fixture(); let release, withdrawing, subscription;
  try {
    const session = f.createSession(), coordinator = f.service.workRunCoordinator;
    const run = await f.send(session.sessionKey, "borrowed-pending-interrupt", "Find telescope memory");
    assert.equal(run.status, "running", run.errorCode);
    const found = await f.callTool(run, "memory_search", { query: "telescope", memoryScope: "all", minScore: 0 });
    assert.ok(found.results.some(value => value.ownerProfileId === f.B && value.borrowed));
    const host = f.transport.hosts.get("codex"), events = [], before = host.turnInterruptCalls;
    subscription = coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
    host.interruptGate = { promise: new Promise(resolve => { release = resolve; }) };
    f.service.nativeMemorySharingConfig.apply({ revision: 1, config: { enabled: true, excludedProfiles: [f.B] } });
    withdrawing = f.owner.sharing.reconcileConfig();
    await waitUntil(() => host.turnInterruptCalls > before, 5000, "assigned native interrupt begins");
    assert.equal(coordinator.getRun(run.id).status, "running", "the physical interruption remains pending in the fixture");
    emitLate(host, run);
    await new Promise(resolve => setImmediate(resolve));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(LATE), "revoked output is filtered even before interruption returns");
    assert.doesNotMatch(JSON.stringify(f.service.transcriptStore.listEvents(f.profile.id, session.id)), new RegExp(LATE));
    assert.equal(host.turnInterruptCalls, before + 1, "concurrent late text/tool/complete events join the already pending native interruption");
    release(); await withdrawing;
    await waitUntil(() => coordinator.getRun(run.id).status === "interrupted", 5000, "source withdrawal finishes");
    await coordinator.waitForIdle(run.id);
    assert.equal(events.filter(event => event.type === "terminal").length, 1);
    assert.equal(coordinator.getRun(run.id).errorCode, "CONTEXT_BORROWED_MEMORY_REVOKED");
    assert.equal(coordinator.lastErrors.size, 0);
  } finally {
    release?.(); await withdrawing?.catch(() => {});
    subscription?.unsubscribe(); await f.close();
  }
});

for (const outcome of ["publish", "withdraw", "unavailable"]) {
  test(`runtime output batches use asynchronous source proof: ${outcome}`, { timeout: 30000 }, async () => {
    const f = await fixture(); let release, subscription, pending;
    try {
      const session = f.createSession(), coordinator = f.service.workRunCoordinator, events = [];
      const run = await f.send(session.sessionKey, "borrowed-output-batch", "Find telescope memory");
      const found = await f.callTool(run, "memory_search", { query: "telescope", ownerProfileId: f.B, minScore: 0 });
      assert.ok(found.results.some(value => value.ownerProfileId === f.B && value.borrowed));
      const host = f.transport.hosts.get("codex");
      subscription = coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
      const sharing = f.owner.sharing, original = sharing.withRunReadProof.bind(sharing);
      const gate = new Promise(resolve => { release = resolve; });
      const batches = [];
      sharing.withRunReadProof = async (id, signal, publish) => {
        batches.push(id);
        await gate;
        return original(id, signal, publish);
      };
      let failedScans = 0;
      if (outcome === "unavailable") {
        const read = f.owner.withAsyncMemoryReadView.bind(f.owner);
        f.owner.withAsyncMemoryReadView = (id, signal, callback, scanSignal) => {
          if (id === f.B) {
            failedScans++;
            return Promise.reject(Object.assign(new Error("controlled worker outage"), { code: "MEMORY_SCAN_UNAVAILABLE" }));
          }
          return read(id, signal, callback, scanSignal);
        };
      }
      const proofRead = f.owner.withMemoryReadView.bind(f.owner);
      let synchronousOwnerViews = 0;
      f.owner.withMemoryReadView = (id, read) => {
        if (id === f.B && !f.owner.memoryViewFor(id)) synchronousOwnerViews++;
        return proofRead(id, read);
      };
      const sourceFiles = f.owner.host(f.B).searchIndex.sourceFiles;
      const readBytes = sourceFiles.readBytes.bind(sourceFiles);
      let synchronousBodies = 0;
      const originalEvidence = sharing.assertDependencyCurrent.bind(sharing);
      sharing.assertDependencyCurrent = (...args) => {
        const previous = sourceFiles.readBytes;
        sourceFiles.readBytes = (...input) => {
          synchronousBodies++;
          return readBytes(...input);
        };
        try { return originalEvidence(...args); } finally { sourceFiles.readBytes = previous; }
      };
      const label = "BORROWED_BATCH_VISIBLE_8571";
      const fragment = `${label} 中文🙂\n`.repeat(2);
      const thread = host.threads.find(value => value.id === run.runtimeSessionRef.sessionId);
      const turn = thread.turns.find(value => value.id === run.runtimeTurnRef.turnId);
      // A native pipe can deliver hundreds of small deltas before the source
      // worker responds. No part of this burst may bypass the same proof.
      for (const type of ["reasoning_delta", "text_delta"]) {
        for (let index = 0; index < 1024; index++) {
          host.emit({ known: true, type, threadId: thread.id, turnId: turn.id,
            itemId: `batch-${type}`, delta: fragment, ...(type === "text_delta" ? { phase: "commentary" } : {}) });
        }
      }
      for (let index = 0; index < 6; index++) {
        host.emit({ known: true, type: "text", threadId: thread.id, turnId: turn.id,
          itemId: `batch-${index}`, text: `${label}_${index}`, phase: "final_answer" });
      }
      if (outcome !== "publish") {
        turn.status = "completed";
        turn.items.push({ type: "agentMessage", id: "revoked-answer", text: label, phase: "final_answer" });
        host.emit({ known: true, type: "complete", threadId: thread.id, turnId: turn.id });
      }
      pending = coordinator.waitForIdle(run.id);
      await waitUntil(() => batches.length > 0, 2000, "worker source proof starts");
      assert.equal(coordinator.getRun(run.id).status, "running");
      assert.doesNotMatch(JSON.stringify(events), new RegExp(label));
      if (outcome === "withdraw") {
        fs.unlinkSync(path.join(f.owner.store.workspace(f.B), found.results.find(value => value.borrowed).canonicalRelativePath));
      }
      release(); await pending;
      if (outcome !== "publish") {
        await waitUntil(() => coordinator.getRun(run.id).status === "interrupted", 5000, "unavailable source interrupts output");
        assert.equal(coordinator.getRun(run.id).errorCode, outcome === "withdraw" ? "CONTEXT_BORROWED_MEMORY_REVOKED" : "CONTEXT_MEMORY_READ_UNAVAILABLE");
        if (outcome === "unavailable") {
          assert.ok(failedScans >= 3, "the worker outage is checked with bounded retries");
          assert.ok(coordinator.telemetry.events.some(event => event.stage === "borrowed_output_scan_failed" && event.code === "MEMORY_SCAN_UNAVAILABLE"));
        }
        assert.doesNotMatch(JSON.stringify(events), new RegExp(label));
        assert.doesNotMatch(JSON.stringify(f.service.transcriptStore.listEvents(f.profile.id, session.id)), new RegExp(label));
      } else {
        const messages = f.service.transcriptStore.listEvents(f.profile.id, session.id).filter(event => event.content?.text?.startsWith(label));
        assert.deepEqual(messages.map(event => event.content.text), Array.from({ length: 6 }, (_, i) => `${label}_${i}`));
        for (const type of ["reasoning.delta", "text.delta"]) {
          const deltas = events.filter(event => event.type === type && event.payload.itemId === `batch-${type.replace(".", "_")}`);
          assert.equal(deltas.map(event => event.payload.delta).join(""), fragment.repeat(1024), "every UTF-8 fragment is delivered in order");
          assert.ok(deltas.every(event => Buffer.byteLength(JSON.stringify(event)) < 48 * 1024), "coalescing stays within the existing public event limit");
        }
      }
      assert.deepEqual(batches, [run.id]);
      assert.equal(synchronousOwnerViews, 0, "output must never fall back to a synchronous owner scan");
      assert.equal(synchronousBodies, 0, "output uses markdown already read and hashed by the worker");
      if (outcome === "publish") await f.complete(run);
    } finally {
      release?.(); await pending?.catch(() => {});
      subscription?.unsubscribe(); await f.close();
    }
  });
}

for (const outcome of ["continue", "tool follow-up", "withdraw", "timeout"]) {
  test(`long conversation verifies pending output again: ${outcome}`, { timeout: 45000 }, async () => {
    const f = await fixture();
    let release, subscription;
    try {
      const { workRunCoordinator: coordinator, nativeRuntimeConfig, transcriptStore, mcpProductToolController } = f.service;
      const config = nativeRuntimeConfig.read();
      nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1, flags: { ...config.flags, runtimeContextLifecycleV1: true } });
      const session = f.createSession();
      for (let index = 0; index < 48; index++) transcriptStore.appendEvent({ profileId: f.profile.id, sessionId: session.id,
        id: `long-history-${index}`, kind: index % 2 ? "user" : "assistant", content: { text: `Sample ${index}. ${"ordinary project notes ".repeat(140)}` } });
      const run = await f.send(session.sessionKey, "borrowed-after-compaction", "Continue checking the telescope calibration.");
      assert.equal(run.status, "running", run.errorCode);
      const found = await f.callTool(run, "memory_search", { query: "telescope", ownerProfileId: f.B, minScore: 0 });
      const ref = found.results.find(item => item.ownerProfileId === f.B && item.borrowed);
      const host = f.transport.hosts.get("codex"), events = [];
      const { sessionId: threadId, turnId } = run.runtimeTurnRef;
      const emit = event => host.emit({ known: true, threadId, turnId, ...event });
      subscription = coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
      const memory = mcpProductToolController.conversationMemoryService;
      const get = memory.get.bind(memory);
      let toolCalls = 0;
      memory.get = (...args) => { toolCalls++; return get(...args); };
      const read = await f.callTool(run, "memory_get", { id: ref.sourceRef });
      assert.match(read.text, /aquamarine/u);
      const launches = host.turnStartCalls;
      const sharing = f.owner.sharing, check = sharing.withRunReadProof.bind(sharing);
      const retryGate = new Promise(resolve => { release = resolve; });
      let checks = 0;
      sharing.withRunReadProof = async (id, signal, publish, ...args) => {
        if (id === run.id) {
          checks++;
          if (checks === 1 || checks === 2 && outcome === "timeout") {
            await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
            signal.throwIfAborted();
          }
          if (checks === 2) await retryGate;
        }
        return check(id, signal, publish, ...args);
      };
      if (outcome !== "tool follow-up") emit({ type: "context_compacted", compactionId: "test-compaction", contextUsage: {
        runtimeSessionId: threadId, usedTokens: 8000, contextWindow: 128000, quality: "exact", source: "runtime_event", observedAt: Date.now() } });
      const call = { kind: "function", name: "memory_get", status: "completed" };
      emit({ type: "tool_result", method: "item/completed", itemId: "read", toolCallId: "read", tool: { ...call, output: read } });
      const answer = `Verified result: ${FACT}`;
      emit({ type: "text", method: "item/completed", itemId: "result", phase: "final_answer", text: answer });
      const turn = host.threads.find(thread => thread.id === threadId).turns.find(item => item.id === turnId);
      turn.status = "completed"; turn.items.push({ type: "agentMessage", id: "result", text: answer, phase: "final_answer" });
      emit({ type: "complete", method: "turn/completed", status: "completed" });
      await waitUntil(() => checks === 2, 10000, "same batch begins its second proof");
      assert.equal(coordinator.getRun(run.id).status, "running");
      assert.doesNotMatch(JSON.stringify(events), /Verified result/);
      let withdrawal;
      if (outcome === "withdraw") {
        const interrupts = host.turnInterruptCalls;
        withdrawal = f.owner.delete({ profileId: f.B, id: f.item.id, reason: "forgotten", operationId: "withdraw-during-retry" });
        await waitUntil(() => host.turnInterruptCalls > interrupts, 5000, "withdrawal fences the outstanding proof");
      }
      release();
      await withdrawal;
      await waitUntil(() => ["completed", "interrupted"].includes(coordinator.getRun(run.id).status), 10000, "terminal result");
      await coordinator.waitForIdle(run.id);
      const history = transcriptStore.listEvents(f.profile.id, session.id).filter(e => e.runId === run.id);
      assert.equal(history.filter(e => e.content?.transcriptType === "context.native.compacted").length, outcome === "tool follow-up" ? 0 : 1);
      assert.equal(toolCalls, 1, "memory_get executes once");
      assert.equal(host.turnStartCalls, launches, "verification never starts another native turn");
      assert.equal(events.filter(e => e.type === "terminal").length, 1);
      const result = coordinator.getRun(run.id);
      const stages = coordinator.telemetry.events.filter(event => event.stage?.startsWith("borrowed_output_")).map(event => event.stage);
      if (outcome === "continue" || outcome === "tool follow-up") {
        assert.equal(result.status, "completed", result.errorCode);
        assert.deepEqual(history.filter(e => e.kind === "assistant").map(e => e.content.text), [answer]);
        assert.equal(history.filter(e => e.kind === "tool_result").length, 1);
        assert.deepEqual(stages, ["borrowed_output_timeout", "borrowed_output_recovered"]);
        if (outcome === "continue") {
          const next = await f.send(session.sessionKey, "borrowed-next-turn", "Continue the telescope check with its existing source.");
          assert.equal(next.runtimeTurnRef.sessionId, threadId);
          assert.notEqual(next.runtimeTurnRef.turnId, turnId);
          const again = await f.callTool(next, "memory_search", { query: "telescope", ownerProfileId: f.B, minScore: 0 });
          const nextRef = again.results.find(item => item.ownerProfileId === f.B && item.borrowed);
          assert.match((await f.callTool(next, "memory_get", { id: nextRef.sourceRef })).text, /aquamarine/u);
          let nextProofs = 0;
          sharing.withRunReadProof = (id, ...args) => {
            if (id === next.id && ++nextProofs === 1) throw new DOMException("controlled second-turn deadline", "TimeoutError");
            return check(id, ...args);
          };
          await f.complete(next, "The second telescope check is complete.");
          assert.equal(toolCalls, 2, "one tool execution per user turn even with two consecutive proof timeouts");
          assert.equal(host.turnStartCalls, launches + 1);
        }
      } else {
        assert.equal(result.status, "interrupted");
        assert.equal(result.errorCode, outcome === "withdraw" ? "CONTEXT_BORROWED_MEMORY_REVOKED" : "CONTEXT_MEMORY_VERIFICATION_TIMEOUT");
        assert.doesNotMatch(JSON.stringify([events, history]), /Verified result|aquamarine/);
        assert.equal(checks, 2);
        assert.deepEqual(stages, ["borrowed_output_timeout", outcome === "withdraw" ? "borrowed_output_revoked" : "borrowed_output_timeout"]);
      }
    } finally { release?.(); subscription?.unsubscribe(); await f.close(); }
  });
}

test("a timeout while committing the terminal result retries only the source proof", { timeout: 30000 }, async () => {
  const f = await fixture();
  let subscription;
  try {
    const session = f.createSession(), coordinator = f.service.workRunCoordinator;
    const run = await f.send(session.sessionKey, "borrowed-terminal-retry", "Find telescope memory");
    await f.callTool(run, "memory_search", { query: "telescope", ownerProfileId: f.B, minScore: 0 });
    const sharing = f.owner.sharing, check = sharing.withRunReadProof.bind(sharing);
    const events = [], signals = [];
    subscription = coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
    sharing.withRunReadProof = async (id, signal, ...args) => {
      if (id === run.id && !coordinator.borrowedOutput.has(id)) {
        signals.push(signal);
        if (signals.length === 1) throw new DOMException("controlled terminal deadline", "TimeoutError");
      }
      return check(id, signal, ...args);
    };
    await f.complete(run, "Verified terminal result");
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
    assert.equal(events.filter(event => event.type === "terminal").length, 1);
    assert.deepEqual(f.service.transcriptStore.listEvents(f.profile.id, session.id).filter(event => event.kind === "assistant")
      .map(event => event.content.text), ["Verified terminal result"]);
  } finally { subscription?.unsubscribe(); await f.close(); }
});

test("borrowed output preserves message, phase, reasoning-part and status boundaries", { timeout: 30000 }, async () => {
  const f = await fixture(); let release, subscription;
  try {
    const session = f.createSession(), coordinator = f.service.workRunCoordinator, events = [];
    const run = await f.send(session.sessionKey, "borrowed-output-boundaries", "Find telescope memory");
    await f.callTool(run, "memory_search", { query: "telescope", ownerProfileId: f.B, minScore: 0 });
    const host = f.transport.hosts.get("codex"), sharing = f.owner.sharing;
    const original = sharing.withRunReadProof.bind(sharing), gate = new Promise(resolve => { release = resolve; });
    sharing.withRunReadProof = async (...args) => { await gate; return original(...args); };
    subscription = coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
    const common = { known: true, threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId };
    const fragments = [
      { type: "text_delta", itemId: "message-a", phase: "commentary", delta: "one " },
      { type: "text_delta", itemId: "message-a", phase: "commentary", delta: "two" },
      { type: "text_delta", itemId: "message-a", phase: "final_answer", delta: "final" },
      { type: "text_delta", itemId: "message-b", phase: "final_answer", delta: "other" },
      { type: "reasoning_delta", itemId: "reasoning", summaryIndex: 0, delta: "part zero" },
      { type: "reasoning_delta", itemId: "reasoning", summaryIndex: 1, delta: "part one" },
      { type: "reasoning_delta", itemId: "reasoning", summaryIndex: 1, contentIndex: 0, delta: "content zero" },
      { type: "reasoning_delta", itemId: "reasoning", summaryIndex: 1, contentIndex: 1, delta: "before status" },
      { type: "status", method: "diagnostic/status", status: "inProgress" },
      { type: "reasoning_delta", itemId: "reasoning", summaryIndex: 1, contentIndex: 1, delta: "after status" },
    ];
    for (const event of fragments) host.emit(Object.freeze({ ...common, ...event }));
    await new Promise(resolve => setImmediate(resolve));
    assert.doesNotMatch(JSON.stringify(events), /part zero|one two|after status/, "unverified deltas stay private");
    release();
    await waitUntil(() => !coordinator.borrowedOutput.has(run.id), 5000, "borrowed output drains");
    const delivered = events.filter(event => ["text.delta", "reasoning.delta"].includes(event.type)
      || event.type === "status" && event.payload.method === "diagnostic/status");
    assert.deepEqual(delivered.map(event => Object.fromEntries(Object.entries({
      type: event.type.replace(".", "_"), itemId: event.payload.itemId, phase: event.payload.phase,
      summaryIndex: event.payload.summaryIndex, contentIndex: event.payload.contentIndex,
      delta: event.payload.delta, method: event.type === "status" ? event.payload.method : undefined,
      status: event.type === "status" ? event.payload.status : undefined,
    }).filter(([, value]) => value !== undefined))), [
      { type: "text_delta", itemId: "message-a", phase: "commentary", delta: "one two" },
      ...fragments.slice(2),
    ]);
    assert.equal(fragments[0].delta, "one ", "source events are not mutated");
    assert.equal(coordinator.borrowedOutputBytes, 0);
    await f.complete(run);
  } finally { release?.(); subscription?.unsubscribe(); await f.close(); }
});

for (const limit of ["events", "bytes"]) {
  test(`borrowed output retains the ${limit} limit and reports output capacity`, { timeout: 30000 }, async () => {
    const f = await fixture(); let release;
    try {
      const session = f.createSession(), coordinator = f.service.workRunCoordinator;
      const run = await f.send(session.sessionKey, `borrowed-output-limit-${limit}`, "Find telescope memory");
      await f.callTool(run, "memory_search", { query: "telescope", ownerProfileId: f.B, minScore: 0 });
      const host = f.transport.hosts.get("codex"), sharing = f.owner.sharing;
      const original = sharing.withRunReadProof.bind(sharing), gate = new Promise(resolve => { release = resolve; });
      sharing.withRunReadProof = async (...args) => { await gate; return original(...args); };
      const common = { known: true, threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId };
      if (limit === "events") {
        for (let index = 0; index < 257; index++) host.emit({ ...common, type: "status", status: `distinct-${index}` });
      } else host.emit({ ...common, type: "text_delta", itemId: "oversized", delta: "x".repeat(16 * 1024 * 1024) });
      release();
      await waitUntil(() => coordinator.getRun(run.id).status === "interrupted", 5000, "buffer capacity interrupts output");
      assert.equal(coordinator.getRun(run.id).errorCode, "RUNTIME_OUTPUT_LIMIT_EXCEEDED");
      await waitUntil(() => !coordinator.borrowedOutput.has(run.id), 5000, "stopped output is released");
      assert.equal(coordinator.borrowedOutputBytes, 0);
    } finally { release?.(); await f.close(); }
  });
}

test("automatic recall anchors a resumed native session before acceptance and survives restart before withdrawal", { timeout: 60000 }, async () => {
  let f = await fixture(true);
  try {
    require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(f.owner);
    let calls = 0;
    f.owner.complete = async ({ prompt }) => {
      calls++; assert.match(prompt, /aquamarine/u);
      return { text: JSON.stringify({ summary: FACT }) };
    };
    const session = f.createSession(), store = f.service.conversationCheckpointStore;
    const seed = await f.send(session.sessionKey, "auto-anchor-seed", "Hello");
    assert.equal(seed.status, "running", seed.errorCode); await f.complete(seed, "Hello");
    assert.equal(calls, 0);
    const nativeId = seed.runtimeSessionRef.sessionId, bindingId = f.binding("codex").id;
    assert.deepEqual(store.nativeSessionBorrowedMemoryRefs(f.profile.id, session.id, nativeId, bindingId), []);
    const host = f.transport.hosts.get("codex"), beforeAcceptance = [];
    const turnStart = host.turnStart.bind(host);
    host.turnStart = async params => {
      beforeAcceptance.push(store.nativeSessionBorrowedMemoryRefs(f.profile.id, session.id, params.threadId, bindingId));
      return turnStart(params);
    };
    const recalled = await f.send(session.sessionKey, "auto-anchor-recall", "Do you remember telescope calibration?");
    assert.equal(recalled.status, "running", recalled.errorCode);
    assert.equal(recalled.runtimeSessionRef.sessionId, nativeId, "first borrow should reuse the still-valid seed session");
    assert.ok(calls > 0, "the real pre-admission Active Memory path ran");
    assert.ok(beforeAcceptance.at(-1).some(ref => ref.ownerProfileId === f.B), "automatic borrow must be durable before turnStart");
    await f.complete(recalled, FACT);
    const compiler = f.service.contextCompiler, compile = compiler.compile.bind(compiler);
    compiler.compile = input => ({ ...compile(input), nativeBorrowedMemoryRefs: [] });
    const independent = await f.send(session.sessionKey, "auto-anchor-followup", "Hello again");
    compiler.compile = compile;
    assert.equal(independent.runtimeSessionRef.sessionId, nativeId);
    assert.ok(beforeAcceptance.at(-1).some(ref => ref.ownerProfileId === f.B));
    assert.ok(f.owner.sharing.borrowedRefsForRun(independent.id).some(ref => ref.ownerProfileId === f.B),
      "old native dependencies remain registered for in-flight withdrawal even with a shorter new snapshot");
    await f.complete(independent, "Hello again");
    host.turnStart = turnStart;
    const { root, transport, B, item, memoryCoreConfig } = f;
    await f.close({ remove: false });
    f = await openHandoffFixture({ root, transport, serviceOptions: { memoryCore: true,
      memorySharingFeatureReady: true, memoryCoreConfig } });
    const owner = f.service.memoryEngine, reopened = f.service.conversationCheckpointStore;
    assert.ok(reopened.nativeSessionBorrowedMemoryRefs(f.profile.id, session.id, nativeId, bindingId).some(ref => ref.ownerProfileId === B));
    await owner.delete({ profileId: B, id: item.id, reason: "forgotten", operationId: "auto-anchor-withdraw" });
    assert.equal(reopened.nativeSessionStale(f.profile.id, session.id, nativeId, bindingId), true);
    const renewed = await f.send(session.sessionKey, "auto-anchor-renewed", "Hello after restart");
    assert.equal(renewed.status, "running", renewed.errorCode);
    assert.notEqual(renewed.runtimeSessionRef.sessionId, nativeId);
    const contract = f.transport.acquisitions.at(-1).options.executionContract;
    assert.equal(contract.contextFresh, true); assert.doesNotMatch(contract.dynamicContext, /aquamarine/u);
    await f.complete(renewed, "Independent answer");
  } finally { await f.close(); }
});


test("an unwritable resumed native anchor stops automatic borrowing before remote acceptance", { timeout: 30000 }, async () => {
  const f = await fixture(true);
  try {
    require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(f.owner);
    f.owner.complete = async ({ prompt }) => {
      assert.match(prompt, /aquamarine/u); return { text: JSON.stringify({ summary: FACT }) };
    };
    const session = f.createSession(), seed = await f.send(session.sessionKey, "resumed-anchor-seed", "Hello");
    assert.equal(seed.status, "running", seed.errorCode); await f.complete(seed, "Hello");
    const host = f.transport.hosts.get("codex"), accepted = host.turnStartCalls;
    f.service.conversationCheckpointStore.recordNativeSession = () => {
      throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
    };
    const denied = await f.send(session.sessionKey, "resumed-anchor-full", "Do you remember telescope calibration?");
    assert.notEqual(denied.status, "running");
    assert.equal(host.turnStartCalls, accepted, "the borrowed turn never reaches native acceptance without durable dependencies");
  } finally { await f.close(); }
});


for (const question of ["Do you remember telescope calibration?",
  "Do you remember the telescope calibration previously recorded here?"]) {
  test(`fresh recall survives native renewal after source update and withdrawal: ${question}`, { timeout: 60000 }, async () => {
    const f = await fixture(true);
    try {
      require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(f.owner);
      const C = "source-c", secondary = "The telescope calibration interval is 23 days.";
      const source = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
      Object.assign(source, { id: C, agentId: C, runtimeProfileId: C, name: C, isDefault: false });
      f.service.productStore.putAgentProfile(source); f.service.agentDefinitionStore.ensureProfile({ profileId: C });
      f.owner.store.ensureProfile(C); f.owner.recallPolicy.assertReady(C);
      await f.owner.propose({ profileId: C, content: secondary, scope: "agent", classification: "explicit",
        sourceRefs: ["user-edit:inflight-secondary"] });
      const updatedFact = FACT.replace("aquamarine", "jade"), session = f.createSession();
      let expected = FACT, calls = 0;
      f.owner.complete = async ({ prompt }) => {
        calls++; assert.match(prompt, /23 days/u);
        if (expected) assert.ok(prompt.includes(expected), "model must receive the current source value");
        if (expected !== FACT) assert.doesNotMatch(prompt, /aquamarine/u);
        if (!expected) assert.doesNotMatch(prompt, /jade/u);
        return { text: JSON.stringify({ summary: [expected, secondary].filter(Boolean).join(" ") }) };
      };
      const recall = async (label, owners) => {
        const before = calls, run = await f.send(session.sessionKey, `renewal-recall-${label}`, question);
        assert.equal(run.status, "running", run.errorCode);
        assert.ok(calls > before, `${label} must perform a fresh automatic recall`);
        const contract = f.transport.acquisitions.at(-1).options.executionContract;
        assert.match(contract.dynamicContext, /<active_memory_plugin>/u, `${label} must deliver fresh recall to the native turn`);
        assert.match(contract.dynamicContext, /23 days/u);
        if (expected) assert.ok(contract.dynamicContext.includes(expected));
        if (expected !== FACT) assert.doesNotMatch(contract.dynamicContext, /aquamarine/u);
        if (!expected) assert.doesNotMatch(contract.dynamicContext, /jade/u);
        const anchor = f.service.conversationCheckpointStore.nativeSessionBorrowedMemoryRefs(
          f.profile.id, session.id, run.runtimeSessionRef.sessionId, f.binding("codex").id);
        assert.deepEqual([...new Set(anchor.map(ref => ref.ownerProfileId))].sort(), owners.sort());
        await f.complete(run, [expected, secondary].filter(Boolean).join(" "));
        return run;
      };
      const initial = await recall("initial", [f.B, C]);
      expected = updatedFact;
      const item = await f.owner.update({ profileId: f.B, id: f.item.id, content: updatedFact,
        sourceRef: "user-edit:inflight-update" });
      const updated = await recall("updated", [f.B, C]);
      assert.notEqual(updated.runtimeSessionRef.sessionId, initial.runtimeSessionRef.sessionId);
      expected = null;
      await f.owner.delete({ profileId: f.B, id: item.id, reason: "forgotten", operationId: "fresh-recall-withdraw" });
      const withdrawn = await recall("withdrawn", [C]);
      assert.notEqual(withdrawn.runtimeSessionRef.sessionId, updated.runtimeSessionRef.sessionId);
      assert.ok(f.transport.acquisitions.every(row => row.binding.runtimeProfileId === f.profile.runtimeProfileId),
        "source Profiles must not start a native Runtime");
    } finally { await f.close(); }
  });
}


for (const change of ["update", "withdraw"]) {
  test(`concurrent queue wakes wait for fresh recall after source ${change}`, { timeout: 60000 }, async () => {
    const f = await fixture(true); let release;
    try {
      require("./fixtures/literal-memory-model-control.cjs").installLiteralMemoryModelControl(f.owner);
      const coordinator = f.service.workRunCoordinator;
      coordinator.onConversationRenewed = () => f.controller.auditPending();
      const config = f.service.nativeRuntimeConfig.read();
      f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1,
        flags: { ...config.flags, runtimeAdmissionV1: true, runtimeContextLifecycleV1: true } });
      const C = "source-c", secondary = "The telescope calibration interval is 23 days.";
      const source = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
      Object.assign(source, { id: C, agentId: C, runtimeProfileId: C, name: C, isDefault: false });
      f.service.productStore.putAgentProfile(source); f.service.agentDefinitionStore.ensureProfile({ profileId: C });
      f.owner.store.ensureProfile(C); f.owner.recallPolicy.assertReady(C);
      await f.owner.propose({ profileId: C, content: secondary, scope: "agent", classification: "explicit",
        sourceRefs: ["user-edit:concurrent-secondary"] });
      const session = f.createSession(), question = "Do you remember the telescope calibration previously recorded here?";
      f.owner.complete = async () => ({ text: JSON.stringify({ summary: `${FACT} ${secondary}` }) });
      const initial = await f.send(session.sessionKey, `concurrent-${change}-initial`, question);
      assert.equal(initial.status, "running", initial.errorCode); await f.complete(initial, FACT);
      const expected = change === "update" ? FACT.replace("aquamarine", "jade") : null;
      if (expected) await f.owner.update({ profileId: f.B, id: f.item.id, content: expected,
        sourceRef: "user-edit:concurrent-update" });
      else await f.owner.delete({ profileId: f.B, id: f.item.id, reason: "forgotten", operationId: "concurrent-source-withdraw" });
      const gate = new Promise(resolve => { release = resolve; }); let entered = false;
      f.owner.complete = async ({ prompt }) => {
        assert.match(prompt, /23 days/u); assert.doesNotMatch(prompt, /aquamarine/u);
        if (expected) assert.ok(prompt.includes(expected)); else assert.doesNotMatch(prompt, /jade/u);
        entered = true; await gate;
        return { text: JSON.stringify({ summary: [expected, secondary].filter(Boolean).join(" ") }) };
      };
      const sending = f.send(session.sessionKey, `concurrent-${change}-changed`, question);
      const observedSend = sending.then(value => ({ value }), error => ({ error }));
      await waitUntil(() => entered, 5000, "fresh recall waiting for the controlled model");
      const wakes = [coordinator.capacityChanged(), coordinator.capacityChanged()];
      const observedWakes = Promise.allSettled(wakes);
      await new Promise(resolve => setImmediate(resolve));
      const queued = coordinator.listSessionRuns(session.sessionKey).at(-1);
      assert.equal(queued.status, "queued", "main turn must wait for this turn's recall");
      assert.equal(f.transport.acquisitions.filter(row => row.options.executionContract?.runId === queued.id).length, 0);
      release();
      const sent = await observedSend, wakeResults = await observedWakes;
      assert.ifError(sent.error);
      for (const result of wakeResults) if (result.status === "rejected") throw result.reason;
      const run = sent.value; assert.equal(run.status, "running", run.errorCode);
      const acquisitions = f.transport.acquisitions.filter(row => row.options.executionContract?.runId === run.id);
      assert.equal(acquisitions.length, 1, "one native main turn is accepted with the prepared recall");
      const contract = acquisitions[0].options.executionContract;
      assert.match(contract.dynamicContext, /<active_memory_plugin>/u); assert.match(contract.dynamicContext, /23 days/u);
      assert.doesNotMatch(contract.dynamicContext, /aquamarine/u);
      if (expected) assert.ok(contract.dynamicContext.includes(expected)); else assert.doesNotMatch(contract.dynamicContext, /jade/u);
      assert.notEqual(run.runtimeSessionRef.sessionId, initial.runtimeSessionRef.sessionId);
      const refs = f.service.conversationCheckpointStore.nativeSessionBorrowedMemoryRefs(
        f.profile.id, session.id, run.runtimeSessionRef.sessionId, f.binding("codex").id);
      assert.deepEqual([...new Set(refs.map(ref => ref.ownerProfileId))].sort(), (expected ? [f.B, C] : [C]).sort());
      assert.ok(f.transport.acquisitions.every(row => row.binding.runtimeProfileId === f.profile.runtimeProfileId));
      await f.complete(run, [expected, secondary].filter(Boolean).join(" "));
    } finally { release?.(); await f.close(); }
  });
}
