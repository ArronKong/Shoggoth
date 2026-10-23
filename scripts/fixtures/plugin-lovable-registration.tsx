import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
const item = {
  id: "lovable", installationId: "bundled:lovable", displayName: "Lovable",
  shortDescription: "Source package description", category: "Design", version: "1.0.0",
  iconAvailable: false, components: { skills: 0, allSkillFiles: 0, apps: 1, mcp: 1 },
  converted: { skills: 0, mcp: 1 }, unconvertedMcp: [],
  importStatus: "needs-adapter", localAdapter: "shoggoth-lovable-official-mcp",
  installationState: "not-installed", installedReleaseDigest: null,
} as const;
const detail = {
  ...item, longDescription: "Source package description", developerName: "Lovable",
  websiteURL: null, license: null, prompts: [], sourceWarnings: [], skills: [],
  mcpServers: [{ name: "lovable", type: "streamable-http" }],
  connectionWarnings: [], apps: ["lovable"],
};
const preview = {
  sourceKind: "bundled", previewDigest: "fixture-lovable-release", expectedRevision: 0,
  specVersion: "1", name: "Lovable", declaredVersion: "1.0.0", installable: true,
  components: { skills: [], mcpServers: [{ name: "lovable", type: "streamable-http",
    descriptorDigest: "fixture-lovable-mcp" }] }, diagnostics: [],
};
type RequestRecord = { route: string; method: string; body: unknown };
const requests: RequestRecord[] = [];
const unexpected: string[] = [];
let configured = false;
let needsVerification = false;
let finishConfigure: ((response: Response) => void) | null = null;
let finishReconcile: ((response: Response) => void) | null = null;
let previewRequests = 0;
scope.fixtureErrors = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const route = String(input);
  const method = init?.method || "GET";
  if (route === "/__api/backends" && method === "GET") return Response.json({ backends: [] });
  if (route === "/__api/config" && method === "GET") {
    return Response.json({ config: { disabledBackends: [] } });
  }
  if (route.startsWith("/__api/plugins?backend=shoggoth") && method === "GET") {
    return Response.json({ page: { supported: true, catalogRevision: "fixture", items: [],
      nextCursor: null } });
  }
  if (route === "/__api/plugins/first-party" && method === "GET") return Response.json({ items: [] });
  if (route === "/__api/plugins/bundled" && method === "GET") {
    return Response.json({ batchDigest: "fixture", items: [item] });
  }
  if (route === "/__api/plugins/bundled/lovable" && method === "GET") {
    return Response.json({ detail });
  }
  if (route === "/__api/agents?backend=shoggoth&lifecycle=active" && method === "GET") {
    return Response.json({ agents: [] });
  }
  if (route === "/__api/plugins/lovable-registration-status" && method === "POST"
    && init?.body === "{}") {
    return Response.json({ configured, restartRequired: configured, needsVerification });
  }
  if (route === "/__api/plugins/lovable-registration-configure" && method === "POST") {
    requests.push({ route, method, body: JSON.parse(String(init?.body)) });
    return new Promise<Response>(resolve => { finishConfigure = resolve; });
  }
  if (route === "/__api/plugins/lovable-registration-reconcile" && method === "POST") {
    requests.push({ route, method, body: JSON.parse(String(init?.body)) });
    return new Promise<Response>(resolve => { finishReconcile = resolve; });
  }
  if (route === "/__api/plugins/bundled-preview" && method === "POST"
    && String(init?.body) === JSON.stringify({ packageId: "lovable" })) {
    previewRequests += 1;
    return Response.json({ canceled: false, preview, selectionHandle: "fixture-handle" });
  }
  if (route === "/__api/plugins/external-calls?backendId=all&limit=10"
    && method === "GET") return Response.json({ items: [], nextCursor: null });
  if (route === "/__api/plugins/external-approvals?backendId=all&limit=2"
    && method === "GET") return Response.json({ items: [], nextCursor: null });
  unexpected.push(method + " " + route);
  throw Error("Unexpected fixture request: " + method + " " + route);
};

const pause = () => new Promise(resolve => setTimeout(resolve, 25));
async function waitFor(predicate: () => unknown, message: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw Error(message);
    await pause();
  }
}
function check(value: unknown, message: string) { if (!value) throw Error(message); }
function card() { return document.querySelector<HTMLElement>('article')!; }
function dialog() { return document.querySelector<HTMLElement>('[role="dialog"]')!; }
function control() { return dialog().querySelector<HTMLElement>("[data-lovable-registration]")!; }

