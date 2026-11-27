"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const delivery = require("../app/agent-service/native-instruction-delivery");
const { NativePromptLedgerStore } = require("../app/agent-service/native-prompt-ledger-store");

const blocks = parts => parts.map(([id, content, kind = "memory"]) => ({ id, content, kind }));
const joined = parts => parts.map(([, content]) => content).join("\n\n");
const memoryStore = () => {
  const map = new Map();
  return { get: key => map.get(key) ?? null, set: (key, state) => map.set(key, state), delete: key => map.delete(key), map };
};
const PROFILE = ["user", "PROFILE: prefers short answers", "user-profile"];
const CONNECTORS = ["mcp-connectors", "CONNECTORS: mail, calendar", "user"];
const memory = text => ["memory", `MEMORY FILES: ${text}`, "memory"];

test("a joined context splits back into its blocks, or into nothing when the text changed", () => {
  const parts = [CONNECTORS, PROFILE, memory("a\n\nb")];
  const index = delivery.contextIndexFor(blocks(parts));
  const sections = delivery.contextSections(joined(parts), index);
  assert.deepEqual(sections.map(section => section.key), ["mcp-connectors", "user", "memory"]);
  assert.equal(sections[2].text, "MEMORY FILES: a\n\nb");
  assert.equal(delivery.contextSections(`${joined(parts)}x`, index), null, "length mismatch");
  assert.equal(delivery.contextSections(joined(parts).replace("\n\n", "\n-"), index), null, "separator mismatch");
  assert.equal(delivery.contextSections(joined(parts), [...index, index[0]]), null, "duplicate key");
  assert.equal(delivery.contextSections(joined(parts), null), null);
  const history = delivery.contextIndexFor(blocks([["transcript", "PRIOR", "transcript"], PROFILE]));
  assert.deepEqual(history.map(entry => entry.once === true), [true, false]);
});

test("unchanged blocks are omitted one by one while changed ones repeat", () => {
  const ledger = new delivery.PromptBlockLedger();
  const turn = parts => delivery.promptBlocks(ledger, "s", { rules: "RULES", context: joined(parts),
    contextIndex: delivery.contextIndexFor(blocks(parts)), run: "RUN" });
  const first = turn([CONNECTORS, PROFILE, memory("one")]);
  assert.equal(first.blocks.join("\n\n"), `RULES\n\n${joined([CONNECTORS, PROFILE, memory("one")])}\n\nRUN`);
  first.commit();
  const second = turn([CONNECTORS, PROFILE, memory("two")]);
  const text = second.blocks.join("\n\n");
  assert.match(text, /MEMORY FILES: two/u);
  assert.doesNotMatch(text, /PROFILE:|CONNECTORS:|RULES/u);
  assert.match(text, /SHOGGOTH CONTEXT UNCHANGED\nThe latest Shoggoth Run rules, MCP connector list, saved user profile sent earlier/u);
});

test("a removed state block is announced once; a recall block that did not match is not", () => {
  const ledger = new delivery.PromptBlockLedger();
  const turn = parts => {
    const plan = delivery.promptBlocks(ledger, "s", { context: joined(parts), contextIndex: delivery.contextIndexFor(blocks(parts)) });
    plan.commit();
    return plan.blocks.join("\n\n");
  };
  turn([CONNECTORS, PROFILE, memory("one")]);
  const removed = turn([PROFILE]);
  assert.match(removed, /SHOGGOTH CONTEXT REMOVED\nThe MCP connector list sent earlier in this conversation no longer apply/u);
  assert.doesNotMatch(removed, /memory files/u, "memory recall changes per turn");
  assert.doesNotMatch(turn([PROFILE]), /REMOVED/u, "announced once");
  assert.match(turn([CONNECTORS, PROFILE]), /CONNECTORS: mail/u, "a returning block is sent again");
});

test("a fresh thread sends its history once and records the other blocks for the next turn", () => {
  const ledger = new delivery.PromptBlockLedger();
  const full = [["transcript", "PRIOR TRANSCRIPT", "transcript"], CONNECTORS, PROFILE];
  const first = delivery.promptBlocks(ledger, "s", { context: joined(full), contextIndex: delivery.contextIndexFor(blocks(full)) });
  assert.equal(first.blocks.join("\n\n"), joined(full));
  first.commit();
  const continuing = [CONNECTORS, PROFILE];
  const second = delivery.promptBlocks(ledger, "s", { context: joined(continuing),
    contextIndex: delivery.contextIndexFor(blocks(continuing)) });
  assert.doesNotMatch(second.blocks.join("\n\n"), /CONNECTORS:|PROFILE:|PRIOR/u);
  assert.equal(ledger.deliveredHash("s", "context:transcript"), null, "history is never recorded");
});

test("a context the index no longer matches is sent whole and never announced as removed", () => {
  const ledger = new delivery.PromptBlockLedger();
  const parts = [CONNECTORS, PROFILE];
  const first = delivery.promptBlocks(ledger, "s", { context: joined(parts), contextIndex: delivery.contextIndexFor(blocks(parts)) });
  first.commit();
  const whole = delivery.promptBlocks(ledger, "s", { context: "[borrowed memory placeholder]", contextIndex: delivery.contextIndexFor(blocks(parts)) });
  assert.deepEqual(whole.blocks, ["[borrowed memory placeholder]"]);
});

