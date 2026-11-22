#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { BridgeRuntime } from "../resources/deepseek-harness/shoggoth-dsh-bridge.mjs";

test("reads only the active DeepSeek account's positive recharge and bonus balances", async () => {
  let account;
  const bridge = new BridgeRuntime({ get: name => name === "deepseekAccount" ? account : null,
    credentials: { describe: async () => null, listRecords: async () => [{}] } });
  const quota = () => bridge.dispatch("quota/read", { version: "0.1.1-rc.2" });
  assert.deepEqual(await quota(), { status: "unsupported" });
  let state = "signed-out";
  let balance = {
    status: "ready",
    value: [{ currency: "CNY", balance: "2.45", grant: "private" }, { currency: "USD", balance: "0E-16" }],
    bonusWallets: [{ currency: "CNY", balance: "5.0000000" }, { currency: "USD", balance: "0x2" }],
  };
  account = {
    getState: async () => ({ status: state }),
    getProfile: async () => ({ status: "ready", value: { name: "DeepSeek 示例账号", id: "private-id" } }),
    getBalance: async client => {
      assert.equal(client.version, "0.1.1-rc.2");
      return balance;
    },
  };
  assert.deepEqual(await quota(), { status: "unsupported" });
  state = "credential-stored";
  assert.deepEqual(await quota(), { status: "available", accountName: "DeepSeek 示例账号", wallets: [
    { kind: "recharge", amount: 2.45, unit: "CNY" },
    { kind: "bonus", amount: 5, unit: "CNY" },
  ] });
  let accountId = "private-account-a";
  account.getPlatformSession = async () => ({ origin: "https://example.test", accountId });
  const auth = () => bridge.dispatch("auth/read", { includeQuotaScope: true });
  const first = await auth();
  assert.match(first.quotaScope, /^[a-f0-9]{64}$/u);
  assert.equal((await quota()).quotaScope, first.quotaScope);
  const readBalance = account.getBalance;
  account.getBalance = async client => {
    accountId = "private-account-b";
    return readBalance(client);
  };
  assert.deepEqual(await quota(), { status: "unavailable" });
  assert.notEqual((await auth()).quotaScope, first.quotaScope);
  balance = null;
  assert.deepEqual(await quota(), { status: "unavailable" });
});

test("reads the official DeepSeek API key balance and rejects another key's late result", async () => {
  let key = "synthetic-deepseek-key-a";
  let baseURL = "https://api.deepseek.com/v1";
  let selectedProvider = "deepseek-official";
  let changeKey = false;
  const requests = [];
  const bridge = new BridgeRuntime({
    get: name => name === "settings" ? { get: () => ({ baseURL }) } : null,
    agentDefaultModel: { currentSelection: () => ({ provider: selectedProvider }) },
    credentials: {
      describe: async name => ({ configured: name === "DEEPSEEK_API_KEY" }),
      listRecords: async () => [],
      resolve: async () => ({ value: key, source: "file" }),
    },
  }, { fetch: async (url, options) => {
    requests.push({ url, method: options.method, redirect: options.redirect, authorization: options.headers.Authorization });
    if (changeKey) key = "synthetic-deepseek-key-b";
    return Response.json({ is_available: false, balance_infos: [
      { currency: "CNY", total_balance: "0.00", topped_up_balance: "0.00", granted_balance: "0.00" },
    ] });
  } });
  const quota = () => bridge.dispatch("quota/read", { version: "0.1.1-rc.2" });
  const auth = () => bridge.dispatch("auth/read", { includeQuotaScope: true });
  const first = await auth();
  assert.match(first.quotaScope, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await quota(), { status: "available", quotaScope: first.quotaScope,
    wallets: [{ kind: "recharge", amount: 0, unit: "CNY" }] });
  assert.deepEqual(requests, [{ url: "https://api.deepseek.com/user/balance", method: "GET", redirect: "error",
    authorization: "Bearer synthetic-deepseek-key-a" }]);
  changeKey = true;
  assert.deepEqual(await quota(), { status: "unavailable" });
  assert.notEqual((await auth()).quotaScope, first.quotaScope);
  baseURL = "https://proxy.example.test";
  assert.deepEqual(await quota(), { status: "unsupported" });
  baseURL = "https://api.deepseek.com";
  selectedProvider = "custom-provider";
  assert.deepEqual(await quota(), { status: "unsupported" });
  assert.equal(requests.length, 2, "another provider's key is never used for a DeepSeek balance request");
});