scope.prepareLovableCatalog = async () => {
  await waitFor(() => card()?.textContent?.includes("Lovable"), "Lovable catalog card loads");
  check(card().textContent?.includes("independent Lovable official MCP"),
    "catalog identifies the independent official MCP adapter");
  check(card().querySelector('[data-plugin-action="install"]')?.getAttribute("aria-label") === "Install Lovable", "catalog exposes the installation +");
  check(!document.querySelector('[role="dialog"]'), "catalog appears directly on the page");
  check(!card().querySelector<HTMLButtonElement>("button:last-child")?.disabled,
    "Lovable remains installable despite the source adapter gap");
  check(unexpected.length === 0, "catalog made only local fixture requests");
  return true;
};

scope.catalogGeometry = async (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
  await pause();
  const box = card().getBoundingClientRect();
  return { stage: "catalog", theme, viewport: window.innerWidth,
    fullWidth: document.documentElement.scrollWidth, cardLeft: box.left,
    cardRight: box.right, cardWidth: card().scrollWidth,
    cardClientWidth: card().clientWidth,
    background: getComputedStyle(card()).backgroundColor,
    textColor: getComputedStyle(card().querySelector("strong")!).color };
};

scope.openLovableDetailForm = async () => {
  card().querySelector<HTMLButtonElement>("button")!.click();
  await waitFor(() => Boolean(dialog()?.querySelector("[data-lovable-registration] button")),
    "Lovable detail and registration status load");
  check(dialog().textContent?.includes("Independent Lovable official MCP"),
    "detail identifies the independent MCP adapter");
  check(dialog().textContent?.includes("workspaces:read"),
    "detail exposes the requested read scope");
  check(!dialog().querySelector<HTMLButtonElement>("footer button:last-child")?.disabled,
    "detail exposes an enabled install preview entry");
  check(!control().querySelector("form"), "first registration starts closed");
  control().querySelector<HTMLButtonElement>("button")!.click();
  await waitFor(() => Boolean(control().querySelector("form")),
    "first registration form opens");
  const field = control().querySelector<HTMLInputElement>('input[name="redirectPort"]');
  check(field?.type === "number" && field.min === "1024" && field.max === "65535"
    && field.value === "45931", "form constrains the callback port");
  check(control().querySelectorAll("form input").length === 1,
    "first registration asks only for the local callback port");
  return true;
};

scope.detailGeometry = async (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
  control().scrollIntoView({ block: "center" });
  await new Promise(resolve => setTimeout(resolve, 100));
  const modal = dialog();
  const panel = control();
  const fields = [...panel.querySelectorAll<HTMLElement>("button, input, code")];
  const modalBox = modal.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  return { stage: "detail-form", theme, viewport: window.innerWidth,
    fullWidth: document.documentElement.scrollWidth,
    dialogLeft: modalBox.left, dialogRight: modalBox.right,
    dialogWidth: modal.scrollWidth, dialogClientWidth: modal.clientWidth,
    panelLeft: panelBox.left, panelRight: panelBox.right,
    panelWidth: panel.scrollWidth, panelClientWidth: panel.clientWidth,
    minFieldLeft: Math.min(...fields.map(field => field.getBoundingClientRect().left)),
    maxFieldRight: Math.max(...fields.map(field => field.getBoundingClientRect().right)),
    formVisible: Boolean(panel.querySelector("form")),
    background: getComputedStyle(panel).backgroundColor };
};

