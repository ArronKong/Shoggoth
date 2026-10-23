"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const fail = code => Object.assign(new Error(code), { code });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const terminalRuns = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const finalTasks = new Set(["succeeded", "failed", "declined", "cancelled"]);
const pick = (value, fields) => Object.fromEntries(fields.map(field => [field, value?.[field] ?? null]));
function stableJsonFile(file, max = 256 * 1024) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > max || before.uid !== process.getuid()) throw fail("GROUP_LIVE_EVALUATION_FILE_UNSAFE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (before.ino !== opened.ino || before.dev !== opened.dev || bytes.length !== opened.size
      || opened.size !== before.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs)
      throw fail("GROUP_LIVE_EVALUATION_FILE_CHANGED");
    return { data: JSON.parse(bytes), digest: sha(bytes), path: file };
  } finally { fs.closeSync(fd); }
}
function evaluation(options) {
  const frozen = stableJsonFile(options.descriptor), descriptor = frozen.data;
  const group = descriptor.groups?.find(value => value.id === options.group), sample = descriptor.cases?.find(value => value.id === options.case);
  if (descriptor.evaluationVersion !== 1 || descriptor.rounds !== 3 || descriptor.expectedMatrixRunsPerVersion !== 72
    || !group || !sample || !Number.isSafeInteger(options.round) || options.round < 1 || options.round > descriptor.rounds
    || !["baseline", "candidate"].includes(options.sourceVersion) || typeof descriptor.sharedPrompt !== "string"
    || !/^[a-f0-9]{40}$/u.test(descriptor.sourcePolicy?.baselineGit || "")) throw fail("GROUP_LIVE_EVALUATION_INVALID");
  const runtimes = group.membersByRound[options.round - 1];
  if (!Array.isArray(runtimes) || runtimes.length < 2 || runtimes.length > 3) throw fail("GROUP_LIVE_EVALUATION_MEMBERS_INVALID");
  const roles = runtimes.map((runtime, position) => {
    const role = descriptor.roles.find(row => row.position === position);
    if (!role || typeof role.card !== "string" || !role.id) throw fail("GROUP_LIVE_EVALUATION_ROLES_INVALID");
    return { id: role.id, position, card: role.card, runtime };
  });
  let thresholds = null;
  if (options.sourceVersion === "candidate") {
    if (!options.thresholds) throw fail("GROUP_LIVE_CANDIDATE_THRESHOLDS_REQUIRED");
    thresholds = stableJsonFile(options.thresholds);
    if (thresholds.data.partialCohort) {
      thresholds.cohort = require("./group-collaboration-live-cohort.cjs").validate(thresholds.data,
        { descriptor, descriptorSha256: frozen.digest, slot: options });
    } else if (thresholds.data.evaluationVersion !== 1 || thresholds.data.descriptorSha256 !== frozen.digest
      || thresholds.data.baselineGit !== descriptor.sourcePolicy.baselineGit || thresholds.data.baselineComplete !== true
      || thresholds.data.frozenBeforeCandidate !== true || !thresholds.data.thresholds || typeof thresholds.data.thresholds !== "object")
      throw fail("GROUP_LIVE_CANDIDATE_THRESHOLDS_INVALID");
  }
  const data = sample.id === "user-supplement" ? { U1: sample.data.U1 } : sample.data;
  const body = descriptor.sharedPrompt + "\n\n" + sample.prompt + "\n\n合成资料：\n" + JSON.stringify(data, null, 2);
  return { descriptor, sample, roles, body, frozen, thresholds, dataDigest: sha(JSON.stringify(data)),
    roleDigest: sha(JSON.stringify(roles)), promptDigest: sha(body) };
}
function permission(runtime, caseId) {
  const requiresWrite = ["implementation-review", "approval-wait"].includes(caseId);
  const sandbox = runtime === "opencode" ? "danger-full-access" : runtime === "deepseek-harness" || requiresWrite ? "workspace-write" : "read-only";
  return { approvalPolicy: "on-request", sandbox };
}
function safeEvidence(value) {
  if (typeof value === "string") {
    if (/^\s*[\[{]/u.test(value)) {
      try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object") return JSON.stringify(safeEvidence(parsed)); } catch {}
    }
    const scrubbed = value.replace(/("(code|errorCode|sourceCauseCode|lastErrorCode)"\s*:\s*)("(?:[^"\\]|\\.)*")/gu, (full, prefix, key, literal) => {
      try { const diagnostic = require("./group-collaboration-live-codes.cjs").boundedCode(JSON.parse(literal)); return prefix + JSON.stringify(diagnostic.code) + (diagnostic.codeDigest ? "," + JSON.stringify(key + "Digest") + ":" + JSON.stringify(diagnostic.codeDigest) : ""); } catch { return full; }
    });
    return scrubbed.replace(/gt1\.[tk]\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, "[group-grant-redacted]")
    .replace(/\b(?:sk-(?:proj-)?|AIza)[A-Za-z0-9_-]{20,}/gu, "[credential-redacted]");
  }
  if (Array.isArray(value)) return value.map(safeEvidence);
  if (value && typeof value === "object") {
    const output = {}, catalogue = require("./group-collaboration-live-codes.cjs"), diagnosticMessage = Object.hasOwn(value, "code") || Object.hasOwn(value, "errorCode");
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:token|credentialToken|runtimeToken|ownerToken|apiKey|api_key|access_token|refresh_token|privateKeyPem|password|secret)$/iu.test(key)) { output[key] = "[credential-redacted]"; continue; }
      if (key === "message" && diagnosticMessage && typeof item === "string") { const diagnostic = catalogue.boundedCode(item); output[key] = diagnostic.codeAvailability ? null : diagnostic.code; if (diagnostic.codeDigest) {output.messageDigest=diagnostic.codeDigest;output.messageAvailability="unknown-runtime-message";} continue; }
      if (["code", "errorCode", "sourceCauseCode", "safeCauseCode", "sourceErrorCode", "fatalCode", "lastErrorCode", "checkpointErrorCode", "error_code"].includes(key)) {
        const diagnostic = catalogue.boundedCode(item);
        output[key] = diagnostic.code;
        for (const [field, detail] of Object.entries(diagnostic)) if (field !== "code") output[key + field.slice(4)] = detail;
      } else if (["errorCodes", "cleanupErrorCodes", "toolErrorCodes"].includes(key) && Array.isArray(item)) {
        const diagnostics = item.map(code => catalogue.boundedCode(code));
        output[key] = diagnostics.map(row => row.code);
        if (diagnostics.some(row => row.codeDigest)) output[key + "Diagnostics"] = diagnostics;
      } else output[key] = safeEvidence(item);
    }
    return output;
  }
  return value;
}
function opportunities(service, groupId) {
  return service.groupChatStore.db.prepare("SELECT data FROM opportunities WHERE group_id=? ORDER BY ordinal").all(groupId).map(row => JSON.parse(row.data));
}
function discussions(service, groupId) {
  return service.groupChatStore.db.prepare("SELECT data FROM discussions WHERE group_id=? ORDER BY created_at").all(groupId).map(row => JSON.parse(row.data));
}
function acceptedNative(service, run, profiles) {
  const context = service.workRunCoordinator.runContexts?.get(run?.id), contract = service.workRunCoordinator.runExecutionContracts?.get(run?.id);
  return Boolean(run && profiles.some(profile => profile.id === run.profileId) && run.status === "running"
    && context?.profileId === run.profileId && context.threadId && context.turnId
    && context.turnRef?.turnId === context.turnId && contract?.runId === run.id);
}
function exactWriteApproval(request, roleWorkspace) {
  if (!request || request.kind !== "runtime_approval" || !request.runId || !request.requestId
    || request.expiresAt !== null && request.expiresAt <= Date.now()) return null;
  const details = request.approvalDetails;
  if (!details || details.kind !== "command" || details.cwd !== roleWorkspace || details.networkHost || details.permissions) return null;
  const nativeCommand = details.command;
  let command = nativeCommand;
  const fixed = "printf '%s' 'approval-evidence-v1' > 'approval-proof.txt'";
  const knownWrapper = typeof command === "string"
    ? ["/bin/zsh -c ", "/bin/sh -c "].find(prefix => command.startsWith(prefix)) : null;
  if (knownWrapper) {
    const encoded = command.slice(knownWrapper.length);
    let decoded; try { decoded = JSON.parse(encoded); } catch { return null; }
    if (decoded !== fixed || JSON.stringify(decoded) !== encoded) return null;
    if (details.commandActions !== undefined && (!Array.isArray(details.commandActions) || details.commandActions.length !== 1 || details.commandActions[0]?.command !== decoded)) return null;
    command = decoded;
  }
  if (typeof command !== "string" || command.length > 2048 || /[\r\n$\\]/u.test(command) || command.includes(String.fromCharCode(96))) return null;
  if (command.startsWith("[")) {
    let argv; try { argv = JSON.parse(command); } catch { return null; }
    if (!Array.isArray(argv) || argv.length !== 3 || !["sh", "/bin/sh", "bash", "/bin/bash", "zsh", "/bin/zsh"].includes(argv[0]) || argv[1] !== "-c") return null;
    command = argv[2]; if (typeof command !== "string" || /[\r\n$\\]/u.test(command) || command.includes(String.fromCharCode(96))) return null;
  }
  const target = path.join(roleWorkspace, "approval-proof.txt");
  const quote = value => [value, "'" + value + "'", '"' + value + '"'];
  const commands = new Set();
  for (const format of quote("%s")) for (const body of quote("approval-evidence-v1"))
    for (const destination of [...quote(target), ...quote("approval-proof.txt")])
      for (const printf of ["printf", "/usr/bin/printf"]) commands.add(printf + " " + format + " " + body + " > " + destination);
  if (!commands.has(command.trim())) return null;
  const option = request.approvalOptions?.find(row => row.kind === "allow_once");
  const choice = option?.choice ?? (request.approvalChoices?.includes("once") ? "once" : null);
  return choice && Array.isArray(request.approvalChoices) && request.approvalChoices.includes(choice) ? { choice, target, command, nativeCommand } : null;
}
function assertApprovalTargetAbsent(target) {
  try { fs.lstatSync(target); }
  catch (error) { if (error.code === "ENOENT") return { observedAt: Date.now(), absent: true }; throw error; }
  throw fail("GROUP_LIVE_APPROVAL_TARGET_ALREADY_EXISTS");
}
function approvalWriteObservation(trigger) {
  try {
    const before = fs.lstatSync(trigger.targetPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024) return { availability: "unsafe-target", newlyCreated: false };
    const fd = fs.openSync(trigger.targetPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
      const stable = before.dev === opened.dev && before.ino === opened.ino && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs && bytes.length === opened.size;
      const exactContent = bytes.equals(Buffer.from("approval-evidence-v1"));
      const newlyCreated = stable && exactContent && trigger.targetBeforeApproval?.absent === true && opened.birthtimeMs >= trigger.targetBeforeApproval.observedAt;
      return { availability: "actual-owned-new-file-after-bound-run-request-approval", newlyCreated, exactContent, stable,
        bytes: bytes.length, sha256: sha(bytes), inode: opened.ino, birthtimeMs: opened.birthtimeMs, mtimeMs: opened.mtimeMs, observedAt: Date.now(),
        runId: trigger.runId, requestId: trigger.requestId, approvalRespondedAt: trigger.respondedAt };
    } finally { fs.closeSync(fd); }
  } catch (error) { return { availability: error.code === "ENOENT" ? "missing" : "unavailable", newlyCreated: false }; }
}
function artifactEvaluation(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024) return { status: "unsafe", code: "GROUP_LIVE_ARTIFACT_UNSAFE" };
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let source;
  try {
    const opened = fs.fstatSync(fd); source = fs.readFileSync(fd, "utf8"); const after = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
      return { status: "failed", code: "GROUP_LIVE_ARTIFACT_CHANGED" };
  } finally { fs.closeSync(fd); }
  // No host-created objects/functions enter the VM. The process has a small
  // heap and Node permission enforcement; the VM also forbids code generation.
  const program = 'const fs=require("node:fs"),vm=require("node:vm");const source=fs.readFileSync(0,"utf8");const c=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});new vm.Script("var module={exports:{}};var exports=module.exports;").runInContext(c,{timeout:100});new vm.Script("\\"use strict\\";\\n"+source).runInContext(c,{timeout:100});const outputs=new vm.Script("const f=typeof module.exports===\\"function\\"?module.exports:module.exports.sumValid;if(typeof f!==\\"function\\")throw new Error(\\"export missing\\");[f([1,2,3]),f([]),f([1,\\"2\\",NaN,Infinity,null,-3])]").runInContext(c,{timeout:100});process.stdout.write(JSON.stringify(Array.from(outputs)));';
  try {
    const raw = require("node:child_process").execFileSync(process.execPath, ["--permission", "--max-old-space-size=64", "--disable-proto=throw", "-e", program],
      { input: source, timeout: 2000, maxBuffer: 16 * 1024, stdio: ["pipe", "pipe", "ignore"] });
    const outputs = JSON.parse(raw);
    return { status: outputs[0] === 6 && outputs[1] === 0 && outputs[2] === -2 ? "passed" : "failed", digest: sha(source),
      bytes: Buffer.byteLength(source), fixedCases: [6, 0, -2], actualOutputs: outputs, isolation: "owned-small-heap-node-permission-process-and-empty-v8-context-no-require-process-fs-network-no-code-generation" };
  } catch { return { status: "failed", digest: sha(source), bytes: Buffer.byteLength(source), code: "GROUP_LIVE_ARTIFACT_FIXED_CASES_FAILED" }; }
}
function collectArtifacts(workspace) {
  const found = [];
  const walk = (directory, depth) => {
    if (depth > 5 || found.length > 64) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory() && ![".git", "node_modules", ".cache"].includes(entry.name)) walk(file, depth + 1);
      else if (stat.isFile() && ["sum-valid.cjs", "approval-proof.txt"].includes(entry.name)) {
        const relative = path.relative(workspace, file);
        if (entry.name === "sum-valid.cjs") found.push({ path: relative, evaluation: artifactEvaluation(file) });
        else if (stat.size <= 1024) { const text = fs.readFileSync(file, "utf8"); found.push({ path: relative, digest: sha(text), exactApprovedContent: text === "approval-evidence-v1" }); }
      }
    }
  };
  walk(workspace, 0); return found;
}
function observeRuntime(service, result) {
  const manager = service.runtimeManager, acquire = manager.acquire.bind(manager), wrappers = new WeakMap();
  const evidence = result.runtimeOperationEvidence ??= [];
  manager.acquire = async (...argumentsList) => {
    const original = await acquire(...argumentsList);
    if (wrappers.has(original)) return wrappers.get(original);
    const functions = new Map();
    const proxy = new Proxy(Object.create(null), {
      get(_target, key) {
        const value = Reflect.get(original, key, original);
        if (typeof value !== "function") return value;
        if (!functions.has(key)) {
          functions.set(key, ["sessionStart", "sessionResume", "turnStart", "sessionRead"].includes(key)
            ? async (...params) => {
              const response = await value.apply(original, params), session = response?.session ?? response?.thread ?? null;
              evidence.push({ at: Date.now(), runtime: original.runtime, runtimeProfileId: original.runtimeProfileId,
                runtimeAccountId: original.runtimeAccountId, operation: key,
                requested: pick(params[0], ["sessionId", "model", "cwd", "workspace", "permissionPolicy", "permissionMode", "modelSettings", "reasoningEffort", "thinkingLevel", "serviceTier"]),
                response: pick(response, ["model", "modelProvider", "reasoningEffort", "serviceTier", "permissionMode", "approvalPolicy", "sandbox", "sandboxPolicy", "cwd", "workingDirectory"]),
                session: session ? pick(session, ["id", "model", "modelProvider", "provider", "cwd", "workingDirectory", "workspace", "permissionMode", "sandbox", "sandboxPolicy", "reasoningEffort", "serviceTier"]) : null });
              return response;
            } : value.bind(original));
        }
        return functions.get(key);
      },
      has(_target, key) { return key in original; },
      ownKeys() { return Reflect.ownKeys(original); },
      getOwnPropertyDescriptor(_target, key) {
        const descriptor = Object.getOwnPropertyDescriptor(original, key);
        return descriptor ? { configurable: true, enumerable: descriptor.enumerable, writable: false, value: this.get(null, key) } : undefined;
      },
      getPrototypeOf() { return Object.getPrototypeOf(original); },
    });
    wrappers.set(original, proxy); return proxy;
  };
  return () => { manager.acquire = acquire; };
}
function recordCalls(service, profiles, events, startedAt) {
  const original = service.groupChatService.callTool.bind(service.groupChatService);
  service.groupChatService.callTool = async (name, args, run, profileId, callId, federationClient, boundIdentity) => {
    const native = profiles.some(profile => profile.id === profileId);
    const record = { at: Date.now(), atMs: Date.now() - startedAt, name, action: args.action ?? null,
      nativeRunBound: native && Boolean(run?.id), externalRunBound: Boolean(boundIdentity?.execution && federationClient),
      runId: run?.id ?? boundIdentity?.execution?.runId ?? null, profileId: profileId ?? null,
      backendId: federationClient ?? "shoggoth", identity: boundIdentity ? safeEvidence(pick(boundIdentity, ["backendId", "agentId", "execution", "hostId", "peerId", "ownerId", "epoch"])) : null,
      arguments: safeEvidence(args) };
    try {
      const result = await original(name, args, run, profileId, callId, federationClient, boundIdentity);
      record.ok = result?.ok !== false; record.result = safeEvidence(result); events.push(record); return result;
    } catch (error) { record.ok = false; const diagnostic = require("./group-collaboration-live-codes.cjs").diagnosticCode(error, "GROUP_LIVE_TOOL_FAILED"); record.code = diagnostic.errorCode; if (diagnostic.errorCodeDigest) record.codeDigest = diagnostic.errorCodeDigest; if (diagnostic.errorCodeAvailability) record.codeAvailability = diagnostic.errorCodeAvailability; events.push(record); throw error; }
  };
  return () => { service.groupChatService.callTool = original; };
}
function nativeTrajectories(service, profiles) {
  return profiles.flatMap(profile => {
    const sessions = service.chatSessionStore.listSessions().filter(session => session.profileId === profile.id);
    return sessions.map(session => ({ profileId: profile.id, runtime: profile.runtime, sessionId: session.id,
      events: safeEvidence(service.transcriptStore.listEvents(profile.id, session.id).map(event => pick(event,
        ["id", "runId", "kind", "content", "createdAt", "runtimeSessionRef", "runtimeTurnRef"]))) }));
  });
}
async function observe({ service, call, profiles, groupId, sent, evaluation: evaluated, workspace, result, startedAt, isAborted = () => false }) {
  const ownIds = new Set(profiles.map(profile => profile.id)), sample = evaluated.sample, lead = profiles.find(profile => profile.evaluationRoleId === "lead");
  const triggers = new Map(), snapshots = [], acceptedTimes = new Map(), requestedModels = new Map(); let idleSince = null, lastDigest = null, completed = false, executionError = null;
  const deadline = Date.now() + 360_000;
  try { while (Date.now() < deadline && !isAborted()) {
    const view = service.groupChatStore.getGroup(groupId), turns = opportunities(service, groupId), tasks = service.groupChatStore.listTasks(groupId);
    const runs = service.workRunCoordinator.listRuns().filter(run => ownIds.has(run.profileId));
    for (const run of runs) { if (acceptedNative(service, run, profiles) && !acceptedTimes.has(run.id)) acceptedTimes.set(run.id, Date.now());
      const contract = service.workRunCoordinator.runExecutionContracts?.get(run.id);
      if (contract) requestedModels.set(run.id, pick(contract, ["runId", "runtime", "profileId", "runtimeProfileId", "runtimeAccountId", "profileDefaultModel", "sessionModelOverride", "defaultModel", "permissionPolicy", "cwd", "workspace", "modelSettings", "reasoningEffort"])); }
    const safe = safeEvidence({ at: Date.now(), view, opportunities: turns, runs: runs.map(run => pick(run,
      ["id", "profileId", "status", "runtimeSessionRef", "runtimeTurnRef", "createdAt", "startedAt", "finishedAt", "errorCode", "resultSummary"])) });
    const digest = sha(JSON.stringify({ view: safe.view, opportunities: safe.opportunities, runs: safe.runs }));
    if (lastDigest !== digest) { snapshots.push(safe); lastDigest = digest; }
    if (sample.id === "user-supplement" && !triggers.has("supplement")) {
      const run = runs.find(item => acceptedNative(service, item, profiles));
      if (run) {
        const spec = sample.triggers[0], at = Date.now();
        const update = await call("group.send", { groupId, clientMessageId: "evaluation-supplement", body: spec.body,
          mentions: [], replyTo: sent.message.seq, attachments: [], discussionId: sent.discussionId,
          ...(view.group.mode === "collaborative" ? { expectedPolicyVersion: view.group.policyVersion } : {}) });
        if (update.discussionId !== sent.discussionId) throw fail("GROUP_LIVE_SUPPLEMENT_REQUEST_CHANGED");
        triggers.set("supplement", { kind: spec.action, at, acceptedRunId: run.id, requestId: sent.discussionId, sourceMessageId: sent.message.id,
          sourceSeq: update.message.seq, digest: sha(spec.body), unplannedRescue: false });
      }
    }
    if (sample.id === "coordinator-failure" && !triggers.has("interrupt")) {
      const candidate = runs.find(run => run.profileId === lead?.id && acceptedNative(service, run, profiles));
      const opportunity = candidate && turns.find(turn => turn.runId === candidate.id);
      if (candidate && opportunity && opportunity.memberId === view.group.coordination?.memberId) {
        const at = Date.now();
        await service.workRunCoordinator.abort({ operationId: "evaluation-interrupt-" + candidate.id, sessionKey: opportunity.sessionKey, runId: candidate.id });
        triggers.set("interrupt", { kind: sample.triggers[0].action, at, runId: candidate.id, opportunityId: opportunity.id,
          coordinationEpoch: opportunity.coordinationEpoch ?? null, requestId: sent.discussionId, unplannedRescue: false });
      }
    }
    for (const pending of view.pendingInteractions || []) {
      if (sample.id !== "approval-wait") { result.unhandledInteractions = safeEvidence(view.pendingInteractions); throw fail("GROUP_LIVE_UNPLANNED_INTERACTION"); }
      const request = pending.request ?? pending.interaction?.request;
      if (triggers.has("approval:" + request?.requestId)) continue;
      const target = pending.target ?? (pending.opportunityId ? { kind: "turn", opportunityId: pending.opportunityId } : { kind: "task", taskId: pending.taskId, attemptId: pending.attemptId });
      const turn = target.kind === "turn" ? turns.find(value => value.id === target.opportunityId) : null;
      const task = target.kind === "task" ? tasks.find(value => value.id === target.taskId) : null;
      const attempt = task?.attempts?.find(value => value.id === target.attemptId);
      const runId = turn?.runId ?? attempt?.runId, run = runs.find(value => value.id === runId);
      const roleWorkspace = run && profiles.find(profile => profile.id === run.profileId)?.defaultCwd;
      const approval = roleWorkspace && request?.runId === runId && exactWriteApproval(request, roleWorkspace);
      if (!approval) { result.unhandledInteractions = safeEvidence([pending]); throw fail("GROUP_LIVE_APPROVAL_OUTSIDE_FROZEN_SCOPE"); }
      const targetBeforeApproval = assertApprovalTargetAbsent(approval.target);
      const at = Date.now(), peers = runs.filter(value => value.id !== runId);
      await call("group.interaction.respond", { groupId, target, requestId: request.requestId,
        response: { choice: approval.choice }, operationId: "evaluation-approved-" + request.requestId });
      triggers.set("approval:" + request.requestId, { kind: "approve-scoped-interaction", at, runId, requestId: request.requestId,
        opportunityId: turn?.id ?? null, taskId: task?.id ?? null, targetPath: approval.target, command: approval.command, nativeCommand: approval.nativeCommand,
        targetBeforeApproval, respondedAt: Date.now(),
        peerRunsWhileWaiting: peers.map(value => pick(value, ["id", "profileId", "status", "runtimeTurnRef"])), unplannedRescue: false });
    }
    const active = turns.some(turn => ["queued", "running", "waiting"].includes(turn.state))
      || tasks.some(task => !finalTasks.has(task.status)) || runs.some(run => !terminalRuns.has(run.status));
    const hasResult = service.groupChatStore.listMessages({ groupId, limit: 200 }).messages.some(message => message.author.kind === "member");
    if (!active && (hasResult || runs.length || turns.length)) { if (idleSince === null) idleSince = Date.now(); if (Date.now() - idleSince >= 1500) { completed = true; break; } }
    else idleSince = null;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  } catch (error) { executionError = error; }
  result.requestParameters = [...requestedModels.values()];
  result.triggers = [...triggers.values()]; result.stateTrajectories = snapshots; result.acceptedObservedAt = Object.fromEntries(acceptedTimes);
  result.runOutcomes = service.workRunCoordinator.listRuns().filter(run => ownIds.has(run.profileId)).map(run => pick(run,
    ["id", "profileId", "status", "createdAt", "startedAt", "finishedAt", "runtimeSessionRef", "runtimeTurnRef", "errorCode", "resultSummary"]));
  result.groupOutcomes = safeEvidence(service.groupChatStore.getGroup(groupId)); result.requests = safeEvidence(discussions(service, groupId));
  result.opportunities = safeEvidence(opportunities(service, groupId)); result.nativeTrajectories = nativeTrajectories(service, profiles);
  result.providerUsage = profiles.flatMap(profile => service.tokenUsageStore.list({ profileId: profile.id }));
  result.maintenanceUsage = service.tokenUsageStore.list().filter(record => !ownIds.has(record.profileId));
  result.effectiveModelEvidence = result.runOutcomes.map(run => {
    const usageReportedModels = [...new Set(result.providerUsage.filter(record => record.runId === run.id && record.model).map(record => record.model))];
    const sessionReportedModels = [...new Set((result.runtimeOperationEvidence || []).filter(record => record.runtimeProfileId === run.runtimeSessionRef?.runtimeProfileId
      && record.session?.model).map(record => record.session.model))];
    return { runId: run.id, requested: requestedModels.get(run.id) ?? null, runtimeUsageReportedModels: usageReportedModels,
      runtimeSessionReportedModels: sessionReportedModels, completed: run.status === "completed",
      effectiveModel: run.status === "completed" && usageReportedModels.length === 1 ? usageReportedModels[0] : null,
      unavailableEffectiveModel: run.status !== "completed" || usageReportedModels.length !== 1,
      provenance: "runtime-reported-usage-and-session-values; failed-zero-token-records-do-not-prove-a-provider-model-completion" };
  });
  result.usageAvailability = { native: result.providerUsage.length ? "raw-product-provider-usage-records" : "unavailable", external: "requires-owned-bridge-observation",
    providerRequestCount: null, note: "WorkRun count does not reveal internal Provider request count; unavailable values stay null." };
  result.finalMessages = safeEvidence(service.groupChatStore.listMessages({ groupId, limit: 200 }).messages);
  result.tasks = safeEvidence(service.groupChatStore.listTasks(groupId)); result.artifacts = collectArtifacts(workspace);
  result.approvalWriteEvidence = result.triggers.filter(trigger => trigger.kind === "approve-scoped-interaction").map(trigger => approvalWriteObservation(trigger));
  if (!executionError && evaluated.sample.id === "approval-wait" && (!result.approvalWriteEvidence.length || result.approvalWriteEvidence.some(row => !row.newlyCreated)))
    executionError = fail("GROUP_LIVE_APPROVED_WRITE_UNPROVEN");
  result.latencyEvidence = result.opportunities.map(turn => ({ opportunityId: turn.id, runId: turn.runId,
    committedAt: sent.message.createdAt ?? null, queuedAt: turn.createdAt ?? null, readyAt: null,
    claimedAt: turn.startedAt ?? null, acceptedAt: turn.observation?.acceptedAt ?? null,
    acceptedObservedAt: acceptedTimes.get(turn.runId) ?? null, terminalAt: turn.finishedAt ?? null, uncertainty: turn.recovery ?? null }));
  result.trajectoryComplete = completed; result.overallMatrixComplete = false; result.qualityAssessment = "requires-original-trajectory-review-against-frozen-rubric";
  result.criticalRubric = evaluated.sample.criticalRubric; result.requiredEvidence = evaluated.sample.requiredEvidence;
  result.unplannedRescueCount = 0; result.retries = [];
  if (executionError) throw executionError;
  if (!completed) throw fail(isAborted() ? "GROUP_LIVE_INTERRUPTED" : "GROUP_LIVE_TIMEOUT");
  result.status = "recorded"; result.completedAtMs = Date.now() - startedAt;
}
module.exports = { evaluation, permission, safeEvidence, exactWriteApproval, assertApprovalTargetAbsent, approvalWriteObservation, artifactEvaluation, collectArtifacts, recordCalls, observeRuntime, observe, opportunities };
