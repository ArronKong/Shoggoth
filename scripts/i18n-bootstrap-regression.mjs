#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const i18nPath = path.join(uiRoot, "src/i18n/index.ts");
const mainSource = fs.readFileSync(path.join(uiRoot, "src/main.tsx"), "utf8");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-i18n-bootstrap-"));
const outfile = path.join(outDir, "i18n.cjs");

const saved = {
  localStorage: globalThis.localStorage,
  navigator: globalThis.navigator,
  document: globalThis.document,
};
const values = new Map([["openclaw.i18n.locale", "en"]]);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { language: "en-US" },
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { documentElement: { lang: "" } },
});

try {
  execFileSync(path.join(uiRoot, "node_modules/.bin/esbuild"), [
    i18nPath,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${outfile}`,
  ]);
  const runtime = createRequire(import.meta.url)(outfile);
  assert.equal(typeof runtime.applyConfiguredLocale, "function");

  await runtime.applyConfiguredLocale("zh-CN");
  assert.equal(runtime.default.language, "zh-CN", "config.locale 应覆盖陈旧 localStorage");
  assert.equal(values.get("openclaw.i18n.locale"), "zh-CN");
  assert.equal(globalThis.document.documentElement.lang, "zh-CN");

  await runtime.applyConfiguredLocale("");
  assert.equal(runtime.default.language, "en", "follow-system 应回落 navigator.language");
  assert.equal(values.has("openclaw.i18n.locale"), false);

  assert.match(mainSource, /await getConfig\(\)[\s\S]{0,220}await applyConfiguredLocale/);
  assert.ok(
    mainSource.indexOf("await applyConfiguredLocale") < mainSource.indexOf(".render("),
    "首个 React render 前必须应用 config locale",
  );
  console.log("PASS BUG-024 standalone locale 在首帧前以 config 为准");
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else Object.defineProperty(globalThis, key, { configurable: true, value });
  }
}
