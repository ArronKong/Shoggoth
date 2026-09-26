#!/usr/bin/env node
"use strict";

// Read-only upgrade receipt. Never opens a Store (whose open() may migrate),
// decrypts credentials, starts a Service, or reads external CLI homes.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveCanonicalServicePaths, resolveServicePaths } = require("../app/agent-service/paths");
const { eventChecksum, snapshotChecksum } = require("../app/agent-service/product-store");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object"
  && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const digestRows = rows => hash(rows.map(canonical).sort().join("\n"));
const stableJson = value => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const values = value => Array.isArray(value) ? value : Object.values(value || {});
function fileInfo(target, parse = false) {
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error("Audit source must be a regular file");
    const digest = crypto.createHash("sha256");
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (parse && bytes > 256 * 1024 * 1024) throw new Error("Audit JSON exceeds its bound");
      digest.update(buffer.subarray(0, count));
      if (parse) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(target);
    if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key]
      || before[key] !== current[key]) || bytes !== before.size || current.isSymbolicLink()) {
      throw new Error("Audit source changed while reading; stop writers and retry");
    }
    return { bytes, sha256: digest.digest("hex"), ...(parse ? { text: Buffer.concat(chunks).toString("utf8") } : {}) };
  } finally { fs.closeSync(fd); }
}
function jsonAt(target) {
  const info = fileInfo(target, true);
  return info === null ? null : JSON.parse(info.text);
}
function readProduct(paths) {
  const snapshotInfo = fileInfo(paths.stateSnapshotPath, true), eventInfo = fileInfo(paths.eventLogPath, true);
  const product = snapshotInfo && JSON.parse(snapshotInfo.text);
  if (!product || product.checksum !== snapshotChecksum(product)) throw new Error("Product snapshot checksum mismatch");
  const snapshotLastSeq = product.lastSeq, events = eventInfo?.text.split("\n").filter(Boolean).map(JSON.parse) || [];
  let physicalSeq = null;
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.checksum !== eventChecksum(event)
      || (physicalSeq !== null && event.seq !== physicalSeq + 1)) throw new Error("Product event checksum or sequence mismatch");
    physicalSeq = event.seq;
    if (event.seq <= snapshotLastSeq) continue;
    if (event.seq !== product.lastSeq + 1 || event.schemaVersion !== product.schemaVersion) {
      throw new Error("Audit cannot replay a missing event or a schema transition");
    }
    const mapping = { "agent_profile.put": ["agentProfiles", "profile"], "work_run.put": ["workRuns", "run"],
      "runtime_account.put": ["runtimeAccounts", "account"], "model_provider.put": ["modelProviders", "provider"],
      "run_note.add": ["runNotes", "note"], "mcp_tool_call.put": ["mcpToolCalls", "call"] };
    const [collection, field] = mapping[event.type] || [];
    if (!collection || !event.payload?.[field] || event.payload[field].id !== event.aggregateId
      || Object.keys(event.payload).some(key => key !== field && !(event.type === "mcp_tool_call.put" && key === "evictedIds"))) {
      throw new Error("Product event needs an explicit read-only audit replay handler");
    }
    const rows = new Map(product[collection].map(row => [row.id, row]));
    for (const id of event.payload.evictedIds || []) rows.delete(id);
    rows.set(event.aggregateId, event.payload[field]); product[collection] = [...rows.values()];
    product.lastSeq = event.seq;
  }
  return { product, events, snapshotLastSeq, snapshotInfo: snapshotInfo && { bytes: snapshotInfo.bytes, sha256: snapshotInfo.sha256 },
    eventInfo: eventInfo && { bytes: eventInfo.bytes, sha256: eventInfo.sha256 } };
}
function rowSummary(rows, fields = null) {
  return { count: rows.length, idsHash: digestRows(rows.map(row => row.id ?? row.sessionKey)),
    contentHash: digestRows(fields ? rows.map(row => Object.fromEntries(fields.map(key => [key, row[key] ?? null]))) : rows) };
}
// Hash every original field, including fields not in the v1 migration summary.
// Values (names, prompts, histories and credential material) never enter receipts.
const LEGACY_PROFILE_FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId",
  "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency",
  "isDefault", "enabled", "createdAt", "updatedAt"];
