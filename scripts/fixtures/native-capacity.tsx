import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import NativeCapacityCard from "../../app/manage-ui/src/pages/settings/NativeCapacityCard";
import ChatContextUsage from "../../app/manage-ui/src/components/ChatContextUsage";
import type { RuntimeContextUsage, RuntimeContextCapabilities, ProductContextState } from "../../app/manage-ui/src/types";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "../../app/manage-ui/src/pages/SettingsPage.css";
import "../../app/manage-ui/src/pages/settings/SettingsLayout.css";
import "../../app/manage-ui/src/pages/settings/SettingsOperations.css";

const state = window as any;
let snapshot = { revision: 0, maxActive: 100, startupConcurrency: 8, enabled: false,
  active: 7, queued: 2, byReason: [{ reason: "SESSION_LOCKED", count: 2 }] };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
state.writes = [];
state.fetch = async (_input: unknown, init?: RequestInit) => {
  if (init?.method === "PUT") {
    const body = JSON.parse(String(init.body));
    state.writes.push(body);
    await pause(30);
    if (state.failNext) {
      state.failNext = false;
      snapshot = { ...snapshot, revision: snapshot.revision + 2 };
      return new Response(JSON.stringify({ code: "NATIVE_RUNTIME_CONFIG_APPLY_FAILED", error: "fixture apply failed" }), { status: 409 });
    }
    if (body.expectedRevision !== snapshot.revision) throw Error("unexpected fixture revision");
    snapshot = { ...snapshot, ...body, revision: snapshot.revision + 1 };
  }
  return new Response(JSON.stringify(snapshot), { headers: { "Content-Type": "application/json" } });
};
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = performance.now() + 6000;
  while (!predicate()) {
    if (performance.now() > deadline) throw Error(`Timed out: ${label}`);
    await pause(10);
  }
};
function Fixture() {
  const [visible, setVisible] = useState(true);
  const [context, setContext] = useState<{ usage: RuntimeContextUsage | null; capabilities: RuntimeContextCapabilities; busy: boolean; product?: ProductContextState }>({
    usage: null, capabilities: { "context.usage.exact": true, "context.usage.estimated": false,
      "context.compact.native": true, "context.compact.auto": true }, busy: false,
  });
  state.showCard = setVisible;
  state.setContext = setContext;
  state.context = context;
  return <UiProvider><main className="page management-page settings-page" style={{ maxWidth: 1000, margin: "auto" }}>
    <div id="context-fixture"><ChatContextUsage {...context} onCompact={() => { state.compacts = (state.compacts || 0) + 1; }} /></div>
    {visible && <NativeCapacityCard />}
  </main></UiProvider>;
}
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
const input = (index = 0) => document.querySelectorAll<HTMLInputElement>('#settings-native-capacity input[type="number"]')[index];
const toggle = () => document.querySelector<HTMLElement>('#settings-native-capacity [role="switch"]')!;
const edit = (index: number, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(index), value);
  input(index).dispatchEvent(new Event("input", { bubbles: true }));
};
const ready = () => input() && !input().disabled;
state.runNativeCapacityFixture = async () => {
  await wait(ready, "initial capacity");
  check(input().value === "100" && input(1).value === "8", "default 100 / 8 rendered");
  check(!state.writes.length, "initial loading must not save defaults");
  check(![...document.querySelectorAll("button")].some((node) => /保存|Save/u.test(node.textContent || "")), "no manual save button");
  toggle().click();
  await wait(() => snapshot.enabled && ready(), "admission enabled immediately");
  check(state.writes.length === 1, "switch sends exactly one write");
  edit(0, "101");
  await pause(450);
  check(state.writes.length === 1 && document.querySelector('[role="alert"]'), "invalid max blocks save and shows validation");
  check(toggle().getAttribute("aria-disabled") === "true" || toggle().hasAttribute("disabled"), "invalid numeric draft blocks switch application");
  edit(0, "60");
  await wait(() => snapshot.maxActive === 60 && ready(), "valid max automatically applied");
  state.failNext = true;
  edit(1, "4");
  await wait(() => document.body.textContent?.includes("fixture apply failed") && ready(), "apply error toast");
  check(input(1).value === "8", "failed application rolls back visible startup value");
  edit(1, "3");
  await wait(() => snapshot.startupConcurrency === 3 && ready(), "retry uses refreshed compensated revision");
  edit(0, "45");
  await pause(30);
  state.showCard(false);
  await wait(() => !input() && snapshot.maxActive === 45, "navigation flushes valid pending edit");
  state.showCard(true);
  await wait(() => ready() && input().value === "45", "remount sees applied value");
  input().focus();
  check(document.activeElement === input(), "keyboard focus belongs to the edited control");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  return { writes: state.writes.length, revision: snapshot.revision, maxActive: snapshot.maxActive,
    startupConcurrency: snapshot.startupConcurrency, rollback: true, navigationFlush: true };
};
state.checkNativeCapacityGeometry = async (theme: string) => {
  document.documentElement.dataset.theme = theme;
  await pause(250);
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  const boxes = [...document.querySelectorAll<HTMLElement>('#settings-native-capacity input[type="number"], #settings-native-capacity [role="switch"]')]
    .map((element) => element.getBoundingClientRect());
  check(boxes.every((box) => box.left >= 0 && box.right <= innerWidth), `controls stay within viewport ${innerWidth}: ${JSON.stringify(boxes)}`);
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  const contextBoxes = [...document.querySelectorAll<HTMLElement>("#context-fixture span, #context-fixture button")]
    .map(element => element.getBoundingClientRect());
  check(contextBoxes.every(box => box.left >= 0 && box.right <= innerWidth), "context budget labels stay within viewport");
  return { theme, width: innerWidth, controls: boxes.length };
};
state.runNativeContextFixture = async () => {
  const text = () => document.querySelector("#context-fixture")!.textContent || "";
  const button = () => document.querySelector<HTMLButtonElement>("#context-fixture button");
  await wait(() => text().includes("尚未上报占用"), "unknown context");
  check(!text().includes("0%"), "unknown context must not look empty");
  const usage = { runtimeSessionId: "fixture-session", usedTokens: 64000, contextWindow: 128000,
    quality: "estimated" as const, source: "session_stats" as const, observedAt: 1 };
  state.setContext({ ...state.context, usage });
  await wait(() => text().includes("50%") && text().includes("估算"), "estimated context");
  check(!state.compacts, "observations never auto compact");
  button()!.click();
  await wait(() => state.compacts === 1, "manual compact dispatches only on click");
  state.setContext({ ...state.context, busy: true, usage: { ...usage, usedTokens: 0, quality: "exact" } });
  await wait(() => text().includes("0%") && text().includes("精确") && button()?.disabled, "exact zero and busy controls");
  state.setContext({ ...state.context, busy: false, usage: { ...usage, usedTokens: 125000 },
    capabilities: { ...state.context.capabilities, "context.compact.auto": false } });
  await wait(() => text().includes("接近上限"), "manual compression hint");
  state.setContext({ ...state.context, capabilities: { ...state.context.capabilities, "context.compact.native": false } });
  await wait(() => !button(), "capability hides unsupported compact");
  const product: ProductContextState = { automatic: "enabled", reason: null, summaryBindingId: "binding-pi", summaryRuntime: "pi", summaryModel: null,
    checkpointId: null, coveredThroughSeq: 0, pendingRunId: null, lastError: null, measurement: "restored", nativeAuto: "unknown", transfer: null,
    budget: { tokens: 128000, source: "runtime", triggerTokens: 102400, retainedTokens: 64000 } };
  state.setContext({ ...state.context, product });
  await wait(() => !!button() && text().includes("上次观测"), "restored observations and product-level manual action");
  state.setContext({ ...state.context, product: { ...product, pendingRunId: "summary-running" } });
  await wait(() => button()?.disabled && text().includes("摘要"), "pending product compaction disables duplicate submission");
  state.setContext({ ...state.context, usage: null, product: { ...product, measurement: "missing",
    budget: { tokens: 1000000, source: "fallback", triggerTokens: 800000, retainedTokens: 500000 } } });
  await wait(() => text().includes("上限未知") && text().includes("临时预算"), "unknown model has a labeled fallback");
  check(!text().includes("%"), "fallback must not invent a window percentage");
  state.setContext({ ...state.context, product: { ...product, measurement: "unsupported",
    budget: { tokens: 1048576, source: "model_spec", triggerTokens: 838860, retainedTokens: 524288 } } });
  await wait(() => text().includes("官方规格预算") && text().includes("CLI 未确认"), "published Gemini window is not a native observation");
  state.setContext({ ...state.context, usage, product: { ...product, measurement: "live",
    budget: { tokens: 1000000, source: "fallback", triggerTokens: 800000, retainedTokens: 500000 } } });
  await wait(() => text().includes("临时预算"), "unknown active window with a known usage count");
  check(!text().includes("%"), "known token usage cannot make an unconfirmed window percentage precise");
  check(text().includes("用量") && !text().includes(" / "), "usage precision stays separate from window provenance");
  const transfer: NonNullable<ProductContextState["transfer"]> = { state: "ready", targetBindingId: "pi", model: null,
    sourceRevision: 10, sourceSessionRevision: 2, snapshotId: "ctx-fixture", mode: "summary", errorCode: null, updatedAt: 1000 };
  for (const status of ["preparing", "ready", "accepted", "unknown", "failed"] as const) {
    state.setContext({ ...state.context, product: { ...product, transfer: { ...transfer, state: status } } });
    await wait(() => document.querySelector(`[data-transfer="${status}"]`), `handoff ${status}`);
  }
  state.setContext({ ...state.context, product: { ...product, transfer: { ...transfer, state: "accepted", mode: "partial" } } });
  await wait(() => text().includes("部分旧记录"), "incomplete legacy tool contents are visible");
  return { unknownHasNoPercent: true, estimated: true, exactZero: true, manualCompacts: state.compacts };
};
