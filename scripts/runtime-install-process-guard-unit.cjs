#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const { parseProcesses, assertAllowedProcesses } = require("./runtime-install-process-guard.cjs");
const parentMap = { 30485: 30111, 30547: 30110, 38087: 36183, 39138: 30112, 39139: 30115, 39140: 30113 };
const time = "Wed Sep 23 19:54:17 2026", uid = process.getuid();
const bin = `${os.userInfo().homedir}/.hermes/hermes-agent/venv/bin`;
const app = "/Applications/Shoggoth.app/Contents";
const parents = Object.values(parentMap).map(pid => ({ pid, ppid: 1, uid, starttime: time,
  command: `${bin}/python3 ${bin}/hermes dashboard --no-open --skip-build --port 9119 --host 127.0.0.1` }));
const processes = Object.entries(parentMap).map(([pid, ppid]) => ({ pid: Number(pid), ppid, uid, starttime: time,
  command: `${app}/MacOS/Shoggoth ${app}/Resources/app.asar/app/bootstrap.js --shoggoth-internal-role=mcp --shoggoth-runtime-profile=shoggoth-test --shoggoth-runtime-account=shoggoth-default`,
  parent: parents.find(row => row.pid === ppid) }));
const permit = { processes }, rows = [...parents, ...processes.map(({ parent, ...row }) => row)];
const facts = () => ({ federationHermes: true, electronRunAsNode: true });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
function rejects(snapshot, expected = permit, env = facts) {
  assert.throws(() => assertAllowedProcesses(snapshot, expected, env), /INSTALL_/u);
}
test("ps parser preserves exact full command and normalizes start-time padding", () => {
  const row = rows[0];
  assert.deepEqual(parseProcesses(` ${row.pid} ${row.ppid} ${uid} Wed Sep  3 19:54:17 2026 ${row.command}\n`),
    [{ ...row, starttime: "Wed Sep 3 19:54:17 2026" }]);
  assert.throws(() => parseProcesses("invalid ps response"), /INSTALL_PROCESS_STATE_UNKNOWN/u);
});
test("default refuses every App helper and allows no App processes", () => {
  rejects(rows, null);
  assert.deepEqual(assertAllowedProcesses(parents, null), { permittedExternalMcpPids: [] });
});
test("six exact identities with federation environment are allowed", () => {
  assert.equal(assertAllowedProcesses(rows, permit, facts).permittedExternalMcpPids.length, 6);
});
test("new helper or Service PID is rejected", () => {
  rejects([...rows, { ...rows.at(-1), pid: 99999 }]);
  rejects([...rows, { pid: 99999, command: "node app/bootstrap.js --shoggoth-internal-role=agent-service" }]);
});
test("PID reuse, reparent, UID, full command and parent identity changes fail", () => {
  for (const key of ["pid", "ppid", "uid", "starttime", "command"]) {
    for (const index of [0, rows.length - 1]) {
      const copy = structuredClone(rows);
      copy[index][key] = typeof copy[index][key] === "number" ? copy[index][key] + 1 : `${copy[index][key]} changed`;
      rejects(copy);
    }
  }
});
test("missing helper, duplicate permit and non-federation environment fail", () => {
  rejects(rows.slice(0, -1));
  rejects(rows, { processes: [...processes.slice(1), processes[1]] });
  rejects(rows, permit, () => ({ federationHermes: false, electronRunAsNode: true }));
  rejects(rows, permit, () => ({ federationHermes: true, electronRunAsNode: false }));
});
console.log(`${passed}/${passed} passed`);