// Enforce the native registry's ownership and complete-prompt contracts. A Map
// that silently overwrites registrations hides both first- and second-turn bugs.
function promptRegistry() {
  const sections = new Map([["native:core", { name: "native:core", text: "NATIVE_CORE" }]]);
  const variables = new Map([["cwd", () => "NATIVE_WORKSPACE_VALUE"]]);
  return {
    sections,
    variable(name, provider) {
      assert.match(name, /^[a-z][a-z0-9_]*$/u);
      assert.equal(variables.has(name), false, "native DSH rejects duplicate variables");
      variables.set(name, provider);
      return () => variables.delete(name);
    },
    section(value) {
      if (sections.has(value.name)) throw new Error(`prompt section "${value.name}" is already registered`);
      sections.set(value.name, value);
      return () => sections.delete(value.name);
    },
    render() {
      const complete = [...sections.values()].filter(section => section.complete);
      if (complete.length > 1) throw new Error("multiple complete prompt sections are active");
      return (complete.length ? complete : [...sections.values()])
        .map(section => typeof section.text === "function" ? section.text({}) : section.text)
        // Like native DSH, substitutions are a single pass over the section.
        .map(text => text.replace(/\{\{([^{}]*)\}\}/gu, (_reference, name) => {
          assert.match(name, /^[a-z][a-z0-9_]*$/u);
          assert(variables.has(name), "unknown prompt variable");
          return variables.get(name)({});
        }))
        .filter(Boolean).join("\n\n");
    },
  };
}

