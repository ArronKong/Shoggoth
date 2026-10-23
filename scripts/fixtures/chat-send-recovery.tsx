import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

declare const __UPSTREAM_ERROR__: string;
declare const __PUBLIC_FAILURE_CODE__: string;
const query = new URLSearchParams(location.search), scenario = query.get("scenario") || "restored";
const backend = query.get("backend") || "openclaw", reloaded = query.has("reload");
const legacyRecovery = scenario.startsWith("legacy-");
const observerLoop = scenario.startsWith("legacy-observer-loop");
const ordinaryRecovery = scenario.startsWith("ordinary-recovery-");
const nativeActiveRecovery = scenario.startsWith("native-active-");
const nativeRejection = ["native-rejected", "native-rejected-immersive"].includes(scenario);
if (!["slash-order", "slash-order-error", "slash-order-uncertain", "slash-order-immersive", "slash-order-uncertain-immersive", "upstream-error", "upstream-error-immersive", "uncertain", "restored", "rejected", "ordinary", "newer", "started", "accepted-error", "accepted-uncertain", "stale-query", "reselect", "terminal-race", "terminal-timeout", "terminal-reload", "ordinary-upstream", "ordinary-receipt", "ordinary-buffered", "ordinary-buffered-immersive", "observer-idle", "observer-idle-pending", "native-approval", "native-approval-immersive", "observer-idle-terminal", "runtime-abort", "runtime-abort-immersive", "runtime-snapshot", "runtime-abort-pending", "silent-queue", "silent-queue-immersive"].includes(scenario)
  && !nativeRejection && !legacyRecovery && !nativeActiveRecovery && !ordinaryRecovery || !["shoggoth", "openclaw", "hermes"].includes(backend)) throw Error("invalid fixture scope");
const key = `agent:${backend}-recovery-fixture:11111111-1111-4111-8111-111111111111`, agentId = key.split(":")[1];
const originalOperation = "original-operation-fixture", originalText = "Use this selected plugin exactly once";
const captured = [{ installationId: "selected-fixture", revision: 1 }], selection = scenario === "newer"
  ? [{ installationId: "selected-fixture", revision: 2 }] : captured;
const storageKey = "shoggoth.chat.pending-native-sends.v1", selectedKey = "shoggoth.chat.plugin-selection.v1";
const sessions = [{ key, agentId, agentName: `${backend} recovery fixture`, backendId: backend, model: "fixture-model", updatedAt: Date.now(),
  ...(nativeRejection || legacyRecovery ? { kind: "cron" } : {}) }];
const sent: Array<any> = [], observed: Array<any> = [], sockets = new Set<FixtureSocket>();
let lookup: any = scenario === "restored" ? { status: "found", admissionAccepted: true, run: { status: "needs_verification" } }
  : scenario === "newer" ? { status: "found", admissionAccepted: true, run: { status: "running" } } : { status: "not_found" };
const reconciliations: any[] = [];
let releaseRecovery: (() => void) | null = null;
if (nativeActiveRecovery) lookup = { status: "found", stateAuthority: "native-service", run: { status: "running" } };
if (legacyRecovery) lookup = { status: "unresolved", run: null, canReconcile: true };
if (scenario.startsWith("ordinary-recovery-reload")) lookup = { status: "found", stateAuthority: "openclaw",
  admissionAccepted: true, run: { id: originalOperation, sessionKey: key, status: "completed" } };
let history: Array<any> = [], releaseLookup: (() => void) | null = null, historyReads = 0, lookupUnavailable = false;
const buffered = scenario.startsWith("ordinary-buffered"), immersive = scenario.endsWith("-immersive");
const upstreamFailure = scenario.startsWith("upstream-error");
const nativeApproval = scenario.startsWith("native-approval");
const runtimeTerminal = scenario.startsWith("runtime-");
const silentQueue = scenario.startsWith("silent-queue");
const slashOrder = scenario.startsWith("slash-order");
const slashRequests: Array<{ body: any; reply: (response: Response) => void }> = [];
if (scenario === "runtime-abort-pending") lookup = { status: "found", run: { status: "running" } };
if (nativeApproval) {
  lookup = { status: "found", run: { status: "waiting_approval" } };
  history = [{ role: "user", content: "读取 https://example.com", timestamp: Date.now() - 60_000 }];
}
const upstreamHistory = () => [
  { role: "user", content: "hi", timestamp: Date.now() - 60_000 },
  { role: "system", content: [{ type: "text", text: `错误：${__UPSTREAM_ERROR__}` }], timestamp: Date.now() - 50_000 },
];
if (upstreamFailure && reloaded) history = upstreamHistory();
const repeatedText = "你再随便创建 3 个";
if (buffered) history = [{ role: "user", content: repeatedText, timestamp: Date.now() - 60_000,
  idempotencyKey: "older-operation:user", __openclaw: { id: "older-user" } },
  { role: "assistant", content: "上一轮的回复", timestamp: Date.now() - 50_000 }];
