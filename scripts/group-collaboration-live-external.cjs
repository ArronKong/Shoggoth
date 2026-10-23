"use strict";
// Real external provider transport for the frozen group evaluation. Never
// construct either backend in the ambient parent environment: their legacy
// local scopes intentionally follow process-level data-root variables.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), net = require("node:net");
const { fork, spawn, execFileSync } = require("node:child_process");
const fail = code => Object.assign(new Error(code), { code });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const codeCatalogue = require("./group-collaboration-live-codes.cjs");
const codeEvidence = error => { const diagnostic = codeCatalogue.diagnosticCode(error, "GROUP_LIVE_EXTERNAL_FAILED"), output = { code: diagnostic.errorCode }; for (const [key,value] of Object.entries(diagnostic)) if (key !== "errorCode") output["code" + key.slice(9)] = value; return output; };
const safeCode = error => codeEvidence(error).code;
const sourceModule = (repo, file) => require(path.join(repo, file));
function privateFile(file, max = 256 * 1024, credential = false) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > max || before.uid !== process.getuid()
    || credential && (before.mode & 0o077)) throw fail("GROUP_LIVE_EXTERNAL_AUTH_FILE_UNSAFE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if ([before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(":")
      !== [opened.dev, opened.ino, opened.size, opened.mtimeMs, opened.ctimeMs].join(":")
      || bytes.length !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
      throw fail("GROUP_LIVE_EXTERNAL_AUTH_FILE_CHANGED");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function directory(file) { fs.mkdirSync(file, { mode: 0o700 }); return file; }
function write(file, content) { fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 }); }
function selectedEntries(object, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(object || {}, key)).map(key => [key, object[key]]));
}
function selectedOpenclawModelDefaults(original, model) {
  const entry = original.agents?.defaults?.models?.[model];
  if (entry === undefined) return { defaults: null, evidence: { configured: false, parameters: {}, parametersDigest: sha("{}"), streaming: null } };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || Object.keys(entry).some(key => !["alias", "params", "streaming"].includes(key))) throw fail("GROUP_LIVE_OPENCLAW_MODEL_PARAMETERS_UNSUPPORTED");
  const serialized = JSON.stringify(entry);
  if (Buffer.byteLength(serialized) > 16384 || entry.params !== undefined && (!entry.params || typeof entry.params !== "object" || Array.isArray(entry.params)))
    throw fail("GROUP_LIVE_OPENCLAW_MODEL_PARAMETERS_UNSUPPORTED");
  const defaults = JSON.parse(serialized), parameters = defaults.params ?? {};
  return { defaults, evidence: { configured: true,
    parameters: require("./group-collaboration-live-matrix.cjs").safeEvidence(parameters),
    parametersDigest: sha(JSON.stringify(parameters)), streaming: defaults.streaming ?? null,
    selectedDefaultsDigest: sha(serialized) } };
}
function selectHostExecutions(records, member, groupId) {
  if (typeof groupId !== "string" || !groupId) throw fail("GROUP_LIVE_EXTERNAL_OBSERVATION_SCOPE_REQUIRED");
  const executions = [], rejected = [];
  for (const record of records) {
    if (record?.groupId !== groupId) continue;
    const identity = record.identity, binding = record.binding, snapshot = record.snapshot;
    const fields = ["executionId", "runId", "backendId", "agentId"];
    const key = binding?.sessionKey;
    const valid = identity && identity.backendId === member.backendId && identity.agentId === member.agentId
      && fields.every(field => typeof identity[field] === "string" && identity[field])
      && typeof key === "string" && key.startsWith("agent:" + member.agentId + ":") && key !== "agent:" + member.agentId + ":main"
      && binding.workspace === member.workspace && snapshot && fields.every(field => snapshot[field] === identity[field])
      && ["sessionKey", "workspace", "mode"].every(field => snapshot[field] === binding[field]);
    if (!valid) { rejected.push({ executionId: identity?.executionId ?? null, reason: "host-execution-binding-mismatch" }); continue; }
    const start = record.startInput;
    const inputBound = start && fields.every(field => start[field] === identity[field])
      && ["sessionKey", "workspace", "mode"].every(field => start[field] === binding[field]) && typeof start.prompt === "string";
    executions.push({ ...selectedEntries(identity, fields), groupId, sessionKey: key, workspace: binding.workspace, mode: binding.mode,
      kind: record.kind, taskId: record.taskId ?? null, status: snapshot.status, sequence: snapshot.sequence,
      createdAt: record.createdAt ?? null, finishedAt: snapshot.finishedAt ?? null,
      inputDigest: inputBound ? sha(start.prompt) : null, inputBound: Boolean(inputBound),
      resultDigest: typeof record.resultDigest === "string" ? record.resultDigest : null,
      resultSummaryDigest: typeof snapshot.resultSummary === "string" ? sha(snapshot.resultSummary) : null });
  }
  return { executions, rejected };
}
function historyEvidence(messages, executions) {
  const content = message => typeof message?.content === "string" ? message.content : typeof message?.text === "string" ? message.text
    : Array.isArray(message?.content) ? message.content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("") : null;
  const rows = messages.map((message, index) => { const text = content(message); return { index, id: message?.id ?? null, role: message?.role ?? null,
    digest: text === null ? null : sha(text), bytes: text === null ? null : Buffer.byteLength(text),
    model: typeof message?.model === "string" ? message.model : null, finishReason: message?.finish_reason ?? message?.stopReason ?? null }; });
  const safe = require("./group-collaboration-live-matrix.cjs").safeEvidence;
  const trajectory = messages.map((message, index) => {
    const text = content(message), rawCalls = message?.tool_calls ?? message?.toolCalls ?? null;
    let calls = rawCalls, callsMalformed = false;
    if (typeof calls === "string") { try { calls = JSON.parse(calls); } catch { calls = null; callsMalformed = true; } }
    if (calls !== null && !Array.isArray(calls)) callsMalformed = true;
    const projected = { index, id: message?.id ?? null, role: message?.role ?? null,
      toolCallId: message?.tool_call_id ?? message?.toolCallId ?? null, toolName: message?.tool_name ?? message?.toolName ?? null,
      finishReason: message?.finish_reason ?? message?.stopReason ?? null,
      text: text === null ? null : text.length > 65536 ? text.slice(0, 65536) : text,
      textDigest: text === null ? null : sha(text), textBytes: text === null ? null : Buffer.byteLength(text), textTruncated: text !== null && text.length > 65536,
      toolCallsAvailability: callsMalformed ? "unavailable-malformed-native-tool-calls" : "owned-runtime-message-projection",
      malformedToolCallsDigest: callsMalformed ? sha(typeof rawCalls === "string" ? rawCalls : JSON.stringify(rawCalls)) : null,
      toolCalls: Array.isArray(calls) ? calls.map(call => ({ id: call?.id ?? null, name: call?.function?.name ?? call?.name ?? null,
        arguments: call?.function?.arguments ?? call?.arguments ?? null })) : [],
      toolErrorCodes: message?.role === "tool" && text !== null ? [...new Set(text.match(/\b[A-Z][A-Z0-9_]{3,100}\b/gu) ?? [])].filter(code => /(?:ERROR|FAILED|INVALID|REJECTED|MISMATCH|UNAVAILABLE|TIMEOUT)/u.test(code)) : [] };
    return safe(projected);
  });
  const actualToolCalls = trajectory.flatMap(row => row.toolCalls.map(call => {
    const toolResult = trajectory.find(result => result.role === "tool" && result.toolCallId === call.id);
    return { messageIndex: row.index, ...call, resultIndex: toolResult?.index ?? null, resultDigest: toolResult?.textDigest ?? null,
      resultText: toolResult?.text ?? null, errorCodes: toolResult?.toolErrorCodes ?? [], errorCodesDiagnostics: toolResult?.toolErrorCodesDiagnostics ?? null,
      resultAvailability: toolResult ? "matched-owned-session-tool-result" : "unavailable" };
  }));
  const bindings = executions.map(execution => {
    const pairs = [];
    for (const input of rows.filter(row => row.role === "user" && row.digest === execution.inputDigest)) {
      for (let index = input.index + 1; index < rows.length && rows[index].role !== "user"; index += 1) {
        const result = rows[index];
        if (result.role === "assistant" && result.digest === execution.resultDigest) pairs.push({ inputIndex: input.index, resultIndex: index, messageModel: result.model });
      }
    }
    return { executionId: execution.executionId, runId: execution.runId, inputDigest: execution.inputDigest, resultDigest: execution.resultDigest,
      uniqueInputResultPair: pairs.length === 1, pairs, effectiveModel: execution.status === "completed" && pairs.length === 1 ? pairs[0].messageModel : null,
      modelProvenance: pairs.length === 1 && pairs[0].messageModel ? "exact-bound-runtime-assistant-message" : "unavailable;session-row-model-is-separate-cumulative-evidence" };
  });
  return { rows, bindings, trajectory, actualToolCalls, totalMessages: rows.length, fullHistory: rows.length < 200 && !trajectory.some(row => row.malformedToolCallsDigest),
    actualToolCallCount: trajectory.some(row => row.malformedToolCallsDigest) ? null : actualToolCalls.length,
    historyAvailability: trajectory.some(row => row.malformedToolCallsDigest) ? "partial-malformed-native-tool-calls" : "observed",
    note: "Actual session tool calls include failures; they are separate from accepted Product group-tool calls and Provider requests." };
}
async function collectBoundSessions({ backend, member, host, groupId }) {
  if (!host?.db || host.agent?.backendId !== member.backendId || host.agent?.agentId !== member.agentId)
    throw fail("GROUP_LIVE_EXTERNAL_OBSERVATION_HOST_MISMATCH");
  // Direct SELECT does not pump queued work, renew leases, or dispatch a run.
  const records = host.db.prepare("SELECT data FROM executions ORDER BY rowid").all().map(row => JSON.parse(row.data));
  const selection = selectHostExecutions(records, member, groupId), sessions = [];
  for (const key of [...new Set(selection.executions.map(execution => execution.sessionKey))]) {
    const executions = selection.executions.filter(execution => execution.sessionKey === key);
    const observed = { sessionKey: key, executions, provenance: "production-host-durable-execution-binding",
      usageScope: "exact-session-cumulative;read-once-per-session;never-sum-with-its-primary-task-usage", providerRequestCount: null,
      rawProviderUsage: null, providerUsageAvailability: "unavailable", model: null, modelAvailability: "unavailable",
      historyAvailability: "unavailable", rawGatewayUsage: null, rawRuntimeSession: null };
    try {
      if (member.backendId === "hermes") {
        const target = backend._sessionTarget(key), mapping = backend.gwRuntimeByKey?.get(key) ?? null;
        if (target.agentId !== member.agentId || target.tail === "main" || mapping?.storedId && mapping.storedId !== target.tail)
          throw fail("GROUP_LIVE_EXTERNAL_SESSION_LINEAGE_MISMATCH");
        observed.runtimeMapping = mapping ? selectedEntries(mapping, ["runtimeId", "storedId", "generation", "profile"]) : null;
        const base = target.dash.baseUrl + "/api/sessions/" + encodeURIComponent(target.tail), query = "?profile=" + encodeURIComponent(target.profile);
        const detail = await backend._httpGetJson(base + query, target.dash.token, target.dash);
        if (detail.status !== 200 || detail.json?.id !== target.tail || detail.json?.profile !== target.profile)
          throw fail("GROUP_LIVE_EXTERNAL_SESSION_METADATA_MISMATCH");
        observed.rawRuntimeSession = selectedEntries(detail.json, ["id", "profile", "model", "billing_provider", "cwd", "started_at", "ended_at",
          "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "api_call_count", "tool_call_count"]);
        let config = detail.json.model_config;
        if (typeof config === "string") { try { config = JSON.parse(config); } catch { config = null; } }
        observed.rawRuntimeSession.modelConfig = selectedEntries(config, ["model", "provider", "max_tokens", "temperature", "reasoning_effort"]);
        observed.runtimeReportedToolNames = typeof detail.json.tool_names === "string" || Array.isArray(detail.json.tool_names) ? detail.json.tool_names : null;
        observed.model = typeof detail.json.model === "string" ? detail.json.model : null;
        observed.modelAvailability = observed.model ? "exact-bound-runtime-session-row;cumulative-not-provider-completion" : "unavailable";
        observed.rawGatewayUsage = backend.gwUsageByKey?.get(key) ?? null;
        observed.usageAvailability = "exact-bound-runtime-session-cumulative-row";
        const history = await backend._httpGetJson(base + "/messages" + query + "&limit=200&offset=0&order=oldest&inline_images=false", target.dash.token, target.dash);
        if (history.status !== 200 || history.json?.session_id !== target.tail || history.json?.profile !== target.profile || !Array.isArray(history.json.messages))
          throw fail("GROUP_LIVE_EXTERNAL_SESSION_HISTORY_MISMATCH");
        observed.history = historyEvidence(history.json.messages, executions); observed.historyAvailability = "exact-bound-runtime-session-rest-history";
      } else {
        const usage = await backend.request("sessions.usage", { key, agentId: member.agentId, groupBy: "instance", limit: 1 }, 10_000);
        const rows = Array.isArray(usage?.sessions) ? usage.sessions : [];
        const exact = rows.find(row => row?.key === key);
        observed.rawSessionsUsage = exact ? { session: exact, provenance: "exact-session-instance-usage-row" } : null;
        observed.usageAvailability = exact ? "exact-bound-runtime-session-cumulative-row" : "unavailable";
        const metadata = await backend.request("sessions.list", { agentId: member.agentId, search: key, limit: 100 }, 10_000);
        const row = Array.isArray(metadata?.sessions) ? metadata.sessions.find(row => row?.key === key) : null;
        observed.rawRuntimeSession = row ? selectedEntries(row, ["key", "sessionId", "model", "modelProvider", "updatedAt", "totalTokens", "contextTokens"]) : null;
        observed.model = typeof row?.model === "string" ? row.model : null;
        observed.modelAvailability = observed.model ? "exact-bound-runtime-session-row;cumulative-not-provider-completion" : "unavailable";
        const history = await backend.request("chat.history", { sessionKey: key, limit: 200 }, 10_000);
        if (!Array.isArray(history?.messages) || history.sessionKey && history.sessionKey !== key) throw fail("GROUP_LIVE_EXTERNAL_SESSION_HISTORY_MISMATCH");
        observed.history = historyEvidence(history.messages, executions); observed.historyAvailability = "exact-bound-runtime-session-rpc-history";
      }
    } catch (error) { observed.observationErrorCode = safeCode(error); }
    sessions.push(observed);
  }
  return { backendId: member.backendId, agentId: member.agentId, groupId, sessions, rejectedHostExecutions: selection.rejected,
    providerRequestCount: null, note: "Only durable Host execution-bound sessions are observed; cumulative counters are kept once, unknown Provider counts stay null." };
}
function observeOwnedHermesRoot(root, groupId) {
  if (typeof root !== "string" || !root.startsWith("/private/tmp/sggroup-live-") || path.resolve(root) !== root)
    throw fail("GROUP_LIVE_EXTERNAL_ROOT_INVALID");
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077))
    throw fail("GROUP_LIVE_EXTERNAL_ROOT_INVALID");
  const jobFile = path.join(root, "external/bridge-job.json"), job = JSON.parse(privateFile(jobFile, 256 * 1024, true));
  if (job.version !== 1 || job.root !== root || job.configs?.hermes?.state !== path.join(root, "external/hermes")
    || !Array.isArray(job.members)) throw fail("GROUP_LIVE_EXTERNAL_CHILD_SCOPE_INVALID");
  const member = job.members.find(member => member.backendId === "hermes");
  if (!member || member.agentId !== "hermes-default") throw fail("GROUP_LIVE_EXTERNAL_OBSERVATION_HOST_MISMATCH");
  const hostFile = path.join(root, "external/host-hermes/group-host.sqlite"), nativeFile = path.join(job.configs.hermes.state, "state.db");
  for (const file of [hostFile, nativeFile]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file || stat.uid !== process.getuid()) throw fail("GROUP_LIVE_EXTERNAL_AUTH_FILE_UNSAFE");
  }
  const { DatabaseSync } = require("node:sqlite"), hostDb = new DatabaseSync(hostFile, { readOnly: true });
  let nativeDb;
  try {
    const selection = selectHostExecutions(hostDb.prepare("SELECT data FROM executions ORDER BY rowid").all().map(row => JSON.parse(row.data)), member, groupId);
    nativeDb = new DatabaseSync(nativeFile, { readOnly: true });
    const columnNames = table => nativeDb.prepare("PRAGMA table_info(" + table + ")").all().map(row => row.name);
    const sessionFields = ["id", "profile_name", "model", "billing_provider", "cwd", "started_at", "ended_at", "input_tokens", "output_tokens",
      "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "api_call_count", "tool_call_count", "tool_names", "model_config"].filter(field => columnNames("sessions").includes(field));
    const usageFields = ["session_id", "model", "billing_provider", "task", "api_call_count", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"].filter(field => columnNames("session_model_usage").includes(field));
    const sessions = [];
    for (const key of [...new Set(selection.executions.map(execution => execution.sessionKey))]) {
      const tail = key.slice(("agent:" + member.agentId + ":").length), executions = selection.executions.filter(execution => execution.sessionKey === key),
        row = nativeDb.prepare("SELECT " + sessionFields.join(",") + " FROM sessions WHERE id=?").get(tail);
      const item = { sessionKey: key, executions, model: null, modelAvailability: "unavailable", rawRuntimeSession: null,
        rawProviderUsage: null, providerRequestCount: null, providerCallsDuringObservation: 0,
        provenance: "read-only-owned-host-and-native-sqlite-after-run;wal-aware-not-immutable",
        usageScope: "exact-session-cumulative;session-row-and-primary-task-usage-are-not-additive;auxiliary-tasks-separated" };
      if (!row || row.id !== tail || row.profile_name && row.profile_name !== "default"
        || row.cwd && !executions.every(execution => execution.workspace === row.cwd)) {
        item.observationErrorCode = "GROUP_LIVE_EXTERNAL_SESSION_METADATA_MISMATCH"; sessions.push(item); continue;
      }
      item.model = typeof row.model === "string" ? row.model : null;
      item.modelAvailability = item.model ? "exact-bound-native-session-row;cumulative-not-provider-completion" : "unavailable";
      item.rawRuntimeSession = selectedEntries(row, sessionFields.filter(field => field !== "model_config"));
      let config = row.model_config;
      if (typeof config === "string") { try { config = JSON.parse(config); } catch { config = null; } }
      item.rawRuntimeSession.modelConfig = selectedEntries(config, ["model", "provider", "max_tokens", "temperature", "reasoning_effort"]);
      const messageFields = ["id", "role", "content", "finish_reason", "tool_calls", "tool_call_id", "tool_name"].filter(field => columnNames("messages").includes(field));
      const messages = nativeDb.prepare("SELECT " + messageFields.join(",") + " FROM messages WHERE session_id=? ORDER BY id LIMIT 200").all(tail);
      item.history = historyEvidence(messages, executions);
      if (usageFields.includes("session_id") && usageFields.includes("task")) {
        const usage = nativeDb.prepare("SELECT " + usageFields.join(",") + " FROM session_model_usage WHERE session_id=?").all(tail);
        item.primaryTaskUsage = usage.filter(usage => !usage.task); item.auxiliaryTaskUsage = usage.filter(usage => usage.task);
      } else { item.primaryTaskUsage = null; item.auxiliaryTaskUsage = null; }
      sessions.push(item);
    }
    return { reportVersion: 1, status: sessions.length === 0 ? "unavailable" : sessions.some(session => session.observationErrorCode) ? "partial" : "observed", root, groupId, backendId: member.backendId, agentId: member.agentId,
      providerCallsDuringObservation: 0, providerRequestCount: null, fullMatrixComplete: false,
      source: "supplemental-owned-durable-state;does-not-rewrite-the-original-live-report", sessions,
      rejectedHostExecutions: selection.rejected, rawEvidenceFiles: [hostFile, nativeFile, nativeFile + "-wal"].filter(file => fs.existsSync(file)).map(file => ({
        path: file, bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) })) };
  } finally { nativeDb?.close(); hostDb.close(); }
}
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { availability: "unavailable", pid: null };
  try {
    const text = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "lstart=", "-o", "command="],
      { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(text);
    if (!match || Number(match[1]) !== pid) return { availability: "unavailable", pid };
    return { availability: "present", pid, parentPid: Number(match[2]), processGroupId: Number(match[3]), startedAt: match[4], commandDigest: sha(match[5]) };
  } catch (error) { return { availability: error.status === 1 ? "absent" : "unavailable", pid }; }
}
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code === "ESRCH" ? false : null; }
}
function captureOwnedProcesses({ registry, members = [], ownedProcesses = [], ownedNativeProcesses = [], identify = processIdentity }) {
  const records = [], seen = new Set();
  const add = (proc, kind, detached) => {
    if (!proc || seen.has(proc)) return; seen.add(proc);
    const pid = Number(proc.pid), identity = identify(pid);
    const record = { proc, kind, pid: Number.isSafeInteger(pid) && pid > 1 ? pid : null,
      before: identity, detachedGroup: detached, ownershipUnverified: detached && identity.availability === "present" && identity.processGroupId !== pid,
      exitObserved: proc.exitCode !== null && proc.exitCode !== undefined || Boolean(proc.signalCode), closeObserved: false };
    const onExit = () => { record.exitObserved = true; }, onClose = () => { record.closeObserved = true; };
    proc.once?.("exit", onExit); proc.once?.("close", onClose);
    record.removeListeners = () => { proc.off?.("exit", onExit); proc.off?.("close", onClose); };
    records.push(record);
  };
  for (const proc of ownedProcesses) add(proc, "owned-helper-or-openclaw-gateway", false);
  for (const entry of ownedNativeProcesses) add(entry.proc, entry.kind, entry.detached === true);
  for (const member of members) {
    if (member.backendId !== "hermes") continue;
    const backend = registry.getBackend(member.backendId);
    if (!backend) continue;
    for (const proc of backend._pendingDashboardProcs ?? []) add(proc, "owned-hermes-pending-dashboard", true);
    for (const dash of backend.dashboards?.values?.() ?? []) {
      if (dash.spawned && dash.proc) add(dash.proc, "owned-hermes-dashboard", true);
      else records.push({ proc: null, kind: "hermes-dashboard-ownership-unverified", pid: null, before: { availability: "unavailable", pid: null },
        detachedGroup: false, ownershipUnverified: true, exitObserved: false, closeObserved: false });
    }
    for (const client of backend.acpClients?.values?.() ?? []) if (client.proc) add(client.proc, "owned-hermes-acp", false);
  }
  return records;
}
async function verifyOwnedProcessesStopped(records, { identify = processIdentity, isGroupAlive = groupAlive, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let observations;
  do {
    observations = records.map(record => {
      const after = identify(record.pid), sameIdentity = after.availability === "present" && record.before.availability === "present"
        && ["pid", "parentPid", "processGroupId", "startedAt", "commandDigest"].every(field => after[field] === record.before[field]);
      const detachedGroupAlive = record.detachedGroup ? isGroupAlive(record.pid) : null;
      const absent = after.availability === "absent", knownExit = record.exitObserved || record.proc?.exitCode !== null && record.proc?.exitCode !== undefined || Boolean(record.proc?.signalCode);
      const stopped = !record.ownershipUnverified && absent && knownExit && record.closeObserved === true && (!record.detachedGroup || detachedGroupAlive === false);
      return { kind: record.kind, pid: record.pid, before: record.before, after, sameIdentity,
        exitObserved: knownExit, closeObserved: record.closeObserved, ownershipUnverified: Boolean(record.ownershipUnverified), exitCode: record.proc?.exitCode ?? null,
        signalCode: record.proc?.signalCode ?? null, detachedGroup: record.detachedGroup, detachedGroupAlive,
        stopped, proof: stopped ? "actual-owned-child-exit-and-close-plus-os-pid-absence;owned-detached-group-absence-when-detached" : "unavailable-or-still-live" };
    });
    if (observations.every(row => row.stopped)) break;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  for (const record of records) record.removeListeners?.();
  return { stopped: observations.every(row => row.stopped), processEvidence: observations,
    method: "captured-actual-owned-childprocess-handles-before-backend-stop;no-global-process-kill", timeoutMs };
}
async function stopOwnedActor(child, records, { getStopEvidence, timeoutMs = 30_000 } = {}) {
  let stopRequestError = null;
  if (child.exitCode === null && child.signalCode === null && child.connected) {
    try { child.send({ type: "stop-owned-bridge" }, error => { if (error) stopRequestError = codeEvidence(error); }); }
    catch (error) { stopRequestError = codeEvidence(error); }
  }
  const actorStopEvidence = await verifyOwnedProcessesStopped(records, { timeoutMs });
  const actor = actorStopEvidence.processEvidence[0], runtimeStopEvidence = getStopEvidence?.() ?? null;
  return { stopped: !stopRequestError && child.exitCode === 0 && actorStopEvidence.stopped && actor?.exitObserved === true
      && actor.closeObserved === true && runtimeStopEvidence?.stopped === true,
    childExited: actor?.exitObserved === true, childClosed: actor?.closeObserved === true, childExitCode: child.exitCode,
    actorStopEvidence, runtimeStopEvidence, ...(stopRequestError ? { stopRequestError } : {}) };
}
function minimalEnv() {
  return selectedEntries(process.env, ["PATH", "LANG", "LC_ALL", "TMPDIR", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy"]);
}
function prepare({ root, sourceRepo, paths, roles, workspace, hermesRuntimeRoot, caseId }) {
  if (!root.startsWith("/private/tmp/sggroup-live-") || fs.realpathSync(root) !== root) throw fail("GROUP_LIVE_EXTERNAL_ROOT_INVALID");
  const hermesArchive = roles.some(role => role.runtime === "hermes")
    ? require("./group-collaboration-hermes-runtime.cjs").loadArchive(hermesRuntimeRoot) : null;
  const external = directory(path.join(root, "external")), isolatedHome = directory(path.join(external, "home"));
  const env = { ...minimalEnv(), HOME: isolatedHome, TMPDIR: root, ...(hermesArchive?.env ?? {}) };
  const members = [], modelEvidence = [], configs = {};
  const groupNames = sourceModule(sourceRepo, "app/agent-service/group-mcp-tools").GROUP_MCP_TOOL_DEFINITIONS.map(tool => tool.name);
  for (const role of roles) {
    if (!["hermes", "openclaw"].includes(role.runtime)) continue;
    const roleWorkspace = path.join(workspace, role.id); if (!fs.existsSync(roleWorkspace)) directory(roleWorkspace);
    const state = directory(path.join(external, role.runtime));
    if (role.runtime === "hermes") {
      const yaml = require("node:module").createRequire(path.join(sourceRepo, "package.json"))("js-yaml"), originalHome = path.join(os.homedir(), ".hermes");
      const original = yaml.load(privateFile(path.join(originalHome, "config.yaml")).toString("utf8"), { schema: yaml.JSON_SCHEMA });
      if (!original?.model?.provider || !original?.model?.default) throw fail("GROUP_LIVE_HERMES_MODEL_UNCONFIRMED");
      const provider = original.model.provider, auth = JSON.parse(privateFile(path.join(originalHome, "auth.json"), 256 * 1024, true));
      if (!auth.providers?.[provider]) throw fail("GROUP_LIVE_HERMES_SELECTED_AUTH_MISSING");
      const isolatedAuth = { version: auth.version, providers: { [provider]: auth.providers[provider] }, active_provider: provider };
      if (auth.credential_pool?.[provider]) isolatedAuth.credential_pool = { [provider]: auth.credential_pool[provider] };
      write(path.join(state, "auth.json"), JSON.stringify(isolatedAuth) + "\n");
      const config = { model: selectedEntries(original.model, ["provider", "default", "base_url", "api_mode", "temperature", "max_tokens", "reasoning_effort"]),
        toolsets: ["terminal", "file", "mcp"], terminal: { cwd: roleWorkspace },
        dashboard: { host: "127.0.0.1" }, memory: { enabled: false, memory_enabled: false, user_profile_enabled: false }, skills: { enabled: false },
        cron: { enabled: false }, agent: { max_iterations: 24 }, plugins: {}, mcp_servers: {} };
      if (original.providers?.[provider]) config.providers = { [provider]: original.providers[provider] };
      const policyModule = require("./group-collaboration-live-policy.cjs"), preparedPolicy = policyModule.preparePolicy({ root,
        workspace: roleWorkspace, readRoots: roles.map(role => path.join(workspace, role.id)).filter(file => fs.existsSync(file)), runtime: "hermes", caseId, groupTools: groupNames, hookCwd: isolatedHome }),
        hook = policyModule.writeHermesHook({ root, prepared: preparedPolicy, nodePath: fs.realpathSync(process.execPath) });
      config.hooks = { pre_tool_call: [{ command: hook.command, timeout: 5, fail_closed: true }] };
      write(path.join(state, "shell-hooks-allowlist.json"), JSON.stringify({ approvals: [{ event: "pre_tool_call", command: hook.command }] }) + "\n");
      write(path.join(state, "config.yaml"), yaml.dump(config, { noRefs: true, lineWidth: -1 }));
      write(path.join(state, "SOUL.md"), "# SOUL.md\n\n" + role.card + "\n");
      env.HERMES_HOME = state; env.HERMES_CWD = roleWorkspace;
      configs.hermes = { state, contextPolicy: { memory_enabled: false, user_profile_enabled: false, enabledToolsets: ["terminal", "file", "mcp"], roleSource: "owned-synthetic-SOUL-only" }, configPath: path.join(state, "config.yaml"), toolPolicy: { policyFile: preparedPolicy.file, policySha256: preparedPolicy.sha256,
        policyModule: preparedPolicy.module, policyModuleSha256: preparedPolicy.moduleSha256, hook: hook.hook, hookSha256: hook.sha256,
        method: "official-pre_tool_call-fail_closed-exact-command-allowlist-before-real-tool-body" } };
      members.push({ backendId: "hermes", agentId: "hermes-default", roleId: role.id, workspace: roleWorkspace });
      modelEvidence.push({ backendId: "hermes", model: original.model.default, provider, parameters: selectedEntries(original.model, ["temperature", "max_tokens", "reasoning_effort"]),
        roleDigest: sha(role.card), authority: "selected-existing-provider-credential-in-owned-private-auth", credentialValuesExported: false });
    } else {
      const original = JSON.parse(privateFile(path.join(os.homedir(), ".openclaw", "openclaw.json")).toString("utf8"));
      const model = typeof original.agents?.defaults?.model === "string" ? original.agents.defaults.model : original.agents?.defaults?.model?.primary;
      const provider = typeof model === "string" ? model.split("/")[0] : null;
      const configuredProvider = provider && original.models?.providers?.[provider];
      if (!model || !configuredProvider) throw fail("GROUP_LIVE_OPENCLAW_MODEL_UNCONFIRMED");
      const modelProvider = selectedEntries(configuredProvider, ["baseUrl", "apiKey", "api", "models", "headers", "authHeader"]);
      const authority = require("./group-collaboration-openclaw-auth.cjs").selectExistingAuthority({ config: original, provider, model, root,
        nativeStateDir: path.join(os.homedir(), ".openclaw"), homeDir: os.homedir() });
      let authEvidence;
      try { authEvidence = authority.applyToProvider(modelProvider); }
      finally { authority.dispose(); }
      const selectedDefaults = selectedOpenclawModelDefaults(original, model);
      const references = new Set();
      for (const value of [modelProvider.apiKey, ...Object.values(modelProvider.headers || {})]) {
        if (typeof value === "string") for (const match of value.matchAll(/\$\{([A-Z][A-Z0-9_]{0,127})\}/gu)) references.add(match[1]);
      }
      const variables = Object.fromEntries([...references].map(key => [key, original.env?.vars?.[key] ?? process.env[key]]));
      if (Object.values(variables).some(value => typeof value !== "string" || !value)) throw fail("GROUP_LIVE_OPENCLAW_SELECTED_AUTH_MISSING");
      const roleIdentity = "# IDENTITY.md\n\n- 角色: " + role.id + "\n\n# SOUL.md\n\n" + role.card + "\n";
      write(path.join(roleWorkspace, "IDENTITY.md"), roleIdentity);
      write(path.join(roleWorkspace, "SOUL.md"), "# SOUL.md\n\n" + role.card + "\n");
      const stateDir = directory(path.join(state, "state")), token = crypto.randomBytes(32).toString("base64url");
      const config = { logging: { file: path.join(state, "gateway.runtime.log") }, models: { mode: "replace", providers: { [provider]: modelProvider } },
        ...(references.size ? { env: { vars: variables } } : {}),
        agents: { defaults: { model: { primary: model }, ...(selectedDefaults.defaults ? { models: { [model]: selectedDefaults.defaults } } : {}), workspace: roleWorkspace, maxConcurrent: 1 }, list: [{ id: "main", name: role.id, workspace: roleWorkspace, skills: [] }] },
        tools: { profile: "coding", alsoAllow: groupNames, deny: ["message", "browser", "web_search", "web_fetch", "cron", "gateway", "nodes", "tts"] },
        channels: {}, cron: { enabled: false }, gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } },
        plugins: { enabled: false }, skills: { load: { extraDirs: [] } }, mcp: {} };
      const ocGuard = require("./group-collaboration-openclaw-policy.cjs").prepareGuard({ root, workspace: roleWorkspace,
        readRoots: roles.map(role => path.join(workspace, role.id)).filter(file => fs.existsSync(file)), caseId, groupTools: groupNames });
      config.plugins = { ...ocGuard.configOverlay.plugins, slots: { memory: "none" } };
      config.tools = { ...config.tools, ...ocGuard.configOverlay.tools, fs: { ...(config.tools.fs ?? {}), ...(ocGuard.configOverlay.tools.fs ?? {}) } };
      write(path.join(state, "openclaw.json"), JSON.stringify(config, null, 2) + "\n");
      env.OPENCLAW_HOME = stateDir; env.OPENCLAW_STATE_DIR = stateDir; env.OPENCLAW_CONFIG_PATH = path.join(state, "openclaw.json");
      configs.openclaw = { authAuthority: authEvidence, toolPolicy: ocGuard.policyEvidence, contextPolicy: { agentSkillFilter: [], memoryPluginSlot: "none", roleSource: "owned-synthetic-IDENTITY-SOUL-only" }, state, stateDir, configPath: env.OPENCLAW_CONFIG_PATH };
      members.push({ backendId: "openclaw", agentId: "main", roleId: role.id, workspace: roleWorkspace });
      modelEvidence.push({ backendId: "openclaw", model, provider, parameters: selectedDefaults.evidence.parameters,
        selectedModelDefaults: selectedDefaults.evidence, roleDigest: sha(role.card), authAuthority: authEvidence,
        authority: "installed-SDK-selected-existing-api-key-profile-projected-to-owned-provider-config", credentialValuesExported: false });
    }
  }
  const openclawBin = members.some(member => member.backendId === "openclaw") ? fs.realpathSync(path.join(os.homedir(), ".local", "bin", "openclaw")) : null;
  const openclawProgram = openclawBin ? sourceModule(sourceRepo, "app/cli-runtime/openclaw").resolveOpenclawProgram(openclawBin) : null;
  if (openclawProgram && (!path.isAbsolute(openclawProgram.entryPath) || !fs.statSync(openclawProgram.entryPath).isFile()
    || openclawProgram.interpreterPath && (!path.isAbsolute(openclawProgram.interpreterPath) || !fs.statSync(openclawProgram.interpreterPath).isFile())))
    throw fail("GROUP_LIVE_OPENCLAW_LAUNCH_DESCRIPTOR_INVALID");
  const job = { version: 1, root, sourceRepo, paths, members, configs,
    helperTools: groupNames, modelEvidence, hermesBin: hermesArchive?.launcher ?? null, hermesRuntimeArchive: hermesArchive?.evidence ?? null,
    openclawBin, openclawProgram,
    nodePath: fs.realpathSync(process.execPath) };
  const jobFile = path.join(external, "bridge-job.json"); write(jobFile, JSON.stringify(job) + "\n");
  return { env, job, jobFile };
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}
async function begin(options) {
  const prepared = prepare(options), child = fork(__filename, ["--owned-bridge-child", prepared.jobFile], {
    env: prepared.env, cwd: options.root, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json" });
  const actorRecords = captureOwnedProcesses({ registry: { getBackend: () => null },
    ownedNativeProcesses: [{ proc: child, kind: "owned-external-bridge-actor", detached: false }] });
  let ready, childStopEvidence = null;
  child.on("message", message => { if (message?.type === "stopped" && message.value && typeof message.value === "object") childStopEvidence = message.value; });
  try { ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail("GROUP_LIVE_EXTERNAL_START_TIMEOUT")), 90_000);
    child.once("exit", () => { clearTimeout(timer); reject(fail("GROUP_LIVE_EXTERNAL_CHILD_EXITED")); });
    child.on("message", message => {
      if (message?.type === "ready") { clearTimeout(timer); resolve(message); }
      if (message?.type === "failed") { clearTimeout(timer); const failure = fail(codeCatalogue.boundedCode(message.code, "GROUP_LIVE_EXTERNAL_FAILED").code); if (typeof message.codeDigest === "string" && /^[a-f0-9]{64}$/u.test(message.codeDigest)) failure.codeDigest = message.codeDigest; if (message.codeAvailability === "unknown-runtime-code") failure.codeAvailability = message.codeAvailability; reject(failure); }
    });
  }); } catch (error) {
    const stopped = await stopOwnedActor(child, actorRecords, { getStopEvidence: () => childStopEvidence });
    error.ownedExternalStopped = stopped.stopped;
    error.ownedExternalStopEvidence = stopped.runtimeStopEvidence;
    error.ownedExternalActorStopEvidence = stopped.actorStopEvidence;
    throw error;
  }
  const finalRuntimeBinaryObservation = () => {
    try {
      const binaries = ready.runtimeBinaryEvidence.map(row => ({ runtime: row.runtime,
        launcherUnchanged: sha(fs.readFileSync(row.path)) === row.sha256,
        ...(row.entryPath ? { entryUnchanged: sha(fs.readFileSync(row.entryPath)) === row.entrySha256 } : {}),
        ...(row.interpreterPath ? { interpreterUnchanged: sha(fs.readFileSync(row.interpreterPath)) === row.interpreterSha256 } : {}),
        ...(row.sdkFiles ? { sdkSourcesUnchanged: row.sdkFiles.every(file=>sha(fs.readFileSync(file.path))===file.sha256) } : {}) }));
      return { runtimeBinariesUnchanged: binaries.every(row => Object.values(row).every(value => typeof value !== "boolean" || value)), runtimeBinaryObservations: binaries };
    } catch (error) { return { runtimeBinariesUnchanged: null, runtimeBinaryObservationError: safeCode(error) }; }
  };
  const finalArchiveObservation = () => {
    if (!prepared.job.hermesRuntimeArchive) return { hermesRuntimeArchiveUnchanged: null };
    try {
      const actual = require("./group-collaboration-hermes-runtime.cjs").loadArchive(prepared.job.hermesRuntimeArchive.root);
      return { hermesRuntimeArchiveUnchanged: actual.evidence.archiveDigest === prepared.job.hermesRuntimeArchive.archiveDigest,
        originalKnownPublicFilesPreserved: actual.evidence.originalKnownPublicFilesPreserved, originalExternalWholeHomeWriteObservation: "not-observed" };
    } catch (error) { return { hermesRuntimeArchiveUnchanged: false, hermesRuntimeArchiveError: safeCode(error) }; }
  };
  return { child, members: ready.members, evidence: { models: prepared.job.modelEvidence, isolation: "new-private-runtime-homes-new-sessions-production-backends-and-group-hosts",
    prewarmInventories: ready.inventories, runtimeBinaryEvidence: ready.runtimeBinaryEvidence, hermesRuntimeArchive: prepared.job.hermesRuntimeArchive,
    originalExternalHomesModified: null, originalExternalWholeHomeWriteObservation: "not-observed",
    toolPolicies: Object.fromEntries(Object.entries(prepared.job.configs).filter(([, config]) => config.toolPolicy).map(([name, config]) => [name, config.toolPolicy])),
    contextPolicies: Object.fromEntries(Object.entries(prepared.job.configs).filter(([, config]) => config.contextPolicy).map(([name, config]) => [name, config.contextPolicy])) },
    async observe({ groupId } = {}) {
      if (typeof groupId !== "string" || !groupId) throw fail("GROUP_LIVE_EXTERNAL_OBSERVATION_SCOPE_REQUIRED");
      if (child.exitCode !== null) throw fail("GROUP_LIVE_EXTERNAL_CHILD_EXITED");
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const listener = message => { if (message?.type !== "observation" || message.requestId !== requestId) return;
          clearTimeout(timer); child.off("message", listener); resolve(message.value); };
        const timer = setTimeout(() => { child.off("message", listener); reject(fail("GROUP_LIVE_EXTERNAL_OBSERVATION_TIMEOUT")); }, 20_000);
        child.on("message", listener); child.send({ type: "observe-owned-bridge", requestId, groupId });
      });
    },
    async stop() {
      const alreadyExited = child.exitCode !== null;
      const stopped = await stopOwnedActor(child, actorRecords, { getStopEvidence: () => childStopEvidence });
      // A failed stop is reported. Never run a global kill/serve --stop command.
      return { ...stopped, ...(alreadyExited ? { reason: "already-exited" } : {}),
        ...finalArchiveObservation(), ...finalRuntimeBinaryObservation() };
    } };
}
async function childMain(jobFile) {
  const job = JSON.parse(privateFile(jobFile, 256 * 1024, true));
  if (job.version !== 1 || !job.root.startsWith("/private/tmp/sggroup-live-") || fs.realpathSync(job.root) !== job.root
    || process.env.HERMES_HOME && process.env.HERMES_HOME !== job.configs.hermes?.state
    || process.env.OPENCLAW_CONFIG_PATH && process.env.OPENCLAW_CONFIG_PATH !== job.configs.openclaw?.configPath)
    throw fail("GROUP_LIVE_EXTERNAL_CHILD_SCOPE_INVALID");
  const { BackendRegistry } = sourceModule(job.sourceRepo, "app/core/backend-registry");
  const { GroupRuntimeHost } = sourceModule(job.sourceRepo, "app/group-runtime-host");
  const { GroupRuntimeRouter } = sourceModule(job.sourceRepo, "app/group-runtime-router");
  const { ExternalInspirationRunner } = sourceModule(job.sourceRepo, "app/external-inspiration-runner");
  const { createFederationHostServer } = sourceModule(job.sourceRepo, "app/federation-host-server");
  const { requestService, readClientToken } = sourceModule(job.sourceRepo, "app/agent-service/client");
  const { PROTOCOL_VERSION } = sourceModule(job.sourceRepo, "app/agent-service/server");
  const protocol = sourceModule(job.sourceRepo, "app/group-runtime-host-protocol");
  const registry = new BackendRegistry(), ownedProcesses = [], hosts = [], peers = [], inventories = [], runtimeBinaryEvidence = [];
  let ownedGateway = null;
  let bridge = null, stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const captured = captureOwnedProcesses({ registry, members: job.members, ownedProcesses }), cleanupErrors = [];
    const bounded = require("./group-collaboration-live-worker.cjs").boundedStop;
    const operations = await bounded(async () => {
      try { await bridge?.stop(); } catch (error) { cleanupErrors.push({ phase: "bridge", ...codeEvidence(error) }); }
      try { await registry.stop(); } catch (error) { cleanupErrors.push({ phase: "registry", ...codeEvidence(error) }); }
      for (const host of hosts) try { await host.close(); } catch (error) { cleanupErrors.push({ phase: "host", ...codeEvidence(error) }); }
      for (const proc of ownedProcesses) if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM"); await Promise.race([new Promise(resolve => proc.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
      }
    }, 15_000);
    const proof = await verifyOwnedProcessesStopped(captured, { timeoutMs: 10_000 });
    const evidence = { ...proof, stopped: operations.stopped && proof.stopped && cleanupErrors.length === 0, stopOperations: operations, cleanupErrors };
    process.send?.({ type: "stopped", value: evidence });
    process.exit(evidence.stopped ? 0 : 1);
  };
  const observe = async (requestId, groupId) => {
    const observations = [];
    for (const member of job.members) {
      const host = hosts.find(host => host.agent.backendId === member.backendId && host.agent.agentId === member.agentId);
      observations.push(await collectBoundSessions({ backend: registry.getBackend(member.backendId), member, host, groupId }));
    }
    process.send?.({ type: "observation", requestId, value: observations });
  };
  process.on("message", message => { if (message?.type === "stop-owned-bridge") void stop();
    else if (message?.type === "observe-owned-bridge" && typeof message.requestId === "string") void observe(message.requestId, message.groupId).catch(() => process.send?.({ type: "observation", requestId: message.requestId, value: { availability: "unavailable" } })); });
  process.on("disconnect", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGINT", () => { void stop(); });
  try {
    const ports = {};
    if (job.configs.hermes) {
      const { HermesBackend } = sourceModule(job.sourceRepo, "app/core/hermes-backend");
      ports.hermes = await freePort(); registry.register(new HermesBackend({ port: ports.hermes, bin: job.hermesBin,
        getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) }));
      runtimeBinaryEvidence.push({ runtime: "hermes", path: job.hermesBin, sha256: sha(privateFile(job.hermesBin)), archive: job.hermesRuntimeArchive, model: job.modelEvidence.find(row => row.backendId === "hermes")?.model });
    }
    if (job.configs.openclaw) {
      const { OpenClawBackend } = sourceModule(job.sourceRepo, "app/core/openclaw-backend");
      const { createAuthResolver } = sourceModule(job.sourceRepo, "app/core/device-auth");
      ports.openclaw = await freePort();
      const config = JSON.parse(privateFile(job.configs.openclaw.configPath, 256 * 1024, true));
      config.gateway.port = ports.openclaw;
      // This is a new owned configuration, never the user's original file.
      fs.writeFileSync(job.configs.openclaw.configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
      const credentialsDir = directory(path.join(job.configs.openclaw.state, "credentials"));
      const gatewayUrl = "ws://127.0.0.1:" + ports.openclaw;
      const authResolver = createAuthResolver({ getConfig: () => ({ gatewayUrl, token: config.gateway.auth.token }),
        credentialsDir, localGatewayConfigPath: job.configs.openclaw.configPath, operatorIdentityDir: path.join(credentialsDir, "operator"), strictPrivateFiles: true });
      registry.register(new OpenClawBackend({ getUpstreamUrl: () => gatewayUrl, authResolver, getOrigin: () => "http://127.0.0.1" }));
      runtimeBinaryEvidence.push({ runtime: "openclaw", path: job.openclawBin, sha256: sha(privateFile(job.openclawBin)),
        entryPath: job.openclawProgram.entryPath, entrySha256: sha(fs.readFileSync(job.openclawProgram.entryPath)),
        sdkFiles: ["package.json", "dist/plugins/loader.js", "dist/loader-runtime-load-DpgEqnzx.mjs", "dist/agent-tools-HIqp3eTk.mjs",
          "dist/agent-tools.before-tool-call-Cg8vCu9u.mjs", "dist/hook-runner-global-CFWs616h.mjs", "dist/plugins/hook-runner-global.js", "dist/agents/agent-bundle-mcp-runtime.js",
          "dist/agent-command-1kxM3B0m.mjs", "dist/prepare.runtime-CraZtPFh.mjs", "dist/bootstrap-files-CgqY-7GK.mjs", "dist/workspace-skill-loader-Mbt_C5Ks.mjs", "dist/agent-filter-Com2ua2W.mjs",
          ...job.configs.openclaw.authAuthority.sdkFiles.map(file=>file.relative)].map(relative=>{
          const file=path.join(path.dirname(job.openclawProgram.entryPath),relative),stat=fs.lstatSync(file);
          if(!stat.isFile()||stat.isSymbolicLink())throw fail("GROUP_LIVE_OPENCLAW_SDK_SOURCE_UNSAFE");
          const sha256=sha(fs.readFileSync(file)),authorityFile=job.configs.openclaw.authAuthority.sdkFiles.find(item=>item.relative===relative);
          if(authorityFile&&sha256!==authorityFile.sha256)throw fail("GROUP_LIVE_OPENCLAW_AUTH_SDK_SOURCE_CHANGED");
          return {relative,path:file,sha256};
        }),
        interpreterPath: job.openclawProgram.interpreterPath ?? null,
        interpreterSha256: job.openclawProgram.interpreterPath ? sha(fs.readFileSync(job.openclawProgram.interpreterPath)) : null,
        launchSelection: "unchanged-selected-source-resolveOpenclawProgram;installed-interpreter-preserved",
        model: job.modelEvidence.find(row => row.backendId === "openclaw")?.model });
    }
    for (const member of job.members) {
      const host = new GroupRuntimeHost({ paths: { stateDir: path.join(job.root, "external", "host-" + member.backendId), trustedRoot: job.root },
        registry, agent: { backendId: member.backendId, agentId: member.agentId }, localWorkspace: member.workspace,
        ownerToken: crypto.randomBytes(32).toString("base64url"), runtimeToken: crypto.randomBytes(32).toString("base64url") }).open();
      hosts.push(host); const address = await host.listen();
      const peer = { id: "owned-" + member.backendId, backendId: member.backendId, agentId: member.agentId, hostId: host.hostId,
        token: host.ownerToken, baseUrl: "http://127.0.0.1:" + address.port + "/" }; peers.push(peer);
      member.peerId = peer.id;
      const connectionFile = path.join(job.root, "external", member.backendId + "-group-connection.json");
      write(connectionFile, JSON.stringify({ version: protocol.VERSION, baseUrl: peer.baseUrl, hostId: host.hostId,
        backendId: member.backendId, agentId: member.agentId, runtimeToken: host.runtimeToken }) + "\n");
      const helperFile = path.join(job.root, "external", member.backendId + "-group-helper.cjs");
      write(helperFile, '"use strict";\nconst h=require(' + JSON.stringify(path.join(job.sourceRepo, "app/group-runtime-mcp-helper")) + ');h.serveStdio(h.loadRuntimeConnection(process.argv[2]));\n');
      const launch = { command: job.nodePath, args: [helperFile, connectionFile] };
      // Both configurations are fresh owned files. Install the documented MCP
      // shape directly before starting the actual Runtime; a legacy CLI
      // config command can itself perform unrelated cold-start discovery.
      if (member.backendId === "hermes") {
        const yaml = require("node:module").createRequire(path.join(job.sourceRepo, "package.json"))("js-yaml");
        const file = job.configs.hermes.configPath, config = yaml.load(privateFile(file, 256 * 1024, true).toString("utf8"), { schema: yaml.JSON_SCHEMA });
        config.mcp_servers = { "shoggoth-group": { ...launch, enabled: true, connect_timeout: 10 } };
        fs.writeFileSync(file, yaml.dump(config, { noRefs: true, lineWidth: -1 }), { mode: 0o600 });
      } else {
        const file = job.configs.openclaw.configPath, config = JSON.parse(privateFile(file, 256 * 1024, true));
        config.mcp = { servers: { "shoggoth-group": { ...launch, connectionTimeoutMs: 10_000, requestTimeoutMs: 120_000, supportsParallelToolCalls: true } } };
        fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
      }
      const helper = spawn(job.nodePath, launch.args, { env: process.env, cwd: member.workspace, stdio: ["pipe", "pipe", "ignore"] }); ownedProcesses.push(helper);
      const inventory = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(fail("GROUP_LIVE_EXTERNAL_HELPER_TIMEOUT")), 10_000); let text = "";
        helper.stdout.on("data", chunk => { text += chunk.toString("utf8"); let at;
          while ((at = text.indexOf("\n")) >= 0) { const line = text.slice(0, at); text = text.slice(at + 1); let frame;
            try { frame = JSON.parse(line); } catch { continue; }
            if (frame.id === 1 && frame.result) helper.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
            if (frame.id === 2 && Array.isArray(frame.result?.tools)) { clearTimeout(timer); resolve(frame.result.tools.map(tool => tool.name)); }
            if (frame.error) { clearTimeout(timer); reject(fail("GROUP_LIVE_EXTERNAL_HELPER_REJECTED")); }
          }
        }); helper.once("exit", () => { clearTimeout(timer); reject(fail("GROUP_LIVE_EXTERNAL_HELPER_EXITED")); });
        helper.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "owned-evaluation-prewarm", version: "1" } } }) + "\n");
      });
      inventories.push({ backendId: member.backendId, agentId: member.agentId, tools: inventory, provenance: "actual-production-mcp-helper-prewarm;model-exposure-still-requires-runtime-call" });
    }
    if (job.configs.openclaw) {
      const program = job.openclawProgram;
      const command = program.interpreterPath || program.entryPath, args = [...(program.interpreterPath ? [program.entryPath] : []), "gateway", "--port", String(ports.openclaw)];
      const stdoutFile = path.join(job.root, "external/openclaw/gateway.stdout.log"), stderrFile = path.join(job.root, "external/openclaw/gateway.stderr.log"),
        stdoutFd = fs.openSync(stdoutFile, "wx", 0o600), stderrFd = fs.openSync(stderrFile, "wx", 0o600);
      try { ownedGateway = spawn(command, args, { env: { ...process.env,
        ...(program.interpreterPath ? { PATH: path.dirname(program.interpreterPath) + path.delimiter + (process.env.PATH || "") } : {}) },
        cwd: job.members.find(member => member.backendId === "openclaw").workspace, stdio: ["ignore", stdoutFd, stderrFd] }); }
      finally { fs.closeSync(stdoutFd); fs.closeSync(stderrFd); }
      ownedProcesses.push(ownedGateway);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (ownedGateway.exitCode !== null) throw fail("GROUP_LIVE_OWNED_GATEWAY_EXITED");
        try { const response = await fetch("http://127.0.0.1:" + ports.openclaw + "/health", { signal: AbortSignal.timeout(1000) }); if (response.ok) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const started = await registry.start();
    for (const member of job.members) {
      const backend = registry.getBackend(member.backendId), deadline = Date.now() + 30_000;
      let available = false, attempts = 0;
      do {
        attempts += 1;
        try { if (await backend.getAgent(member.agentId)) { available = true; break; } } catch { /* startup admission can lag /health */ }
        if (member.backendId !== "openclaw") break;
        await new Promise(resolve => setTimeout(resolve, 150));
      } while (Date.now() < deadline);
      const evidence = runtimeBinaryEvidence.find(row => row.runtime === member.backendId);
      if (evidence) evidence.readiness = { actualAgentHandshakeReady: available, startupReadAttempts: attempts,
        initialRegistryStartReportedReady: started.get(member.backendId) === true, method: "production-backend-getAgent-read-with-bounded-startup-admission-retry;no-model-retry" };
      if (!available) throw fail("GROUP_LIVE_EXTERNAL_BACKEND_UNAVAILABLE");
    }
    const runner = new GroupRuntimeRouter({ registry, paths: job.paths, allowRemote: true, getPeers: () => peers,
      localRunner: new ExternalInspirationRunner({ registry, adapterOptions: { sessionPurpose: "group" } }), isLocal: () => false,
      invokeTool: params => requestService(job.paths, { token: readClientToken(job.paths), version: PROTOCOL_VERSION, method: "group.remote.tool", params }, { timeoutMs: 15_000 }) });
    bridge = createFederationHostServer({ paths: job.paths, registry, groupRunner: runner });
    await bridge.start();
    if (job.configs.openclaw?.toolPolicy) {
      const verifier = require("./group-collaboration-openclaw-policy.cjs"), deadline = Date.now() + 5000;
      let attestation;
      do { try { attestation = verifier.verifyGuard(job.configs.openclaw.toolPolicy, ownedGateway?.pid); break; }
        catch(error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 100)); } } while(true);
      const binaryEvidence = runtimeBinaryEvidence.find(row => row.runtime === "openclaw");
      if (!binaryEvidence) throw fail("GROUP_LIVE_OPENCLAW_POLICY_RUNTIME_IDENTITY_UNAVAILABLE");
      binaryEvidence.guardAttestation = attestation;
    }
    process.send?.({ type: "ready", members: job.members, inventories, runtimeBinaryEvidence });
  } catch (error) {
    process.send?.({ type: "failed", ...codeEvidence(error) });
    await stop();
  }
}
if (require.main === module && process.argv[2] === "--owned-bridge-child") childMain(process.argv[3])
  .catch(error => { process.send?.({ type: "failed", ...codeEvidence(error) }); process.exitCode = 1; });
module.exports = { prepare, begin, privateFile, selectedEntries, selectedOpenclawModelDefaults, minimalEnv, selectHostExecutions, historyEvidence, codeEvidence, collectBoundSessions, observeOwnedHermesRoot, processIdentity, captureOwnedProcesses, verifyOwnedProcessesStopped, stopOwnedActor };