function fixture() {
  const records = new Map(), frames = [], prompts = [];
  let nextBehavior = "complete", dispatches = 0;
  const create = async options => {
    const id = options.sessionId || options.resumeSessionId;
    const registry = promptRegistry();
    const previous = records.get(id);
    const session = { id, header: { cwd: "/tmp", createdAt: 1 } };
    const events = previous?.events || [];
    const emit = (type, data) => {
      const event = { type, data, seq: events.length };
      events.push(event);
      bridge.onSessionEvent(session, event);
    };
    let idle = Promise.resolve();
    options.setup({ systemPrompt: registry });
    const agent = {
      session,
      followup(message) {
        dispatches++;
        const behavior = nextBehavior;
        idle = Promise.resolve().then(() => {
          emit("turn/start", { turn: dispatches });
          try {
            const prompt = registry.render();
            prompts.push({ id, prompt });
            if (behavior === "idle-no-end") return;
            if (behavior === "idle-reject") throw Object.assign(new Error("private failure"), { code: "NETWORK" });
            if (behavior === "auth-before-message") {
              emit("turn/end", { reason: { kind: "error", error: { code: "AUTH", status: 401, message: "private credential" } } });
              return;
            }
            if (behavior === "interrupt-before-message") {
              emit("turn/end", { reason: { kind: "aborted" } });
              return;
            }
            emit("user/message", message);
            emit("assistant/message", { message: { content: [{ type: "text", text: "fixture answer" }] } });
            emit("turn/end", { reason: { kind: "completed" } });
          } catch (error) {
            if (behavior === "idle-reject") throw error;
            emit("turn/end", { reason: { kind: "error", error: { code: "UNKNOWN", message: error.message } } });
          }
        });
        idle.catch(() => {});
      },
      whenIdle: () => idle,
    };
    records.set(id, { session, events, registry });
    return { agent, dispose: async () => {} };
  };
  const bridge = new BridgeRuntime({
    agents: { create, resume: create },
    permissionPresets: { set: async () => {} },
    sessions: { flush: async () => {} },
    sessionPersistence: { inspect: async id => {
      const record = records.get(id);
      if (!record) throw new Error(`session "${id}" not found`);
      return { meta: record.session.header, events: record.events };
    } },
    get: () => undefined,
  });
  bridge.write = async frame => { frames.push(frame); };
  let requestId = 0;
  const request = async (command, params) => {
    const id = `request-${++requestId}`;
    let timer;
    try {
      await Promise.race([
        bridge.onRequest({ type: "request", id, command, params }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${command} stayed pending`)), 500); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const response = frames.find(frame => frame.type === "response" && frame.id === id);
    assert.ok(response);
    assert.equal(response.success, true, JSON.stringify(response.error));
    return response;
  };
  const start = (id = "native-session", developerInstructions = "STABLE_POLICY") => request("session/start", {
    remoteSessionId: id, cwd: "/tmp", model: "fixture/model", developerInstructions,
  });
  const turn = (operationId, turnDeveloperInstructions = "", id = "native-session") => request("turn/start", {
    remoteSessionId: id, sessionId: `public-${id}`, turnId: `turn-${operationId}`,
    operationId, prompt: `user-${operationId}`, turnDeveloperInstructions,
  });
  return { bridge, frames, records, prompts, request, start, turn,
    behavior(value) { nextBehavior = value; },
    get dispatches() { return dispatches; },
  };
}

test("continuous turns keep one complete prompt and replace only current instructions", async () => {
  const f = fixture();
  await f.start();
  for (const [id, instructions] of [["first", "RUN_ONE"], ["second", "RUN_TWO"], ["third", ""]]) {
    await f.turn(id, instructions);
    assert.equal(f.frames.find(frame => frame.event?.turnId === `turn-${id}` && frame.event.type === "complete")?.event.status, "completed");
  }
  assert.deepEqual(f.prompts.map(item => item.prompt), ["STABLE_POLICY\n\nRUN_ONE", "STABLE_POLICY\n\nRUN_TWO", "STABLE_POLICY"]);
  assert.equal(f.records.get("native-session").registry.sections.get("native:core").text, "NATIVE_CORE");
  assert.equal([...f.records.get("native-session").registry.sections.values()].filter(section => section.complete).length, 1);
  assert.equal(f.dispatches, 3);
});

test("host and current Run text preserve credential references and native-looking variables literally", async () => {
  const f = fixture();
  const stable = "References: {{SHOGGOTH_SECRET_<opaque ID>}}; examples: {{cwd}} {{not_registered}} {{{nested}}}";
  await f.start("literal", stable);
  await f.turn("first-literal", "Rule {{current_unknown}}", "literal");
  await f.turn("second-literal", "Changed {{cwd}}", "literal");
  assert.deepEqual(f.prompts.map(row => row.prompt), [stable + "\n\nRule {{current_unknown}}", stable + "\n\nChanged {{cwd}}"]);
  assert.equal(f.dispatches, 2);
});

test("sessions and resumed handles cannot retain another turn's instructions", async () => {
  const f = fixture();
  await f.start("one", "BASE_ONE");
  await f.start("two", "BASE_TWO");
  await f.turn("one-first", "ONE_RULE", "one");
  await f.turn("two-first", "TWO_RULE", "two");
  await f.request("session/resume", { remoteSessionId: "one", cwd: "/tmp",
    model: "fixture/model", developerInstructions: "RESUMED_BASE" });
  await f.turn("one-resumed", "", "one");
  assert.deepEqual(f.prompts, [
    { id: "one", prompt: "BASE_ONE\n\nONE_RULE" },
    { id: "two", prompt: "BASE_TWO\n\nTWO_RULE" },
    { id: "one", prompt: "RESUMED_BASE" },
  ]);
});

for (const [behavior, status, errorCode] of [
  ["auth-before-message", "failed", "RUNTIME_AUTH_REQUIRED"],
  ["interrupt-before-message", "interrupted", undefined],
  ["idle-no-end", "failed", "DEEPSEEK_HARNESS_TURN_INCOMPLETE"],
  ["idle-reject", "failed", "NETWORK"],
]) test(`${behavior}: settle admission promptly and allow the next explicit turn`, async () => {
  const f = fixture();
  await f.start();
  f.behavior(behavior);
  const response = await f.turn("failed", "RUN_ONE");
  const terminals = f.frames.filter(frame => frame.event?.type === "complete" && frame.event.turnId === "turn-failed");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].event.status, status);
  assert.equal(terminals[0].event.errorCode, errorCode);
  assert.ok(f.frames.indexOf(response) < f.frames.indexOf(terminals[0]), "acceptance precedes the terminal event");
  assert.equal(f.bridge.activeTurns.size, 0);
  if (["auth-before-message", "idle-reject"].includes(behavior)) {
    assert.equal(typeof terminals[0].event.failure.message, "string", "private bridge carries the structured reason to the redacting Host");
    assert.equal(terminals[0].event.failure.stack, undefined);
  }
  assert.equal(f.dispatches, 1, "failure never replays the original turn");
  f.behavior("complete");
  await f.turn("next-explicit", "NEW_RULE");
  assert.equal(f.frames.find(frame => frame.event?.type === "complete" && frame.event.turnId === "turn-next-explicit")?.event.status, "completed");
  assert.equal(f.dispatches, 2);
});

test("accepted operation replay reads native events without running the agent again", async () => {
  const f = fixture();
  await f.start();
  await f.turn("same-operation", "RULE");
  const replay = await f.turn("same-operation", "RULE");
  assert.equal(replay.data.replayed, true);
  assert.equal(f.dispatches, 1);
  assert.equal(f.bridge.activeTurns.size, 0);
});
