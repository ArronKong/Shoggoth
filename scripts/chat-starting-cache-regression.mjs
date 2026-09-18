#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const uiRoot = path.join(root, "app/manage-ui");
const helperPath = path.join(uiRoot, "src/lib/sessionListCompleteness.ts");
const chatPath = path.join(uiRoot, "src/pages/ChatPage.tsx");
const cssPath = path.join(uiRoot, "src/pages/ChatPage.css");
const zhPath = path.join(uiRoot, "src/i18n/locales/zh-CN.ts");
const enPath = path.join(uiRoot, "src/i18n/locales/en.ts");
const immersivePath = path.join(uiRoot, "src/pages/immersive/ImmersiveChat.tsx");
const esbuild = path.join(uiRoot, "node_modules/.bin/esbuild");
const results = [];

function check(name, condition) {
  results.push({ name, ok: !!condition });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
}

let helper = null;
if (fs.existsSync(helperPath)) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-starting-cache-"));
  const outfile = path.join(tempDir, "helper.mjs");
  try {
    execFileSync(esbuild, [helperPath, "--format=esm", "--loader:.ts=ts", `--outfile=${outfile}`], { stdio: "pipe" });
    helper = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

check("session completeness helper exists", !!helper);
if (helper) {
  const previous = [
    { key: "agent:main:main", updatedAt: 20 },
    { key: "agent:hermes-default:main", updatedAt: 10 },
    { key: "agent:hermes-owl:main", updatedAt: 5 },
  ];
  const partial = [
    { key: "agent:main:main", updatedAt: 21 },
    { key: "agent:hermes-default:main", updatedAt: 11 },
  ];
  const partitionOf = (row) => row.key.split(":")[1].startsWith("hermes-") ? "hermes" : "openclaw";
  const kept = helper.mergeIncompleteSessionRows(previous, partial, new Set(["hermes"]), partitionOf);
  check("partial Hermes snapshot keeps cached missing agents", kept.some((row) => row.key === "agent:hermes-owl:main"));
  check("partial Hermes snapshot prefers the fresh duplicate", kept.find((row) => row.key === "agent:hermes-default:main")?.updatedAt === 11);
  check("partial Hermes snapshot remains deduplicated", new Set(kept.map((row) => row.key)).size === kept.length);

  const complete = helper.mergeIncompleteSessionRows(previous, partial, new Set(), partitionOf);
  check("complete snapshot removes stale cached agents", !complete.some((row) => row.key === "agent:hermes-owl:main"));
}

const chat = fs.readFileSync(chatPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");
const zh = fs.readFileSync(zhPath, "utf8");
const en = fs.readFileSync(enPath, "utf8");
const immersive = fs.readFileSync(immersivePath, "utf8");
check("chat uses the shared completeness merge", /mergeIncompleteSessionRows/.test(chat));
check("chat imports history cache", /from\s+["'][^"']*chatHistoryCache["']/.test(chat));
check("chat imports history runtime", /from\s+["'][^"']*chatHistoryRuntime["']/.test(chat));
check("startingBackends state remains for cache visibility", /\[startingBackends,\s*setStartingBackends\]\s*=\s*useState/.test(chat));
check("status refresh still collects backend starting", /info\?\.starting/.test(chat) && /setStartingBackends\(starting\)/.test(chat));
check("agent row has no explicit starting status branch", !/st\s*===\s*["']starting["']/.test(chat));
check("header has no visible starting label", !/liveStatus\.starting|return\s+["']starting["']/.test(chat));
check("Immersive liveStatusKind has no starting", !/liveStatusKind\s*[:=][^\n]*["']starting["']/.test(chat));
check("ImmersiveChat props exclude visible starting", !/ImmersiveLiveStatus[^\n]*starting|liveStatusKind[^\n]*starting/.test(immersive));
check("ImmersiveChat render excludes starting label", !/liveStatus\.starting|chat-status--starting|["']starting["']/.test(immersive));
check("starting status has no visible pulse styling", !/chat-status--starting/.test(css));
check("Chinese visible starting copy is removed", !/liveStatus:[^\n]*starting:\s*["']启动中["']/.test(zh));
check("English visible starting copy is removed", !/liveStatus:[^\n]*starting:\s*["']Starting["']/.test(en));

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
