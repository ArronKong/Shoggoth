"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { collectSessionOutputArtifacts, sessionArtifactHistory } = require("../app/core/session-output-artifacts");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-outputs-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const start = Date.now() - 10_000;
  const event = (kind, content, runId = "run-1") => ({ kind, content, runId, occurredAt: Date.now() });
  const file = (name) => {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "fixture");
    return full;
  };
  const call = (id, name, args, success = true, runId = "run-1") => [
    event("tool_call", { toolCallId: id, tool: { name, displayArgs: args } }, runId),
    event("tool_result", { toolCallId: id, tool: { status: success ? "completed" : "failed", success } }, runId),
  ];
  const collect = (events, extra = {}) => collectSessionOutputArtifacts({ events,
    runs: [{ id: "run-1", startedAt: start, finishedAt: Date.now() }], workspace: root,
    runtimeHome: root, sessionCreatedAt: start, agentId: "agent", ...extra });
  return { root, start, event, file, call, collect };
}

test("only successful writes survive uploads, reads, directory listings and shared-workspace changes", async t => {
  const f = fixture(t);
  const output = f.file("output/report.html");
  const input = f.file("input/image.png");
  const copy = f.file("image.png");
  const read = f.file("existing.pdf");
  const foreign = f.file("other-session.txt");
  const events = [
    f.event("user", { text: `Read ${input}`, attachments: [{ path: input }] }),
    ...f.call("read", "view_file", { AbsolutePath: read }),
    ...f.call("copy", "run_command", { command: `cp '${input}' '${copy}'` }),
    ...f.call("list", "list_dir", { path: f.root }),
    ...f.call("write", "write_to_file", { TargetFile: output }),
    f.event("assistant", { text: `Inputs: ${input} ${copy} ${read}; folder: ${f.root}; other: ${foreign}` }),
  ];
  assert.deepEqual((await f.collect(events)).map(item => item.path), [output]);
  assert.deepEqual((await f.collect([...events, {
    ...f.event("user", { text: `Quoted previous reply: \`${output}\`` }, "later-run"),
    occurredAt: Date.now() + 1000,
  }])).map(item => item.path), [output], "Later user quotations must not reclassify earlier AI outputs");
});

test("opaque historical writes recover delivered files but never inputs, plain mentions or directory children", async t => {
  const f = fixture(t);
  const output = f.file("report with spaces.html");
  const input = f.file("image.png");
  f.file("delivery/unrelated.txt");
  const events = [f.event("user", { text: `Read \`${input}\`` }),
    ...f.call("write", "write_to_file", undefined),
    f.event("assistant", { text: `Created \`${output}\`. Input \`${input}\`. Folder \`${f.root}/delivery\`.` })];
  assert.deepEqual((await f.collect(events)).map(item => item.path), [output]);
  assert.deepEqual(await f.collect([events.at(-1)]), []);
  assert.deepEqual(await f.collect([
    ...f.call("read", "read", { path: output }), events.at(-1),
  ]), []);
});

test("failed, pending and mismatched run tool IDs cannot claim files", async t => {
  const f = fixture(t);
  const output = f.file("failure.txt");
  const failed = f.call("same-id", "write", { path: output }, false);
  const wrongRun = f.call("same-id", "read", { path: output }, true, "run-2");
  assert.deepEqual(await f.collect([...failed, ...wrongRun,
    f.event("assistant", { text: output })]), []);
  assert.deepEqual(await f.collect([f.call("pending", "write", { path: output })[0]]), []);
  const nonzero = f.call("exit", "write", { path: output });
  nonzero[1].content.tool.exitCode = 1;
  assert.deepEqual(await f.collect(nonzero), []);
});

