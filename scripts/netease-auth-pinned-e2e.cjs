"use strict";
// Explicit, offline acceptance of an already verified pinned installation.
// Copies only manifest-owned program files, never the user's HOME or secrets.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict"), { execFileSync, spawn } = require("node:child_process");
const { createOfficialSkillRuntime } = require("../app/agent-service/official-skill-runtime");
const source = path.resolve(process.argv.find(value => value.startsWith("--cli-root="))?.slice(11) || "");
assert.ok(process.argv.some(value => value.startsWith("--cli-root=")), "Supply --cli-root=<verified official installation>");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "payload-manifest.json"), "utf8"));
assert.equal(manifest.providerId, "netease-music");
assert.equal(JSON.parse(fs.readFileSync(path.join(source, "runtime/package.json"), "utf8")).version, "0.1.7");
const base = fs.mkdtempSync("/private/tmp/netease-auth-pinned-"); fs.chmodSync(base, 0o700);
const root = path.join(base, "state/runtime-bin/official-skills/netease-music", crypto.randomUUID()), home = path.join(root, "home"), audit = path.join(base, "audit.jsonl"), mock = path.join(base, "mock.cjs");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
for (const file of manifest.files) {
  assert.ok(!path.isAbsolute(file.path) && !file.path.split(/[\\/]/u).some(part => !part || part === "." || part === ".."));
  const from = path.join(source, file.path), to = path.join(root, file.path);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(from)).digest("hex"), file.sha256);
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); execFileSync("/bin/cp", ["-c", from, to]); fs.chmodSync(to, 0o600);
}
fs.writeFileSync(path.join(root, "payload-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
fs.writeFileSync(mock, `
const fs=require('node:fs'),net=require('node:net'),tls=require('node:tls'),cp=require('node:child_process');
const audit=${JSON.stringify(audit)},write=value=>fs.appendFileSync(audit,JSON.stringify(value)+'\\n',{mode:0o600});
write({pid:process.pid,kind:'started'});
net.connect=net.createConnection=tls.connect=()=>{throw Error('Real network forbidden in pinned acceptance')};
global.fetch=async input=>{const u=new URL(typeof input==='string'?input:input.url||input);write({pid:process.pid,path:u.pathname});
 let value={code:500,message:'Offline fixture rejects unexpected request'};
 if(u.pathname.includes('/login/anonymous'))value={code:200,data:{accessToken:'fixture-anonymous',refreshToken:'fixture-refresh',expireTime:4102444800000,scopes:[]}};
 if(u.pathname.includes('/qrcodekey/get/'))value={code:200,subCode:0,data:{qrCodeUrl:'https://163cn.tv/fixtureAuth',uniKey:'fixture-unikey'}};
 if(u.pathname.includes('/device/login/qrcode/get'))value={code:200,subCode:801,message:'等待扫码',data:{status:801}};
 return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
};
const original=cp.spawn;
cp.spawn=function(command,args,options={}){const env={...(options.env||process.env)};env.NODE_OPTIONS=(env.NODE_OPTIONS||'')+' --require='+__filename;return original.call(this,command,command===process.execPath?['--require',__filename,...args]:args,{...options,env});};
`, { mode: 0o600 });
const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey.replace(/-----(?:BEGIN|END) PRIVATE KEY-----|\s+/gu, "");
const diagnostics = [];
const runtime = createOfficialSkillRuntime({ providerId: "netease-music", root, home, env: { NCM_APP_ID: "fixture-app", NCM_PRIVATE_KEY: key },
  spawn: (command, args, options) => {
    const child = spawn(command, ["--require", mock, ...args], { ...options, env: { ...options.env, NODE_OPTIONS: `--require=${mock}` } });
    const result = { command: args.includes("--field") ? "config" : args.slice(3), stdout: "", stderr: "" }; diagnostics.push(result);
    child.stdout.on("data", bytes => { result.stdout += bytes; }); child.stderr.on("data", bytes => { result.stderr += bytes; });
    return child;
  },
});
const readAudit = () => fs.existsSync(audit) ? fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
const waitFor = async predicate => { const deadline = Date.now() + 7000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); } assert.fail("Pinned CLI condition timed out"); };
(async () => {
  try {
    const started = await runtime.call("account_start", {});
    assert.equal(started.state, "authorizing"); assert.equal(started.verificationUrl, "https://163cn.tv/fixtureAuth");
    await waitFor(() => readAudit().filter(row => row.path?.endsWith("/device/login/qrcode/get")).length >= 2);
    assert.equal((await runtime.call("account_status", {})).state, "authorizing");
    const rows = readAudit(), pollers = [...new Set(rows.filter(row => row.path?.endsWith("/device/login/qrcode/get")).map(row => row.pid))];
    assert.ok(pollers.length && pollers.every(alive)); await runtime.close();
    await waitFor(() => [...new Set(readAudit().map(row => row.pid))].every(pid => !alive(pid)));
    console.log(JSON.stringify({ version: "0.1.7", host: "163cn.tv", pollingRequests: rows.filter(row => row.path?.endsWith("/device/login/qrcode/get")).length, managedPollerAlive: true, closedAllChildren: true, electron: !!process.versions.electron, network: "mock-only", sourceFilesVerified: manifest.files.length }));
  } catch (error) { console.error(JSON.stringify({ diagnostics, requests: readAudit().filter(row => row.path).map(row => row.path) })); throw error; }
  finally { await runtime.close(); fs.rmSync(base, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
