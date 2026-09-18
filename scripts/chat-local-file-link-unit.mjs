#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const helperPath = path.join(uiRoot, "src/lib/sessionArtifacts.ts");
const appLinksHelperPath = path.join(uiRoot, "src/lib/appLinks.ts");
const esbuild = path.join(uiRoot, "node_modules/.bin/esbuild");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-local-file-link-"));
const outfile = path.join(outDir, "session-artifacts.cjs");
const appLinksOutfile = path.join(outDir, "app-links.cjs");
const markdownOutfile = path.join(outDir, "markdown.cjs");
let server = null;

try {
  execFileSync(esbuild, [helperPath, "--bundle", "--platform=node", "--format=cjs", `--outfile=${outfile}`], {
    stdio: "pipe",
  });
  execFileSync(esbuild, [appLinksHelperPath, "--bundle", "--platform=node", "--format=cjs", `--outfile=${appLinksOutfile}`], {
    stdio: "pipe",
  });
  execFileSync(esbuild, [path.join(uiRoot, "src/lib/markdown.ts"), "--bundle", "--platform=node", "--format=cjs", "--loader:.css=empty", `--outfile=${markdownOutfile}`], {
    stdio: "pipe",
  });
  const { localFilePathFromHref, findLocalFileLinks } = createRequire(import.meta.url)(outfile);
  const { md } = createRequire(import.meta.url)(markdownOutfile);
  const { internalAppHashFromHref } = createRequire(import.meta.url)(appLinksOutfile);

  const expected = "/Users/example/Library/Application Support/Shoggoth/workspaces/abc/index.html";
  assert.equal(localFilePathFromHref(
    "/Users/example/Library/Application%20Support/Shoggoth/workspaces/abc/index.html",
  ), expected);
  assert.equal(localFilePathFromHref(
    "file:///Users/example/Library/Application%20Support/Shoggoth/workspaces/abc/index.html",
  ), expected);
  assert.equal(localFilePathFromHref(
    "http://127.0.0.1:18799/Users/example/Library/Application%20Support/Shoggoth/workspaces/abc/index.html",
  ), expected);
  assert.equal(localFilePathFromHref("http://localhost:3000/dashboard"), null);
  assert.equal(localFilePathFromHref("https://example.com/index.html"), null);
  assert.equal(localFilePathFromHref("/settings"), null);
  assert.equal(localFilePathFromHref("/__api/status"), null);
  assert.equal(localFilePathFromHref("/Users/example/a%00b.txt"), null);
  assert.equal(localFilePathFromHref("/Applications/Shoggoth.app"), "/Applications/Shoggoth.app");
  assert.equal(localFilePathFromHref("~/Desktop/report.md:12:3"), "~/Desktop/report.md");
  assert.equal(localFilePathFromHref("/Users/example/report.md#L12-L20"), "/Users/example/report.md");
  assert.equal(localFilePathFromHref("/Library/Logs/report.log"), "/Library/Logs/report.log");
  assert.equal(localFilePathFromHref("file://other-host/Users/example/report.md"), null);
  assert.equal(localFilePathFromHref("//other-host/Users/example/report.md"), null);

  const localPaths = (text, wholePath = false) => findLocalFileLinks(text, wholePath).map((link) => link.path);
  assert.deepEqual(localPaths("打开/Users/example/Desktop/报告.pdf，然后查看 ~/Downloads/report.csv。"), [
    "/Users/example/Desktop/报告.pdf", "~/Downloads/report.csv",
  ]);
  assert.deepEqual(localPaths('文件 "' + expected + '" 已生成'), [expected]);
  assert.deepEqual(localPaths(expected, true), [expected]);
  assert.deepEqual(localPaths("文件（/Users/example/report(1).pdf），以及 (/tmp/output.txt)."), [
    "/Users/example/report(1).pdf", "/tmp/output.txt",
  ]);
  assert.deepEqual(localPaths("/Users/example/a.ts:12:3 ~/Desktop/a.ts#L8-L10"), ["/Users/example/a.ts", "~/Desktop/a.ts"]);
  assert.deepEqual(localPaths("/Users/example/100%ready.txt /Users/example/literal%20space.txt"), [
    "/Users/example/100%ready.txt", "/Users/example/literal%20space.txt",
  ]);
  assert.deepEqual(localPaths("file:///Users/example/my%20report.pdf"), ["/Users/example/my report.pdf"]);
  for (const text of ["/new /settings /__api/status", "https://example.com/Users/example/a.txt", "file://other-host/Users/example/a.txt", "//other-host/Users/example/a.txt", "/Users/example/a\0b.txt"]) {
    assert.deepEqual(localPaths(text), [], `must not treat ${JSON.stringify(text)} as a local file`);
  }

  const renderedPaths = (text) => Array.from(md.render(text, { localFiles: true }).matchAll(/data-local-path="([^"]*)"/g), (match) => decodeURIComponent(match[1]));
  assert.deepEqual(renderedPaths("打开 /Users/example/report.pdf，然后查看 `~/Desktop/报告.csv`。"), [
    "/Users/example/report.pdf", "~/Desktop/报告.csv",
  ]);
  assert.deepEqual(renderedPaths("`" + expected + "`"), [expected]);
  assert.deepEqual(renderedPaths("[文件](</Users/example/My Report.pdf:12>)"), ["/Users/example/My Report.pdf"]);
  assert.deepEqual(renderedPaths("[文件](file:///Users/example/My%20Report.pdf#L12)"), ["/Users/example/My Report.pdf"]);
  assert.deepEqual(renderedPaths("[文件](~/Desktop/report.md)"), ["~/Desktop/report.md"]);
  assert.deepEqual(renderedPaths("file:///Users/example/My%20Report.pdf"), ["/Users/example/My Report.pdf"]);
  assert.deepEqual(renderedPaths("[/Users/example/a.txt](https://example.com) [`/Users/example/b.txt`](https://example.com)"), []);
  assert.deepEqual(renderedPaths("https://example.com/Users/example/a.txt ![/Users/example/a.txt](https://example.com/image.png)"), []);
  assert.deepEqual(renderedPaths("```sh\ncat /Users/example/a.txt\n```"), []);
  assert.deepEqual(renderedPaths('<a data-local-path="%2FUsers%2Fexample%2Fa.txt">injected</a>'), []);
  assert.match(md.render("`/Users/example/a.txt`", { localFiles: true }), /<a [^>]*><code>\/Users\/example\/a.txt<\/code><\/a>/);
  assert.doesNotMatch(md.render("/Users/example/a.txt `~/Desktop/b.txt`"), /data-local-path/);

  const currentHref = "http://127.0.0.1:18799/#/chat";
  const taskRoute = "#/tasks?backend=pi&board=board-1&task=task-1";
  assert.equal(internalAppHashFromHref(taskRoute, currentHref), taskRoute);
  assert.equal(internalAppHashFromHref(`http://127.0.0.1:18799/${taskRoute}`, currentHref), taskRoute);
  assert.equal(internalAppHashFromHref(`http://127.0.0.1:18800/${taskRoute}`, currentHref), null);
  assert.equal(internalAppHashFromHref("https://example.com/#/tasks", currentHref), null);
  assert.equal(internalAppHashFromHref("#message-1", currentHref), null);
  assert.equal(internalAppHashFromHref("javascript:#/tasks", currentHref), null);

  const markdownSource = fs.readFileSync(path.join(uiRoot, "src/lib/markdown.ts"), "utf8");
  const chatSource = fs.readFileSync(path.join(uiRoot, "src/pages/ChatPage.tsx"), "utf8");
  const clientSource = fs.readFileSync(path.join(uiRoot, "src/api/client.ts"), "utf8");
  assert.match(markdownSource, /data-local-path/);
  assert.match(markdownSource, /internalAppHashFromHref/);
  assert.match(markdownSource, /appRoute[\s\S]{0,240}removeAttribute\("target"\)/);
  assert.match(chatSource, /a\[data-local-path\]/);
  assert.match(chatSource, /chat-artifacts-popover/);
  assert.match(chatSource, /ref=\{sessionArtifactsTriggerRef\}[\s\S]{0,240}chat-artifacts-trigger/);
  assert.match(chatSource, /const sessionArtifactItems = activeSessionArtifactResult\?\.items \?\? \[\]/);
  assert.doesNotMatch(chatSource, /extractLocalFilePaths|mergeSessionArtifacts|messageReferenced/);
  assert.match(chatSource, /chat-artifact-reveal/);
  assert.match(clientSource, /export async function revealPath[\s\S]*\/__api\/host\/reveal-path/);

  const revealCalls = [];
  const openCalls = [];
  const { startStaticServer } = createRequire(import.meta.url)(path.join(root, "app/static-server.js"));
  server = await startStaticServer(0, {
    registry: {},
    hostOps: {
      reveal: (target) => { revealCalls.push(target); return true; },
      openPath: async (target) => { openCalls.push(target); return target === "/tmp/missing.txt" ? "File not found" : ""; },
    },
  });
  const missing = await fetch(`${server.url}/__api/host/reveal-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missing.status, 400);
  const revealed = await fetch(`${server.url}/__api/host/reveal-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: expected }),
  });
  assert.equal(revealed.status, 200);
  assert.deepEqual(await revealed.json(), { ok: true });
  assert.deepEqual(revealCalls, [expected]);
  for (const [target, status, body] of [
    [expected, 200, { ok: true }],
    ["~/Desktop/报告.pdf", 200, { ok: true }],
    ["/tmp/missing.txt", 500, { ok: false, error: "File not found" }],
  ]) {
    const opened = await fetch(`${server.url}/__api/host/open-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    assert.equal(opened.status, status);
    assert.deepEqual(await opened.json(), body);
  }
  assert.deepEqual(openCalls, [expected, "~/Desktop/报告.pdf", "/tmp/missing.txt"]);

  console.log("✓ chat-local-file-link-unit: all cases passed");
} finally {
  if (server) await server.close();
  fs.rmSync(outDir, { recursive: true, force: true });
}
