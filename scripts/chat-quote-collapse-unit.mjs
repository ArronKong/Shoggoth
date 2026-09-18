#!/usr/bin/env node

// Unit: 引用回复在**历史重载后**仍必须折叠成一行（R347）。
//
// 发送路径给引用的每一行加 `> ` 前缀，空行因此成为 `"> "`（带尾随空格），Hermes
// 原样落盘。但 loadHistory 会先过 extractAttachmentMarkers，其尾部
// `replace(/[ \t]+$/gm, "")` 逐行剥尾随空白 → `"> "` 变成 `">"`。只认
// `startsWith("> ")` 的解析器于是在第一个空引用行断开：只有首段折叠，剩下的引用
// 连同正文掉进 body，被 markdown 渲染成整面 blockquote 墙（用户报的「引用发出去
// 的消息经常会展开」）。
//
// 断言：两种形态（as-sent 带空格 / after-strip 不带）解析结果必须**逐字节一致**，
// 且都只留下用户自己写的正文。历史里两种形态并存（老消息内存态是前者、重载后是
// 后者），所以修法必须两边都吃。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const helperPath = path.join(root, "app/manage-ui/src/lib/chatRuntime.ts");
const esbuild = path.join(uiRoot, "node_modules/.bin/esbuild");

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-quote-"));
const outfile = path.join(outDir, "chat-runtime.cjs");
execFileSync(esbuild, [helperPath, "--bundle", "--platform=node", "--format=cjs", `--outfile=${outfile}`], {
  stdio: "pipe",
});
const { parseQuoteFromText } = createRequire(import.meta.url)(outfile);

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err.message.split("\n")[0]}`);
  }
};

// loadHistory 里那一步的等价物（ChatPage.tsx extractAttachmentMarkers 尾部）。
const stripTrailingWs = (text) => text.replace(/[ \t]+$/gm, "").trim();

// 用户 2026-07-28 报障那条消息的结构：多段引用（表格 + 代码块）+ 一行正文。
const QUOTED = [
  "搞定啦老板！🎉",
  "",
  "---",
  "",
  "## 📂 Clippings 分类完成",
  "",
  "| 分类文件夹 | 数量 |",
  "|-----------|------|",
  "| AI图像与视频生成 | 49 |",
  "",
  "```yaml",
  "tags:",
  "  - clippings",
  "```",
  "",
  "现在在 Obsidian 里可以直接按 tag 搜索了～",
].join("\n");
const BODY = "这种分离有没有可能以后做成自动化的，先不写代码，分析方案";
// 发送路径的前缀构造（ChatPage.tsx sendMessage）。
const asSent = `${QUOTED.split("\n").map((l) => `> ${l}`).join("\n")}\n\n${BODY}`;
const afterStrip = stripTrailingWs(asSent);

check("前提：剥尾随空白确实改写了这条消息（否则本测试无意义）", () => {
  assert.notEqual(afterStrip, asSent.trim());
  assert.ok(afterStrip.includes("\n>\n"), "空引用行应已退化为 '>'");
});

check("as-sent（内存态）：整段引用折叠为一条，body 只剩用户正文", () => {
  const r = parseQuoteFromText(asSent);
  assert.deepEqual(r.quotes, [QUOTED]);
  assert.equal(r.body.trim(), BODY);
});

check("after-strip（历史重载态）：同样整段折叠，body 不得残留 blockquote", () => {
  const r = parseQuoteFromText(afterStrip);
  assert.equal(r.quotes.length, 1, `expected 1 quote, got ${r.quotes.length}`);
  assert.equal(r.body.trim(), BODY);
  assert.ok(!/^>/m.test(r.body), "body 里还有 '>' 开头的行 = 又渲染成 blockquote 墙");
});

check("两种形态解析出的引用载荷逐字节一致（跳转匹配才不会分叉）", () => {
  assert.deepEqual(parseQuoteFromText(afterStrip).quotes, parseQuoteFromText(asSent).quotes);
});

// ---- 既有行为不能退化 -------------------------------------------------------

check("R154：未终结的截断引用块仍整体折叠", () => {
  const r = parseQuoteFromText("> 头部\n>\n> 被截断的尾巴 ...(truncated)...");
  assert.equal(r.quotes.length, 1);
  assert.equal(r.body.trim(), "");
});

check("R115：重复堆叠的引用去重成一条", () => {
  const dup = `> A\n>\n> B\n\n> A\n>\n> B\n\n${BODY}`;
  const r = parseQuoteFromText(dup);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.body.trim(), BODY);
});

check("两个不同引用各自成行", () => {
  const r = parseQuoteFromText(`> A\n>\n> A2\n\n> B\n\n${BODY}`);
  assert.equal(r.quotes.length, 2);
  assert.equal(r.body.trim(), BODY);
});

check("没有引用 → null（普通消息不受影响）", () => {
  assert.equal(parseQuoteFromText(BODY), null);
});

check("孤立的 '>' 空行开头不算引用（无实体内容不造空行）", () => {
  const r = parseQuoteFromText(`>\n\n${BODY}`);
  assert.equal(r, null);
});

fs.rmSync(outDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
