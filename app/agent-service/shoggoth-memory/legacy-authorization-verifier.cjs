"use strict";

// Bounded draft: fixed durable Product / Session / Transcript / receipt inputs,
// original Policy / CandidateService / Engine algorithms, no writer startup.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { JsonlProductStore } = require("../product-store");
const { ChatSessionStore } = require("../chat-session-store");
const { TranscriptStore } = require("../transcript-store");
const { MemoryCandidateStore } = require("../memory-candidate-store");
const { MemoryCandidateService } = require("../memory-candidate-service");
const { ConversationRecallService } = require("../conversation-recall-service");
const { MemoryStore } = require("../memory-store");
const { MemoryEngine, memoryTrust, matchesWorkspace, workspaceMemoryRefs } = require("../memory-engine");
const { RecallPolicyStore } = require("../recall-policy-store");
const { createWorkDispatcher } = require("../work-run");
const { readPrivateFile, validatePrivateStat } = require("../private-file");
const { serviceError } = require("../security");

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const REVIEWED = /^reviewed-(mc-[a-f0-9]{64})$/u;
const SHARED = new Set(["user", "project", "workspace"]);
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ITEMS = 10_000, MAX_CELLS = 500_000;
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`
    : JSON.stringify(value);
const fail = (code, text) => { throw serviceError(code, text); };
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function stat(target) { try { return fs.lstatSync(target); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
function identity(s) { return { dev: s.dev, ino: s.ino, mode: s.mode, uid: s.uid, nlink: s.nlink, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }; }
function checkInput(paths, profileId, now, assertCurrent) {
  if (!paths || typeof paths.trustedRoot !== "string" || fs.realpathSync.native(paths.trustedRoot) !== paths.trustedRoot
    || !ID.test(profileId || "") || !Number.isSafeInteger(now) || now < 0 || typeof assertCurrent !== "function") {
    fail("MEMORY_ROLLBACK_AUTHORIZATION_INPUT_INVALID", "授权矩阵需要固定路径、Profile、时间与同步停服证明");
  }
  if (paths.agentsDir !== path.join(paths.stateDir, "agents") || paths.eventLogPath !== path.join(paths.stateDir, "events.jsonl")
    || paths.stateSnapshotPath !== path.join(paths.stateDir, "state.snapshot.json")) {
    fail("MEMORY_ROLLBACK_PATH_UNSAFE", "授权矩阵只能读取固定 Product 权威路径");
  }
}
function stopped(assertCurrent) {
  const result = assertCurrent();
  if (result !== true && result !== undefined) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "授权矩阵停服及来源证明未同步成立");
}

// Snapshot excludes only the selected Profile's two primary files: apply may
// change those through its owned journal batches. Every peer primary remains
// pinned. Full capture is also taken before/after every read-only evaluation.
function captureResources(paths, profileId, profileIds, workspaces, auxiliary = false, ownedSnapshotArtifactsNames = []) {
  const files = new Map(), directories = new Map(), root = paths.trustedRoot;
  if (!Array.isArray(ownedSnapshotArtifactsNames) || ownedSnapshotArtifactsNames.length > 16
    || new Set(ownedSnapshotArtifactsNames).size !== ownedSnapshotArtifactsNames.length
    || ownedSnapshotArtifactsNames.some(name => typeof name !== "string" || !/^(?:snapshot\.json\.tmp|snapshot\.json\.backup-[1-9][0-9]*-[a-f0-9]{16})$/u.test(name))
    || !auxiliary && ownedSnapshotArtifactsNames.length) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "授权辅助捕获只允许已证明本 intent 归属的固定 snapshot 残留");
  const skipped = new Set(auxiliary ? ["events.jsonl", "snapshot.json", ...ownedSnapshotArtifactsNames].map(n => path.join(paths.agentsDir, profileId, "memory", n)) : []);
  const owned = (target, isDirectory = false) => {
    if (target !== path.resolve(target) || !(target.startsWith(root + path.sep) || isDirectory && target === root)) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "授权资源超出固定私有根目录");
    for (let parent = isDirectory ? target : path.dirname(target); ; parent = path.dirname(parent)) {
      const s = fs.lstatSync(parent);
      if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync.native(parent) !== parent || s.mode & 0o077
        || typeof process.getuid === "function" && s.uid !== process.getuid()) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "授权资源目录不安全");
      directories.set(parent, { ...directories.get(parent), path: parent, dev: s.dev, ino: s.ino, mode: s.mode, uid: s.uid });
      if (parent === root) break;
    }
  };
  const file = (target, required = false) => {
    if (skipped.has(target)) return;
    owned(target);
    const before = stat(target);
    if (!before) {
      if (required) fail("MEMORY_ROLLBACK_AUTHORIZATION_RESOURCE_MISSING", "授权资源文件缺失");
      files.set(target, { path: target, present: false }); return;
    }
    validatePrivateStat(before, target);
    const bytes = readPrivateFile(target, { maxBytes: MAX_BYTES });
    const after = validatePrivateStat(fs.lstatSync(target), target);
    if (stable(identity(before)) !== stable(identity(after)) || bytes.length !== after.size) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "授权资源读取中变化");
    files.set(target, { path: target, present: true, bytes: bytes.length, sha256: hash(bytes), identity: identity(after) });
    if (files.size > 100_000) fail("MEMORY_ROLLBACK_SNAPSHOT_TOO_LARGE", "授权资源数量超限");
  };
  const tree = (target, depth = 0) => {
    if (depth > 64) fail("MEMORY_ROLLBACK_SNAPSHOT_TOO_LARGE", "授权资源层级超限");
    owned(path.dirname(target), true);
    const s = stat(target);
    if (!s) { files.set(target, { path: target, present: false, directory: true }); return; }
    owned(target, true);
    const names = fs.readdirSync(target).filter(n => !skipped.has(path.join(target, n))).sort();
    directories.set(target, { ...directories.get(target), entries: names });
    for (const name of names) {
      const next = path.join(target, name), entry = fs.lstatSync(next);
      if (entry.isSymbolicLink()) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "授权资源含 symlink");
      if (/\.tmp$|\.backup-/u.test(name)) fail("MEMORY_ROLLBACK_TRANSACTION_UNSETTLED", "授权资源含未闭合事务");
      if (entry.isDirectory()) tree(next, depth + 1); else file(next, true);
    }
  };
  owned(paths.stateDir, true);
  const fixed = ["state.snapshot.json", "events.jsonl", "chat-sessions.json"];
  for (const name of fs.readdirSync(paths.stateDir)) {
    if (fixed.some(base => name === base + ".tmp" || name.startsWith(base + ".backup-")) || name === "chat-sessions.writer.lock") {
      fail("MEMORY_ROLLBACK_TRANSACTION_UNSETTLED", "Product 或 Session 有 writer/未闭合事务");
    }
  }
  file(paths.eventLogPath, true); file(paths.stateSnapshotPath); file(path.join(paths.stateDir, "chat-sessions.json"), true);
  for (const id of profileIds) {
    const dir = path.join(paths.agentsDir, id);
    tree(path.join(dir, "memory")); tree(path.join(dir, "generated")); tree(path.join(dir, "transcripts"));
    file(path.join(dir, "memory", "recall-policy.jsonl"), true);
    file(path.join(dir, "memory", "recall-policy.seal.json"), true);
    file(path.join(dir, "recall-policy-installed.json"), true);
    file(path.join(paths.agentsDir, ".recall-policy-installations", id + ".json"), true);
  }
  // Original matchesWorkspace follows .git / gitdir / commondir. Pin exactly
  // that metadata chain too; this bounded draft rejects external git targets.
  for (const workspace of workspaces.filter(Boolean)) {
    if (!path.isAbsolute(workspace) || !(workspace === root || workspace.startsWith(root + path.sep))) {
      fail("MEMORY_ROLLBACK_WORKSPACE_RESOURCE_UNSUPPORTED", "有界草案需要可固定的私有 workspace 资源");
    }
    owned(workspace, true);
    let repository = null;
    for (let dir = workspace; ; dir = path.dirname(dir)) {
      const marker = path.join(dir, ".git"), s = stat(marker);
      if (dir === root || dir.startsWith(root + path.sep)) {
        if (!s) file(marker);
        else if (s.isDirectory()) { owned(marker, true); repository = fs.realpathSync.native(marker); break; }
        else if (s.isFile()) {
          file(marker, true);
          const gitdir = /^gitdir:\s*(.+)$/mu.exec(readPrivateFile(marker, { maxBytes: 4096 }).toString("utf8"))?.[1]?.trim();
          if (!gitdir) fail("MEMORY_ROLLBACK_WORKSPACE_RESOURCE_UNSUPPORTED", "gitdir 元数据无效");
          const resolved = path.resolve(dir, gitdir); owned(resolved, true);
          const common = path.join(resolved, "commondir"); file(common, true);
          const shared = path.resolve(resolved, readPrivateFile(common, { maxBytes: 4096 }).toString("utf8").trim());
          owned(shared, true); repository = fs.realpathSync.native(shared); break;
        } else fail("MEMORY_ROLLBACK_PATH_UNSAFE", "git marker 类型不安全");
      } else {
        // The original lookup also inspects ancestors outside the synthetic
        // root. Only absent markers are supported; record absence explicitly.
        if (s) fail("MEMORY_ROLLBACK_WORKSPACE_RESOURCE_UNSUPPORTED", "workspace 从外部祖先继承 git 身份");
        files.set(marker, { path: marker, present: false, workspaceAncestor: true });
      }
      if (path.dirname(dir) === dir) break;
    }
    // MemoryEngine caches repository keys process-wide. A prior lookup cannot
    // stand in for the fixed metadata just captured. Validate the real helper
    // against those bytes and fail on cache drift; never replace its algorithm.
    const expectedRefs = [`workspace:${hash(workspace)}`, ...(repository ? [`workspace:${hash(`git:${repository}`)}`] : [])];
    if (stable(workspaceMemoryRefs(workspace, "project")) !== stable(expectedRefs)) {
      fail("MEMORY_ROLLBACK_WORKSPACE_SOURCE_CHANGED", "原 workspace resolver cache 与固定 git 元数据不一致");
    }
  }
  const value = { directories: [...directories.values()].sort((a, b) => a.path.localeCompare(b.path)),
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  return { ...value, sha256: hash(stable(value)) };
}

// Pure auxiliary CAS: no selected MemoryStore replay, so this can guard an
// exact owned journal tail/snapshot recovery before any truncation or cleanup.
function captureLegacyAuthorizationAuxiliaryAuthority({ paths, profileId, assertCurrent, ownedSnapshotArtifactsNames = [] }) {
  checkInput(paths, profileId, 0, assertCurrent); stopped(assertCurrent);
  const initial = captureResources(paths, profileId, [], [], true, ownedSnapshotArtifactsNames);
  const product = new JsonlProductStore({ paths, readOnly: true, now: () => 0 });
  const sessions = new ChatSessionStore({ paths, readOnly: true, now: () => 0 });
  try {
    product.openReadOnly(); sessions.openReadOnly();
    const profileIds = product.listAgentProfiles().map(p => p.id).sort();
    if (!profileIds.includes(profileId) || profileIds.some(p => !ID.test(p)) || new Set(profileIds).size !== profileIds.length || profileIds.length > 100) {
      fail("MEMORY_ROLLBACK_AUTHORIZATION_CATALOG_INVALID", "Profile 不在真实共享 catalog 中");
    }
    const workspaces = [...new Set([null, ...product.listAgentProfiles().map(p => p.defaultCwd),
      ...sessions.listSessions().filter(s => profileIds.includes(s.profileId)).map(s => s.workspace)])].sort((a, b) => String(a).localeCompare(String(b)));
    const result = captureResources(paths, profileId, profileIds, workspaces, true, ownedSnapshotArtifactsNames);
    if (initial.sha256 !== captureResources(paths, profileId, [], [], true, ownedSnapshotArtifactsNames).sha256) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "辅助授权 Product/Session 读取期间变化");
    stopped(assertCurrent); return freeze(result);
  } finally { sessions.close(); product.close(); }
}
function needsLegacyAuthorization(records) { return records.some(item => REVIEWED.test(item.id) || SHARED.has(item.scope)); }
function retainedAuthorizationRecords(plan) {
  const changed = new Set((plan.operations || []).filter(operation => stable(operation.before) !== stable(operation.after)).map(operation => operation.id));
  return plan.snapshot.legacyRecords.filter(item => !changed.has(item.id));
}
function assertLegacyAuthorizationPlanBinding(plan) {
  const required = needsLegacyAuthorization(plan.snapshot.legacyRecords);
  const snapshot = plan.authorizationSnapshot;
  if (!snapshot) {
    if (required || plan.authorizationSnapshotHash !== undefined || plan.snapshot.authorizationAuxiliaryAuthority !== undefined) {
      fail("MEMORY_ROLLBACK_AUTHORIZATION_PLAN_BINDING_REQUIRED", "保留 review/shared 项需要已发布的授权前像及来源绑定");
    }
    return false;
  }
  if (snapshot.format !== "shoggoth-legacy-authorization-snapshot" || snapshot.schemaVersion !== 1 || snapshot.profileId !== plan.profileId
    || !Number.isSafeInteger(snapshot.now) || snapshot.now < 0 || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.cells)
    || snapshot.sha256 !== hash(stable(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "sha256"))))
    || plan.authorizationSnapshotHash !== snapshot.sha256 || !plan.snapshot.authorizationAuxiliaryAuthority
    || stable(snapshot.auxiliaryAuthority) !== stable(plan.snapshot.authorizationAuxiliaryAuthority)
    || stable(snapshot.records.filter(item => item.profileId === plan.profileId).sort((a,b)=>a.id.localeCompare(b.id)))
      !== stable(retainedAuthorizationRecords(plan).sort((a,b)=>a.id.localeCompare(b.id)))) {
    fail("MEMORY_ROLLBACK_AUTHORIZATION_PLAN_BINDING_REQUIRED", "授权前像与不可变计划的保留项或完整辅助来源不同");
  }
  return true;
}
function authorizationPlanBinding(plan) {
  return assertLegacyAuthorizationPlanBinding(plan) ? { authorizationSnapshotHash: plan.authorizationSnapshotHash,
    authorizationAuthorityHash: plan.snapshot.authorizationAuxiliaryAuthority.sha256 } : {};
}

class ReadOnlyPolicy extends RecallPolicyStore {
  _load() { fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "授权验收禁止 Policy 启动或恢复"); }
}
function openLegacyAuthorizationResources({ paths, profileId, now, assertCurrent }) {
  checkInput(paths, profileId, now, assertCurrent); stopped(assertCurrent);
  // Capture the fixed catalog before its original parser is allowed to read.
  const initial = captureResources(paths, profileId, [], []);
  const product = new JsonlProductStore({ paths, readOnly: true, now: () => now });
  const sessions = new ChatSessionStore({ paths, readOnly: true, now: () => now });
  const transcripts = new TranscriptStore({ paths, readOnly: true, now: () => now });
  const store = new MemoryStore({ paths, readOnly: true });
  let policy, engine, recall, before;
  try {
    product.openReadOnly(); sessions.openReadOnly(); transcripts.openReadOnly(); store.opened = true;
    const profileIds = product.listAgentProfiles().map(p => p.id).sort();
    if (!profileIds.includes(profileId) || profileIds.some(p => !ID.test(p)) || new Set(profileIds).size !== profileIds.length || profileIds.length > 100) {
      fail("MEMORY_ROLLBACK_AUTHORIZATION_CATALOG_INVALID", "Profile 不在真实共享 catalog 中");
    }
    const workspaces = [...new Set([null, ...product.listAgentProfiles().map(p => p.defaultCwd),
      ...sessions.listSessions().filter(s => profileIds.includes(s.profileId)).map(s => s.workspace)])].sort((a, b) => String(a).localeCompare(String(b)));
    before = captureResources(paths, profileId, profileIds, workspaces);
    if (initial.sha256 !== captureResources(paths, profileId, [], []).sha256) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "Product/Session 解析时来源变化");
    policy = new ReadOnlyPolicy({ paths, memoryStore: store, transcriptStore: transcripts, chatSessionStore: sessions,
      strictSourceResolution: true, now: () => now });
    const records = [];
    for (const id of profileIds) {
      const journal = path.join(paths.agentsDir, id, "memory", "events.jsonl");
      const bytes = stat(journal) ? readPrivateFile(journal, { maxBytes: MAX_BYTES }) : Buffer.alloc(0);
      if (bytes.length && bytes.at(-1) !== 0x0a) fail("MEMORY_ROLLBACK_TRANSACTION_UNSETTLED", "共享主日志含未闭合尾部");
      const state = policy._read(id, policy._paths(id)); policy.states.set(id, state);
      records.push(...store.list(id));
    }
    if (records.length > MAX_ITEMS) fail("MEMORY_ROLLBACK_SNAPSHOT_TOO_LARGE", "授权矩阵目标数量超限");
    policy.opened = true;
    engine = new MemoryEngine({ store, recallPolicy: policy, transcriptStore: transcripts, chatSessionStore: sessions,
      sharedProfiles: () => product.listAgentProfiles().map(p => p.id), now: () => now }); engine.opened = true;
    const receipts = new MemoryCandidateStore({ paths, readOnly: true, now: () => now });
    const dispatcher = createWorkDispatcher({ store: product, now: () => now });
    recall = new ConversationRecallService({ paths, transcriptStore: transcripts, chatSessionStore: sessions,
      workDispatcher: dispatcher, getRunSessionKey: run => run.source === "chat" ? run.sourceId : null,
      recallPolicy: policy, memoryStore: store, now: () => now });
    const candidates = new MemoryCandidateService({ candidateStore: receipts, memoryEngine: engine, memoryStore: store,
      conversationRecallService: recall, chatSessionStore: sessions, now: () => now, isProfileEligible: () => true,
      extractCandidates: () => { fail("MEMORY_ROLLBACK_SIDE_EFFECT_FORBIDDEN", "只读验收禁止模型提取"); } });
    for (const item of records.filter(r => REVIEWED.test(r.id))) {
      if (!stat(path.join(paths.agentsDir, item.profileId, "memory", "candidate-review.json"))) fail("MEMORY_ROLLBACK_REVIEW_RESOURCE_MISSING", "保留 reviewed 记忆缺少真实回执文件");
      const state = receipts.get(item.profileId), candidate = state.candidates[REVIEWED.exec(item.id)[1]];
      if (!candidate) fail("MEMORY_ROLLBACK_REVIEW_RESOURCE_MISSING", "保留 reviewed 记忆没有对应候选回执");
      if (item.status !== "active") continue;
      if (!engine._reviewCommitted(item, state)) fail("MEMORY_ROLLBACK_REVIEW_RECEIPT_MISMATCH", "active reviewed 记忆与原 accepted 回执不一致");
      const session = sessions.listSessions().find(s => s.id === candidate.source.sessionId && s.profileId === item.profileId);
      if (!session || session.workspace !== candidate.source.workspace || !["ready", "archived"].includes(session.status)) fail("MEMORY_ROLLBACK_REVIEW_RESOURCE_MISSING", "保留 reviewed 来源会话不可证明");
      const run = dispatcher.getRun(candidate.source.runId);
      if (!run) fail("MEMORY_ROLLBACK_REVIEW_RESOURCE_MISSING", "保留 reviewed 来源 Run 缺失");
      if (run.source !== "chat") fail("MEMORY_ROLLBACK_REVIEW_SOURCE_UNSUPPORTED", "有界草案尚未接入非 chat 来源 owner");
      if (run.status !== "completed" || run.profileId !== item.profileId || run.workspace !== session.workspace || run.sourceId !== session.sessionKey) fail("MEMORY_ROLLBACK_REVIEW_SOURCE_MISMATCH", "保留 reviewed 来源 Run 归属不匹配");
      const event = transcripts.getEvent(item.profileId, session.id, candidate.source.eventId);
      if (!event) fail("MEMORY_ROLLBACK_REVIEW_RESOURCE_MISSING", "保留 reviewed 来源事件缺失");
      const resolved = transcripts.contextEvent(item.profileId, session.id, event), text = resolved.content?.text;
      if (event.kind !== "user" || event.seq !== candidate.source.seq || event.runId !== run.id || typeof text !== "string"
        || hash(text) !== candidate.source.contentHash || hash(text.slice(candidate.source.quoteStart, candidate.source.quoteStart + candidate.source.quoteLength)) !== candidate.source.quoteHash) {
        fail("MEMORY_ROLLBACK_REVIEW_SOURCE_MISMATCH", "保留 reviewed 来源事件/正文/引用不匹配");
      }
      // Run the actual CandidateService gate before Engine's intentional catch.
      // Only its three known policy/source denials are permitted; corruption,
      // missing resources and unexpected errors must not become hidden success.
      try { candidates._assertCandidateVisible(item.profileId, candidate); }
      catch (error) {
        if (!["MEMORY_CANDIDATE_SOURCE_UNAVAILABLE", "MEMORY_CANDIDATE_SOURCE_OUTDATED"].includes(error.code)) throw error;
        // All exact source resources were proved above. The original recall
        // service now decides whether that known source remains authorized.
      }
    }
    stopped(assertCurrent);
    const context = { paths, profileId, now, assertCurrent, product, sessions, transcripts, store, policy, engine, recall,
      receipts, candidates, profileIds, workspaces, records, before,
      auxiliary: captureResources(paths, profileId, profileIds, workspaces, true),
      attach(target) { target.setReviewReceiptStore(receipts); target.setReviewSourceVerifier(engine.reviewSourceVerifier); },
      close() {
        recall.close(); engine.close(); store.close(); sessions.close(); transcripts.close(); product.close();
        const after = captureResources(paths, profileId, profileIds, workspaces);
        if (stable(after) !== stable(before)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "授权矩阵验收改变了权威字节或身份");
      } };
    return context;
  } catch (error) {
    recall?.close(); engine?.close(); policy?.close(); store.close(); sessions.close(); transcripts.close(); product.close();
    throw error;
  }
}

function cellKey(cell) { return stable([cell.viewer, cell.home, cell.id, cell.workspace, cell.sensitivity]); }
function authorizationMatrix(context, selectedRecords = context.records) {
  const cells = [], byId = new Map(context.records.map(r => [stable([r.profileId, r.id]), r]));
  for (const requested of selectedRecords) {
    const item = byId.get(stable([requested.profileId, requested.id]));
    if (!item || stable(item) !== stable(requested)) fail("MEMORY_ROLLBACK_AUTHORIZATION_TARGET_CHANGED", "保留授权记录的实际 14 字段已变化");
    // Full historical source checks stay attached to the actual full Store.
    // Only search competition is projected to one actual record per Profile.
    const projectedStore = new MemoryStore({ paths: context.paths, readOnly: true }); projectedStore.opened = true;
    for (const profile of context.profileIds) {
      const state = projectedStore._empty(profile); state.revision = context.store.getRevision(profile);
      if (profile === item.profileId) {
        state.items.set(item.id, structuredClone(item));
        state.contentRevisions.set(item.id, context.store.getContentRevision(profile, item.id));
        state.itemWriteProofs.set(item.id, context.store.getItemWriteProof(profile, item.id));
      }
      projectedStore.profiles.set(profile, state);
    }
    const projectedEngine = new MemoryEngine({ store: projectedStore, recallPolicy: context.policy,
      sharedProfiles: () => context.profileIds, now: () => context.now }); projectedEngine.opened = true; context.attach(projectedEngine);
    try {
      for (const viewer of context.profileIds) for (const workspace of context.workspaces) for (const sensitivity of ["normal", "private"]) {
        stopped(context.assertCurrent);
        const homeVisible = context.policy.isMemoryVisible(item.profileId, item);
        const sourceVisible = context.engine.isReviewCommitted(item.profileId, item);
        const expected = item.status === "active" && item.validFrom <= context.now && (item.validUntil === null || item.validUntil > context.now)
          && memoryTrust(item) !== "untrusted" && item.sensitivity !== "restricted"
          && (sensitivity === "private" || item.sensitivity === "normal") && homeVisible && sourceVisible
          && (viewer === item.profileId || SHARED.has(item.scope) && context.policy.snapshot(viewer).isForeignMemoryVisible(item))
          && (!["project", "workspace"].includes(item.scope) || matchesWorkspace(item, workspace));
        const result = projectedEngine.search({ profileId: viewer, query: item.content, scopes: [item.scope], workspace,
          maxSensitivity: sensitivity, now: context.now, limit: 100, maxBytes: 128 * 1024 });
        const visible = result.items.some(r => r.id === item.id && r.profileId === item.profileId);
        if (visible !== expected) fail("MEMORY_ROLLBACK_AUTHORIZATION_SEARCH_MISMATCH", "原 Engine 检索与原权限矩阵不一致");
        cells.push({ viewer, home: item.profileId, id: item.id, workspace, sensitivity, visible });
        if (cells.length > MAX_CELLS) fail("MEMORY_ROLLBACK_SNAPSHOT_TOO_LARGE", "授权矩阵单元数量超限");
      }
    } finally { projectedEngine.opened = false; projectedStore.close(); }
  }
  return cells.sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
}
function captureLegacyAuthorizationSnapshot(options) {
  const excluded = options.excludeSelectedIds || [];
  if (!Array.isArray(excluded) || excluded.length > MAX_ITEMS || excluded.some(id => !ID.test(id)) || new Set(excluded).size !== excluded.length) fail("MEMORY_ROLLBACK_AUTHORIZATION_INPUT_INVALID", "授权保留项排除列表无效");
  const context = openLegacyAuthorizationResources(options);
  try {
    const records = context.records.filter(item => item.profileId !== options.profileId || !excluded.includes(item.id));
    const value = { format: "shoggoth-legacy-authorization-snapshot", schemaVersion: 1, profileId: options.profileId,
      now: options.now, profileIds: context.profileIds, workspaces: context.workspaces,
      records, cells: authorizationMatrix(context, records), auxiliaryAuthority: context.auxiliary };
    return freeze({ ...value, sha256: hash(stable(value)) });
  } finally { context.close(); }
}
function verifyLegacyAuthorizationSnapshot(context, snapshot, plan = null) {
  if (!snapshot || snapshot.format !== "shoggoth-legacy-authorization-snapshot" || snapshot.schemaVersion !== 1
    || snapshot.profileId !== context.profileId || snapshot.now !== context.now || !Array.isArray(snapshot.records)
    || !Array.isArray(snapshot.cells) || snapshot.sha256 !== hash(stable(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "sha256"))))) {
    fail("MEMORY_ROLLBACK_AUTHORIZATION_SNAPSHOT_INVALID", "授权矩阵前像无效");
  }
  if (stable(snapshot.profileIds) !== stable(context.profileIds) || stable(snapshot.workspaces) !== stable(context.workspaces)
    || stable(snapshot.auxiliaryAuthority) !== stable(context.auxiliary)) fail("MEMORY_ROLLBACK_AUTHORIZATION_SOURCE_CHANGED", "共享或审核来源权威与授权前像不同");
  if (plan) {
    assertLegacyAuthorizationPlanBinding(plan);
    const expected = [...retainedAuthorizationRecords(plan), ...context.records.filter(item => item.profileId !== context.profileId)].sort((a,b)=>stable([a.profileId,a.id]).localeCompare(stable([b.profileId,b.id])));
    if (stable([...snapshot.records].sort((a,b)=>stable([a.profileId,a.id]).localeCompare(stable([b.profileId,b.id])))) !== stable(expected)) {
      fail("MEMORY_ROLLBACK_AUTHORIZATION_TARGET_CHANGED", "授权前像必须包含全部保留项及全部真实共享 peer 项");
    }
  }
  const actual = authorizationMatrix(context, snapshot.records);
  if (stable(actual) !== stable(snapshot.cells)) fail("MEMORY_ROLLBACK_AUTHORIZATION_MATRIX_CHANGED", "保留项的原权限矩阵已变化");
  // Full real search independently checks all returned results, including
  // peer deduplication and the original 100 result cap. Projection is never a
  // claim that a row was persisted: context.records came from actual replay.
  const allowed = new Map(actual.map(c => [cellKey(c), c.visible]));
  let fullSearchChecks = 0;
  for (const item of snapshot.records) for (const viewer of context.profileIds) for (const workspace of context.workspaces) for (const sensitivity of ["normal", "private"]) {
    const result = context.engine.search({ profileId: viewer, query: item.content, workspace, scopes: [item.scope], maxSensitivity: sensitivity,
      now: context.now, limit: 100, maxBytes: 128 * 1024 });
    for (const row of result.items) {
      const target = snapshot.records.find(r => r.id === row.id && r.profileId === row.profileId);
      if (target && allowed.get(cellKey({ viewer, home: row.profileId, id: row.id, workspace, sensitivity })) !== true) {
        fail("MEMORY_ROLLBACK_AUTHORIZATION_SEARCH_MISMATCH", "完整原 Engine search 泄露权限矩阵之外的保留项");
      }
    }
    fullSearchChecks += 1;
  }
  return freeze({ authorizationMatrixVerified: true, authorizationResourceReadOnlyVerified: true, authorizationSnapshotHash: snapshot.sha256,
    authorizationAuthorityHash: context.auxiliary.sha256, authorizationProfileCount: context.profileIds.length,
    authorizationCellCount: actual.length, authorizationVisibleCellCount: actual.filter(c => c.visible).length,
    authorizationFullSearchChecks: fullSearchChecks, authorizationProjectionScope: "one-actual-record-only-search-competition",
    authorizationPersistedRecordCount: snapshot.records.length, authorizationSnapshotTime: snapshot.now,
    authorizationSourceOwnerScope: "chat-only", authorizationWorkspaceScope: "private-fixed-git-metadata" });
}

module.exports = { openLegacyAuthorizationResources, captureLegacyAuthorizationSnapshot, verifyLegacyAuthorizationSnapshot,
  captureLegacyAuthorizationAuxiliaryAuthority, needsLegacyAuthorization, retainedAuthorizationRecords, assertLegacyAuthorizationPlanBinding, authorizationPlanBinding };
