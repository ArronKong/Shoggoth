import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import AgentRuntimeBindings from "../../app/manage-ui/src/components/AgentRuntimeBindings";
import AgentDefaultRuntime from "../../app/manage-ui/src/components/AgentDefaultRuntime";
import RuntimeStatusList from "../../app/manage-ui/src/pages/settings/RuntimeStatusList";
import ChatModelMenu from "../../app/manage-ui/src/pages/ChatModelMenu";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
const state = window as any;
const first = "11111111-1111-8111-8111-111111111111";
const second = "22222222-2222-8222-8222-222222222222";
const makeBinding = (id: string, runtime: string) => ({ id, profileId: "profile-one", runtime,
  runtimeProfileId: `runtime-${id}`, runtimeAccountId: `account-${runtime}`, label: null, enabled: true, revision: 1, createdAt: 1, updatedAt: 1 });
let snapshot = { bindings: [makeBinding(first, "codex"), makeBinding(second, "pi")], defaultBindingId: first, revision: 1, canAdd: false };
const bundledCodex = { ...makeBinding(first, "codex"), runtimeAccountId: "shoggoth-internal-codex-default-v1" };
const nativeCodex = { ...makeBinding(second, "codex"), runtimeAccountId: "native-codex-default-v1" };
const defaultSnapshot = { bindings: [bundledCodex, nativeCodex], defaultBindingId: first, revision: 1,
  canAdd: false, availability: [
    { bindingId: first, available: true, reason: null },
    { bindingId: second, available: true, reason: null },
  ] };
