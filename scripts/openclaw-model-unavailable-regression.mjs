#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Only pure error/display helpers run from the pinned package. No Gateway,
// account, production transcript, or model request participates in this test.
const root = path.resolve(import.meta.dirname, "..");
const source = process.env.SHOGGOTH_TEST_OPENCLAW_SOURCE || "/opt/homebrew/lib/node_modules/openclaw";
const payloadRoot = path.join(root, "resources/external-plugin-host-patches/openclaw/2026.9.9-managed-v3");
const manifest = JSON.parse(fs.readFileSync(path.join(payloadRoot, "openclaw-2026.9.9-managed.json"), "utf8"));
const { build } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const files = ["classify-core-CZDKY3fB.mjs", "embedded-agent-helpers-CNzM9z5K.mjs", "assistant-request-failure-copy-DDaASoSI.mjs"];
const originals = new Map(files.map(file => [path.join(source, "dist", file), fs.readFileSync(path.join(source, "dist", file), "utf8")]));
const patched = new Map(originals);
if (!process.argv.includes("--unpatched")) for (const item of manifest.files) {
  const file = path.join(source, item.path);
  if (!patched.has(file)) continue;
  let content = originals.get(file);
  assert.equal(sha(content), item.beforeSha256, `pinned original: ${item.path}`);
  for (const edit of item.edits) {
    const at = content.indexOf(edit.before);
    assert.ok(at >= 0 && content.indexOf(edit.before, at + 1) < 0, `unique patch anchor: ${item.path}`);
    content = content.slice(0, at) + edit.after + content.slice(at + edit.before.length);
  }
  assert.equal(sha(content), item.afterSha256, `pinned output: ${item.path}`);
  patched.set(file, content);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-model-unavailable-"));
try {
  fs.symlinkSync(path.join(source, "node_modules"), path.join(temp, "node_modules"), "dir");
  await build({ stdin: { contents: `
    export { n as classify } from "./classify-core-CZDKY3fB.mjs";
    export { h as live } from "./embedded-agent-helpers-CNzM9z5K.mjs";
    export { o as recorded } from "./assistant-request-failure-copy-DDaASoSI.mjs";
    export { a as display } from "./chat-display-projection.core-Dxw4YBTq.mjs";
  `, resolveDir: path.join(source, "dist") }, bundle: true, packages: "external", platform: "node", format: "esm",
    outfile: path.join(temp, "errors.mjs"), logLevel: "silent", plugins: [{ name: "pinned-error-patch", setup(builder) {
      builder.onLoad({ filter: /\.mjs$/ }, args => patched.has(args.path)
        ? { contents: patched.get(args.path), resolveDir: path.dirname(args.path), loader: "js" } : null);
    } }] });
  const runtime = await import(pathToFileURL(path.join(temp, "errors.mjs")).href);
  const originalError = "400 Model id : deepseek-ai/DeepSeek-V4.1-Flash , has no provider supported";
  const message = { role: "assistant", content: [], stopReason: "error", provider: "modelscope", model: "deepseek-ai/DeepSeek-V4.1-Flash",
    errorMessage: originalError, errorCode: "400", errorBody: JSON.stringify({ message: originalError.slice(4), request_id: "fixture-request" }) };
  const cases = [];
  for (const errorMessage of [originalError,
    `400 ${JSON.stringify({ error: { type: "invalid_request_error", message: originalError.slice(4) } })}`,
    "404 The model fixture-model does not exist", "400 No endpoints found for fixture-model"]) {
    const item = { ...message, errorMessage, errorCode: errorMessage.slice(0, 3),
      errorBody: errorMessage === originalError ? message.errorBody : undefined };
    const reason = runtime.classify({ message: errorMessage, status: Number(item.errorCode), provider: item.provider });
    assert.equal(reason?.reason, "model_not_found", "model availability must take precedence over generic HTTP 400 format classification");
    const live = runtime.live(item), recorded = runtime.recorded(item);
    assert.match(live, /model unavailable/u);
    assert.equal(live, recorded, "live and saved errors must share the availability explanation");
    assert.doesNotMatch(live, /request format rejected|schema|fixture-request/u);
    cases.push({ live, history: runtime.display(item) });
  }
  for (const errorMessage of ["400 Invalid tool schema: required property is missing", "400 Invalid messages: unsupported role",
    `400 ${JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid tool arguments for model fixture-model" } })}`]) {
    assert.equal(runtime.classify({ message: errorMessage, status: 400 })?.reason, "format");
    assert.doesNotMatch(runtime.live({ ...message, errorMessage, errorBody: undefined }), /model unavailable/u);
  }
  for (const [errorMessage, reason] of [["401 Invalid API key", "auth"], ["429 Rate limit exceeded", "rate_limit"],
    ["503 Service unavailable", "overloaded"]]) {
    assert.equal(runtime.classify({ message: errorMessage, status: Number(errorMessage.slice(0, 3)) })?.reason, reason);
  }
  assert.equal(runtime.live({ ...message, errorMessage: "SECRET_MODEL_PROJECTION_UNAVAILABLE" }), "SECRET_MODEL_PROJECTION_UNAVAILABLE");
  await build({ stdin: { contents: `
    export { translateGatewayError as translate } from "${path.join(root, "app/manage-ui/src/lib/gatewayErrors.ts")}";
    export { default as zh } from "${path.join(root, "app/manage-ui/src/i18n/locales/zh-CN.ts")}";
    export { default as en } from "${path.join(root, "app/manage-ui/src/i18n/locales/en.ts")}";
  `, resolveDir: root }, bundle: true, platform: "node", format: "esm", outfile: path.join(temp, "copy.mjs"), logLevel: "silent" });
  const { translate, zh, en } = await import(pathToFileURL(path.join(temp, "copy.mjs")).href);
  const t = dictionary => (key, vars = {}) => key.split(".").reduce((value, field) => value[field], dictionary)
    .replace(/\{\{(\w+)\}\}/gu, (_match, name) => String(vars[name]));
  const uiCases = cases.map(({ live, history }, index) => {
    const historyExpected = Object.fromEntries([["zh-CN", zh], ["en", en]].map(([language, dictionary]) => {
      const translated = translate(live, t(dictionary));
      assert.match(translated, language === "zh-CN" ? /所选模型当前不可用/u : /selected model is currently unavailable/u);
      assert.match(translated, new RegExp(`HTTP ${index === 2 ? 404 : 400}`, "u"));
      return [language, translated];
    }));
    const expected = Object.fromEntries([["zh-CN", zh], ["en", en]].map(([language, dictionary]) =>
      [language, t(dictionary)("chat.errorPrefix", { msg: historyExpected[language] })]));
    const historicalText = history.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.equal(historicalText, live);
    assert.equal(history.errorBody, undefined, "provider diagnostics must remain hidden from display projections");
    return { frame: { type: "event", event: "chat", payload: { sessionKey: "agent:shoggoth-default:failure-fixture", runId: `model-error-${index}`, state: "error", errorMessage: live } },
      history, expected, historyExpected };
  });
  const trueFormat = "⚠️ LLM request failed (request format rejected, HTTP 400).";
  assert.equal(translate(trueFormat, t(zh)), trueFormat, "a real format failure must not be relabeled as model unavailability");
  assert.equal(translate(originalError + "; extra provider details", t(zh)), originalError + "; extra provider details");
  const noStatus = runtime.live({ ...message, errorMessage: originalError.slice(4), errorCode: undefined, errorBody: undefined });
  assert.equal(translate(noStatus, t(zh)), zh.chat.gwErrors.providerModelUnavailable);
  assert.equal(translate(noStatus, t(en)), en.chat.gwErrors.providerModelUnavailable);
  console.log("PASS: unavailable model classification, live/history parity, genuine format/auth/rate-limit/server errors, secret-projection boundary and bilingual copy");
  if (process.argv.includes("--ui")) {
    // Reuse the actual ChatPage fixture for both realtime events and history.
    const output = path.join(root, ".artifacts/model-unavailable-errors-20261102");
    fs.mkdirSync(output, { recursive: true });
    // Live system errors use ChatPage's error prefix. Projected assistant
    // history has its own error styling and does not add that prefix.
    const fixtureData = JSON.stringify({ key: "agent:shoggoth-default:failure-fixture", cases: uiCases });
    await build({ entryPoints: [path.join(root, "scripts/fixtures/runtime-failure-details.tsx")], bundle: true, format: "esm",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.glob": "fixtureAssetGlob", __ERROR_FIXTURE__: "fixtureErrorCases" },
      banner: { js: `const fixtureAssetGlob=()=>({});const fixtureErrorCases=${fixtureData};if(new URLSearchParams(location.search).get('history')==='1')for(const sample of fixtureErrorCases.cases)sample.expected=sample.historyExpected;` },
      loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" },
      outfile: path.join(temp, "fixture.js"), nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent" });
    fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
    fs.writeFileSync(path.join(temp, "main.cjs"), `const {app,BrowserWindow}=require("electron");const fs=require("node:fs");
      app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
      app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1360,height:900,webPreferences:{backgroundThrottling:false}});let passed=false;
      try {const results=[];for(const language of ['zh-CN','en'])for(const width of [1360,600])for(const mode of [0,1])for(let sample=0;sample<${uiCases.length};sample++){
        w.setContentSize(width,900);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{case:String(sample),history:String(mode),language}});
        const result=await w.webContents.executeJavaScript('(async()=>{try{return{ok:true,value:await window.runFixture()}}catch(error){return{ok:false,error:String(error.stack||error)}}})()');
        if(!result.ok)throw Error(JSON.stringify({language,width,mode,sample,error:result.error}));results.push({language,width,mode,sample,...result.value});
        if(sample===0)fs.writeFileSync(${JSON.stringify(output)}+'/'+language+'-'+width+'-'+mode+'.png',(await w.webContents.capturePage()).toPNG());
      }fs.writeFileSync(${JSON.stringify(path.join(output, "results.json"))},JSON.stringify(results,null,2));console.log('PASS: '+results.length+' ChatPage cases');passed=true;
      }catch(error){console.error(error.stack||error);}finally{w.destroy();app.exit(passed?0:1);}});`);
    const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [path.join(temp, "main.cjs")], {
      encoding: "utf8", timeout: 60000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
    if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
    assert.equal(result.status, 0, "isolated ChatPage fixture");
    process.stdout.write(result.stdout);
  }
} finally {
  for (const [file, content] of originals) assert.equal(fs.readFileSync(file, "utf8"), content, "installed runtime must remain unchanged");
  fs.rmSync(temp, { recursive: true, force: true });
}
