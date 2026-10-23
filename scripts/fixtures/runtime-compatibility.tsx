import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import RuntimeStatusList from "../../app/manage-ui/src/pages/settings/RuntimeStatusList";
import OAuthProvidersCard from "../../app/manage-ui/src/pages/keys/OAuthProvidersCard";
import AgentDefaultRuntime from "../../app/manage-ui/src/components/AgentDefaultRuntime";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import type { RuntimeStatus } from "../../app/manage-ui/src/types";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "../../app/manage-ui/src/pages/SettingsPage.css";
import "../../app/manage-ui/src/pages/settings/SettingsLayout.css";
import "../../app/manage-ui/src/pages/settings/SettingsOperations.css";
import "../../app/manage-ui/src/pages/settings/SettingsCards.css";

const scope = window as any;
const rows: RuntimeStatus[] = ["codex", "pi", "claude-code", "grok-build", "opencode", "deepseek-harness", "antigravity"].map(runtime => ({
  backendId: "shoggoth", runtime, name: runtime === "pi" ? "Pi" : runtime,
  runtimeAccountId: `native-${runtime}-default-v1`, enabled: true, releaseEnabled: runtime !== "claude-code",
  installation: runtime === "deepseek-harness" ? "unavailable" : "available",
  serviceConnected: runtime !== "antigravity", readiness: runtime === "codex" ? "ready"
    : runtime === "pi" ? "incompatible" : runtime === "opencode" ? "auth-required" : "unverified",
}));
let rechecks = 0, writes = 0;
const bindings = ["codex", "pi"].map(runtime => ({ id: runtime, runtime, runtimeAccountId: `native-${runtime}-default-v1`, label: runtime, enabled: true }));
scope.fetch = async (input: string, init?: RequestInit) => {
  const route = new URL(String(input), "http://fixture.invalid").pathname;
  if (init?.method && init.method !== "GET") { writes++; throw Error("No mutation expected"); }
  if (route.includes("runtime-bindings")) return Response.json({ bindings, defaultBindingId: "codex", revision: 1, availability: [] });
  if (route.includes("runtime-status")) return Response.json({ runtimes: rows });
  if (route.includes("oauth")) {
    rechecks++;
    return Response.json({ profiles: [], providers: [{ id: "native-pi-default-v1", name: "Pi", flow: "external",
      cliCommand: "pi auth login", docsUrl: "", disconnectable: false, connection: { id: "pi", enabled: true },
      status: { loggedIn: false, error: "Current CLI is incompatible", verification: "incompatible", expiresAt: null } }] });
  }
  return Response.json({});
};
function Fixture() {
  const [current, setCurrent] = useState(rows);
  return <UiProvider><main className="management-page settings-page" style={{ padding: 16, maxWidth: 1000, margin: "0 auto" }}>
    <RuntimeStatusList runtimes={current} loading={false} error={false} busy={false}
      onToggle={runtime => setCurrent(value => value.map(row => row.runtime === runtime.runtime ? { ...row, enabled: !row.enabled } : row))} />
    <OAuthProvidersCard backend="shoggoth-compatibility" showActionLabels />
    <AgentDefaultRuntime backend="shoggoth" agentId="fixture" onChanged={() => { writes++; }} />
  </main></UiProvider>;
}
const wait = async (predicate: () => unknown, label = "UI fixture") => {
  const until = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > until) throw Error(`${label} did not settle`); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<Fixture />);
scope.verifyRuntimeCompatibility = async (locale: string) => {
  await applyConfiguredLocale(locale);
  const zh = locale === "zh-CN";
  await wait(() => document.querySelector('[data-runtime="pi"]')?.textContent?.includes(zh ? "版本不兼容" : "Incompatible"), "locale");
  const text = (runtime: string) => document.querySelector(`[data-runtime="${runtime}"]`)!.textContent!;
  check(text("codex").includes(zh ? "已就绪" : "Ready"), "only verified CLI is ready");
  check(text("grok-build").includes(zh ? "尚未验证" : "Not verified"), "unverified is explicit");
  check(text("opencode").includes(zh ? "需要登录" : "Sign-in required"), "signed out is distinct");
  check(document.querySelectorAll(".settings-cli-tile.is-healthy").length === 1, "no false green status");
  await wait(() => [...document.querySelectorAll("button")].some(button => button.title === (zh ? "重试" : "Retry")));
  const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.title === (zh ? "重试" : "Retry"))!;
  const before = rechecks; retry.click(); await wait(() => rechecks > before, "read-only recheck");
  check(writes === 0, "recheck never starts login, config or a turn");
  await wait(() => document.querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled === false, "default Runtime selector");
  const select = document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  select.click(); await wait(() => document.querySelector('[role="option"]'), "Runtime options");
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  check(options.length === 1 && options[0].textContent?.includes("codex"), "only compatible target is selectable");
  options[0].click();
  await wait(() => select.getAttribute("aria-expanded") !== "true", "Runtime selector close");
  window.scrollTo(0, 0); await new Promise(resolve => setTimeout(resolve, 250));
  check(document.documentElement.scrollWidth <= innerWidth + 1, "no horizontal overflow");
  for (const tile of document.querySelectorAll<HTMLElement>(".settings-cli-tile")) {
    const box = tile.getBoundingClientRect(); check(box.left >= 0 && box.right <= innerWidth + 1, "tile fits viewport");
  }
  return { locale, width: innerWidth, ready: 1, states: 7, recheckReadOnly: true, overflow: false };
};