function profileView(row) {
  if (!row.bindings) return row;
  const selected = row.bindings.find(binding => binding.id === row.defaultBindingId);
  if (!selected) throw new Error("Profile default Binding missing");
  const { bindings, bindingOperations, defaultBindingId, bindingsRevision, ...rest } = row;
  return { ...rest, runtime: selected.runtime, runtimeProfileId: selected.runtimeProfileId,
    runtimeAccountId: selected.runtimeAccountId };
}
function inventoryRows(source, transform = row => row) {
  const entries = Array.isArray(source) ? source.map(row => [row.id ?? row.operationId ?? row.sessionKey, row])
    : Object.entries(source || {});
  const seen = new Set();
  return entries.map(([id, raw]) => {
    if (typeof id !== "string" || !id || seen.has(id)) throw new Error("Audit row identity missing or duplicated");
    seen.add(id);
    const row = transform(raw);
    return { id, hash: hash(canonical(row)),
      fields: Object.fromEntries(Object.entries(row).map(([key, value]) => [key, hash(canonical(value))])),
      ...(transform === profileView ? { migrationDigest: hash(JSON.stringify(Object.fromEntries(
        LEGACY_PROFILE_FIELDS.map(key => [key, row[key]])))) } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function transcriptFiles(root, kind = "transcripts") {
  const files = [];
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Transcript audit refuses symbolic links");
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push({ path: path.relative(root, target), ...fileInfo(target) });
      else throw new Error("Transcript audit encountered a non-file entry");
    }
  }
  if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Agent audit refuses symbolic links");
    if (entry.isDirectory()) {
      visit(path.join(root, entry.name, kind));
      if (kind === "definition") {
        const manifest = path.join(root, entry.name, "manifest.json"), info = fileInfo(manifest);
        if (info) files.push({ path: path.relative(root, manifest), ...info });
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function transcriptAppendProofs(paths, files, baseline, runs) {
  if (!baseline) return [];
  const previous = new Map(baseline.transcripts.files.map(file => [file.path, file]));
  const priorRuns = new Set(baseline.inventory["product.workRuns"].map(run => run.id));
  const runMap = new Map(runs.map(run => [run.id, run]));
  const proofs = [];
  for (const file of files) {
    const old = previous.get(file.path);
    if (!old || old.sha256 === file.sha256 || !file.path.endsWith("/events.jsonl") || file.bytes <= old.bytes) continue;
    const info = fileInfo(path.join(paths.agentsDir, file.path), true), buffer = Buffer.from(info.text, "utf8");
    if (info.sha256 !== file.sha256 || buffer.length !== info.bytes) throw new Error("Transcript changed or has invalid UTF-8");
    const prefixMatches = hash(buffer.subarray(0, old.bytes)) === old.sha256;
    if (!prefixMatches || (old.bytes && buffer[old.bytes - 1] !== 10) || buffer.at(-1) !== 10) continue;
    const oldRecords = buffer.subarray(0, old.bytes).toString("utf8").split("\n").filter(Boolean).map(JSON.parse);
    const tail = buffer.subarray(old.bytes).toString("utf8").split("\n").filter(Boolean).map(JSON.parse);
    const records = [...oldRecords, ...tail], profileId = file.path.split(path.sep)[0], sessionId = file.path.split(path.sep)[2];
    let lastEventSeq = 0; const eventIds = new Set(); let lastEventTime = 0;
    const checksumsValid = records.every((record, index) => {
      const { checksum, ...body } = record;
      if (record.schemaVersion !== 1 || record.seq !== index + 1 || checksum !== hash(stableJson(body))) return false;
      if (record.type === "event.context.set") return eventIds.has(record.payload.eventId);
      if (record.type !== "event.append" || record.payload.seq !== lastEventSeq + 1
        || record.payload.sessionId !== sessionId || eventIds.has(record.payload.id)) return false;
      lastEventSeq = record.payload.seq; eventIds.add(record.payload.id); lastEventTime = record.payload.occurredAt; return true;
    });
    const newRuns = [...new Set(tail.map(record => record.payload.runId))];
    const attributed = tail.every(record => {
      const event = record.payload, run = runMap.get(event.runId);
      // Match the durable execution protocol, not the UI send operation. Domain
      // runs deliberately derive a distinct operation ID (domain-work-run-executor).
      const expectedOperationId = run && ["inspiration", "cron", "kanban"].includes(run.source)
        ? `domain-${hash(JSON.stringify([run.source, run.id, run.idempotencyKey]))}`
        : run?.source === "chat" && run.idempotencyKey.startsWith("shoggoth:chat-send:")
          ? run.idempotencyKey.slice("shoggoth:chat-send:".length) : null;
      return record.type === "event.append" && run && !priorRuns.has(run.id) && run.profileId === profileId
        && event.occurredAt > Date.parse(baseline.observedAt)
        && (event.kind !== "user" || typeof event.content?.operationId === "string"
          && event.content.operationId === expectedOperationId);
    });
    const manifestPath = file.path.replace(/events\.jsonl$/u, "manifest.json");
    const manifestInfo = fileInfo(path.join(paths.agentsDir, manifestPath), true), manifest = JSON.parse(manifestInfo.text);
    const expected = { schemaVersion: 1, profileId, sessionId, revision: records.length,
      lastEventSeq, eventCount: eventIds.size, updatedAt: lastEventTime };
    expected.checksum = hash(stableJson(expected));
    const manifestMatches = canonical(manifest) === canonical(expected);
    proofs.push({ path: file.path, originalBytes: old.bytes, originalSha256: old.sha256, currentSha256: file.sha256,
      prefixMatches, checksumsValid, appendedRecords: tail.length, addedRunIds: newRuns,
      cutoffObservedAt: baseline.observedAt, cutoffSourceAuditSha256: baseline.baselineReceipt?.sourceAuditSha256 ?? null,
      tailAttributedToNewRuns: attributed, manifestPath, manifestSha256: manifestInfo.sha256, manifestMatches,
      verified: prefixMatches && checksumsValid && attributed && manifestMatches });
  }
  return proofs;
}
function audit(paths, options = {}) {
  const activeMarkers = [paths.lockPath, paths.socketPath,
    ...fs.readdirSync(paths.stateDir).filter(name => name.endsWith(".writer.lock"))
      .map(name => path.join(paths.stateDir, name))].filter(target => fs.existsSync(target));
  const { product, events, snapshotLastSeq, snapshotInfo, eventInfo } = readProduct(paths);
  let evidenceInfo = null, creationEvents = events;
  if (options.eventEvidencePath) {
    const evidence = fileInfo(options.eventEvidencePath, true);
    const records = evidence.text.split("\n").filter(Boolean).map(JSON.parse);
    if (records.some((event, index) => event.checksum !== eventChecksum(event)
      || event.seq > product.lastSeq || index > 0 && event.seq !== records[index - 1].seq + 1)) {
      throw new Error("Creation event evidence checksum/sequence mismatch");
    }
    evidenceInfo = { bytes: evidence.bytes, sha256: evidence.sha256 };
    creationEvents = records;
  }
  const chat = jsonAt(path.join(paths.stateDir, "chat-sessions.json"));
  const usageInfo = fileInfo(paths.tokenUsagePath, true);
  const envelopes = usageInfo?.text.split("\n").filter(Boolean).map(line => JSON.parse(line)) || [];
  const usage = envelopes.map(envelope => envelope.record);
  const tokenFields = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens",
    "outputTokens", "reasoningOutputTokens"];
  const legacyUsageFields = ["id", "profileId", "agentId", "agentName", "source", "sourceId", "threadId",
    "turnId", "model", "provider", ...tokenFields, "createdAt", "costUsd"];
  const totals = Object.fromEntries(tokenFields.map(key => [key, usage.reduce((sum, row) => sum + row[key], 0)]));
  if (Object.values(totals).some(value => !Number.isSafeInteger(value))) throw new Error("Invalid usage totals");
  const profiles = values(product?.agentProfiles), runs = values(product?.workRuns);
  const sessions = values(chat?.sessions);
  const transcripts = transcriptFiles(paths.agentsDir);
  const cron = jsonAt(path.join(paths.stateDir, "native-cron.json"));
  const privateFiles = Object.fromEntries(["local-crypto-master-key.v1", "mcp-auth.json", "pending-commands.json",
    "encrypted-secrets.json", "federation-mcp-auth.json", "inspirations.sqlite", "native-cron.json", "native-kanban.json"]
    .map(name => [name, fileInfo(path.join(paths.stateDir, name))]));
  const secretContainer = jsonAt(paths.encryptedSecretsPath);
  const concurrencyJournal = jsonAt(path.join(paths.stateDir, "profile-concurrency-migration-v11.json"));
  if (concurrencyJournal) {
    const { checksum, ...body } = concurrencyJournal;
    if (checksum !== hash(JSON.stringify(body)) || body.version !== 1 || body.targetSchemaVersion !== 11
      || body.stage !== "committed" || !Array.isArray(body.profiles)) throw new Error("Concurrency journal is not verified and committed");
  }
  const definitions = transcriptFiles(paths.agentsDir, "definition");
  const inventory = {
    "product.profiles": inventoryRows(product?.agentProfiles, profileView),
    ...Object.fromEntries(["workRuns", "runtimeAccounts", "modelProviders", "runNotes", "mcpToolCalls"]
      .map(key => [`product.${key}`, inventoryRows(product?.[key])])),
    ...Object.fromEntries(["sessions", "createOperations", "bindingOperations", "remoteOperations", "cronRuns"]
      .map(key => [`chat.${key}`, inventoryRows(chat?.[key])])),
    usage: inventoryRows(usage),
  };
  const creationReceipts = values(product?.mcpToolCalls).filter(call => call.name === "agent.create").map(call => {
    const binding = call.binding, profile = profiles.find(row => row.id === binding?.targetProfileId);
    const identity = binding?.identity, result = call.result?.result?.profile;
    const stableUuid = require("../app/agent-service/agent-runtime-binding").stableUuid;
    const pending = creationEvents.find(event => event.type === "mcp_tool_call.put" && event.aggregateId === call.id
      && event.payload.call.status === "pending" && canonical(event.payload.call.binding) === canonical(binding));
    const completed = creationEvents.find(event => event.type === "mcp_tool_call.put" && event.aggregateId === call.id
      && canonical(event.payload.call) === canonical(call));
    const puts = creationEvents.filter(event => event.type === "agent_profile.put" && event.aggregateId === profile?.id
      && pending && completed && event.seq > pending.seq && event.seq < completed.seq);
    const eventChain = !!pending && !!completed && puts.length === 2 && completed.seq === pending.seq + 3
      && puts[0].seq === pending.seq + 1 && puts[1].seq === pending.seq + 2
      && puts[0].payload.profile.enabled === false && puts[1].payload.profile.enabled === true
      && canonical(puts[1].payload.profile) === canonical(profile)
      && [pending, ...puts, completed].every(event => event.schemaVersion === 12
        && event.time >= call.createdAt) && completed.time >= pending.time;
    return { callId: call.id, profileId: binding?.targetProfileId ?? null, createdAt: call.createdAt,
      completed: call.status === "completed" && call.result?.ok === true,
      operationIdentityMatches: typeof binding?.operationId === "string"
        && stableUuid("shoggoth-agent-profile-v2", binding.operationId) === profile?.id
        && stableUuid("shoggoth-agent-lifecycle-call-v1", binding.operationId) === call.callId,
      profileMatches: !!profile && binding?.method === "agent.create" && identity?.id === profile.id
        && identity?.agentId === profile.agentId && binding.createdAt === profile.createdAt
        && binding.createdAt === call.createdAt && binding.name === profile.name
        && binding.backendId === profile.backendId && binding.defaultCwd === profile.defaultCwd
        && identity.runtime === profileView(profile).runtime && identity.runtimeProfileId === profileView(profile).runtimeProfileId
        && result?.id === profile.id && result?.agentId === profile.agentId && result?.createdAt === profile.createdAt,
      originalEventChainVerified: eventChain,
      eventChain: eventChain ? { firstSeq: pending.seq, lastSeq: completed.seq, firstTime: pending.time, lastTime: completed.time,
        checksums: [pending, ...puts, completed].map(event => event.checksum) } : null,
      evidence: eventChain ? "verified_original_events_and_durable_completed_receipt"
        : "durable_completed_receipt_only; original_event_chain_not_retained" };
  });
  return { auditVersion: 2, stateDir: paths.stateDir, observedAt: new Date().toISOString(),
    quiescent: activeMarkers.length === 0, activeMarkers,
    product: { schemaVersion: product?.schemaVersion, lastSeq: product?.lastSeq, snapshotLastSeq,
      snapshot: snapshotInfo, eventReplayVerified: true, eventLog: eventInfo,
      profiles: rowSummary(profiles, ["id", "backendId", "agentId", "name", "providerRef", "defaultModel",
        "defaultCwd", "permissionPolicy", "isDefault", "enabled", "createdAt"]),
      workRuns: rowSummary(runs), runtimeAccounts: rowSummary(values(product?.runtimeAccounts), ["id", "runtime", "kind",
        "installationKind", "homeKind", "providerRef", "isDefault", "createdAt"]),
      modelProviders: rowSummary(values(product?.modelProviders).map(({ revision, ...row }) => row)),
      runNotes: rowSummary(values(product?.runNotes)), mcpToolCalls: rowSummary(values(product?.mcpToolCalls)),
      activeRuns: runs.filter(row => ["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(row.status)).length },
    chat: { version: chat?.version, sessions: rowSummary(sessions, ["id", "sessionKey", "profileId", "runtimeSessionId",
      "workspace", "title", "modelOverride", "permissionMode", "status", "createdAt", "modelSettings"]),
      createOperations: rowSummary(values(chat?.createOperations)), bindingOperations: rowSummary(values(chat?.bindingOperations)),
      remoteOperations: rowSummary(values(chat?.remoteOperations)), cronRuns: rowSummary(values(chat?.cronRuns)) },
    usage: { versions: [...new Set(envelopes.map(row => row.version))], ...rowSummary(usage, legacyUsageFields), totals },
    transcripts: { fileCount: transcripts.length, bytes: transcripts.reduce((sum, file) => sum + file.bytes, 0),
      digest: digestRows(transcripts), files: transcripts },
    credentials: { count: Object.keys(secretContainer?.credentials || {}).length },
    cron: { jobs: values(cron?.jobs).length, enabled: values(cron?.jobs).filter(job => job.enabled).length,
      currentlyDue: values(cron?.jobs).filter(job => job.enabled && job.nextRunAt !== null && job.nextRunAt <= Date.now()).length },
    privateFiles, config: fileInfo(path.join(paths.userDataRoot, "config.json")),
    inventory, definitions: { files: definitions, digest: digestRows(definitions) },
    concurrencyJournal: concurrencyJournal && { sha256: fileInfo(path.join(paths.stateDir, "profile-concurrency-migration-v11.json")).sha256,
      profiles: concurrencyJournal.profiles }, creationReceipts, eventEvidence: evidenceInfo,
    transcriptAppendProofs: transcriptAppendProofs(paths, transcripts, options.baseline, runs) };
}
function compare(before, after) {
  const differences = [];
  const at = (object, key) => key.split(".").reduce((value, part) => value?.[part], object);
  for (const key of ["product.profiles", "product.runtimeAccounts", "product.modelProviders", "product.workRuns",
    "product.runNotes", "product.mcpToolCalls", "chat.sessions", "chat.createOperations", "chat.bindingOperations",
    "chat.remoteOperations", "chat.cronRuns", "usage.count", "usage.idsHash", "usage.contentHash", "usage.totals",
    "transcripts.fileCount", "transcripts.digest", "credentials.count"]) {
    if (canonical(at(before, key)) !== canonical(at(after, key))) differences.push(key);
  }
  for (const key of ["local-crypto-master-key.v1", "mcp-auth.json", "federation-mcp-auth.json"]) {
    if (before.privateFiles[key] && canonical(before.privateFiles[key]) !== canonical(after.privateFiles[key])) {
      differences.push(`privateFiles.${key}`);
    }
  }
  const result = { comparable: before.quiescent && after.quiescent
      && (before.product.eventLog?.bytes === 0 || before.product.eventReplayVerified === true)
      && (after.product.eventLog?.bytes === 0 || after.product.eventReplayVerified === true),
    differences, matches: differences.length === 0 };
  if (!before.inventory || !after.inventory) return { ...result, detailLevel: "v1_aggregate_only" };
  const collections = {}, changes = [], migrations = [];
  for (const [key, prior] of Object.entries(before.inventory)) {
    const current = new Map((after.inventory[key] || []).map(row => [row.id, row]));
    const oldIds = new Set(prior.map(row => row.id)), missing = [], changed = [];
    for (const row of prior) {
      const next = current.get(row.id);
      if (!next) { missing.push(row.id); continue; }
      const fields = Object.keys(row.fields).filter(field => row.fields[field] !== next.fields[field]);
      const migration = after.concurrencyJournal?.profiles.find(entry => entry.profileId === row.id
        && entry.beforeDigest === row.migrationDigest && entry.afterDigest === next.migrationDigest);
      if (key === "product.profiles" && before.product.schemaVersion === 10 && after.product.schemaVersion >= 11
        && fields.length === 1 && fields[0] === "concurrency"
        && row.fields.concurrency === hash(canonical({ maxActive: 4, maxWorkspaceWrites: 4 }))
        && next.fields.concurrency === hash(canonical({ maxActive: null, maxWorkspaceWrites: null })) && migration) {
        migrations.push({ collection: key, id: row.id, field: "concurrency", evidence: "verified_committed_v11_journal" });
      } else if (fields.length) changed.push({ id: row.id, fields });
    }
    const added = [...current.keys()].filter(id => !oldIds.has(id));
    collections[key] = { before: prior.length, after: current.size, originalPreserved: prior.length - missing.length - changed.length,
      missing, changed, added };
    if (missing.length || changed.length) changes.push(key);
  }
  function compareFiles(key) {
    const prior = before[key].files, current = new Map(after[key].files.map(file => [file.path, file]));
    const oldPaths = new Set(prior.map(file => file.path));
    const missing = [], changed = [], appended = [], derivedManifestUpdates = [];
    for (const file of prior) {
      const next = current.get(file.path);
      if (!next) missing.push(file.path);
      else if (canonical(file) !== canonical(next)) {
        const proof = key === "transcripts" && after.transcriptAppendProofs?.find(entry => entry.verified
          && entry.originalSha256 === before.transcripts.files.find(old => old.path === entry.path)?.sha256
          && ((entry.path === file.path && entry.currentSha256 === next.sha256)
            || (entry.manifestPath === file.path && entry.manifestSha256 === next.sha256)));
        if (proof?.path === file.path) appended.push(file.path);
        else if (proof?.manifestPath === file.path) derivedManifestUpdates.push(file.path);
        else changed.push(file.path);
      }
    }
    const added = [...current.keys()].filter(file => !oldPaths.has(file));
    collections[key] = { before: prior.length, after: current.size, originalPreserved: prior.length - missing.length - changed.length,
      missing, changed, added, appended, derivedManifestUpdates };
    if (missing.length || changed.length) changes.push(key);
  }
  compareFiles("transcripts"); compareFiles("definitions");
  const addedProfiles = collections["product.profiles"].added;
  const addedCalls = new Set(collections["product.mcpToolCalls"].added);
  const postBackupCreates = addedProfiles.map(profileId => {
    const proof = after.creationReceipts.find(entry => entry.profileId === profileId && addedCalls.has(entry.callId));
    return { profileId, verifiedDurableReceipt: !!proof && proof.completed && proof.operationIdentityMatches
      && proof.profileMatches && proof.createdAt > Date.parse(before.observedAt), proof: proof || null,
      originalEventChainVerified: proof?.originalEventChainVerified === true };
  });
  const privateFileChanges = Object.keys(before.privateFiles).filter(key =>
    canonical(before.privateFiles[key]) !== canonical(after.privateFiles[key]));
  const masterKeyPreserved = canonical(before.privateFiles["local-crypto-master-key.v1"])
    === canonical(after.privateFiles["local-crypto-master-key.v1"]);
  const additionsPresent = Object.values(collections).some(entry => entry.added.length);
  const transcriptGrowth = Object.values(collections).some(entry => entry.appended?.length || entry.derivedManifestUpdates?.length);
  return { ...result, matches: result.matches && changes.length === 0 && migrations.length === 0
      && !additionsPresent && !transcriptGrowth && privateFileChanges.length === 0,
    detailLevel: "per_original_id_and_field_hash", collections, migrations,
    originalRecordsPreserved: changes.length === 0, changedOriginalCollections: changes,
    additionsPresent,
    postBackupCreates, privateFileChanges, masterKeyPreserved,
    credentialContentsVerified: false,
    credentialBoundary: "Only file hashes are compared. Changed encrypted blobs require a separate authenticated credential check; no decryption was performed." };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const name = args.shift();
      if (name === "--require-stopped") options.stopped = true;
      else if (["--state-dir", "--out", "--compare", "--events-evidence"].includes(name) && args.length) options[name] = args.shift();
      else throw new Error("Usage: runtime-upgrade-audit.cjs [--state-dir PATH] [--require-stopped] [--out NEW_FILE] [--compare PRE_FILE] [--events-evidence FILE]");
    }
    const paths = options["--state-dir"] ? resolveServicePaths({ stateRoot: options["--state-dir"] }) : resolveCanonicalServicePaths();
    const baseline = options["--compare"] ? JSON.parse(fs.readFileSync(options["--compare"], "utf8")) : null;
    const result = audit(paths, { baseline: baseline?.inventory ? baseline : null, eventEvidencePath: options["--events-evidence"] });
    if (options.stopped && !result.quiescent) throw new Error("Service/writer markers remain; no coherent receipt written");
    if (baseline) result.comparison = compare(baseline, result);
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (options["--out"]) fs.writeFileSync(options["--out"], output, { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ ...result, inventory: undefined, definitions: result.definitions && { digest: result.definitions.digest },
      concurrencyJournal: result.concurrencyJournal && { sha256: result.concurrencyJournal.sha256 }, creationReceipts: undefined,
      transcripts: { ...result.transcripts, files: undefined } }, null, 2));
    if (result.comparison && (!result.comparison.comparable || !result.comparison.matches)) process.exitCode = 2;
  } catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
}
module.exports = { audit, compare };
