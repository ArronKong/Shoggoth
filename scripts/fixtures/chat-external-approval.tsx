import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import TurnProcess from "../../app/manage-ui/src/components/TurnTimeline/TurnProcess";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import type { TurnStep } from "../../app/manage-ui/src/lib/turnTimeline";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
scope.fixtureErrors = [];
scope.fixtureReads = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));

function row(toolCallId: string) {
  return { callId: `audit-${toolCallId}`, backendId: "openclaw", instanceId: "instance-one",
    agentId: "agent-one", sessionId: "physical-session-one", runId: "run-one",
    taskId: null, turnId: null, toolCallId, bindingId: "binding-one",
    installationId: "installation-one", componentId: "a".repeat(64),
    connectionId: "connection-one", toolIdentity: `plugin:binding-one:${"a".repeat(64)}:echo:${"b".repeat(64)}`,
    toolName: "echo", cancelRequested: false, resultDigest: null, resultBytes: null,
    errorCode: null, approvalRequestId: `request-${toolCallId}`,
    approvalOutcome: toolCallId === "tool-denied" ? "denied" : "approved",
    approvalUpdatedAt: 1, status: toolCallId === "tool-denied"
      ? "rejected_before_send" : "outcome_unknown", createdAt: 1, updatedAt: 1 };
}

window.fetch = async input => {
  const route = String(input);
  scope.fixtureReads.push(route);
  const url = new URL(route, "https://fixture.invalid");
  if (url.pathname !== "/__api/plugins/external-calls") throw Error(`unexpected request: ${route}`);
  const q = url.searchParams;
  if (q.get("backendId") !== "openclaw" || q.get("agentId") !== "agent-one"
    || q.get("limit") !== "1") throw Error(`unscoped plugin call query: ${route}`);
  const callId = q.get("toolCallId") || "";
  let result: { items: ReturnType<typeof row>[]; nextCursor: { createdAt: number; callId: string } | null };
  if (callId === "tool-cross-session") {
    // Even a faulty REST response cannot paint a foreign physical session.
    result = { items: [row(callId)], nextCursor: null };
  } else if (callId === "tool-ambiguous") {
    result = { items: [row(callId)], nextCursor: { createdAt: 1, callId: "second-call" } };
  } else {
    if (q.get("sessionId") !== "physical-session-one") throw Error(`wrong session scope: ${route}`);
    result = { items: [row(callId)], nextCursor: null };
  }
  return new Response(JSON.stringify(result), { status: 200,
    headers: { "content-type": "application/json" } });
};

applyConfiguredLocale("zh-CN");
type Scenario = "approved" | "denied" | "cross" | "ambiguous" | "duplicate-step" | "missing-id" | "non-plugin";
function Fixture() {
  const [scenario, setScenario] = useState<Scenario>("approved");
  scope.setScenario = setScenario;
  const toolCallId = {
    approved: "tool-approved", denied: "tool-denied", cross: "tool-cross-session",
    ambiguous: "tool-ambiguous", "duplicate-step": "tool-duplicate",
    "missing-id": undefined, "non-plugin": "tool-ordinary",
  }[scenario];
  const step: TurnStep = { id: `step-${scenario}`, kind: "tool", status: "ok",
    startTs: 1, endTs: 2, toolName: scenario === "non-plugin" ? "web_search" : "shoggoth_plugin_call",
    toolCallId, args: { serverId: "plugin.binding-one", toolName: "echo" } };
  const steps = scenario === "duplicate-step"
    ? [step, { ...step, id: "second-visible-step" }] : [step];
  const sessionId = scenario === "cross" ? "physical-session-two" : "physical-session-one";
  return <main id="fixture" data-scenario={scenario}
    style={{ maxWidth: 860, margin: "40px auto", padding: "16px" }}>
    <TurnProcess key={scenario} steps={steps} defaultOpen pluginConversation={{
      backendId: "openclaw", sessionKey: "agent:agent-one:main",
      agentId: "agent-one", sessionId,
    }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate: () => unknown) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw Error("external approval fixture timeout"); await pause(); }
}
scope.runExternalApprovalFixture = async () => {
  await wait(() => !!document.querySelector('[data-testid="external-plugin-call-outcome"]'));
  const approved = document.querySelector<HTMLElement>('[data-testid="external-plugin-call-outcome"]')!;
  if (!approved.textContent?.includes("审批: 已允许一次")
    || !approved.textContent.includes("Service 调用: 结果待核对")) throw Error("approval and execution were conflated");
  if (!document.body.textContent?.includes("宿主已结束")
    || document.querySelector('[data-external-plugin="1"]')?.textContent?.includes("完成")) {
    throw Error("host wrapper completion was shown as remote business success");
  }
  scope.setScenario("denied");
  await wait(() => document.querySelector<HTMLElement>('[data-testid="external-plugin-call-outcome"]')?.dataset.callId === "audit-tool-denied");
  if (!document.body.textContent?.includes("审批: 已拒绝 · Service 调用: 发送前拒绝")) throw Error("denial label missing");
  const scenarios: Scenario[] = ["cross", "ambiguous", "duplicate-step", "missing-id", "non-plugin"];
  const reads: Record<string, number> = {};
  for (const scenario of scenarios) {
    const before = scope.fixtureReads.length;
    scope.setScenario(scenario);
    await wait(() => document.querySelector("#fixture")?.getAttribute("data-scenario") === scenario);
    if (scenario === "cross" || scenario === "ambiguous") {
      const expected = scenario === "cross" ? "tool-cross-session" : "tool-ambiguous";
      await wait(() => scope.fixtureReads.some((read: string) => read.includes(expected)));
    }
    await pause(180);
    if (document.querySelector('[data-testid="external-plugin-call-outcome"]')) throw Error(`${scenario} painted a foreign or ambiguous approval`);
    reads[scenario] = scope.fixtureReads.length - before;
  }
  if (reads["duplicate-step"] || reads["missing-id"] || reads["non-plugin"]) throw Error("unidentifiable tool triggered audit read");
  if (reads.cross !== 1 || reads.ambiguous !== 1) throw Error("cross-session or duplicate audit response was not checked");
  scope.setScenario("approved");
  await wait(() => !!document.querySelector('[data-testid="external-plugin-call-outcome"]'));
  return { approved: true, denied: true, crossSessionHidden: true,
    ambiguousHidden: true, duplicateStepHidden: true, missingIdHidden: true,
    ordinaryToolIgnored: true, reads };
};
scope.captureExternalApproval = (theme: string) => {
  document.documentElement.dataset.theme = theme;
  const badge = document.querySelector<HTMLElement>('[data-testid="external-plugin-call-outcome"]')!.getBoundingClientRect();
  return { theme, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    badge: { left: badge.left, right: badge.right, top: badge.top, bottom: badge.bottom },
    errors: scope.fixtureErrors };
};
