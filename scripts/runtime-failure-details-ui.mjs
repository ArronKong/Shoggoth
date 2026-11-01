#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { build, transformSync } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { transcriptHistoryItem } = require("../app/agent-service/chat-service-controller");
const module = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(root, "app/manage-ui/src/lib/gatewayErrors.ts"), "utf8"),
  { loader: "ts", format: "cjs" }).code, { module, exports: module.exports });
const translate = module.exports.translateGatewayError;
for (const reason of ["Invalid API key for project example; request id abc", "You exceeded your current quota; daily limit 100, reset tomorrow",
  "OAuth session expired for workspace example; request id abc", "LLM idle timeout after 45s during tool execution"]) {
  assert.equal(translate(reason, () => "统一文案"), reason);
}
assert.equal(translate("401 Invalid API Key", () => "密钥无效"), "密钥无效");
const key = "agent:shoggoth-default:failure-fixture";
const englishRegion = "Google's model API does not support the region of this request. The task did not complete; check the service's supported regions and your current network egress.";
const englishMissing = "Antigravity failed to complete this task. The provider did not supply displayable error details. The task was not replayed automatically; check the native session before deciding whether to retry.";
const backend = new ShoggothBackend({ requestService: async () => { throw Error("fixture must stay offline"); } });
backend._sessionTarget = () => ({ profile: { id: "fixture" }, sessionKey: "failure-fixture" });
// Exercise the actual Backend fallback copy, including failures without a
// diagnostic. A wording change must not silently bypass localization.
for (const [code, expectedKey] of Object.entries({
  ANTIGRAVITY_REGION_UNSUPPORTED: "regionUnsupported", ANTIGRAVITY_TURN_FAILED: "runtimeFailureNoDetails",
  ANTIGRAVITY_NETWORK_UNAVAILABLE: "providerNetworkUnavailable", ANTIGRAVITY_MCP_UNAVAILABLE: "runtimeToolsUnavailable",
  RUNTIME_AUTH_REQUIRED: "runtimeAuthRequired", RUNTIME_QUOTA_EXHAUSTED: "runtimeQuotaExceeded",
  RUNTIME_RATE_LIMITED: "runtimeRateLimited", RUNTIME_SPENDING_LIMIT_REACHED: "runtimeSpendingLimit",
  RUNTIME_ACCOUNT_BLOCKED: "runtimeAccountBlocked", RUNTIME_UPSTREAM_UNAVAILABLE: "runtimeUpstreamUnavailable",
  RUNTIME_MODEL_UNAVAILABLE: "runtimeModelUnavailable", RUNTIME_MODEL_SETTINGS_INVALID: "runtimeSettingsInvalid",
  RUNTIME_MAX_TOKENS: "runtimeMaxTokens", RUNTIME_MAX_TURN_REQUESTS: "runtimeMaxTurnRequests", RUNTIME_REFUSED: "runtimeRefused",
})) {
  let message;
  await backend._consumeEvent({ key, sessionKey: "failure-fixture", run: { id: "fallback-fixture" }, poll: {},
    hooks: { error: value => { message = value; } } }, { text: "", settled: false },
  { type: "terminal", payload: { status: "failed", errorCode: code, failure: null } });
  assert.equal(translate(message, key => key), `chat.gwErrors.${expectedKey}`, `${code} fallback must be localized`);
  assert.equal(translate(`${message}; provider request id fixture`, () => "lost"), `${message}; provider request id fixture`);
}
const cases = [];
for (const [code, failure, englishSummary, englishDetail] of [
  ["ANTIGRAVITY_REGION_UNSUPPORTED", { message: "User location is not supported for the API use.", httpStatus: 400, upstreamCode: "FAILED_PRECONDITION" }, englishRegion],
  ["RUNTIME_QUOTA_EXHAUSTED", { message: "You exceeded your current quota; daily limit 100. Contact the project administrator.", httpStatus: 429, upstreamCode: "insufficient_quota" }, "The account's quota is exhausted and the request has stopped. Wait for the quota to reset, add quota, or switch accounts before retrying."],
  ["ANTIGRAVITY_TURN_FAILED", { message: "Project verification required. Invalid API key for this project.", httpStatus: 403, upstreamCode: "project_verification_required" }, "The task failed and was not replayed automatically. See the provider details below."],
  ["ANTIGRAVITY_TURN_FAILED", null, englishMissing],
  ["RUNTIME_AUTH_REQUIRED", { message: "Invalid credentials.\nAuthorization: Bearer fixture-secret\nContact user@example.com\nConfig /Users/alice/private.json\nURL http://[bad]", httpStatus: 401 }, "Agent authentication failed. Check the account under Models or sign in again before retrying.", "Invalid credentials.\n[REDACTED]\nContact [EMAIL REDACTED]\nConfig [PATH REDACTED]\nURL [URL REDACTED]"],
  ["ANTIGRAVITY_REGION_UNSUPPORTED", null, englishRegion],
  ["RUNTIME_QUOTA_EXHAUSTED", null, "The account's quota is exhausted and the request has stopped. Wait for the quota to reset, add quota, or switch accounts before retrying."],
  ["RUNTIME_AUTH_REQUIRED", null, "Agent authentication failed. Check the account under Models or sign in again before retrying."],
]) {
  const frames = [], runId = "run-fixture";
  backend._getHistoryItems = async () => [];
  const context = { key, sessionKey: "failure-fixture", run: { id: runId }, poll: {}, hooks: {
    error: errorMessage => frames.push({ type: "event", event: "chat", payload: { sessionKey: key, runId, state: "error", errorMessage } }),
  } };
  await backend._consumeEvent(context, { text: "", settled: false }, { type: "terminal", payload: { status: "failed", errorCode: code, failure } });
  const item = transcriptHistoryItem({ id: "terminal-fixture", runId, kind: "error", seq: 1, contextExcluded: false, occurredAt: 200,
    content: { transcriptType: "terminal", status: "failed", errorCode: code, failure, resultSummary: null } });
  backend._getHistoryItems = async () => [item];
  const history = (await backend.getHistory(key)).messages[0];
  assert.equal(history.content[0].text, `错误：${frames[0].payload.errorMessage}`);
  const status = failure ? [failure.httpStatus ? `HTTP ${failure.httpStatus}` : null, failure.upstreamCode].filter(Boolean).join(" · ") : "";
  const expectedEnglish = `Error: ${englishSummary}${failure ? `\nProvider error: ${englishDetail || failure.message}${status ? `\n${status}` : ""}\nError code: ${code}` : ""}`;
  cases.push({ frame: frames[0], history, expected: { "zh-CN": history.content[0].text, en: expectedEnglish } });
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-error-ui-"));
const output = path.join(root, ".artifacts/runtime-failure-details-20261029/ui-bilingual");
fs.mkdirSync(output, { recursive: true });
try {
  await build({ entryPoints: [path.join(root, "scripts/fixtures/runtime-failure-details.tsx")], bundle: true, format: "esm",
    // The offline fixture does not open connector dialogs; Vite's optional
    // logo globs use their normal empty-artwork fallback under esbuild.
    define: { "process.env.NODE_ENV": '"production"', "import.meta.glob": "fixtureAssetGlob", __ERROR_FIXTURE__: JSON.stringify({ key, cases }) },
    banner: { js: "const fixtureAssetGlob=()=>({});" },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl" }, outfile: path.join(temp, "fixture.js"),
    nodePaths: [path.join(root, "app/manage-ui/node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="fixture.js"></script>');
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `const {app,BrowserWindow}=require("electron");const fs=require("node:fs");
app.setPath("userData",${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1360,height:900,webPreferences:{backgroundThrottling:false}});let passed=false;
w.webContents.on('console-message',event=>{if(event.level==='error')console.error(String(event.message).slice(0,2000));});
try {const results=[];for(const language of ['zh-CN','en'])for(const width of [1360,600])for(const mode of [0,1])for(let sample=0;sample<${cases.length};sample++){
w.setContentSize(width,900);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))},{query:{case:String(sample),history:String(mode),language}});
const checked=await w.webContents.executeJavaScript('(async()=>{try{return{ok:true,value:await window.runFixture()}}catch(error){return{ok:false,error:String(error.stack||error)}}})()');
if(!checked.ok)throw Error(JSON.stringify({language,width,mode,sample,error:checked.error}));
results.push({language,width,sample,...checked.value});
if(sample===0)fs.writeFileSync(${JSON.stringify(output)}+'/'+language+'-'+width+'-'+mode+'.png',(await w.webContents.capturePage()).toPNG());
}console.log(JSON.stringify({passed:true,results}));passed=true;}catch(error){console.error(error.stack||error);}finally{w.destroy();app.exit(passed?0:1);}});`);
  const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [main], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  fs.writeFileSync(path.join(output, "result.json"), result.stdout || "");
  if (result.status !== 0) process.stderr.write(result.stderr || String(result.error));
  assert.equal(result.status, 0, "isolated error UI fixture failed");
  assert.match(result.stdout, /"passed":true/);
  console.log(`PASS: bilingual error details, ${cases.length} causes × 2 widths × 2 modes × 2 languages; live language switching and original provider details preserved`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
