"use strict";

// Only the owned Supervisor calls this bridge, under its writer/source/Service
// fences. The child imports the pinned upstream handlers, never App/asar files.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { applyProviderCredentialOperation } = require("./openclaw-provider-credential-operation");
const METHODS = new Set(["config.set", "models.authSetApiKey", "models.authLogout"]);
const SOURCES = {
  "dist/config-DCEMZjGn.mjs": "d53c7d1b470b27262ec122a421ebb7e2b3c0680a219ad361d656457b8a0a5077",
  "dist/models-auth-status-Cg48vzMk.mjs": "854c9adeefc423275e307c6384a573716e085844ddd5f1f370faf84971273e14", // gitleaks:allow -- Reviewed source SHA-256
  "dist/config-revision-token-BE5gb7qW.mjs": "d077635242bfb0c94a8e3b299e8e4f3854f5b01b2ccae8998127c26c6268b874", // gitleaks:allow -- Reviewed source SHA-256
};
const fail = (code, extras = {}) => Object.assign(new Error(code), { code, ...extras });

const RUNNER = String.raw`
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const applyProviderCredentialOperation=${applyProviderCredentialOperation.toString()};
const root=process.argv[1],method=process.argv[2];
const emit=value=>process.stdout.write('SHOGGOTH_NATIVE_RESULT:'+JSON.stringify(value)+'\n');
let response=null,stage='imports';
try {
  console.log=console.info=console.warn=console.error=()=>{};
  let raw='';for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>2*1024*1024)throw Error('input');}
  const input=JSON.parse(raw);raw='';
  const revision=await import(pathToFileURL(path.join(root,'dist/config-revision-token-BE5gb7qW.mjs')).href);
  const io=await import(pathToFileURL(path.join(root,'dist/io.runtime-Bq0AQO_N.mjs')).href);
  const {configHandlers}=await import(pathToFileURL(path.join(root,'dist/config-DCEMZjGn.mjs')).href);
  stage='projector';const projector=revision.t();
  const context={configRevisionProjector:projector,getRuntimeConfig:()=>{io.n();return io.i();},
    logGateway:{warn(){},info(){},error(){},debug(){}}};
  const invoke=async(handler,params)=>{
    let frame=null;
    await handler({params,context,client:{connect:{scopes:['operator.admin']}},req:{method,params},
      respond:(ok,value,error)=>{if(frame)throw Error('duplicate response');frame={ok,value,code:error?.code};}});
    if(!frame)throw Error('missing response');return frame;
  };
  if(method==='config.set'){
    stage='config-save';
    const hash=crypto.createHash('sha256').update(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH)).digest('hex');
    if(hash!==input.baseHash){response={ok:false,code:'INVALID_REQUEST',responded:true};}
    else{
      const current=await invoke(configHandlers['config.get'],{});
      if(!current.ok||!current.value?.valid)response={ok:false,code:'INVALID_REQUEST',responded:true};
      else {
        const frame=await invoke(configHandlers['config.set'],{raw:input.raw,baseHash:current.value.hash});
        response={ok:frame.ok,responded:true,...frame.ok?{value:{ok:frame.value?.ok===true}}:{code:frame.code}};
      }
    }
  } else {
    stage='auth-write';
    const {modelsAuthStatusHandlers}=await import(pathToFileURL(path.join(root,'dist/models-auth-status-Cg48vzMk.mjs')).href);
    const frame=input.credentialScope==='provider'?{ok:true,value:await applyProviderCredentialOperation({
      ...input,clear:method==='models.authLogout',request:async (authMethod,params)=>{
        const result=await invoke(modelsAuthStatusHandlers[authMethod],params);
        if(!result.ok)throw Error('auth outcome unavailable');return result.value;
      }})}:await invoke(modelsAuthStatusHandlers[method],input);
    response={ok:frame.ok,responded:true,...frame.ok?{value:{provider:frame.value?.provider,
      ...(typeof frame.value?.profileId==='string'?{profileId:frame.value.profileId}:{}),
      ...(frame.value?.credentialScope==='provider'?{credentialScope:'provider',complete:frame.value.complete,
        agentIds:frame.value.agentIds,...Array.isArray(frame.value.profileIds)?{profileIds:frame.value.profileIds}:{}}:{}),
      ...(Array.isArray(frame.value?.removedProfiles)?{removedProfiles:frame.value.removedProfiles}:{}),
      ...(typeof frame.value?.warning==='string'?{warning:'Saved; runtime refresh requires verification'}:{})}}:{code:frame.code}};
  }
  emit(response);
} catch(error) { emit(response||{ok:false,responded:false,code:'MANAGED_NATIVE_OUTCOME_UNKNOWN',stage,
  nativeCode:typeof error?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:null}); }
`;

