import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import SettingsAgentPermission from "../../app/manage-ui/src/pages/settings/SettingsAgentPermission";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import {
  followsGlobalPermission,
  GLOBAL_PERMISSION_MODES,
  normalizeGlobalPermissionMode,
  sessionPermissionModeFor,
} from "../../app/manage-ui/src/lib/globalPermissionMode";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import type { AppConfig, ChatPermissionModeOption } from "../../app/manage-ui/src/types";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/pages/SettingsPage.css";
import "../../app/manage-ui/src/pages/settings/SettingsLayout.css";
import "../../app/manage-ui/src/pages/settings/SettingsCards.css";

const state = window as unknown as {
  permissionCatalog: Record<string, ChatPermissionModeOption[]>;
  runPermissionFixture: () => Promise<unknown>;
};
// Backends outside the Shoggoth service publish their own options.
const openclaw: ChatPermissionModeOption[] = [
  { id: "read-only", label: "Read only", risk: "safe" },
  { id: "guarded", label: "Guarded", risk: "standard" },
  { id: "workspace", label: "Workspace", risk: "elevated" },
  { id: "full", label: "Full access", risk: "danger" },
];
const hermes: ChatPermissionModeOption[] = [
  { id: "inherit", label: "Inherit", risk: "standard" },
  { id: "yolo", label: "YOLO", risk: "danger" },
];
const saves: Array<Partial<AppConfig>> = [];

function Fixture() {
  const [cfg, setCfg] = useState({ chatPermissionMode: undefined } as unknown as AppConfig);
  return <main className="page management-page settings-page" style={{ margin: "40px auto", width: "min(720px, calc(100% - 48px))" }}>
    <p>当前设置：<output data-selected>{normalizeGlobalPermissionMode(cfg.chatPermissionMode)}</output></p>
    <SettingsAgentPermission cfg={cfg} disabled={false} onChange={(patch) => {
      saves.push(patch); setCfg((current) => ({ ...current, ...patch }));
    }} />
  </main>;
}
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<UiProvider><Fixture /></UiProvider>);
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const wait = async (predicate: () => unknown, message: string) => {
  const deadline = performance.now() + 4000;
  while (!predicate()) { if (performance.now() > deadline) throw Error(message); await pause(); }
};
const radios = () => [...document.querySelectorAll<HTMLInputElement>('input[name="settings-agent-permission"]')];
const selected = () => document.querySelector("[data-selected]")?.textContent;
state.runPermissionFixture = async () => {
  await wait(() => radios().length, "Settings permission choices render");
  check([...document.querySelectorAll("label[data-mode]")].map(item => item.querySelector("span span")?.textContent).join("|")
    === "请求批准|帮我批准|完全访问权限", "exactly three localized choices");
  check(radios()[1].checked && selected() === "auto-review", "missing setting shows the default automatic review");
  check(document.querySelector('[role="radiogroup"]')?.getAttribute("aria-labelledby") === "settings-agent-permission-title",
    "choices are one labelled group");
  radios()[2].click(); await wait(() => selected() === "full-access", "full access saved");
  check(!document.querySelector('[role="alertdialog"], [role="dialog"]'), "full access has no confirmation dialog");
  radios()[2].click(); await pause();
  radios()[0].click(); await wait(() => selected() === "request-approval", "request approval saved");
  check(saves.length === 2 && saves.every(patch => Object.keys(patch).join() === "chatPermissionMode"),
    "each explicit choice saves only the permission field, once");
  check(normalizeGlobalPermissionMode("workspace-auto") === "auto-review", "unknown saved values fall back to the default");

  // Every Shoggoth runtime exposes the three choices directly.
  for (const [runtime, options] of Object.entries(state.permissionCatalog)) {
    for (const mode of GLOBAL_PERMISSION_MODES) {
      check(sessionPermissionModeFor(mode, options) === mode, `${runtime} maps ${mode} directly`);
    }
  }
  const mapped = (options: ChatPermissionModeOption[]) => GLOBAL_PERMISSION_MODES.map(mode => sessionPermissionModeFor(mode, options)).join("|");
  check(mapped(openclaw) === "guarded|workspace|full", "OpenClaw uses its closest native options");
  check(mapped(hermes) === "inherit|inherit|yolo", "Hermes falls back to its stricter option");
  check(sessionPermissionModeFor("full-access", []) === null && sessionPermissionModeFor("auto-review", undefined) === null,
    "backends without permission options are left alone");

  // Scheduled tasks and inspiration notes keep their own (full access) rules.
  const uuid = "11111111-1111-4111-8111-111111111111";
  check(followsGlobalPermission({ key: `agent:shoggoth-a:${uuid}`, kind: "direct" }), "ordinary native chats follow Settings");
  check(followsGlobalPermission({ key: "agent:main:main" }) && followsGlobalPermission({ key: `agent:hermes-a:dashboard:${uuid}` }),
    "main and web chats follow Settings");
  for (const [label, row] of Object.entries({
    nativeCron: { key: `agent:shoggoth-a:${uuid}`, kind: "cron" },
    gatewayCron: { key: "agent:main:cron:daily-report" },
    kanban: { key: "agent:main:kanban:t_1", source: "kanban" },
    nativeInspiration: { key: `agent:shoggoth-a:${uuid}`, kind: "direct", inspirationId: "idea-1" },
    inspirationKey: { key: "agent:main:inspiration:idea-1" },
    legacyHermesInspiration: { key: `agent:hermes-a:${uuid}`, title: "这是用户当前委派的灵感任务。请推进。" },
  })) check(!followsGlobalPermission(row), `${label} sessions are not changed by Settings`);
  return { runtimes: Object.keys(state.permissionCatalog).length, options: 3, saves: saves.length,
    fullAccessWithoutDialog: true, openclawMapped: true, hermesMapped: true, tasksAndInspirationExcluded: true };
};
