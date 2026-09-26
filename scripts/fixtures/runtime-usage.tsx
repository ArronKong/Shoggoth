import React from "react";
import { createRoot } from "react-dom/client";
import RuntimeUsagePanel from "../../app/manage-ui/src/components/RuntimeUsagePanel";
import RuntimeUsageBreakdown from "../../app/manage-ui/src/components/RuntimeUsageBreakdown";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
const state = window as any;
const parts = (totalTokens: number) => ({ totalTokens, totalCost: 0, inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
const snapshot = { byModel: [], byAgent: [{ agentId: "agent-one", ...parts(500) }],
  bySource: [{ id: "agent-one", label: "同一个 Agent", kind: "agent" as const, backendId: "fixture", ...parts(500) }],
  totals: parts(500), runtimes: [{ runtime: "codex", runtimeAccountId: "native-codex-default-v1", ...parts(200) },
    { runtime: "pi", runtimeAccountId: "native-pi-default-v1", ...parts(250) }, { runtime: null, runtimeAccountId: null, ...parts(50) }] };
state.reads = 0;
state.fetch = async () => { state.reads++; await new Promise((resolve) => setTimeout(resolve, 30)); return Response.json({ breakdown: snapshot }); };
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<UiProvider><main className="page management-page" style={{ maxWidth: 900, margin: "auto" }}>
  <div id="dashboard-runtime"><RuntimeUsagePanel backend="fixture" /></div>
  <section id="usage-runtime"><RuntimeUsageBreakdown data={snapshot} /></section>
</main></UiProvider>);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const wait = async (predicate: () => unknown) => { const deadline = performance.now() + 4000; while (!predicate()) {
  if (performance.now() > deadline) throw Error("runtime usage fixture timeout"); await pause(10); } };
state.runRuntimeUsageFixture = async () => {
  await wait(() => document.querySelector("#usage-runtime tbody"));
  check(state.reads === 0, "collapsed dashboard does not block hero with a cold usage scan");
  document.querySelector<HTMLElement>("summary")!.click();
  await wait(() => document.querySelector("#dashboard-runtime tbody"));
  const dashboard = document.querySelector("#dashboard-runtime")!;
  check(dashboard.querySelectorAll("li").length === 1 && dashboard.querySelector("li")?.textContent?.includes("500"), "one Agent aggregates across runtimes");
  for (const area of [dashboard, document.querySelector("#usage-runtime")!]) {
    const rows = [...area.querySelectorAll("tbody tr")]; check(rows.length === 3, "both views keep actual runtime groups");
    check(rows[2].textContent?.includes("未知") && !rows[2].textContent?.includes("codex"), "unknown stays unknown");
    check(rows[0].textContent?.includes("200") && rows[1].textContent?.includes("250") && rows[2].textContent?.includes("50"), "groups retain actual values");
  }
  return { reads: state.reads, agents: 1, runtimes: 3, unknownPreserved: true };
};
state.checkRuntimeUsageGeometry = async (theme: string) => {
  document.documentElement.dataset.theme = theme; await pause(250); await new Promise(requestAnimationFrame);
  check(document.documentElement.scrollWidth <= innerWidth, "runtime usage horizontal overflow");
  const control = document.querySelector<HTMLElement>("summary")!; control.focus(); check(document.activeElement === control, "summary keyboard focus");
  return { width: innerWidth, theme, overflow: false };
};