function verifyNativeModelSources(runtimeRoot) {
  for (const [relative, expected] of Object.entries(SOURCES)) {
    const file = path.join(runtimeRoot, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
      || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== expected) {
      throw fail("MANAGED_NATIVE_SOURCE_UNSUPPORTED");
    }
  }
  return true;
}

async function runNativeModelMethod({ runtimeRoot, dataRoot, execution, method, params, deadlineAt, signal, assertCurrent }) {
  if (!METHODS.has(method) || typeof assertCurrent !== "function" || !Number.isSafeInteger(deadlineAt)) throw fail("MANAGED_NATIVE_METHOD_INVALID");
  const check = () => {
    if (signal?.aborted || Date.now() >= deadlineAt || assertCurrent() === false) throw fail("MANAGED_NATIVE_OWNER_RETIRED");
  };
  check();
  for (const target of [dataRoot, execution.home, execution.stateDir, execution.workspace, execution.configPath]) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || fs.realpathSync(target) !== target || (stat.mode & 0o077) !== 0
      || process.getuid && stat.uid !== process.getuid()
      || !(target === dataRoot || target.startsWith(dataRoot + path.sep))) throw fail("MANAGED_NATIVE_PATH_UNSAFE");
  }
  verifyNativeModelSources(runtimeRoot);
  const input = JSON.stringify(params);
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw fail("MANAGED_NATIVE_DATA_LIMIT");
  return new Promise((resolve, reject) => {
    let output = "", invalid = false, child, killTimer, stopping = false;
    const stop = () => {
      invalid = true;
      if (stopping) return;
      stopping = true;
      try { child?.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch {} }, 1000);
      killTimer.unref?.();
    };
    const timer = setInterval(() => { try { check(); } catch { stop(); } }, 100);
    timer.unref?.();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      child = spawn(execution.interpreterPath, ["--input-type=module", "-e", RUNNER, runtimeRoot, method], {
        cwd: execution.workspace, env: { HOME: execution.home, PATH: `${path.dirname(execution.interpreterPath)}:/usr/bin:/bin`,
          LANG: "en_US.UTF-8", TMPDIR: "/private/tmp", OPENCLAW_STATE_DIR: execution.stateDir,
          OPENCLAW_CONFIG_PATH: execution.configPath, OPENCLAW_NO_AUTO_UPDATE: "1", OPENCLAW_DISABLE_BONJOUR: "1" },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch { clearInterval(timer); signal?.removeEventListener("abort", stop); reject(fail("MANAGED_NATIVE_START_FAILED")); return; }
    child.stdout.on("data", part => { output += part.toString(); if (Buffer.byteLength(output) > 65536) stop(); });
    child.stdin.on("error", () => {});
    child.on("error", () => { invalid = true; });
    child.on("close", code => {
      clearInterval(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", stop);
      try {
        check(); verifyNativeModelSources(runtimeRoot);
        if (invalid || code !== 0) throw fail("MANAGED_NATIVE_OUTCOME_UNKNOWN");
        const lines = output.split("\n").filter(line => line.startsWith("SHOGGOTH_NATIVE_RESULT:"));
        if (lines.length !== 1) throw fail("MANAGED_NATIVE_OUTCOME_UNKNOWN");
        const result = JSON.parse(lines[0].slice("SHOGGOTH_NATIVE_RESULT:".length));
        output = "";
        if (result.ok !== true) throw fail(typeof result.code === "string" && /^[A-Z0-9_]{1,80}$/.test(result.code)
          ? result.code : "MANAGED_NATIVE_OUTCOME_UNKNOWN", { gatewayResponse: result.responded === true,
            nativeStage: result.stage, nativeCode: result.nativeCode });
        resolve(result.value);
      } catch (error) { output = ""; reject(error); }
    });
    child.stdin.end(input);
  });
}

module.exports = { runNativeModelMethod, verifyNativeModelSources };