test("per-Run Hosts and a restarted Service share what each native session holds", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "prompt-ledger-"));
  try {
    const paths = { cacheDir: path.join(root, "cache"), trustedRoot: root };
    const parts = [CONNECTORS, PROFILE];
    const plan = ledger => delivery.promptBlocks(ledger, "s", { rules: "RULES", context: joined(parts),
      contextIndex: delivery.contextIndexFor(blocks(parts)) });
    const store = new NativePromptLedgerStore({ paths });
    plan(new delivery.PromptBlockLedger({ store, scope: "pi" })).commit();
    const nextRun = plan(new delivery.PromptBlockLedger({ store, scope: "pi" }));
    assert.doesNotMatch(nextRun.blocks.join("\n\n"), /RULES|CONNECTORS|PROFILE/u, "a new Host of the next Run");
    const restarted = new NativePromptLedgerStore({ paths });
    assert.doesNotMatch(plan(new delivery.PromptBlockLedger({ store: restarted, scope: "pi" })).blocks.join("\n\n"),
      /CONNECTORS/u, "after restart");
    assert.match(plan(new delivery.PromptBlockLedger({ store: restarted, scope: "claude-code" })).blocks.join("\n\n"),
      /CONNECTORS/u, "another Runtime's session is separate");
    const file = fs.readFileSync(path.join(paths.cacheDir, "native-prompt-ledger-v1.json"), "utf8");
    assert.doesNotMatch(file, /CONNECTORS|PROFILE|RULES|"s"/u, "hashes only");
    new delivery.PromptBlockLedger({ store: restarted, scope: "pi" }).reset("s");
    assert.match(plan(new delivery.PromptBlockLedger({ store: new NativePromptLedgerStore({ paths }), scope: "pi" }))
      .blocks.join("\n\n"), /CONNECTORS/u, "a reset is persisted");
    fs.writeFileSync(path.join(paths.cacheDir, "native-prompt-ledger-v1.json"), "{broken");
    assert.match(plan(new delivery.PromptBlockLedger({ store: new NativePromptLedgerStore({ paths }), scope: "pi" }))
      .blocks.join("\n\n"), /CONNECTORS/u, "a corrupt file only resends");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Hosts of the five per-Run Runtimes deduplicate across their Runs through the shared store", () => {
  const { ClaudeCodeRuntimeHost } = require("../app/agent-service/claude-code-runtime-host");
  const { PiRuntimeHost } = require("../app/agent-service/pi-runtime-host");
  const store = memoryStore();
  const parts = [CONNECTORS, PROFILE];
  for (const Host of [ClaudeCodeRuntimeHost, PiRuntimeHost]) {
    const prompt = () => {
      const host = Object.create(Host.prototype);
      host.promptLedger = new delivery.PromptBlockLedger({ store, scope: Host.name });
      host.commandCatalog = [];
      return host._promptParts("s", { prompt: "ask", context: joined(parts), contextIndex: delivery.contextIndexFor(blocks(parts)) });
    };
    prompt().commit();
    assert.doesNotMatch(prompt().text, /CONNECTORS|PROFILE/u, Host.name);
  }
});

test("Codex keeps applied instructions across compaction and a new Host, and repeats changed context blocks", async () => {
  const injected = [];
  let emit = null;
  const host = () => ({
    threadStart: async () => ({ thread: { id: "s" } }),
    threadResume: async input => ({ thread: { id: input.threadId } }),
    threadInjectItems: async input => { injected.push(...input.items); },
    turnStart: async () => ({ turn: { id: "t" } }),
    subscribe: listener => { emit = listener; return () => {}; },
  });
  const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
  const store = memoryStore();
  const acquire = () => new CodexRuntimeAdapter({ runtimePool: { get: async () => host() }, promptLedgerStore: store })
    .acquire({ runtime: "codex", runtimeProfileId: "profile", runtimeAccountId: "account" });
  const turn = async (handle, parts, runId) => {
    injected.length = 0;
    await handle.turnStart({ sessionId: "s", operationId: runId, prompt: "ask", context: joined(parts),
      contextIndex: delivery.contextIndexFor(blocks(parts)), turnDeveloperInstructions: `RULES\n\n${delivery.runIdInstruction(runId)}` });
    return injected.map(item => `${item.role}:${item.content[0].text}`);
  };
  const first = await acquire();
  first.subscribe(() => {});
  await first.sessionStart({ source: "chat", developerInstructions: "FULL_POLICY" });
  assert.deepEqual(await turn(first, [CONNECTORS, PROFILE], "run-1"),
    ["developer:RULES\n\nCurrent Shoggoth Run ID: run-1", `user:${joined([CONNECTORS, PROFILE])}`]);
  const second = await turn(first, [CONNECTORS, ["user", "PROFILE: changed", "user-profile"]], "run-2");
  assert.equal(second[1], "user:PROFILE: changed", "only the changed block, still at user authority");
  assert.match(second[0], /^developer:SHOGGOTH CONTEXT UNCHANGED\nThe latest Shoggoth Run rules, MCP connector list/u);
  emit({ known: true, type: "context_compacted", threadId: "s" });
  // A new Host (Codex restart or Service restart) resumes the compacted thread.
  const resumed = await acquire();
  await resumed.sessionResume({ sessionId: "s", developerInstructions: "FULL_POLICY" });
  const third = await turn(resumed, [CONNECTORS], "run-3");
  assert.equal(third.some(text => text.includes("FULL_POLICY")), false, "unchanged instructions are not repeated");
  assert.match(third.join("\n"), /CONNECTORS: mail/u, "context dropped by compaction is sent again");
  await resumed.sessionResume({ sessionId: "s", developerInstructions: "NEW_POLICY" });
  assert.match((await turn(resumed, [CONNECTORS], "run-4")).join("\n"), /These are the current Shoggoth developer instructions[\s\S]*NEW_POLICY/u);
});
