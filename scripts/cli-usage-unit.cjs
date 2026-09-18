"use strict";

// Unit test for parseCliCommandNames — the CLI-usage command extractor that
// turns a bash/exec `arguments.command` string into the command names invoked.
// Run: node scripts/cli-usage-unit.cjs
const assert = require("node:assert/strict");
const {
  parseCliCommandNames,
  extractCliCommandsFromLine,
  dedupeSessionFiles,
} = require("../app/core/openclaw-backend");

function eq(input, expected, label) {
  const got = parseCliCommandNames(input);
  assert.deepEqual(
    got,
    expected,
    `${label}: ${JSON.stringify(input)} → ${JSON.stringify(got)} (want ${JSON.stringify(expected)})`,
  );
}

// spec §九 sample table
eq("git push origin main", ["git"], "plain command");
eq("sudo npm i -g foo", ["npm"], "strip sudo wrapper");
eq("cat a.txt | grep x | sort", ["cat", "grep", "sort"], "pipe segments");
eq("FOO=bar node script.js", ["node"], "strip VAR=val");
eq("cd /x && git status", ["cd", "git"], "&& chain");

// edges
eq("", [], "empty");
eq("    ", [], "whitespace only");
eq("/usr/bin/python3 -m venv .venv", ["python3"], "absolute path basename");
eq("env NODE_ENV=prod node app.js", ["node"], "env wrapper + assignment");
eq("docker run -it ubuntu bash", ["docker"], "leading token only per segment");
eq("ls -la; pwd", ["ls", "pwd"], "semicolon separator");
eq("foo || bar", ["foo", "bar"], "or chain");

// shell-wrapper unwrap (spec §九 step 1) — trajectory commands are login-shell wrapped
eq("/bin/zsh -lc 'git push origin main'", ["git"], "unwrap /bin/zsh -lc");
eq('bash -c "cat a | grep x"', ["cat", "grep"], "unwrap bash -c double-quote pipe");
eq("/bin/sh -c 'npm run build'", ["npm"], "unwrap sh -c");
eq("zsh -ic 'FOO=bar node app.js'", ["node"], "unwrap zsh -ic + inner VAR=val");
eq("/bin/zsh -lc 'cd /x && git status'", ["cd", "git"], "unwrap then split inner chain");
eq("git -c x.y=z commit", ["git"], "non-shell -c flag must NOT unwrap (task1 review guard)");

console.log("✓ cli-usage-unit: all command-parse cases passed");

// --- extractCliCommandsFromLine: returns { id, command } per CLI tool call ---
function eqArr(got, expected, label) {
  assert.deepEqual(got, expected, `${label}: → ${JSON.stringify(got)} (want ${JSON.stringify(expected)})`);
}
const cmds = (line) => extractCliCommandsFromLine(line).map((t) => t.command);

eqArr(
  extractCliCommandsFromLine({ type: "tool.call", data: { name: "bash", arguments: { command: "git status" } } }),
  [{ id: null, command: "git status" }],
  "legacy trajectory bash tool.call",
);
eqArr(
  cmds({ type: "tool.call", data: { name: "web_search", arguments: { query: "x" } } }),
  [],
  "trajectory non-CLI tool ignored",
);
// --- plain transcript (message.content[].toolCall) ---
eqArr(
  extractCliCommandsFromLine({
    message: { content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: { command: "npm i" } }] },
  }),
  [{ id: "call_1", command: "npm i" }],
  "plain exec toolCall carries its id",
);
eqArr(
  cmds({ type: "session" }),
  [],
  "non-tool line ignored",
);

// --- real trajectory schema: toolCalls live in data.messagesSnapshot[].content[],
// NOT in a top-level `tool.call` event (the shape this file used to assume). ---
const tc = (id, command) => ({ type: "toolCall", id, name: "exec", arguments: { command } });
eqArr(
  cmds({
    type: "model.completed",
    data: {
      messagesSnapshot: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [tc("call_a", "zsh -ic 'bird list-timeline'")] },
      ],
    },
  }),
  ["zsh -ic 'bird list-timeline'"],
  "trajectory model.completed messagesSnapshot",
);
eqArr(
  cmds({ type: "context.compiled", data: { messages: [{ role: "assistant", content: [tc("call_b", "git log")] }] } }),
  ["git log"],
  "trajectory context.compiled messages",
);
eqArr(
  cmds({
    type: "model.completed",
    data: { messagesSnapshot: [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } }] }] },
  }),
  [],
  "trajectory non-CLI tool in snapshot ignored",
);

// --- dedupeSessionFiles: plain transcript wins when both formats exist for a UUID.
// Both formats record the same toolCalls, but the trajectory repeats each one in
// every累积 messagesSnapshot; the plain transcript is append-only (one entry per
// call), so it is the cheaper and duplicate-free source. ---
eqArr(
  dedupeSessionFiles([
    { agentId: "ada", name: "u1.jsonl", mtime: 200 },
    { agentId: "ada", name: "u1.trajectory.jsonl", mtime: 100 },
  ]).map((f) => `${f.agentId}/${f.uuid}/${f.kind}`),
  ["ada/u1/plain"],
  "dedup prefers plain over trajectory (same uuid)",
);
eqArr(
  dedupeSessionFiles([
    { agentId: "ada", name: "u2.trajectory.jsonl", mtime: 100 },
    { agentId: "ada", name: "u2.jsonl", mtime: 200 },
  ]).map((f) => `${f.agentId}/${f.uuid}/${f.kind}`),
  ["ada/u2/plain"],
  "dedup prefers plain regardless of readdir order",
);
eqArr(
  dedupeSessionFiles([
    { agentId: "main", name: "p.jsonl", mtime: 1 },
    { agentId: "main", name: "t.trajectory.jsonl", mtime: 2 },
    { agentId: "main", name: "notes.txt", mtime: 3 },
  ]).map((f) => `${f.uuid}:${f.kind}`).sort(),
  ["p:plain", "t:trajectory"],
  "plain-only + trajectory-only kept; non-jsonl dropped",
);

console.log("✓ cli-usage-unit: extractor + dedupe cases passed");