test("shell output destinations and file changes exclude input paths and embedded content paths", async t => {
  const f = fixture(t);
  const input = f.file("source.txt");
  const output = f.file("shell.txt");
  const download = f.file("Downloads/clip.mp4");
  const changed = f.file("edited.html");
  const events = [
    ...f.call("shell", "exec_command", { command: `printf 'Generated report based on ${input}' > '${output}'` }),
    ...f.call("download", "terminal", { command: `curl https://example.test/file -o '${download}'` }),
    ...f.call("changes", "fileChange", { changes: [{ path: changed, kind: "update" }], content: input }),
  ];
  assert.deepEqual(new Set((await f.collect(events)).map(item => item.path)), new Set([output, download, changed]));
  assert.deepEqual(await f.collect([
    ...f.call("quote", "exec_command", { command: `printf 'example > ${input}'` }),
    ...f.call("copy", "exec_command", { command: `cat '${input}' > '${output}'` }),
    ...f.call("delete", "fileChange", { path: changed, changes: [{ path: changed, kind: "delete" }] }),
  ]), []);
});

test("input attachments remain excluded when an opaque writer echoes them; same-named outputs remain", async t => {
  const f = fixture(t);
  const input = f.file("input/report.pdf");
  const output = f.file("output/report.pdf");
  const events = [f.event("user", { attachments: [{ path: input }] }),
    ...f.call("write-input", "write", { path: input }),
    ...f.call("write-output", "write", { path: output })];
  assert.deepEqual((await f.collect(events)).map(item => item.path), [output]);
});

test("internal files, symlinks, old files, missing files and unrestricted roots stay excluded", async t => {
  const f = fixture(t);
  const names = ["AGENTS.md", "trace.log", "chat-attachments/image.png", "node_modules/pkg/index.js", ".cache/result.txt"];
  const files = names.map(f.file);
  const old = f.file("old.txt");
  fs.utimesSync(old, new Date(1000), new Date(1000));
  const link = path.join(f.root, "linked.txt");
  fs.symlinkSync(old, link);
  files.push(old, link, path.join(f.root, "missing.txt"), "/etc/hosts");
  assert.deepEqual(await f.collect(files.flatMap((file, i) => f.call(String(i), "write", { path: file }))), []);
  const fresh = f.file("unrelated-new.txt");
  const freshLink = path.join(f.root, "fresh-link.txt");
  fs.symlinkSync(fresh, freshLink);
  assert.deepEqual(await f.collect([
    ...f.call("opaque", "write_to_file", undefined),
    f.event("assistant", { text: `\`${freshLink}\`` }),
  ]), [], "Legacy delivery references must not resolve symlinks into unrelated files");
});

test("history adapters preserve tool identities and failure markers across user turns", async t => {
  const f = fixture(t);
  const output = f.file("hermes.pdf");
  const input = f.file("input.png");
  const messages = [
    { role: "user", timestamp: f.start, content: input },
    { role: "assistant", timestamp: Date.now(), tool_calls: [{ id: "a", function: { name: "write_file", arguments: JSON.stringify({ path: output }) } }] },
    { role: "tool", timestamp: Date.now(), tool_call_id: "a", is_error: false, content: "saved" },
    { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: output }] },
    { role: "user", timestamp: Date.now(), content: "next turn" },
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "write", arguments: { path: input } }] },
    { role: "toolResult", toolCallId: "a", isError: true, content: "error" },
  ];
  const history = sessionArtifactHistory(messages, f.start);
  assert.deepEqual((await f.collect(history.events, { runs: history.runs })).map(item => item.path), [output]);
  const imported = messages.map(message => ({
    ...f.event(message.role === "user" ? "user" : "assistant", {
      historyItem: { role: message.role, payload: { message } },
    }), occurredAt: message.timestamp || Date.now(),
  }));
  assert.deepEqual((await f.collect(imported)).map(item => item.path), [output]);
  messages[2] = { ...messages[2], is_error: undefined, content: JSON.stringify({ error: "write denied" }) };
  const failedHistory = sessionArtifactHistory(messages, f.start);
  assert.deepEqual(await f.collect(failedHistory.events, { runs: failedHistory.runs }), []);
});
