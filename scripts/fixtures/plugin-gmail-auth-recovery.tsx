import React from "react";
import { createRoot } from "react-dom/client";
import { PluginGmailConnect } from "../../app/manage-ui/src/pages/PluginGmailConnect";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
const installationId = "gmail-fixture-installation";
const componentId = "a".repeat(64);
const agents = ["start-rejected", "preexisting", "flow-failed", "poll-rejected", "pending-cancel", "late-cancel"] as const;
let pendingCancelRequested = false;
let lateCancelRequested = false;
let lateCancelResolve: ((response: Response) => void) | null = null;
let startRecoveryBlocked = false;
let reconcileMode: "canceled" | "blocked" | "recovered" = "canceled";
const requests: Array<{ route: string; agentId: string; body: Record<string, unknown> }> = [];
scope.fixtureErrors = [];
scope.fixtureRequests = requests;
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
for (const agentId of agents.filter(id => !["start-rejected", "preexisting"].includes(id))) {
  sessionStorage.setItem(`shoggoth.plugin.gmail.${agentId}.${installationId}.${componentId}`,
    `fixture-${agentId}-flow`);
}

window.fetch = async (input, init) => {
  const route = String(input);
  const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
  if (init?.method !== "POST") throw Error(`Unexpected method: ${route}`);
  requests.push({ route, agentId: String(body.agentId || ""), body });
  if (route === "/__api/plugins/gmail-auth-start") {
    if (body.agentId !== "start-rejected") throw Error("Unexpected Gmail start request");
    startRecoveryBlocked = true;
    return Response.json({ code: "GMAIL_AUTH_RECOVERY_REQUIRED" }, { status: 409 });
  }
  if (route === "/__api/plugins/gmail-auth-recovery-status") {
    const pending = body.agentId === "start-rejected" && !startRecoveryBlocked ? null
      : { email: "fixture@example.invalid", client: "shoggoth" };
    return Response.json({ pending });
  }
  if (route === "/__api/plugins/gmail-auth-reconcile") {
    if (body.email !== "fixture@example.invalid") throw Error("Reconcile must use the pending account email");
    if (reconcileMode === "canceled") return Response.json({ canceled: true, recovered: false });
    if (reconcileMode === "blocked") {
      return Response.json({ code: "GMAIL_AUTH_RECOVERY_REQUIRED" }, { status: 409 });
    }
    return Response.json({ canceled: false, recovered: true });
  }
  if (route === "/__api/plugins/gmail-auth-status" && body.agentId === "flow-failed") {
    return Response.json({ flowId: body.flowId, status: "failed", expiresAt: Date.now() + 30_000,
      reasonCode: "GMAIL_AUTH_RECOVERY_REQUIRED", bindingId: null, receipt: null });
  }
  if (route === "/__api/plugins/gmail-auth-status" && body.agentId === "poll-rejected") {
    return Response.json({ code: "GMAIL_AUTH_RECOVERY_REQUIRED" }, { status: 409 });
  }
  if (route === "/__api/plugins/gmail-auth-status" && body.agentId === "pending-cancel") {
    return Response.json({ flowId: body.flowId,
      status: pendingCancelRequested ? "failed" : "pending", expiresAt: Date.now() + 30_000,
      reasonCode: pendingCancelRequested ? "GMAIL_AUTH_RECOVERY_REQUIRED" : null,
      bindingId: null, receipt: null });
  }
  if (route === "/__api/plugins/gmail-auth-cancel" && body.agentId === "pending-cancel") {
    pendingCancelRequested = true;
    return Response.json({ flowId: body.flowId, status: "pending", expiresAt: Date.now() + 30_000,
      reasonCode: null, bindingId: null, receipt: null });
  }
  if (route === "/__api/plugins/gmail-auth-status" && body.agentId === "late-cancel") {
    return Response.json({ flowId: body.flowId,
      status: lateCancelRequested ? "failed" : "pending", expiresAt: Date.now() + 30_000,
      reasonCode: lateCancelRequested ? "GMAIL_AUTH_RECOVERY_REQUIRED" : null,
      bindingId: null, receipt: null });
  }
  if (route === "/__api/plugins/gmail-auth-cancel" && body.agentId === "late-cancel") {
    lateCancelRequested = true;
    return new Promise<Response>(resolve => { lateCancelResolve = resolve; });
  }
  throw Error(`Unexpected request: ${route}`);
};

