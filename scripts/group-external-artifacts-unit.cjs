"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { GroupExternalArtifacts } = require("../app/agent-service/group-external-artifacts");
const { FederationHostClient } = require("../app/agent-service/federation-host-client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createFederationHostServer } = require("../app/federation-host-server");
const { GroupRuntimeHost } = require("../app/group-runtime-host");
const { GroupRuntimeRouter } = require("../app/group-runtime-router");
const { requestGroupHost } = require("../app/group-runtime-host-client");
const { ExternalInspirationRunner } = require("../app/external-inspiration-runner");
const { validateGroupExternalArtifactParams, validateGroupExternalArtifactResult } = require("../app/external-inspiration-protocol");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");

async function pairedFixture(t, { doubleSlash = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g-art-"))); fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "host-workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
  const agent = { backendId: "hermes", agentId: "artifact-fixture" };
  const authority = { groupId: crypto.randomUUID(), ownerId: crypto.randomUUID(), epoch: 1 };
  let generationCalls = 0;
  const forbidden = async () => { generationCalls++; throw new Error("fixture forbids generation"); };
  const registry = { getStatus: async () => [], getBackend: () => ({ getAgent: async () => ({ id: agent.agentId }) }) };
  const runner = new ExternalInspirationRunner({ registry, adapters: { hermes: {
    prepare: async input => ({ sessionKey: `agent:artifact-fixture:${input.sessionId}`, workspace: doubleSlash ? `/${workspace}` : workspace, mode: "gateway" }),
    start: forbidden, inspect: forbidden, fullResult: forbidden, cancel: forbidden, respond: forbidden, reset() {},
  } } });
  let host, federation;
  t.after(async () => {
    await federation?.stop(); await host?.close();
    assert.equal(generationCalls, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });
  host = new GroupRuntimeHost({ paths: { stateDir: path.join(root, "paired-host"), trustedRoot: root },
    agent, registry, ownerToken: token(), runtimeToken: token(), runner }).open();
  const address = await host.listen();
  const peer = { id: "paired-artifact-fixture", ...agent, hostId: host.hostId,
    baseUrl: `http://127.0.0.1:${address.port}/`, token: host.ownerToken };
  const identity = { executionId: crypto.randomUUID(), runId: crypto.randomUUID(), ...agent };
  const prepared = await requestGroupHost(peer, "host.prepare", { execution: { ...identity, sessionKey: null,
    workspace: null, operationId: `prepare-${identity.executionId}` }, kind: "task", taskId: crypto.randomUUID() }, authority);
  const external = { ...identity, ...prepared.binding, hostId: prepared.hostId,
    remote: { peerId: peer.id, hostId: peer.hostId, ...authority } };
  const router = new GroupRuntimeRouter({ allowRemote: true, localRunner: { reset() {} }, getPeers: () => [peer] });
  const paths = resolveServicePaths({ trustedRoot: root, userDataRoot: path.join(root, "service"),
    stateRoot: path.join(root, "service", "state"), profileRoot: path.join(root, "service", "profile"),
    cacheRoot: path.join(root, "service", "cache") });
  federation = createFederationHostServer({ paths, registry, groupRunner: router }); await federation.start();
  const client = new FederationHostClient({ paths }), requests = [];
  const broker = new GroupExternalArtifacts({ store: { getRemoteOwnerId: () => authority.ownerId, getDriverFence: () => authority.epoch },
    getClient: () => ({ request(method, params) { requests.push(structuredClone(params)); return client.request(method, params); } }) });
  return { root, workspace, external, broker, requests, artifactRoot: { external, groupId: authority.groupId },
    hostRequest: params => requestGroupHost(peer, "host.artifact", params, authority) };
}

test("absolute bound artifacts cross the real federation client and paired host with pinned paged bytes", async t => {
  const f = await pairedFixture(t), relative = "contributor/sum-valid.cjs";
  fs.mkdirSync(path.join(f.workspace, "contributor"));
  const file = path.join(f.workspace, relative), text = "远端交付🙂\n".repeat(4000);
  fs.writeFileSync(file, text);
  // The paired host's relative-only contract remains intact.
  await assert.rejects(f.hostRequest({ execution: Object.fromEntries(Object.entries(f.external).filter(([key]) => key !== "remote")),
    path: file, digest: null, offset: 0 }), error => error.code === "GROUP_HOST_ARTIFACT_INVALID");
  const artifact = await f.broker.resolve(f.artifactRoot, file);
  assert.deepEqual(artifact, { path: relative, bytes: Buffer.byteLength(text), digest: hash(text) });
  assert.ok(f.requests.length > 1);
  assert.equal(f.requests[0].path, relative); assert.equal(f.requests[0].digest, null);
  for (const request of f.requests.slice(1)) {
    assert.equal(request.path, relative); assert.equal(request.digest, artifact.digest);
    assert.ok(request.offset > 0 && request.offset % (16 * 1024) === 0);
  }
  fs.writeFileSync(file, "changed workspace bytes");
  f.requests.length = 0;
  assert.deepEqual(await f.broker.preview(f.artifactRoot, artifact), { text, truncated: false, changed: false });
  assert.ok(f.requests.every(request => request.path === relative && request.digest === artifact.digest));
  assert.equal(await f.broker.preview(f.artifactRoot, { ...artifact, digest: "0".repeat(64) }), null);
});

test("bound normalization cannot read siblings, traversal, the workspace root or a host symlink escape", async t => {
  const f = await pairedFixture(t);
  const outside = path.join(f.root, "outside.txt"); fs.writeFileSync(outside, "outside canary");
  const sibling = `${f.workspace}-other`; fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, "secret.txt"), "sibling canary");
  for (const requested of [f.workspace, `${f.workspace}/`, outside, path.join(sibling, "secret.txt"),
    `${f.workspace}/sub/../secret.txt`, "../outside.txt", "sub\\..\\outside.txt", "file:///host-workspace/result.txt"]) {
    const before = f.requests.length;
    assert.equal(await f.broker.resolve(f.artifactRoot, requested), null, requested);
    assert.equal(f.requests.length, before, requested);
  }
  fs.symlinkSync(outside, path.join(f.workspace, "escape.txt"));
  await assert.rejects(f.broker.resolve(f.artifactRoot, path.join(f.workspace, "escape.txt")),
    error => error.code === "GROUP_HOST_ARTIFACT_INVALID");
  assert.equal(fs.readFileSync(outside, "utf8"), "outside canary");
});

test("a real POSIX host with a double-slash binding receives a shared slash-relative path", async t => {
  const f = await pairedFixture(t, { doubleSlash: true }), relative = "contributor/result.txt";
  fs.mkdirSync(path.join(f.workspace, "contributor")); fs.writeFileSync(path.join(f.workspace, relative), "POSIX double slash bytes");
  const artifact = await f.broker.resolve(f.artifactRoot, `${f.external.workspace}/${relative}`);
  assert.deepEqual(artifact, { path: relative, bytes: 24, digest: hash("POSIX double slash bytes") });
  assert.equal(f.requests[0].path, relative);
});

function receiptFixture(workspace, relative, firstPath = relative) {
  const content = Buffer.from("跨设备路径🙂\n".repeat(1800)), digest = hash(content), requests = [];
  const artifactRoot = { groupId: crypto.randomUUID(), external: { executionId: crypto.randomUUID(), runId: crypto.randomUUID(),
    backendId: "hermes", agentId: "path-fixture", hostId: crypto.randomUUID(), sessionKey: "agent:path-fixture:session", workspace, mode: "gateway" } };
  const broker = new GroupExternalArtifacts({ store: {}, getClient: () => ({ request: async (method, params) => {
    assert.equal(method, "group.external.artifact"); assert.ok(validateGroupExternalArtifactParams(params));
    assert.equal(params.path, params.offset === 0 ? firstPath : relative); assert.equal(params.digest, params.offset === 0 ? null : digest);
    requests.push(structuredClone(params));
    const end = Math.min(params.offset + 16 * 1024, content.length);
    const result = { artifact: { path: relative, digest, bytes: content.length, offset: params.offset,
      nextOffset: end === content.length ? null : end, content: content.subarray(params.offset, end).toString("base64") } };
    assert.ok(validateGroupExternalArtifactResult(result)); return result;
  } }) });
  return { broker, artifactRoot, requests, digest, content };
}

test("absolute host syntax follows the binding even when that workspace does not exist on the Service", async () => {
  const cases = [
    ["/host-only/role", "/host-only/role/contributor/result.txt", "contributor/result.txt"],
    ["C:\\host-only\\role", "C:\\host-only\\role\\contributor\\result.txt", "contributor\\result.txt"],
    ["C:/host-only/role", "c:/host-only/role/contributor/result.txt", "contributor\\result.txt"],
    ["\\\\host-only\\share\\role", "\\\\HOST-ONLY\\share\\role\\contributor\\result.txt", "contributor\\result.txt"],
    ["//host-only/share/role", "//host-only/share/role/contributor/result.txt", "contributor\\result.txt", "contributor/result.txt"],
  ];
  for (const [workspace, requested, relative, firstPath] of cases) {
    const f = receiptFixture(workspace, relative, firstPath);
    assert.deepEqual(await f.broker.resolve(f.artifactRoot, requested), { path: relative, bytes: f.content.length, digest: f.digest });
    assert.ok(f.requests.length > 1);
  }
});

test("relative artifact spelling remains host-owned, including literal backslashes on POSIX", async () => {
  for (const [workspace, relative] of [["/host-only/role", "contributor/result.txt"],
    ["/host-only/role", "literal\\filename.txt"], ["C:\\host-only\\role", "contributor\\result.txt"]]) {
    const f = receiptFixture(workspace, relative);
    assert.equal((await f.broker.resolve(f.artifactRoot, relative)).path, relative);
  }
});

test("cross-device roots and ambiguous absolute syntax are refused before the client", async () => {
  const cases = [
    ["/host-only/role", "/host-only/role-other/result.txt"], ["/host-only/role", "C:\\host-only\\role\\result.txt"],
    ["C:\\host-only\\role", "D:\\host-only\\role\\result.txt"], ["C:\\host-only\\role", "/host-only/role/result.txt"],
    ["C:\\host-only\\role", "C:\\host-only\\role-other\\result.txt"], ["C:\\host-only\\role", "C:\\host-only\\role"],
    ["C:\\host-only\\role", "\\host-only\\role\\result.txt"], ["C:\\host-only\\role", "C:result.txt"],
    ["\\\\host-only\\share\\role", "\\\\host-only\\share-other\\role\\result.txt"],
    ["\\\\host-only\\share\\role", "\\\\other-host\\share\\role\\result.txt"],
    ["C:\\host-only\\role", "\\\\?\\C:\\host-only\\role\\result.txt"],
    ["//host-only/share/role", "//HOST-ONLY/share/role/result.txt"],
    ["//host-only/share/role", "//host-only/share/role/literal\\filename.txt"],
    ["//host-only/share/role", "\\\\host-only\\share\\role\\result.txt"],
    ["//?/C:/role", "//?/C:/role/result.txt"], ["//./share/role", "//./share/role/result.txt"],
    ["/host-only/role", "/host-only/role/sub\\..\\result.txt"],
    ["\\host-only\\role", "\\host-only\\role\\result.txt"], [null, "/host-only/role/result.txt"],
  ];
  for (const [workspace, requested] of cases) {
    let requests = 0;
    const broker = new GroupExternalArtifacts({ store: {}, getClient: () => ({ request: async () => { requests++; throw new Error("must not contact host"); } }) });
    assert.equal(await broker.resolve({ groupId: "path-fixture", external: { workspace } }, requested), null, `${workspace}: ${requested}`);
    assert.equal(requests, 0);
  }
});

test("paged artifact receipts reject digest changes, changed paths, oversized chunks and corrupt content", async () => {
  for (const mutation of ["digest", "path", "chunk", "offset", "bytes", "content"]) {
    const f = receiptFixture("/host-only/role", "result.txt");
    const original = f.broker.getClient(); let pages = 0;
    f.broker.getClient = () => ({ request: async (...args) => {
      const result = await original.request(...args); pages++;
      if (mutation === "digest" && pages === 2) result.artifact.digest = "0".repeat(64);
      if (mutation === "path" && pages === 2) result.artifact.path = "changed.txt";
      if (mutation === "chunk") result.artifact.content = Buffer.alloc(16 * 1024 + 1).toString("base64");
      if (mutation === "offset") result.artifact.nextOffset++;
      if (mutation === "bytes" && pages === 2) result.artifact.bytes++;
      if (mutation === "content" && pages === 1) result.artifact.content = Buffer.alloc(16 * 1024).toString("base64");
      return result;
    } });
    assert.equal(await f.broker.resolve(f.artifactRoot, "/host-only/role/result.txt"), null, mutation);
  }
});
