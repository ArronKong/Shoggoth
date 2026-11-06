import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import DashboardPage from "../../app/manage-ui/src/pages/DashboardPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { runPageRefresh } from "../../app/manage-ui/src/lib/page-refresh";
import { DASHBOARD_CACHE_KEY, DASHBOARD_CACHE_VERSION } from "../../app/manage-ui/src/lib/dashboardCache";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const state = window as any;
const options = new URLSearchParams(location.search);
const language = options.get("language") || "zh-CN";
const theme = options.get("theme") || "light";
const scenario = options.get("scenario") || "cold";
let mode = scenario;
const now = Date.now();
const pendingSummary: Array<() => void> = [];
const pendingUsage: Array<() => void> = [];
const pendingActivities: Array<() => void> = [];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const isEmpty = () => mode === "empty" || scenario === "filter";
const summary = () => ({
  generatedAt: Date.now(), sinceMs: new Date().setHours(0, 0, 0, 0),
  status: FALLBACK_BACKEND_DESCRIPTORS.map(backend => ({ id: backend.id, name: backend.name, connected: true, info: {} })),
  runs: [], running: [], approvals: [],
  usage: [{ backend: "shoggoth", ...(mode === "pending" ? { error: "pending", availability: "unavailable" } : mode === "unavailable"
    ? { error: "offline", availability: "unavailable" } : { availability: "complete",
      today: { date: "today", totalTokens: 128000, totalCost: 1.25 },
      yesterday: { date: "yesterday", totalTokens: 64000, totalCost: 0.8 } }) }],
  artifacts: [{ backend: "shoggoth", supported: true, items: isEmpty() ? [] : Array.from({ length: 3 }, (_, index) => ({
    path: `/tmp/dashboard-fixture-${index}.md`, name: `Dashboard report ${index + 1}.md`,
    area: "workspace", kind: "doc", mtimeMs: now - index * 1000, size: 1024,
  })) }],
  activityPage: { items: isEmpty() ? [] : Array.from({ length: 5 }, (_, index) => ({
    id: `fixture-${index}`, kind: "cron", backendId: "shoggoth", agentId: "writer",
    occurredAt: now - index * 1000, severity: "ok", title: `Daily report ${index + 1}`, summary: "Completed dashboard fixture report",
    run: { backendId: "shoggoth", jobId: `job-${index}`, status: "ok", runId: `run-${index}` },
  })), hasMore: false, degradedSources: [] },
  taskStats: { total: { ok: 12, error: 1 }, byKind: { cron: { ok: 12, error: 1 }, kanban: { ok: 0, error: 0 }, inspiration: { ok: 0, error: 0 } },
    byAgent: Array.from({ length: 6 }, (_, index) => ({ backendId: "shoggoth", agentId: `writer-${index}`, ok: 6 - index, error: 0 })), complete: true },
});

state.fetch = async (input: unknown, init: RequestInit = {}) => {
  if (init.method && init.method !== "GET") throw Error(`Unexpected write: ${init.method} ${String(input)}`);
  const url = new URL(String(input), location.href);
  if (url.pathname === "/__api/dashboard") return new Promise(resolve => pendingSummary.push(() =>
    resolve(mode === "failed" ? response({ error: "Fixture unavailable" }, 503) : response({ summary: summary() }))));
  if (url.pathname === "/__api/dashboard/activities") return new Promise(resolve => pendingActivities.push(() =>
    resolve(mode === "failed" ? response({ error: "Activity unavailable" }, 503)
      : response({ items: [], hasMore: false, degradedSources: [] }))));
  if (url.pathname === "/__api/usage") return new Promise(resolve => pendingUsage.push(() => resolve(response({ series: null }))));
  if (url.pathname === "/__api/dashboard/live") return response({ generatedAt: now, running: [], approvals: [] });
  if (url.pathname === "/__api/config") return response({ config: { disabledBackends: [], locale: language } });
  if (url.pathname === "/__api/backends") return response({ backends: FALLBACK_BACKEND_DESCRIPTORS });
  if (url.pathname === "/__api/agents") return response({ agents: [{ id: "writer", name: "Writer", backendId: url.searchParams.get("backend") }] });
  return response({});
};
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });

// This document runs only in a private renderer profile or its dedicated preview origin.
localStorage.clear();
if (scenario === "cache") localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify({
  version: DASHBOARD_CACHE_VERSION, savedAt: now, data: summary(),
}));
await i18n.changeLanguage(language);
document.documentElement.dataset.theme = theme;
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><DashboardPage /></UiProvider></HashRouter>);

const check = (condition: unknown, label: string) => { if (!condition) throw Error(label); };
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = performance.now() + 6000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (performance.now() > deadline) throw Error(label);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
};
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const release = (queue: Array<() => void>) => { for (const done of queue.splice(0)) done(); };
const pageSkeleton = () => document.querySelector('[data-dashboard-skeleton="page"]');
const activitySkeleton = () => document.querySelector('[data-dashboard-skeleton="activity"]');
const boxes = () => Array.from(document.querySelectorAll(".kpi, .dash-columns")).map(element => {
  const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
});
const verifyLayout = () => {
  check(document.documentElement.scrollWidth <= innerWidth + 1, "Horizontal overflow");
  for (const element of document.querySelectorAll(".kpi, .dash-section")) {
    const rect = element.getBoundingClientRect();
    check(rect.width > 0 && rect.height > 0 && rect.right <= innerWidth + 1, "Collapsed or overflowing card");
  }
};

