"use strict";

const { groupRunTarget } = require("./group-chat-run");
const { transcriptEventId } = require("./transcript-store");
const { canonicalWorkspace } = require("./work-run");
const { validText } = require("../group-result-content");
const { mergeBorrowedMemoryRefs, refsFromEvents } = require("./shoggoth-memory/borrowed-memory-provenance.cjs");

const BINDING = ["runtime", "runtimeProfileId", "runtimeAccountId"];
const failure = () => Object.assign(new Error("Original group result cannot be verified"), { code: "GROUP_TURN_RESULT_UNAVAILABLE" });

// Reads an already completed execution only. No session creation/resume, turn
// dispatch, summary fallback or authority is reconstructed from model text.
async function recoverGroupNativeResult({ run, getRun, chatSessionStore, productStore, transcriptStore,
  runtimeManager, runtimeAccountAdmission, runtimeSessionOwnershipStore, checkpointStore, memoryEngine,
  assertSecretSafe, assertCurrent, timeoutMs = 5000 }) {
  const target = groupRunTarget(run);
  if (target?.kind !== "turn" || run.status !== "completed" || !run.runtimeTurnRef || !run.runtimeSessionRef) throw failure();
  const ref = run.runtimeTurnRef;
  const operationId = `group-turn-${target.opportunityId}`;
  const session = chatSessionStore.getSession(run.sourceId);
  const profile = session && productStore.resolveAgentRuntimeProfile?.(run.profileId, session.runtimeBindingId);
  if (!session || session.profileId !== run.profileId || session.status !== "ready"
    || canonicalWorkspace(session.workspace) !== run.workspace || session.runtimeSessionId !== ref.sessionId
    || !profile?.enabled || BINDING.some(key => profile[key] !== ref[key] || run.runtimeSessionRef[key] !== ref[key])
    || run.runtimeSessionRef.sessionId !== ref.sessionId) throw failure();
  const profileIdentity = JSON.stringify(profile);
  const sessionIdentity = JSON.stringify(session);
  const runIdentity = JSON.stringify(run);
  const events = transcriptStore.listEvents(run.profileId, session.id).filter(event => event.runId === run.id);
  if (!events.some(event => event.kind === "user" && event.content?.operationId === operationId)) throw failure();
  // Source exclusions and revocations cannot be undone by reading native history.
  if (events.some(event => event.contextExcluded || event.content?.borrowedMemoryInvalid)) throw failure();
  const refs = mergeBorrowedMemoryRefs(refsFromEvents(events), checkpointStore?.nativeSessionBorrowedMemoryRefs?.(
    run.profileId, session.id, ref.sessionId, session.runtimeBindingId) || []);
  const account = runtimeAccountAdmission?.read?.(ref.runtimeAccountId);
  const deadline = Date.now() + timeoutMs;
  const fence = () => {
    assertCurrent();
    const currentAccount = runtimeAccountAdmission?.read?.(ref.runtimeAccountId);
    if (Date.now() >= deadline || currentAccount?.mutationActive || currentAccount?.generation !== account?.generation
      || JSON.stringify(getRun(run.id)) !== runIdentity
      || JSON.stringify(chatSessionStore.getSession(run.sourceId)) !== sessionIdentity
      || JSON.stringify(productStore.resolveAgentRuntimeProfile(run.profileId, session.runtimeBindingId)) !== profileIdentity
      || checkpointStore?.nativeSessionStale?.(run.profileId, session.id, ref.sessionId, session.runtimeBindingId)
      || refs.length && memoryEngine?.borrowedMemoryDependenciesCurrent?.(run.profileId, session.id, refs) !== true) throw failure();
    const current = transcriptStore.listEvents(run.profileId, session.id).filter(event => event.runId === run.id);
    if (current.some(event => event.contextExcluded || event.content?.borrowedMemoryInvalid)) throw failure();
    if (!runtimeSessionOwnershipStore) throw failure();
    runtimeSessionOwnershipStore.assertOwned({ binding: Object.fromEntries(BINDING.map(key => [key, ref[key]])),
      sessionId: ref.sessionId, profileId: run.profileId, workspace: run.workspace });
  };
  const observe = async task => {
    fence();
    let timer;
    try {
      const result = await Promise.race([Promise.resolve().then(() => { fence(); return task(); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure()), Math.max(1, deadline - Date.now())); })]);
      fence(); return result;
    } finally { clearTimeout(timer); }
  };
  const host = await observe(() => runtimeManager.acquire(Object.fromEntries(BINDING.map(key => [key, ref[key]])),
    { workspace: run.workspace, permissionPolicy: profile.permissionPolicy }));
  const scoped = host.capabilities?.["session.read.scoped"] === true;
  const response = await observe(() => host.sessionRead({ sessionId: ref.sessionId, includeTurns: true,
    ...(scoped ? { operationId, turnId: ref.turnId } : {}) }));
  const thread = response?.session;
  if (thread?.id !== ref.sessionId || !Array.isArray(thread.turns)
    || thread.historyScope && (thread.historyScope.operationId !== operationId || thread.historyScope.complete !== true)
    || thread.turns.some(turn => (turn.itemsView ?? "full") !== "full" || !Array.isArray(turn.items))) throw failure();
  const matches = thread.turns.flatMap(turn => turn.items.filter(item => item?.type === "userMessage"
    && item.clientId === operationId).map(() => turn));
  if (matches.length !== 1 || matches[0].id !== ref.turnId || matches[0].status !== "completed") throw failure();
  const answers = matches[0].items.filter(item => item?.type === "agentMessage" && item.delivery !== "async");
  const answer = [...answers].reverse().find(item => item.phase === "final_answer")
    ?? [...answers].reverse().find(item => item.phase == null);
  if (!answer || answer.contextIncomplete || !validText(answer.text) || !answer.text.trim()
    || Buffer.byteLength(answer.text) > 8 * 1024 * 1024) throw failure();
  const accepted = assertSecretSafe({ text: answer.text }, Object.freeze({ runId: run.id, type: "text", kind: "fullText" }));
  if (accepted === false || accepted?.then) throw failure();
  fence();
  // A stream callback may have committed the answer while history was read.
  if (transcriptStore.listEvents(run.profileId, session.id).some(event => {
    if (event.runId !== run.id || event.kind !== "assistant") return false;
    try {
      const content = transcriptStore.displayEvent(run.profileId, session.id, event).content;
      return content.delivery !== "async" && (content.phase === "final_answer" || content.phase == null)
        && validText(content.text) && content.text.trim();
    } catch { return false; }
  })) return;
  transcriptStore.appendEvent({ profileId: run.profileId, sessionId: session.id, runId: run.id,
    id: transcriptEventId("group-result-recovery", run.id, ref.turnId), kind: "assistant",
    content: { text: answer.text, phase: "final_answer", transcriptType: "text", recovered: true,
      ...(refs.length ? { borrowedMemoryRefs: refs, borrowedMemoryDerived: true } : {}) },
    ...(refs.length ? { borrowedMemoryProjection: { refs, derived: true } } : {}),
    runtimeRef: ref, contextExcluded: false, occurredAt: run.finishedAt });
}

module.exports = { recoverGroupNativeResult };