scope.submitLovableRegistration = async () => {
  const firstForm = control().querySelector("form")!;
  firstForm.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  await waitFor(() => !control().querySelector("form"), "Cancel closes the form");
  check(requests.length === 0, "Cancel contacts neither Lovable nor local configure");
  control().querySelector<HTMLButtonElement>("button")!.click();
  await waitFor(() => Boolean(control().querySelector("form")), "registration reopens");
  const field = control().querySelector<HTMLInputElement>('input[name="redirectPort"]')!;
  const submit = control().querySelector<HTMLButtonElement>('button[type="submit"]')!;
  field.value = "80";
  submit.click();
  await pause();
  check(requests.length === 0, "out-of-range port cannot reach local configure");
  field.value = "45931";
  submit.click();
  await waitFor(() => finishConfigure !== null, "first local configure request starts");
  check(JSON.stringify(requests[0]) === JSON.stringify({ route:
    "/__api/plugins/lovable-registration-configure", method: "POST",
    body: { redirectPort: 45931 } }), "request contains only the public callback port");
  finishConfigure!(Response.json({ canceled: true, configured: false, restartRequired: false }));
  finishConfigure = null;
  await waitFor(() => control().textContent?.includes("Registration canceled"),
    "canceled registration is shown");
  check(Boolean(control().querySelector("form")), "canceled registration remains editable");
  submit.click();
  await waitFor(() => finishConfigure !== null, "explicit second configure request starts");
  needsVerification = true;
  finishConfigure!(Response.json({ code: "LOVABLE_REGISTRATION_NEEDS_VERIFICATION",
    error: "Prior registration outcome unknown" }, { status: 409 }));
  finishConfigure = null;
  await waitFor(() => control().textContent?.includes("previous registration may have reached Lovable"),
    "unknown result blocks the registration form");
  check(!control().querySelector("form") && requests.filter(item =>
    item.route.endsWith("-configure")).length === 2,
  "unknown result leaves no duplicate registration action");
  control().querySelector<HTMLButtonElement>("button")!.click();
  await waitFor(() => finishReconcile !== null, "explicit reconciliation starts");
  check(JSON.stringify(requests.at(-1)?.body) === JSON.stringify({ reviewedRemoteOutcome: true }),
    "reconciliation sends only an explicit acknowledgement");
  finishReconcile!(Response.json({ canceled: true, configured: false,
    restartRequired: false, needsVerification: true }));
  finishReconcile = null;
  await pause();
  check(!control().querySelector("form"), "canceled reconciliation preserves the block");
  control().querySelector<HTMLButtonElement>("button")!.click();
  await waitFor(() => finishReconcile !== null, "approved reconciliation starts");
  needsVerification = false;
  finishReconcile!(Response.json({ canceled: false, configured: false,
    restartRequired: false, needsVerification: false }));
  finishReconcile = null;
  await waitFor(() => control().textContent?.includes("Register local client"),
    "successful reconciliation exposes a new explicit registration action");
  control().querySelector<HTMLButtonElement>("button")!.click();
  await waitFor(() => Boolean(control().querySelector("form")), "form reopens after reconciliation");
  control().querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await waitFor(() => finishConfigure !== null, "explicit third configure request starts");
  configured = true;
  finishConfigure!(Response.json({ canceled: false, configured: true,
    restartRequired: true, needsVerification: false }));
  finishConfigure = null;
  await waitFor(() => control().textContent?.includes("Restart Shoggoth"),
    "success asks for a restart");
  check(!control().querySelector("button") && !control().querySelector("form"),
    "configured registration has no overwrite action");
  check(requests.filter(item => item.route.endsWith("-configure")).length === 3
    && requests.filter(item => item.route.endsWith("-reconcile")).length === 2
    && JSON.stringify(requests.at(-1)?.body) === JSON.stringify({ redirectPort: 45931 })
    && unexpected.length === 0, "only explicit fixture actions occurred");
  return { canceledBeforeRequest: true, canceledReceipt: true, pendingBlocksRetry: true,
    configureRequests: 3, reconciliationRequests: 2,
    body: requests[0].body, restartPrompt: true };
};

scope.openLovableInstallPreview = async () => {
  dialog().querySelector<HTMLButtonElement>("footer button:last-child")!.click();
  await waitFor(() => previewRequests === 1 && !document.querySelector('[class*="embedded"]') && Boolean(document.querySelector('[role="dialog"]'))
    && Boolean(document.querySelector("[data-lovable-registration]")),
  "installer stays open for the Lovable preview");
  const previewControl = document.querySelector<HTMLElement>("[data-lovable-registration]")!;
  await waitFor(() => previewControl.textContent?.includes("Restart Shoggoth"),
    "preview shares configured restart status");
  check(previewControl.textContent?.includes("workspaces:read"),
    "preview preserves the read-only scope");
  check(!previewControl.querySelector("button"), "preview has no overwrite registration action");
  check(unexpected.length === 0, "no unexpected or remote requests occurred");
  return { previewRequests, configuredInPreview: true, unexpectedRequests: unexpected };
};

void applyConfiguredLocale("en").then(async () => {
  localStorage.setItem("shoggoth.ui.v1", JSON.stringify({ version: 1,
    values: { "backend.plugins": "shoggoth" } }));
  document.documentElement.dataset.theme = "light";
  const { default: PluginsPage } = await import("../../app/manage-ui/src/pages/PluginsPage");
  createRoot(document.getElementById("root")!).render(<MemoryRouter initialEntries={["/plugins"]}>
    <NavigationGuardProvider><PluginsPage /></NavigationGuardProvider>
  </MemoryRouter>);
}).catch(error => scope.fixtureErrors.push(String(error)));