const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function wait(predicate: () => unknown, message: string) {
  const deadline = performance.now() + 4000;
  while (!predicate()) { if (performance.now() > deadline) throw Error(message); await pause(); }
}
function card(agentId: string) { return document.querySelector<HTMLElement>(`#${agentId} [data-gmail-connect]`)!; }
function state(agentId: string) {
  const node = card(agentId);
  return { agentId, text: node.innerText, alert: node.querySelector("[role=alert]")?.textContent,
    inputDisabled: node.querySelector("input")?.disabled,
    submitDisabled: node.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    cancelPresent: !!node.querySelector('button[type="button"]:not([data-gmail-reconcile])'),
    reconcilePresent: !!node.querySelector('[data-gmail-reconcile]'),
    email: node.querySelector<HTMLInputElement>("input")?.value,
    storedFlow: sessionStorage.getItem(`shoggoth.plugin.gmail.${agentId}.${installationId}.${componentId}`) };
}
scope.gmailRecoveryInitial = async () => {
  await wait(() => card("start-rejected")?.querySelector("input"), "Gmail cards render");
  await wait(() => ["preexisting", "flow-failed", "poll-rejected"].every(id =>
    !!state(id).alert && state(id).reconcilePresent), "initial and terminal recovery states render");
  await wait(() => ["pending-cancel", "late-cancel"].every(id => state(id).cancelPresent),
    "in-flight authorization remains cancelable before cancellation request");
  return ["preexisting", "flow-failed", "poll-rejected"].map(state);
};
scope.gmailRecoveryRejectStart = async () => {
  const node = card("start-rejected");
  const input = node.querySelector<HTMLInputElement>("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, "fixture@example.invalid");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(() => !node.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    "valid Gmail address enables submit");
  node.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await wait(() => !!state("start-rejected").alert && state("start-rejected").reconcilePresent,
    "recovery rejection renders alert and check action");
  const before = requests.filter(request => request.route.endsWith("gmail-auth-start")).length;
  node.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await pause();
  return { ...state("start-rejected"), startRequestsBeforeRetry: before,
    startRequestsAfterRetry: requests.filter(request => request.route.endsWith("gmail-auth-start")).length };
};
scope.gmailRecoveryCancelPending = async () => {
  const agentId = "pending-cancel";
  const before = requests.filter(request => request.route === "/__api/plugins/gmail-auth-status"
    && request.agentId === agentId).length;
  card(agentId).querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  await wait(() => requests.some(request => request.route === "/__api/plugins/gmail-auth-cancel"
    && request.agentId === agentId), "cancel endpoint receives request");
  await wait(() => !card(agentId).querySelector<HTMLButtonElement>('button[type="button"]')?.disabled,
    "pending cancel response releases busy state");
  return { ...state(agentId), statusReadsBeforeCancel: before };
};
scope.gmailRecoveryAfterCancel = async () => {
  const agentId = "pending-cancel";
  await wait(() => !!state(agentId).alert && state(agentId).reconcilePresent,
    "follow-up poll reports recovery requirement");
  return { ...state(agentId), statusReads: requests.filter(request =>
    request.route === "/__api/plugins/gmail-auth-status" && request.agentId === agentId).length };
};
scope.gmailRecoveryLateCancel = async () => {
  const agentId = "late-cancel";
  card(agentId).querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  await wait(() => lateCancelResolve !== null, "late cancel request is held");
  const before = state(agentId);
  await wait(() => !!state(agentId).alert && state(agentId).reconcilePresent,
    "poll reaches recovery while cancel is unresolved");
  const recovered = state(agentId);
  lateCancelResolve!(Response.json({ flowId: `fixture-${agentId}-flow`, status: "pending",
    expiresAt: Date.now() + 30_000, reasonCode: null, bindingId: null, receipt: null }));
  lateCancelResolve = null;
  await pause();
  return { before, recovered, afterLateResponse: state(agentId) };
};
scope.gmailRecoveryGeometry = async (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
  await new Promise(resolve => setTimeout(resolve, 100));
  const bounds = agents.map(agentId => {
    const rect = card(agentId).getBoundingClientRect();
    return { agentId, left: rect.left, right: rect.right, width: rect.width,
      background: getComputedStyle(card(agentId)).backgroundColor };
  });
  return { theme, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, bounds };
};
scope.gmailRecoveryChinese = async () => {
  await applyConfiguredLocale("zh-CN");
  await wait(() => agents.every(agentId => state(agentId).alert?.includes("本机留下凭据")),
    "Chinese recovery copy renders in all states");
  return agents.map(state);
};
scope.gmailRecoveryEnglish = async () => { await applyConfiguredLocale("en"); };
scope.gmailRecoveryReconcile = async (mode: "canceled" | "blocked" | "recovered") => {
  reconcileMode = mode;
  const agentId = "start-rejected";
  await wait(() => !card(agentId).querySelector<HTMLButtonElement>("[data-gmail-reconcile]")?.disabled,
    "reconcile action is ready");
  card(agentId).querySelector<HTMLButtonElement>("[data-gmail-reconcile]")!.click();
  const expected = mode === "canceled" ? "The check was canceled"
    : mode === "blocked" ? "Local credentials may remain" : "No local credentials were found";
  const expectedRequests = mode === "canceled" ? 1 : mode === "blocked" ? 2 : 3;
  await wait(() => requests.filter(request => request.route === "/__api/plugins/gmail-auth-reconcile"
    && request.agentId === agentId).length === expectedRequests && state(agentId).text.includes(expected),
  `${mode} reconcile result renders`);
  return { ...state(agentId), reconcileRequests: requests.filter(request =>
    request.route === "/__api/plugins/gmail-auth-reconcile" && request.agentId === agentId).length,
    reconcileBody: requests.filter(request => request.route === "/__api/plugins/gmail-auth-reconcile"
      && request.agentId === agentId).at(-1)?.body };
};

void applyConfiguredLocale("en").then(() => {
  document.documentElement.dataset.theme = "light";
  createRoot(document.getElementById("root")!).render(<main className="management-page"
    style={{ maxWidth: 740, margin: "0 auto", padding: 16, display: "grid", gap: 18 }}>
    {agents.map(agentId => <section id={agentId} key={agentId}>
      <h2 style={{ fontSize: 14, margin: "0 0 6px" }}>{agentId}</h2>
      <PluginGmailConnect agentId={agentId} installationId={installationId} componentId={componentId}
        revision={1} disabled={false} connected={false} onReady={() => { throw Error("No flow may become ready"); }} />
    </section>)}
  </main>);
});