const runtimeStatuses = [
  { backendId: "shoggoth", runtime: "codex", name: "Codex CLI", runtimeAccountId: "native-codex-default-v1",
    enabled: true, releaseEnabled: true, installation: "available" as const, serviceConnected: true },
  { backendId: "shoggoth", runtime: "pi", name: "Pi", runtimeAccountId: "native-pi-default-v1",
    enabled: false, releaseEnabled: true, installation: "unavailable" as const, serviceConnected: true },
];
state.writes = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
state.fetch = async (input: string, init?: RequestInit) => {
  if (String(input).includes("/__api/runtime-status")) return Response.json({ runtimes: runtimeStatuses });
  if (String(input).includes("default-agent")) return Response.json(defaultSnapshot);
  if (String(input).includes("runtime-policy")) return Response.json({ version: 1, revision: 0, mode: "fixed", allowedBindingIds: [], preferredBindingIds: [], affinity: true, weights: {}, compactionBindingId: null });
  if (String(input).includes("runtime-accounts")) return Response.json({ accounts: [{ id: "account-codex", runtime: "codex" }, { id: "account-pi", runtime: "pi" }], backups: [] });
  if (!init?.method) return Response.json(snapshot);
  const body = JSON.parse(String(init.body)); state.writes.push({ method: init.method, body });
  await pause(20);
  if (state.failNext) { state.failNext = false; snapshot.revision++; return Response.json({ code: "AGENT_BINDING_REVISION_CONFLICT", error: "fixture binding conflict" }, { status: 409 }); }
  if (body.revision !== snapshot.revision) throw Error("fixture stale revision");
  const url = new URL(String(input), "http://fixture");
  const isDefault = url.pathname.endsWith("/default");
  const id = isDefault ? url.pathname.split("/").at(-2)! : url.pathname.split("/").at(-1)!;
  let changed: any = snapshot.bindings.find((entry) => entry.id === id);
  snapshot = { ...snapshot, revision: snapshot.revision + 1 };
  if (init.method === "PATCH") { changed = { ...changed, ...body.patch, revision: snapshot.revision }; snapshot.bindings = snapshot.bindings.map((entry) => entry.id === id ? changed : entry); }
  else if (isDefault) snapshot.defaultBindingId = id;
  else if (init.method === "DELETE") { snapshot.bindings = snapshot.bindings.filter((entry) => entry.id !== id); changed = null; }
  else { changed = { ...makeBinding("33333333-3333-8333-8333-333333333333", body.spec.runtime), ...body.spec, revision: snapshot.revision }; snapshot.bindings = [...snapshot.bindings, changed]; }
  return Response.json({ ...snapshot, binding: changed });
};
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = performance.now() + 5000;
  while (!predicate()) { if (performance.now() > deadline) throw Error(label); await pause(10); }
};
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
function Fixture() {
  const [version, setVersion] = useState(0); state.reload = () => setVersion((value) => value + 1);
  return <UiProvider><main className="page management-page" style={{ maxWidth: 1000, margin: "auto" }}>
    <AgentRuntimeBindings key={version} backend="fixture-native" agentId={`agent-${version}`} />
    <AgentDefaultRuntime backend="fixture-native" agentId="default-agent" onChanged={() => {}} />
    <RuntimeStatusList runtimes={runtimeStatuses} loading={false} error={false} busy={false} onToggle={() => {}} />
    <ChatModelMenu models={[
      { id: "gpt-fixture", name: "GPT Fixture", runtime: "codex", runtimeName: "Codex Harness", bindingId: first },
      { id: "gpt-fixture", name: "GPT Fixture", runtime: "codex", runtimeName: "Codex CLI", bindingId: second },
    ]} activeModel="gpt-fixture" activeBindingId={first} onSelect={(_id, _provider, bindingId) => { state.modelBinding = bindingId; }}
    runtimeGroups={[
      { runtime: "codex", bindingId: first, name: "Codex Harness", available: true },
      { runtime: "codex", bindingId: second, name: "Codex CLI", available: true },
    ]} />
  </main></UiProvider>;
}
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<Fixture />);
const row = (id: string) => document.querySelector<HTMLElement>(`[data-binding-id="${id}"]`)!;
const button = (name: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === name)!;
const toggle = (id: string) => row(id).querySelector<HTMLElement>('[role="switch"]')!;
const ready = () => !!row(first) && !row(first).closest("section")?.getAttribute("aria-busy")?.includes("true");
const edit = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
state.runBindingFixture = async () => {
  await wait(ready, "load bindings");
  check(!button("添加绑定"), "flag off hides add only");
  check(toggle(first).hasAttribute("disabled") || toggle(first).getAttribute("aria-disabled") === "true", "default disable protected");
  check(!button("删除", row(first)), "default removal hidden");
  state.failNext = true; toggle(second).click();
  await wait(() => document.body.textContent?.includes("fixture binding conflict") && ready(), "conflict refresh toast");
  check(toggle(second).getAttribute("aria-checked") === "true", "failed toggle retains server state");
  toggle(second).click(); await wait(() => !snapshot.bindings[1].enabled && ready(), "disable");
  check(button("设为默认", row(second)).disabled, "disabled binding cannot become default");
  toggle(second).click(); await wait(() => snapshot.bindings[1].enabled && ready(), "enable");
  button("设为默认", row(second)).click(); await wait(() => snapshot.defaultBindingId === second && ready(), "set default");
  button("改名", row(second)).click(); await pause(20);
  edit(row(second).querySelector<HTMLInputElement>("input.field-input")!, "Pi 工作账号"); await pause(20);
  button("保存", row(second)).click(); await wait(() => row(second).textContent?.includes("Pi 工作账号") && ready(), "rename");
  snapshot.canAdd = true; state.reload(); await wait(() => !!button("添加绑定"), "enable add capability");
  button("添加绑定").click(); await pause(20);
  const addButtons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((entry) => entry.textContent === "添加绑定");
  addButtons[1].click(); await wait(() => snapshot.bindings.length === 3 && ready(), "add binding");
  const added = snapshot.bindings[2].id;
  button("删除", row(added)).click(); await wait(() => !!document.querySelector('[role="alertdialog"]'), "delete confirmation");
  button("删除", document.querySelector('[role="alertdialog"]')!).click(); await wait(() => snapshot.bindings.length === 2 && ready(), "delete");
  return { writes: state.writes.length, revision: snapshot.revision, protectedDefault: true, conflictRefresh: true };
};
state.checkBindingGeometry = async (theme: string) => {
  document.documentElement.dataset.theme = theme; await pause(250); await new Promise(requestAnimationFrame);
  check(document.documentElement.scrollWidth <= innerWidth, "binding card horizontal overflow");
  const control = row(first).querySelector<HTMLButtonElement>("button")!; control.focus();
  check(document.activeElement === control, "keyboard focus");
  return { width: innerWidth, theme, overflow: false };
};
state.checkOnboardingRuntime = async () => {
  await wait(() => !!document.querySelector('[data-runtime="pi"]')
    && !!document.querySelector('button[title="默认 Runtime"]'), "runtime UI load");
  const missing = document.querySelector<HTMLElement>('[data-runtime="pi"]')!;
  check(missing.textContent?.includes("未安装 CLI"), "missing CLI must show installation hint");
  check(!missing.querySelector("button"), "missing CLI cannot reconnect");
  const trigger = document.querySelector<HTMLButtonElement>('button[title="默认 Runtime"]')!;
  check(trigger.textContent?.includes("Codex Harness"), "bundled default is labeled Codex Harness");
  trigger.click();
  await wait(() => [...document.querySelectorAll('[role="option"]')].some(option =>
    option.textContent?.includes("Codex CLI（本机安装）")), "separate native Codex option");
  const names = [...document.querySelectorAll('[role="option"]')].map(option => option.textContent?.trim());
  check(names.some(name => name?.includes("Codex Harness（Shoggoth 内置）")), "bundled option stays distinct");
  check(names.some(name => name?.includes("Codex CLI（本机安装）")), "native CLI option stays distinct");
  document.querySelector<HTMLButtonElement>(".chat-pill--model")!.click();
  await wait(() => document.querySelectorAll(".model-menu__label").length === 2, "separate Codex model groups");
  const groups = [...document.querySelectorAll(".model-menu__label")].map(entry => entry.textContent?.trim());
  check(groups.join("|") === "Codex Harness|Codex CLI", "model menu groups are account-scoped");
  document.querySelectorAll<HTMLButtonElement>(".model-menu__item")[1].click();
  check(state.modelBinding === second, "native Codex model retains its own binding ID");
  return { missingCliBlocked: true, harnessAndCliDistinct: true, modelGroupsDistinct: true };
};