state.prepareScreenshot = async () => {
  await wait(() => pendingSummary.length > 0 && (pageSkeleton() || scenario === "cache"), "Initial request/loading state missing");
  await wait(() => document.querySelector('.kpi [aria-hidden="true"]'), "Placeholder did not mount");
  if (scenario !== "cache") {
    await wait(() => Array.from(pageSkeleton()!.querySelectorAll("span")).some(element =>
      getComputedStyle(element).animationName !== "none" && getComputedStyle(element).opacity === "1")
      || matchMedia("(prefers-reduced-motion: reduce)").matches, "Skeleton did not become visible");
  }
  verifyLayout();
  await settle();
};

state.runFixture = async () => {
  const before = boxes();
  const feedHeaderHeight = document.querySelector(".dash-feed-head")?.getBoundingClientRect().height;
  if (scenario === "cache") {
    check(!pageSkeleton() && document.querySelectorAll(".dash-art").length === 3, "Cached data was replaced by skeletons");
  } else {
    check(pageSkeleton()!.getAttribute("aria-busy") === "true", "Initial loading is not accessible");
    check(pageSkeleton()!.querySelectorAll("button, a, input, [tabindex]").length === 0, "Placeholder is focusable");
    check(!document.querySelector(".dash-empty"), "Loading falsely reports empty content");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const shape = pageSkeleton()!.querySelector<HTMLElement>(".kpi-val span")!;
      check(getComputedStyle(shape).animationName === "none" && getComputedStyle(shape, "::after").animationName === "none", "Reduced motion still animates");
    }
  }

  if (scenario === "failure") {
    mode = "failed"; release(pendingSummary);
    await wait(() => document.querySelector('[role="alert"]'), "Initial failure missing");
    check(!pageSkeleton(), "Failed request left an endless skeleton");
    document.querySelector<HTMLButtonElement>(".dash-error button")!.click();
    await wait(() => pageSkeleton() && pendingSummary.length > 0, "Retry did not restore loading skeleton");
    mode = "empty"; release(pendingSummary);
    await wait(() => document.querySelectorAll(".dash-empty").length === 2, "Successful empty response missing");
    check(!pageSkeleton(), "Empty response kept loading skeleton");
  } else {
    release(pendingSummary);
    await wait(() => !pageSkeleton() && document.querySelectorAll(".kpi").length === 3, "Summary did not replace the skeleton");
    if (scenario === "pending") {
      check(document.querySelectorAll('.kpi[aria-busy="true"]').length === 2, "Pending usage needs two metric placeholders");
      check(document.querySelectorAll(".dash-art").length === 3, "Pending usage hid ready content");
      mode = "ready"; release(pendingUsage);
      await wait(() => pendingSummary.length > 0, "Completed usage did not refresh summary");
      release(pendingSummary);
      await wait(() => !document.querySelector('.kpi[aria-busy="true"]'), "Usage metric skeleton did not settle");
    }
    if (scenario === "unavailable") check(!document.querySelector('.kpi[aria-busy="true"]'), "Unavailable usage is not an in-flight load");
    if (scenario === "filter") {
      const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(element =>
        element.textContent === i18n.t("dashboard.filterCron"))!;
      tab.click();
      await wait(() => activitySkeleton() && pendingActivities.length > 0, "Empty filtered request needs activity skeleton");
      check(getComputedStyle(activitySkeleton()!).pointerEvents === "none", "Loading rows must not imply click actions");
      check(!document.querySelector(".dash-activity-scroll .dash-empty"), "Filter load falsely reports empty");
      release(pendingActivities);
      await wait(() => !activitySkeleton() && document.querySelector(".dash-activity-scroll .dash-empty"), "Filter empty state did not settle");
    }
    if (["cold", "cache"].includes(scenario)) {
      await settle();
      const after = boxes();
      check(Math.abs((document.querySelector(".dash-feed-head")?.getBoundingClientRect().height || 0) - (feedHeaderHeight || 0)) <= 1,
        "Activity filters changed the header height on reveal");
      // The grid and three metric cards reserve their final space at every breakpoint.
      for (let index = 0; index < 3; index++) for (const key of ["x", "y", "width", "height"] as const) {
        check(Math.abs(before[index][key] - after[index][key]) <= 1, `Metric card moved on reveal: ${index} ${key}`);
      }
      if (innerWidth > 900) check(Math.abs(before[3].height - after[3].height) <= 1, "Two-column area moved on reveal");
      const refresh = runPageRefresh("/dashboard");
      await wait(() => pendingSummary.length > 0, "Refresh did not request summary");
      check(!pageSkeleton() && document.querySelectorAll(".dash-art").length === 3, "Background refresh hid existing data");
      mode = "failed"; release(pendingSummary); await refresh;
      await wait(() => document.querySelector(".dash-error"), "Refresh error missing");
      check(!pageSkeleton() && document.querySelectorAll(".dash-art").length === 3, "Refresh error discarded existing data");
    }
  }
  await settle(); verifyLayout();
  check(!state.fixtureError, state.fixtureError);
  return { scenario, language, theme, width: innerWidth, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    loadingSettled: !pageSkeleton(), preservedLayout: true, noWrites: true };
};