if (scenario.startsWith("observer-idle")) history = [
  { role: "user", content: "已完成的请求", timestamp: Date.now() - 60_000 },
  { role: "assistant", content: "已完成的最终回复", timestamp: Date.now() - 50_000 },
];
if (reloaded && scenario === "terminal-reload") lookup = { status: "found", admissionAccepted: true, run: { status: "running" } };
if (scenario === "stale-query") lookup = { status: "found", admissionAccepted: true, run: { status: "running" } };
if (legacyRecovery) history = [{ role: "assistant", content: "原 Cron 任务已完成", timestamp: Date.now() - 3600000 }];
if (!reloaded) {
  localStorage.clear();
  localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
  localStorage.setItem("shoggoth.chat.lastActive.v1", key);
  localStorage.setItem("shoggoth.chat.immersive.v1", immersive ? "1" : "0");
  if (scenario.startsWith("ordinary-recovery-reload")) localStorage.setItem(storageKey, JSON.stringify([
    { key, idem: originalOperation, at: Date.now() - 3600000, backendId: backend, terminalObserved: true },
  ]));
  if (!scenario.startsWith("ordinary") && !silentQueue && !upstreamFailure && !slashOrder && !nativeRejection && !legacyRecovery) localStorage.setItem(selectedKey, JSON.stringify({ [key]: selection }));
  if (legacyRecovery || nativeActiveRecovery) localStorage.setItem(storageKey, JSON.stringify([{ key, idem: originalOperation,
    at: Date.now() - 3600000, backendId: backend, terminalObserved: true,
    ...(scenario === "legacy-accepted" || nativeActiveRecovery ? { accepted: true } : {}) }]));
  if (scenario === "restored" || scenario === "newer" || scenario === "stale-query" || scenario === "observer-idle-pending"
    || nativeApproval || scenario === "observer-idle-terminal" || scenario === "runtime-abort-pending") localStorage.setItem(storageKey,
    JSON.stringify([{ key, idem: originalOperation, at: Date.now(), selection: captured,
      ...(nativeApproval || scenario === "observer-idle-terminal" || scenario === "runtime-abort-pending" ? { backendId: backend, accepted: true } : {}) }]));
}
if (scenario === "native-active-storage-failure") {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (name, value) {
    if (name === storageKey) throw new DOMException("Fixture quota exceeded", "QuotaExceededError");
    return setItem.call(this, name, value);
  };
}
void i18n.changeLanguage("zh-CN");
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { sockets.add(this); setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const frame = JSON.parse(raw); let payload: unknown = {};
    if (frame.method === "sessions.list") payload = { sessions, hasMore: false };
    if (frame.method === "agents.list") payload = { agents: [{ id: agentId, name: sessions[0].agentName, backendId: backend }] };
    if (frame.method === "models.list") payload = { models: [{ id: "fixture-model", name: "Fixture", provider: "fixture" }] };
    if (frame.method === "chat.history") { historyReads += 1; payload = { messages: history,
      hasMore: false, nextCursor: null, sourceId: `fixture-${key}` };
      if (observerLoop) setTimeout(() => this.emit({ type: "event", event: "chat",
        payload: { sessionKey: key, state: "status", statusKind: "idle", text: "idle" } }), 5);
    }
    if (frame.method === "chat.operation.get") {
      observed.push(frame.params); payload = lookup;
      if (backend === "openclaw") {
        const original = JSON.parse(localStorage.getItem(storageKey) || "[]").find((item: any) => item.idem === frame.params.idempotencyKey);
        if (original && frame.params.operationKind !== (original.selection?.length ? "plugin-selection" : "chat")) {
          throw Error("original operation queried through the wrong recovery protocol");
        }
      }
      if (lookupUnavailable) {
        setTimeout(() => this.emit({ type: "res", id: frame.id, ok: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "Service restarting" } }), 0); return;
      }
      if (scenario === "stale-query" || scenario === "native-active-stale") {
        const captured = payload;
        releaseLookup = () => this.emit({ type: "res", id: frame.id, ok: true, payload: captured });
        return;
      }
    }
    if (frame.method === "chat.operation.reconcile") {
      reconciliations.push(frame.params);
      if (observerLoop) {
        setTimeout(() => this.emit({ type: "res", id: frame.id, ok: true,
          payload: { status: "unresolved", run: null } }), 0); return;
      }
      releaseRecovery = () => this.emit(scenario === "legacy-unavailable"
        ? { type: "res", id: frame.id, ok: false, error: { code: "BACKEND_NOT_READY", message: "Cannot prove receipt" } }
        : { type: "res", id: frame.id, ok: true, payload: { status: scenario === "legacy-unresolved" ? "unresolved" : "not_admitted", run: null } });
      return;
    }
    if (frame.method === "chat.send") {
      sent.push(frame.params);
      if (ordinaryRecovery && sent.length === 1 && !scenario.startsWith("ordinary-recovery-reload")) {
        setTimeout(() => this.emit({ type: "res", id: frame.id, ok: false, error: {
          code: "UPSTREAM_NEEDS_VERIFICATION", message: "Fixture lost original ACK", receiptUncertain: true,
        } }), 0); return;
      }
      if (scenario === "uncertain") {
        // OpenClaw/native: an actual socket close loses the ACK. Hermes: explicit
        // uncertainty survives the RPC error parser instead of becoming retryable.
        if (backend !== "hermes") { setTimeout(() => this.close(), 0); return; }
        setTimeout(() => this.emit({ type: "res", id: frame.id, ok: false,
          error: { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION", message: "Receipt uncertain" } }), 0); return;
      }
      if (scenario === "ordinary-upstream" || scenario === "ordinary-receipt") {
        setTimeout(() => this.emit({ type: "res", id: frame.id, ok: false, error: {
          code: scenario === "ordinary-upstream" ? "UPSTREAM_NEEDS_VERIFICATION" : "ORDINARY_TRANSPORT_ERROR",
          message: "Dispatched ordinary receipt uncertain", receiptUncertain: true,
          admissionAccepted: false, requestNotSent: true } }), 0); return;
      }
      if (scenario === "rejected" || scenario === "ordinary") {
        setTimeout(() => this.emit({ type: "res", id: frame.id, ok: false, error: {
          code: scenario === "rejected" ? "PLUGIN_SELECTION_UNAVAILABLE" : "ORDINARY_CHAT_ERROR", message: "Fixture refused" } }), 0); return;
      }
      payload = { status: "started" };
    }
    setTimeout(() => this.emit({ type: "res", id: frame.id, ok: true, payload }), 0);
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; sockets.delete(this); this.onclose?.(); }
}
Object.assign(window, { WebSocket: FixtureSocket });
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href); let payload: unknown = {};
  if (slashOrder && url.pathname === "/__api/chat/slash/exec") {
    return new Promise<Response>(reply => slashRequests.push({ body: JSON.parse(String(init?.body)), reply }));
  }
  if (url.pathname === "/__api/plugins") payload = { page: { supported: true, catalogRevision: "a".repeat(64), nextCursor: null,
    items: [{ installationId: "selected-fixture", revision: selection[0].revision, packageName: "Selected fixture",
      declaredVersion: "1.0", sourceKind: "bundled", desiredState: "enabled", diagnosticCount: 0,
      components: [{ componentId: "fixture-skill", kind: "skill", title: "Fixture skill", state: "ready" }] }] } };
  if (url.pathname === "/__api/plugins/selection-readiness") payload = { version: 1, supported: url.searchParams.get("backend") === "shoggoth" };
  if (url.pathname === "/__api/plugins/bundled") payload = { batchDigest: "a".repeat(64), items: [] };
  if (url.pathname === "/__api/status") payload = { backends: ["shoggoth", "openclaw", "hermes"].map(id =>
    ({ id, connected: true, info: { readyAgentIds: [agentId] } })) };
  if (url.pathname === "/__api/backends") payload = { backends: ["shoggoth", "openclaw", "hermes"].map(id =>
    ({ id, surfaces: { agentHarness: true, chat: true } })) };
  if (url.pathname === "/__api/models") payload = { models: [{ id: "fixture-model", name: "Fixture", provider: "fixture", backendId: backend }] };
  if (url.pathname === "/__api/chat/capabilities") payload = { attachments: {}, slash: slashOrder, maxPromptBytes: 61440 };
  if (url.pathname === "/__api/chat/slash") payload = { supported: slashOrder, commands: slashOrder
    ? [{ name: "compress", description: "Compress context", source: "Hermes", execution: "runtime" }] : [] };
  if (url.pathname === "/__api/chat/cache-scope") payload = { backendId: backend, cacheScope: `recovery-fixture-${scenario}` };
  if (url.pathname.endsWith("/archive")) payload = { archive: { supported: false, segments: [] } };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 9_000;
  while (!predicate()) { if (Date.now() > deadline) throw Error(`timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const input = () => Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea"))
  .find(element => element.getBoundingClientRect().height > 0)!;
const pending = () => JSON.parse(localStorage.getItem(storageKey) || "[]");
const chosen = () => JSON.parse(localStorage.getItem(selectedKey) || "{}")[key] || [];
const banner = () => document.querySelector(".chat-verification-banner");
const setInput = async (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
  input().dispatchEvent(new Event("input", { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 40));
};
const enter = () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
const emit = (payload: any) => { for (const socket of sockets) socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, ...payload } }); };
const clickVerify = () => document.querySelector<HTMLButtonElement>(".chat-verification-banner button")!.click();
Object.assign(window, { runChatSendRecoveryFixture: async () => {
  await wait(() => input() && sockets.size > 0, "actual ChatPage composer");
  await new Promise(resolve => setTimeout(resolve, 120));
  if (ordinaryRecovery) {
    if (reloaded) {
      check(pending().length === 0 && !banner() && sent.length === 0, "resolved ordinary operation returned or replayed on reload");
      return { scenario, backend, reloaded: true, recoveredStatePersisted: true, noReplay: true };
    }
    let idem = originalOperation;
    if (scenario.startsWith("ordinary-recovery-reload")) {
      await wait(() => observed.length > 0 && pending().length === 0 && !banner(), "existing terminal pending record automatically recovered");
      check(sent.length === 0, "old pending record was replayed");
    } else {
      await setInput("Original ordinary message"); enter();
      await wait(() => sent.length === 1 && banner() && observed.length > 0, "ordinary lost ACK safely tracked");
      idem = sent[0].idempotencyKey;
      if (scenario.startsWith("ordinary-recovery-late-ack")) {
        const before = observed.length;
        lookup = { status: "found", run: { id: idem, sessionKey: key, status: "running" } };
        for (const socket of sockets) socket.emit({ type: "event", event: "chat.operation.accepted", payload: { sessionKey: key, runId: idem } });
        await wait(() => observed.length > before && !banner() && pending()[0]?.accepted, "late accepted event rechecks the original automatically");
        check(sent.length === 1, "late ACK replayed original send");
      }
      lookup = { status: "found", stateAuthority: "openclaw", admissionAccepted: true,
        run: { id: idem, sessionKey: key, status: "completed" } };
      history = [{ role: "user", content: "Original ordinary message", idempotencyKey: `${idem}:user` },
        { role: "assistant", content: "Original answer completed", stopReason: "stop", __openclaw: { runId: idem } }];
      emit({ runId: idem, state: "final", message: history[1] });
      await wait(() => pending().length === 0 && !banner(), "exact original completion automatically unlocks composer");
    }
    check(observed.every(item => item.operationKind === "chat" && item.sessionKey === key && item.idempotencyKey === idem),
      "ordinary recovery used plugin or different operation identity");
    const before = sent.length;
    await setInput("Next fresh message after recovery"); enter();
    await wait(() => sent.length === before + 1 && input().value === "", "composer sends next message normally");
    check(sent.at(-1).idempotencyKey !== idem && !sent.at(-1).pluginSelection, "new user intent reused the original or gained a plugin");
    emit({ runId: sent.at(-1).idempotencyKey, state: "final", message: { role: "assistant", content: "Next reply" } });
    return { scenario, backend, immersive, originalRecovered: true, nextMessageSent: true,
      originalSends: before, noReplay: true, ordinaryProtocol: true };
  }
  if (scenario === "native-active-stale") {
    await wait(() => observed.length > 0 && releaseLookup, "delayed native Service lookup");
    emit({ runId: originalOperation, agentId, backendId: backend, state: "status", statusKind: "needs_verification" });
    await new Promise(resolve => setTimeout(resolve, 50)); releaseLookup?.();
    await new Promise(resolve => setTimeout(resolve, 100));
    check(banner() && pending()[0]?.terminalObserved && !document.querySelector(".chat-stop"),
      "old native receipt cleared a newer uncertainty or reopened generation");
    check(sent.length === 0, "stale native lookup replayed the original request");
    return { scenario, backend, sent: 0, newerUncertaintySupersedesOldLookup: true };
  }
  if (scenario === "native-active-storage-failure") {
    await wait(() => observed.length > 0 && banner(), "native recovery cannot persist its marker change");
    await setInput("保留的新草稿"); enter();
    await new Promise(resolve => setTimeout(resolve, 150));
    check(pending()[0]?.terminalObserved && !document.querySelector(".chat-stop")
      && sent.length === 0 && input().value === "保留的新草稿", "failed recovery write released the send fence");
    return { scenario, backend, sent: 0, durableWriteFailureRetainsFence: true };
  }
  if (nativeActiveRecovery) {
    await wait(() => observed.length > 0 && !banner() && document.querySelector(".chat-stop"), "native active receipt replaces the persisted terminal hint");
    check(pending()[0]?.idem === originalOperation && pending()[0]?.accepted && !pending()[0]?.terminalObserved,
      "active recovery lost the original send fence or retained the old terminal hint");
    check(sent.length === 0 && reconciliations.length === 0, "active recovery resent or rejected the admitted task");
    if (!reloaded) {
      await setInput("保留的新草稿");
      for (const status of ["queued", "running", "waiting_approval"]) {
        lookup = { status: "found", stateAuthority: "native-service", run: { status } };
        const reads = observed.length;
        emit({ runId: originalOperation, agentId, backendId: backend, state: "error", errorMessage: "Old observer ended" });
        await wait(() => observed.length > reads && !banner() && !pending()[0]?.terminalObserved
          && document.querySelector(".chat-stop"), `recover authoritative native ${status}`);
        check(sent.length === 0 && input().value === "保留的新草稿", "active lookup changed the draft or replayed chat.send");
      }
    }
    return { scenario, backend, reloaded, activeRestored: true, originalOperationPreserved: true, noReplay: true };
  }
  if (legacyRecovery) {
    if (reloaded) {
      check(pending().length === 0 && !banner() && sent.length === 0 && reconciliations.length === 0,
        "resolved legacy observation returned after full reload");
      return { scenario, backend, reloaded, noReplay: true, resolvedPersists: true };
    }
    await wait(() => banner() && observed.length > 0, "old observation is restored");
    await setInput("保留的新草稿");
    if (observerLoop) {
      // Restored terminal hints retain their three bounded 100/400/1600 ms
      // retries. Once those finish, idle/history must not keep polling itself.
      await new Promise(resolve => setTimeout(resolve, 2400));
      const reads = historyReads, checks = observed.length;
      await new Promise(resolve => setTimeout(resolve, 200));
      check(historyReads === reads && observed.length === checks,
        `unresolved lookup and history idle observer formed a refresh loop: history ${reads}->${historyReads}, lookup ${checks}->${observed.length}`);
      check(pending().length === 1 && banner() && sent.length === 0 && input().value === "保留的新草稿",
        "unknown original was unlocked, replayed or changed the draft");
      clickVerify();
      await wait(() => observed.length > checks, "manual verification remains available");
      return { scenario, backend, immersive, boundedObservation: true, noReplay: true, historyReads, observations: observed.length };
    }
    if (scenario === "legacy-accepted") {
      check(reconciliations.length === 0 && pending()[0]?.accepted && sent.length === 0,
        "accepted original entered non-admission recovery");
      return { scenario, backend, acceptedPreserved: true, noReplay: true };
    }
    await wait(() => releaseRecovery, "owner recovery request");
    check(reconciliations.every(item => item.sessionKey === key && item.idempotencyKey === originalOperation
      && item.createdAt === pending()[0].at), "recovery changed the original owner, key or timestamp");
    if (scenario === "legacy-late-accepted") {
      emit({ runId: originalOperation, agentId, backendId: backend, state: "accepted" });
      await wait(() => pending()[0]?.accepted, "acceptance during pending reconciliation");
    }
    releaseRecovery!();
    const retained = ["legacy-unavailable", "legacy-unresolved", "legacy-late-accepted"].includes(scenario);
    if (retained) {
      await new Promise(resolve => setTimeout(resolve, 160));
      check(pending().length === 1 && banner(), "unproven or accepted operation was released");
    } else {
      await wait(() => pending().length === 0 && !banner() && !document.querySelector(".chat-stop"), "durable rejection unlocks old session");
      const button = document.querySelector<HTMLButtonElement>(`[data-send-entry="${immersive ? "immersiveButton" : "composerButton"}"]`);
      check(button && !button.disabled, "composer still cannot send after confirmed recovery");
    }
    check(sent.length === 0 && input().value === "保留的新草稿" && document.body.innerText.includes("原 Cron 任务已完成"),
      "recovery replayed the old input or changed draft/history");
    return { scenario, backend, immersive, retained, noReplay: true, newDraftPreserved: true, historyPreserved: true };
  }
  if (slashOrder) {
    const later = "你先修复Hermes的", resultText = "slash-order-result";
    const sendButton = () => document.querySelector<HTMLButtonElement>(`[data-send-entry="${immersive ? "immersiveButton" : "composerButton"}"]`);
    await setInput("/compress");
    await wait(() => sendButton() && !sendButton()!.disabled, "slash composer readiness");
    sendButton()!.click();
    await wait(() => slashRequests.length === 1 && document.body.innerText.includes("/compress"), "command is visible before its RPC returns");
    check(slashRequests[0].body.text === "/compress" && slashRequests[0].body.sessionKey === key, "command owns the original session");
    await setInput(later);
    await wait(() => !sendButton()!.disabled, "later message composer readiness");
    sendButton()!.click();
    await wait(() => sent.length === 1 && document.body.innerText.includes(later), "later normal message is sent during compression");
    const readsBefore = historyReads;
    history = [{ role: "user", content: later, timestamp: Date.now() },
      { role: "assistant", content: "已开始检查 Hermes", timestamp: Date.now() + 1 }];
    emit({ runId: sent[0].idempotencyKey, state: "final", message: history[1] });
    await wait(() => historyReads > readsBefore && document.body.innerText.includes("已开始检查 Hermes"), "canonical history refresh during slash execution");
    check(document.body.innerText.includes("/compress"), "history refresh dropped the submitted command");
    const failed = scenario.includes("error"), uncertain = scenario.includes("uncertain");
    slashRequests[0].reply(new Response(JSON.stringify(failed ? { error: resultText }
      : { kind: "output", text: resultText, executionUncertain: uncertain }),
    { status: failed ? 500 : 200, headers: { "Content-Type": "application/json" } }));
    await wait(() => document.body.innerText.includes(resultText), "command outcome is rendered");
    // content-visibility can omit an offscreen bubble from innerText; DOM text
    // preserves the actual message order independently of the scroll anchor.
    const surface = document.querySelector(immersive ? '[data-testid="immersive-chat"]' : ".chat-thread");
    const body = surface?.textContent || "";
    check(body.indexOf("/compress") < body.indexOf(resultText) && body.indexOf(resultText) < body.indexOf(later), "completion reordered the original command or attached its output to the later turn");
    check(body.split("/compress").length === 2, "command echoed more than once");
    check(!surface?.querySelector(`button[title="${i18n.t("chat.retry")}"]`), "local command output must not become a failed model turn with a retry button");
    check(!uncertain || body.includes("命令结果尚未确认") && !body.includes("命令执行失败"), "uncertain execution is falsely reported as failed");
    check(slashRequests.length === 1 && sent.length === 1, "command or user message was replayed");
    return { scenario, backend, immersive, immediateEcho: true, orderPreserved: true,
      historyRefresh: true, failed, uncertain, noReplay: true, historyReads };
  }
  if (upstreamFailure) {
    check(__UPSTREAM_ERROR__.length > 20 && !__UPSTREAM_ERROR__.includes("RUNTIME_"), "public failure message explains the cause");
    if (!reloaded) {
      await setInput("hi"); enter();
      await wait(() => sent.length === 1 && document.querySelector(".chat-stop"), "accepted upstream request");
      const runId = sent[0].idempotencyKey;
      lookup = { status: "found", admissionAccepted: true, run: { status: "failed", errorCode: __PUBLIC_FAILURE_CODE__ } };
      history = upstreamHistory();
      emit({ runId, agentId, backendId: backend, state: "error",
        errorCode: __PUBLIC_FAILURE_CODE__, errorMessage: __UPSTREAM_ERROR__ });
    }
    await wait(() => document.body.innerText.includes(__UPSTREAM_ERROR__) && !document.querySelector(".chat-stop"),
      "upstream error is visible after terminal or reload");
    check(!document.body.innerText.includes("RUNTIME_TURN_FAILED"), "generic failure is not displayed");
    check(sent.length === (reloaded ? 0 : 1), "the failed request is never replayed");
    return { scenario, backend, immersive, reloaded, sent: sent.length,
      upstreamMessage: __UPSTREAM_ERROR__, errorCode: __PUBLIC_FAILURE_CODE__, noReplay: true, historyReads };
  }
  if (silentQueue) {
    await setInput("制作一份新报告"); enter();
    await wait(() => sent.length === 1, "one submitted report request");
    const runId = sent[0].idempotencyKey;
    emit({ runId, state: "status", statusKind: "queued", reason: "CHAT_SESSION_BUSY", queuedAt: Date.now() - 24000 });
    await wait(() => document.querySelector(".chat-stop"), "queued original remains active");
    await new Promise(resolve => setTimeout(resolve, 150));
    check(!document.querySelector('[data-testid="chat-run-wait"][data-kind="queued"]'), "brief queue is still visible in chat");
    check(!document.body.innerText.includes("当前会话正在执行"), "queue reason remains visible");
    emit({ runId, state: "status", statusKind: "running" });
    history = [{ role: "user", content: "制作一份新报告", timestamp: Date.now() - 1000 },
      { role: "assistant", content: "新报告已经生成", timestamp: Date.now() }];
    emit({ runId, state: "final", message: history[1] });
    await wait(() => document.body.innerText.includes("新报告已经生成") && !document.querySelector(".chat-stop"), "original automatically finishes after silent wait");
    check(sent.length === 1 && pending().length === 0, "silent queue replayed or lost the original request");
    return { scenario, backend, immersive, silentQueue: true, originalContinues: true, noReplay: true };
  }
  if (runtimeTerminal) {
    const nativeRunId = "native-current-run";
    const thinking = () => document.querySelector(".chat-agent.is-active")?.textContent?.includes(i18n.t("chat.liveStatus.running"));
    const lifecycle = (runId: string, data: object) => {
      for (const socket of sockets) socket.emit({ type: "event", event: "agent", payload: {
        sessionKey: key, runId, stream: "lifecycle", data,
        ...(scenario === "runtime-abort-pending" ? { clientRunId: originalOperation } : {}),
      } });
    };
    emit({ runId: nativeRunId, state: "thinking", text: "正在检索报告资料" });
    for (const socket of sockets) socket.emit({ type: "event", event: "agent", payload: {
      sessionKey: key, runId: nativeRunId, stream: "tool",
      data: { toolCallId: "report-command", phase: "start", name: "exec", args: { command: "fixture" } },
    } });
    await wait(() => thinking() && document.querySelector(".chat-stop"), "delegated tool execution visible");
    lifecycle("native-old-run", { phase: "end", aborted: true });
    lifecycle(nativeRunId, { phase: "error", error: "temporary retry", retryable: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    check(thinking() && document.querySelector(".chat-stop"), "stale or retryable lifecycle stopped the current turn");
    if (scenario === "runtime-snapshot") {
      for (const socket of sockets) socket.emit({ type: "event", event: "sessions.changed", payload: {
        sessionKey: key, runId: nativeRunId, phase: "end",
        session: { key, status: "killed", hasActiveRun: false, lastRunId: nativeRunId },
      } });
    } else {
      if (scenario === "runtime-abort-pending") lookupUnavailable = true;
      lifecycle(nativeRunId, { phase: "end", aborted: true, stopReason: "aborted" });
    }
    await wait(() => !thinking() && !document.querySelector(".chat-stop"), "native abort retires generation UI without chat final");
    if (scenario === "runtime-abort-pending") {
      await wait(() => banner(), "exact original receipt still needs verification");
      check(pending()[0]?.idem === originalOperation, "abort hint forgot original send before verification");
      await setInput("must not replay while uncertain"); enter();
      await new Promise(resolve => setTimeout(resolve, 100));
      check(sent.length === 0, "terminal hint bypassed original-send protection");
      lookupUnavailable = false; lookup = { status: "found", run: { status: "interrupted" } };
      for (const socket of sockets) socket.emit({ type: "event", event: "agents.changed", payload: { backendId: backend } });
      await wait(() => pending().length === 0 && !banner(), "exact durable interruption settles original send");
    }
    check(sent.length === 0, "recovery replayed the task");
    return { scenario, backend, immersive, stoppedWithoutChatFinal: true, staleRunIgnored: true,
      retryableErrorIgnored: true, pendingReceiptPreserved: scenario === "runtime-abort-pending", noReplay: true };
  }
  if (nativeApproval) {
    await wait(() => observed.length > 0, "restored original operation");
    emit({ runId: "native-observer-run", state: "prompt", prompt: {
      version: 1, requestId: "native-url-approval", runId: "native-product-run", kind: "runtime_approval",
      title: "需要授权", message: "需要用户授权", fields: [], expiresAt: null,
      approvalChoices: ["runtime:0", "once", "deny", "cancel"], approvalOptions: [
        { choice: "runtime:0", kind: "allow_always", label: "Allow Always (risky) — Allowing always can be risky" },
        { choice: "once", kind: "allow_once", label: "Allow" },
        { choice: "deny", kind: "reject_once", label: "Deny" },
      ], approvalDetails: { kind: "command", toolName: "read_url_content", cwd: "/tmp/fixture-workspace",
        input: JSON.stringify({ url: "https://example.com" }) },
    } });
    const card = () => document.querySelector<HTMLElement>(".chat-prompt--approval");
    await wait(() => card()?.getBoundingClientRect().height && card()!.innerText.includes("https://example.com"), "visible native URL approval card");
    check(card()!.querySelector(".chat-prompt__btn.is-primary"), "native allow-once option is unavailable");
    check(card()!.querySelector(".chat-prompt__risk"), "native always-allow risk missing");
    lookupUnavailable = true;
    history = [...history, { role: "system", content: "错误：原生 Runtime 已重启，本次任务已中断", timestamp: Date.now() }];
    emit({ runId: "native-observer-run", state: "error", errorCode: "RUNTIME_HOST_RESTARTED", errorMessage: "原生 Runtime 已重启，本次任务已中断" });
    await wait(() => banner() && observed.length >= 2, "terminal lookup failed during restart");
    check(pending()[0]?.idem === originalOperation, "uncertain original was prematurely forgotten");
    lookupUnavailable = false; lookup = { status: "found", run: { status: "interrupted" } };
    for (const socket of sockets) socket.emit({ type: "event", event: "agents.changed", payload: { backendId: backend } });
    await wait(() => pending().length === 0 && !banner() && !document.querySelector(".chat-stop"), "backend recovery confirms interrupted original");
    await wait(() => document.body.innerText.includes("原生 Runtime 已重启"), "canonical interrupted history");
    check(!document.querySelector(".chat-agent.is-active")?.textContent?.includes(i18n.t("chat.liveStatus.running")), "interrupted original still looks active");
    check(!document.querySelector(".chat-prompt__actions"), "ended native approval remains actionable");
    check(sent.length === 0 && observed.every(item => item.sessionKey === key && item.idempotencyKey === originalOperation), "recovery replayed or changed the original");
    return { scenario, backend, immersive, sent: 0, nativeApprovalVisible: true, recoveredInterruptedOriginal: true, noReplay: true };
  }
  if (scenario.startsWith("observer-idle")) {
    await wait(() => document.body.innerText.includes("已完成的最终回复"), "completed canonical history");
    const thinking = () => document.querySelector(".chat-agent.is-active")?.textContent?.includes(i18n.t("chat.liveStatus.running"));
    emit({ state: "status", statusKind: "running" });
    await wait(() => thinking() && document.querySelector(".chat-stop"), "restored running controls");
    emit({ state: "status", statusKind: "needs_verification" });
    await wait(() => banner(), "observer uncertainty banner");
    if (scenario === "observer-idle-terminal") lookup = { status: "found", run: { status: "interrupted" } };
    emit({ state: "status", statusKind: "idle" });
    if (scenario === "observer-idle-pending") {
      await new Promise(resolve => setTimeout(resolve, 100));
      check(banner() && pending()[0]?.idem === originalOperation, "idle cannot settle an uncertain original operation");
      await setInput("Never replay this uncertain operation"); enter();
      await new Promise(resolve => setTimeout(resolve, 100));
      check(sent.length === 0 && input().value.includes("Never"), "idle allowed an uncertain send to replay");
      return { scenario, backend, sent: 0, originalOperationPreserved: true, idleDoesNotSettleReceipt: true };
    }
    await wait(() => !banner() && !thinking() && !document.querySelector(".chat-stop"), "idle clears banner and generation controls");
    check(pending().length === 0 && sent.length === 0 && document.body.innerText.includes("已完成的最终回复"), "idle changed the completed answer or sent a task");
    check(!/\bidle\b/.test(document.body.innerText), "idle observation must not add a visible execution step");
    return { scenario, backend, sent: 0, idleClearsThinking: true, idleClearsVerification: true, finalAnswerPreserved: true };
  }
  if (buffered) {
    const userCount = () => Array.from(document.querySelectorAll(immersive ? "[data-user-row]" : ".chat-thread .chat-bubble"))
      .filter(element => immersive || element.closest(".is-user"))
      .reduce((count, element) => count + (element.textContent || "").split(repeatedText).length - 1, 0);
    await wait(() => userCount() === 1, "older identical prompt in canonical history");
    for (let index = 0; index < 3; index += 1) {
      await setInput(repeatedText); enter();
      await wait(() => sent.length === index + 1 && userCount() === index + 2, "optimistic buffered prompt");
      if (!immersive && index === 0) {
        const readsBefore = historyReads;
        document.querySelector<HTMLButtonElement>(".chat-agent.is-active")!.click();
        await wait(() => historyReads > readsBefore, "reopen live session snapshot");
        await new Promise(resolve => setTimeout(resolve, 180));
        check(userCount() === 2, "reopening a running session duplicated its local prompt");
      }
      const readsBefore = historyReads;
      // A previous run finishes before the newly accepted input is persisted.
      emit({ runId: `previous-run-${index}`, state: "final",
        message: { role: "assistant", content: "上一轮的回复" } });
      await wait(() => historyReads > readsBefore, "old-run terminal history refresh");
      await new Promise(resolve => setTimeout(resolve, 180));
      check(userCount() === index + 2, `buffered prompt ${index + 1} disappeared during history refresh`);
      if (!immersive) {
        const readsBefore = historyReads;
        document.querySelector<HTMLButtonElement>(".chat-agent.is-active")!.click();
        await wait(() => historyReads > readsBefore, "reopen stale persisted cache");
        await new Promise(resolve => setTimeout(resolve, 180));
        check(userCount() === index + 2, "reopening cached history removed a buffered prompt");
      }
    }
    for (let index = 0; index < sent.length; index += 1) {
      const idem = sent[index].idempotencyKey;
      history = [...history, { role: "user", content: repeatedText, timestamp: Date.now(),
        ...(index === 0 ? { idempotencyKey: `${idem}:user` } : {}),
        __openclaw: { id: `persisted-user-${index}`, ...(index > 0 ? { idempotencyKey: `${idem}:user` } : {}) } },
        { role: "assistant", content: `第 ${index + 1} 轮回复`, timestamp: Date.now() }];
      const readsBefore = historyReads;
      emit({ runId: `resumed-run-${index}`, state: "final", message: history.at(-1) });
      await wait(() => historyReads > readsBefore, "persisted history refresh");
      await new Promise(resolve => setTimeout(resolve, 180));
      check(userCount() === 4, "canonical confirmation duplicated or removed a repeated prompt");
    }
    check(sent.length === 3, "history reconciliation replayed a buffered input");
    return { scenario, backend, immersive, sent: 3, visibleWhileBuffered: true,
      exactIdentityConfirmation: true, noDuplicate: true, noResend: true, reopenWhileBuffered: !immersive };
  }
  if (reloaded) {
    await wait(() => banner() && observed.length > 0, "reload observation");
    check(sent.length === 0, "reload must never replay chat.send");
    check(observed.every(item => item.idempotencyKey === pending()[0].idem), "reload must observe the original operation");
    if (scenario === "ordinary-upstream" || scenario === "ordinary-receipt") {
      const idem = pending()[0].idem;
      check(pending()[0].backendId === backend && !pending()[0].selection && chosen().length === 0,
        "ordinary original subject changed on reload");
      await setInput("Never replay a dispatched ordinary message"); enter();
      await new Promise(resolve => setTimeout(resolve, 120));
      check(sent.length === 0 && input().value.includes("Never") && banner(), "ordinary uncertainty replayed after reload");
      lookup = { status: "not_found" }; clickVerify();
      await wait(() => observed.length >= 2, "ordinary original remains unknown");
      check(pending()[0]?.idem === idem && banner(), "unknown ordinary operation became retryable");
      lookup = { status: "found", admissionAccepted: true, run: { status: "completed" } }; clickVerify();
      await wait(() => pending().length === 0 && !banner(), "ordinary original durable completion");
      check(sent.length === 0 && observed.every(item => item.idempotencyKey === idem && item.sessionKey === key),
        "ordinary reload minted or observed another operation");
      return { scenario, backend, reloaded: true, sent: 0, originalOperation: idem, ordinaryOriginalPersisted: true,
        notFoundNeverRetryable: true, noReplay: true, exactDurableCompletionOnly: true };
    }
    if (scenario === "terminal-reload") {
      const idem = pending()[0].idem;
      check(pending()[0].terminalObserved === true && pending()[0].backendId === backend, "terminal hint/original backend was not retained");
      check(!document.querySelector(".chat-stop"), "old running receipt reopened Stop after reload");
      await setInput("Do not replay after terminal reload"); enter();
      await new Promise(resolve => setTimeout(resolve, 2400));
      const boundedReads = observed.length;
      await new Promise(resolve => setTimeout(resolve, 500));
      check(observed.length === boundedReads && boundedReads <= 5 && banner() && pending()[0]?.idem === idem
        && sent.length === 0 && !document.querySelector(".chat-stop"), "reload terminal observation replayed or retried without bound");
      lookup = { status: "found", admissionAccepted: true, run: { status: "completed" } }; clickVerify();
      await wait(() => pending().length === 0 && !banner(), "reload manual exact durable terminal verification");
      return { scenario, backend, reloaded: true, sent: 0, originalOperation: idem, persistedTerminalObservation: true,
        stoppedGenerationStaysClosed: true, boundedReads, noReplay: true, manualDurableTerminalResolved: true };
    }
    return { scenario, backend, reloaded: true, sent: sent.length, originalOperation: pending()[0].idem, verificationVisible: true };
  }
  if (scenario === "stale-query") {
    await wait(() => observed.length > 0 && releaseLookup, "delayed original lookup");
    emit({ runId: originalOperation, state: "status", statusKind: "needs_verification" });
    await new Promise(resolve => setTimeout(resolve, 50)); releaseLookup?.();
    await new Promise(resolve => setTimeout(resolve, 100));
    check(banner() && pending()[0]?.idem === originalOperation && !pending()[0]?.accepted,
      "old active response must not clear a newer needs_verification status");
    check(sent.length === 0, "stale observation replayed a message");
    return { scenario, backend, sent: 0, newerUncertaintySupersedesOldLookup: true };
  }
  if (scenario === "restored") {
    await wait(() => banner() && observed.length > 0, "found needs_verification remains visible");
    await wait(() => chosen().length === 0, "exact durable admission consumes restored selection");
    check(pending()[0].idem === originalOperation, "needs_verification must retain original ID");
    await setInput("Do not make a new operation while receipt is uncertain"); enter();
    await new Promise(resolve => setTimeout(resolve, 100));
    check(sent.length === 0 && input().value.includes("Do not"), "uncertain submit must retain input and not send");
    lookup = { status: "found", admissionAccepted: true, run: { status: "completed" } };
    history = [{ role: "user", content: originalText, timestamp: Date.now() }, { role: "assistant", content: "Confirmed existing result", timestamp: Date.now() }];
    clickVerify(); await wait(() => pending().length === 0 && !banner(), "exact completed operation resolves uncertainty");
    check(sent.length === 0, "completion observation must not send");
    return { scenario, backend, sent: 0, foundNeedsVerificationRetained: true, draftConsumedOnlyAfterAdmission: true, originalObserved: true };
  }
  if (scenario === "newer") {
    await wait(() => observed.length > 0 && pending()[0]?.accepted, "restored operation admission");
    check(chosen()[0]?.revision === 2, "old operation must not consume a newer choice");
    check(sent.length === 0, "newer draft must not replay");
    return { scenario, backend, sent: 0, newerDraftPreserved: true };
  }
  await setInput(originalText); enter(); await wait(() => sent.length === 1, "first actual chat.send");
  const idem = sent[0].idempotencyKey;
  if (nativeRejection) {
    await wait(() => pending()[0]?.idem === idem, "native Cron follow-up tracked");
    emit({ runId: idem, agentId, backendId: "hermes", state: "error", errorMessage: "Foreign rejection",
      errorCode: "INTERNAL_ERROR", admissionAccepted: false });
    await new Promise(resolve => setTimeout(resolve, 80));
    check(pending()[0]?.idem === idem && input().value === "", "foreign rejection restored a native draft");
    emit({ runId: idem, agentId, backendId: backend, state: "error", errorMessage: "发送准备失败",
      errorCode: "INTERNAL_ERROR", admissionAccepted: false });
    await wait(() => input().value === originalText && pending().length === 0 && !banner(), "definite native rejection restores input");
    check(chosen().length === 0 && !Object.hasOwn(sent[0], "pluginSelection"), "ordinary Cron follow-up became a plugin send");
    check(sent.length === 1 && observed.length === 0, "definite rejection retried or queried an unaccepted operation");
    check(document.body.innerText.includes("发送准备失败"), "native rejection is not visible");
    return { scenario, backend, sent: 1, cronFollowUp: true, restoredOriginalInput: true,
      pendingRemoved: true, foreignOwnerIgnored: true, noVerificationLoop: true, noAutomaticRetry: true };
  }
  if (scenario === "ordinary-upstream" || scenario === "ordinary-receipt") {
    await wait(() => banner() && observed.length > 0, "dispatched ordinary receipt remains uncertain");
    check(pending()[0]?.idem === idem && pending()[0]?.backendId === backend && !pending()[0].selection
      && chosen().length === 0 && !Object.hasOwn(sent[0], "pluginSelection"), "ordinary original identity not retained");
    check(input().value === "", "dispatched ordinary text was restored for resend");
    check(Object.keys(pending()[0]).every(field => ["key", "idem", "at", "backendId"].includes(field)),
      "ordinary observation record persisted a replayable payload");
    emit({ runId: idem, agentId, backendId: "hermes", state: "error", admissionAccepted: false,
      errorCode: "PLUGIN_SELECTION_UNAVAILABLE" });
    await new Promise(resolve => setTimeout(resolve, 80));
    check(pending()[0]?.idem === idem && banner() && !pending()[0]?.accepted && input().value === "",
      "foreign owner restored ordinary original or erased uncertainty");
    await setInput("Never issue a replacement ordinary operation"); enter();
    await new Promise(resolve => setTimeout(resolve, 120));
    check(sent.length === 1 && input().value.includes("Never") && observed.every(item =>
      item.sessionKey === key && item.idempotencyKey === idem), "ordinary uncertainty minted a replacement operation");
    return { scenario, backend, sent: 1, originalOperation: idem, ordinaryOriginalPersisted: true,
      conflictingNotSentIgnored: true, foreignOwnerIgnored: true, notFoundNeverRetryable: true, noResend: true };
  }
  if (scenario === "rejected") {
    await wait(() => input().value === originalText && pending().length === 0, "clear preflight rejection restores original input");
    check(chosen().length === 1, "rejection must retain plugin draft");
    check(!banner(), "known not-sent rejection is not uncertain");
    return { scenario, backend, sent: 1, restoredOriginalInput: true, retainedSelection: true, pendingRemoved: true };
  }
  if (scenario === "ordinary") {
    await wait(() => document.body.innerText.includes("Fixture refused"), "ordinary external failure");
    check(pending().length === 0 && !banner(), "ordinary external chat must preserve existing non-durable behavior");
    check(!Object.hasOwn(sent[0], "pluginSelection"), "ordinary chat selection injected");
    if (backend === "shoggoth") check(input().value === originalText, "definite native rejection must restore original input");
    return { scenario, backend, sent: 1, ordinaryBehaviorUnchanged: backend !== "shoggoth",
      ...(backend === "shoggoth" ? { definiteNativeRejectionRestoresInput: true } : {}) };
  }
  if (scenario === "terminal-race" || scenario === "terminal-timeout" || scenario === "terminal-reload") {
    emit({ runId: idem, agentId, backendId: backend, state: "accepted" });
    await wait(() => pending()[0]?.accepted, "terminal test exact admission");
    lookup = { status: "found", admissionAccepted: true, run: { status: "running" } };
    // Wrong original owner cannot authorize terminal observation or retries.
    emit({ runId: "other-run", agentId, backendId: backend, state: "final", message: { content: "Foreign run" } });
    await new Promise(resolve => setTimeout(resolve, 60));
    check(pending()[0]?.idem === idem && document.querySelector(".chat-stop")
      && observed.every(item => item.idempotencyKey === idem), "foreign final was treated as the original terminal event");
    const foreignReads = observed.length;
    emit({ runId: idem, agentId, backendId: backend, state: "final", message: { content: "Finished before receipt write" } });
    await wait(() => observed.length > 0 && banner(), "old running receipt remains verification");
    check(!document.querySelector(".chat-stop"), "terminal active receipt reopened Stop");
    await setInput("Never send while terminal receipt is not durable"); enter();
    await new Promise(resolve => setTimeout(resolve, 60));
    check(sent.length === 1 && input().value.includes("Never"), "terminal verification minted a new send");
    if (scenario === "terminal-race") {
      lookup = { status: "found", admissionAccepted: true, run: { status: "completed" } };
      await wait(() => pending().length === 0 && !banner(), "bounded original operation observation sees durable terminal");
      check(observed.length >= 2 && observed.every(item => item.idempotencyKey === idem && item.sessionKey === key), "terminal retry changed identity");
      check(sent.length === 1 && !document.querySelector(".chat-stop"), "durable terminal query resent or reopened generation");
      return { scenario, backend, sent: 1, boundedOriginalReadOnlyObservation: true, foreignFinalIgnored: true,
        terminalBeforeReceiptResolved: true, noResend: true, stoppedGenerationStaysClosed: true };
    }
    await wait(() => observed.length === foreignReads + 4, "three finite delayed original reads");
    await new Promise(resolve => setTimeout(resolve, 500));
    check(observed.length === foreignReads + 4 && banner() && pending()[0]?.idem === idem, "terminal deadline dropped original uncertainty or retried indefinitely");
    check(!document.querySelector(".chat-stop") && sent.length === 1, "expired terminal reads reopened generation or sent");
    if (scenario === "terminal-reload") {
      check(pending()[0]?.terminalObserved === true, "exact terminal observation was not persisted");
      return { scenario, backend, sent: 1, persistedTerminalObservation: true, finiteAutomaticReads: 4, originalOperation: idem };
    }
    lookup = { status: "found", admissionAccepted: true, run: { status: "completed" } }; clickVerify();
    await wait(() => pending().length === 0 && !banner(), "manual exact verification after finite retry budget");
    return { scenario, backend, sent: 1, finiteAutomaticReads: 4, manualVerificationAfterExpiry: true,
      terminalUnknownRemainsPending: true, noResend: true, stoppedGenerationStaysClosed: true };
  }
  if (scenario === "reselect") {
    emit({ runId: idem, state: "accepted" });
    await wait(() => pending()[0]?.accepted && chosen().length === 0, "first selection consumed");
    Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]'))
      .find(button => button.textContent?.startsWith("插件"))!.click();
    await wait(() => document.querySelector('[role="dialog"] input[type="checkbox"]'), "actual picker opens");
    document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.click();
    await wait(() => chosen().length === 1, "user chooses identical plugin again");
    emit({ runId: idem, state: "accepted" });
    await new Promise(resolve => setTimeout(resolve, 80));
    check(chosen().length === 1, "duplicate accepted consumed the newer identical choice");
    lookup = { status: "found", admissionAccepted: true, run: { status: "running" } };
    emit({ runId: idem, state: "status", statusKind: "needs_verification" });
    await wait(() => banner(), "verification before repeated lookup");
    clickVerify(); await wait(() => observed.length > 0 && !banner(), "original operation active again");
    check(chosen().length === 1 && sent.length === 1, "repeated lookup must preserve the new choice and not send");
    return { scenario, backend, sent: 1, duplicateAcceptedDoesNotConsumeNewIntent: true, repeatedLookupDoesNotConsumeNewIntent: true };
  }
  if (scenario === "accepted-error" || scenario === "accepted-uncertain") {
    emit({ runId: idem, state: "accepted" });
    await wait(() => pending()[0]?.accepted && chosen().length === 0, "exact acceptance before execution error");
    lookup = { status: "found", admissionAccepted: true,
      run: { status: scenario === "accepted-error" ? "failed" : "needs_verification" } };
    emit({ runId: idem, state: "error", errorMessage: "Execution outcome", errorCode: "RUNTIME_OUTCOME_UNKNOWN" });
    if (scenario === "accepted-error") {
      await wait(() => pending().length === 0 && observed.length > 0, "durable terminal failure resolves original operation");
      check(input().value === "", "accepted execution failure must not restore original for resend");
      return { scenario, backend, sent: 1, confirmedAccepted: true, resolvedByExactOperation: true, originalInputNotRestored: true };
    }
    await wait(() => banner() && observed.length > 0, "accepted operation with uncertain execution remains blocked");
    check(pending()[0]?.idem === idem && input().value === "", "accepted uncertainty was converted to a retry");
    return { scenario, backend, sent: 1, confirmedAccepted: true, uncertainExecutionStillBlocked: true };
  }
  if (scenario === "started") {
    await new Promise(resolve => setTimeout(resolve, 150));
    check(chosen().length === 1 && !pending()[0]?.accepted, "early started must not consume the draft");
    emit({ runId: idem, state: "error", errorMessage: "Outcome unavailable" });
    await wait(() => banner() && observed.length > 0, "unaccepted generic error remains uncertain");
    check(input().value === "", "uncertain execution must not restore resendable original text");
    emit({ runId: idem, state: "error", errorMessage: "Conflicting uncertainty flags",
      errorCode: "PLUGIN_SELECTION_NEEDS_VERIFICATION", admissionAccepted: false });
    await new Promise(resolve => setTimeout(resolve, 80));
    check(input().value === "" && pending()[0]?.idem === idem,
      "uncertainty must dominate a contradictory rejection flag");
  } else await wait(() => banner() && observed.length > 0, "lost ACK observation");
  check(pending()[0]?.idem === idem, "uncertain operation ID was replaced");
  check(chosen().length === 1, "not_found must retain plugin draft");
  emit({ runId: "different-operation", state: "accepted" });
  await new Promise(resolve => setTimeout(resolve, 80));
  check(chosen().length === 1 && banner(), "foreign accepted must not consume draft or clear verification");
  emit({ runId: idem, backendId: backend === "openclaw" ? "hermes" : "openclaw", state: "accepted" });
  emit({ runId: idem, backendId: backend, agentId: "wrong-agent", state: "error",
    errorCode: "PLUGIN_SELECTION_UNAVAILABLE", admissionAccepted: false, errorMessage: "Foreign owner rejection" });
  await new Promise(resolve => setTimeout(resolve, 80));
  check(pending()[0]?.idem === idem && !pending()[0]?.accepted && chosen().length === 1 && input().value === "" && banner(),
    "same operation with a foreign owner consumed intent or restored resendable original text");
  await setInput("Do not resend the uncertain original"); enter();
  await new Promise(resolve => setTimeout(resolve, 100));
  check(sent.length === 1 && input().value.includes("Do not"), "uncertain retry generated a new operation");
  check(observed.every(item => item.idempotencyKey === idem), "verification queried a different operation");
  return { scenario, backend, sent: 1, originalOperation: idem, verificationVisible: true,
    noReplay: true, notFoundRetained: true, foreignAcceptedIgnored: true, foreignOwnerEventsIgnored: true, inputNotRestoredForAutomaticResend: true };
} });
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
