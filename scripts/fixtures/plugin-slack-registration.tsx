import React from "react";
import { SLACK_ACCESS_PROFILES } from "../../app/manage-ui/src/lib/slackAccessProfiles";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
const item = {
  id: "slack", installationId: "bundled:slack", displayName: "Slack",
  shortDescription: "Source package description", category: "Productivity", version: "1.0.0",
  iconAvailable: false, components: { skills: 0, allSkillFiles: 0, apps: 1, mcp: 1 },
  converted: { skills: 0, mcp: 0 },
  unconvertedMcp: [{ name: "slack", reasonCode: "LEGACY_MCP_FIELD_UNSUPPORTED" }],
  importStatus: "needs-adapter", localAdapter: "shoggoth-slack-official-mcp",
  installationState: "not-installed", installedReleaseDigest: null,
} as const;
const detail = {
  ...item, longDescription: "Source package description", developerName: "Slack",
  websiteURL: null, license: "MIT", prompts: [], sourceWarnings: [], skills: [],
  mcpServers: [], connectionWarnings: [], apps: ["slack"],
};
const preview = {
  sourceKind: "bundled", previewDigest: "fixture-slack-release", expectedRevision: 0,
  specVersion: "1", name: "Slack", declaredVersion: "1.0.0", installable: true,
  components: { skills: [], mcpServers: [{ name: "shoggoth-slack-official-mcp",
    type: "streamable-http", descriptorDigest: "fixture-slack-mcp" }] }, diagnostics: [],
};
type RequestRecord = { route: string; method: string; body: unknown };
const requests: RequestRecord[] = [];
const unexpected: string[] = [];
let configured = false;
let configuredProfile: string | null = null;
let finishConfigure: ((response: Response) => void) | null = null;
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
  if (route === "/__api/plugins/bundled/slack" && method === "GET") {
    return Response.json({ detail });
  }
  if (route === "/__api/agents?backend=shoggoth&lifecycle=active" && method === "GET") {
    return Response.json({ agents: [] });
  }
  if (route === "/__api/plugins/slack-registration-status" && method === "POST"
    && init?.body === "{}") {
    return Response.json({ configured, restartRequired: configured, accessProfile: configuredProfile });
  }
  if (route === "/__api/plugins/slack-registration-configure" && method === "POST") {
    requests.push({ route, method, body: JSON.parse(String(init?.body)) });
    return new Promise<Response>(resolve => { finishConfigure = resolve; });
  }
  if (route === "/__api/plugins/bundled-preview" && method === "POST"
    && String(init?.body) === JSON.stringify({ packageId: "slack" })) {
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
function control() { return dialog().querySelector<HTMLElement>("[data-slack-registration]")!; }

scope.prepareSlackCatalog = async () => {
  await waitFor(() => card()?.textContent?.includes("Slack"), "Slack catalog card loads");
  check(card().textContent?.includes("Slack") && card().textContent?.includes("official MCP"),
    "catalog identifies the official MCP entry");
  check(card().querySelector('[data-plugin-action="install"]')?.getAttribute("aria-label") === "Install Slack", "catalog exposes the installation +");
  check(!document.querySelector('[role="dialog"]'), "catalog appears directly on the page");
  check(!card().querySelector<HTMLButtonElement>("button:last-child")?.disabled,
    "Slack independent entry remains installable despite source adapter gap");
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

scope.openSlackDetailForm = async () => {
  card().querySelector<HTMLButtonElement>("button")!.click();
  await waitFor(() => Boolean(dialog()?.querySelector("[data-slack-registration] button")),
    "Slack detail and registration status load");
  check(dialog().textContent?.includes("Slack official MCP"),
    "detail identifies the official MCP entry");
  check(dialog().textContent?.includes("search:read.public"),
    "detail exposes the exact read-only user scope");
  check(dialog().textContent?.includes("workspace-admin approval"),
    "detail states the workspace approval gate");
  check(dialog().textContent?.includes("17 reviewed tools")
    && dialog().textContent?.includes("complete equivalence with the source managed app is unverified"),
    "detail states the reviewed tool coverage and remaining original-app acceptance");
  check(dialog().textContent?.includes("then choose account scopes")
    && dialog().textContent?.includes("grant the tools you need"),
    "detail explains the account and tool approval sequence");
  check(!dialog().querySelector<HTMLButtonElement>("footer button:last-child")?.disabled,
    "detail exposes an enabled install preview entry");
  control().querySelector<HTMLButtonElement>("button")!.click();
  await waitFor(() => Boolean(control().querySelector("form")),
    "first registration form opens");
  const clientId = control().querySelector<HTMLInputElement>('input[name="clientId"]');
  const port = control().querySelector<HTMLInputElement>('input[name="redirectPort"]');
  check(clientId?.type === "text" && port?.type === "number"
    && port.min === "1024" && port.max === "65535" && port.value === "49152",
  "form requests a public client ID and a bounded callback port");
  check(control().querySelectorAll("form input").length === 2,
    "registration does not ask for client secret or token");
  check(control().textContent?.includes("http://localhost:49152/oauth/callback"),
    "registration shows the exact initial callback URL");
  return true;
};

scope.detailGeometry = async (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
  control().scrollIntoView({ block: "center" });
  await new Promise(resolve => setTimeout(resolve, 100));
  const modal = dialog();
  const panel = control();
  const fields = [...panel.querySelectorAll<HTMLElement>("button, input, select, code")];
  const modalBox = modal.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  return { stage: "detail-form", profile: panel.querySelector<HTMLSelectElement>('select[name="accessProfile"]')?.value, theme, viewport: window.innerWidth,
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

scope.selectSlackProfile = async (profile: string) => {
  const select = control().querySelector<HTMLSelectElement>('select[name="accessProfile"]')!;
  check(Boolean(select) && select.options.length === 3, "three explicit profiles are available");
  check(select.labels?.length === 1, "profile selector has an accessible label");
  select.value = profile;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => select.value === profile && SLACK_ACCESS_PROFILES
    .find(item => item.id === profile)!.scopes.every(scope => control().textContent?.includes(scope)),
    "the selected profile displays its actual requested scopes");
  check(requests.length === 0, "selecting scopes does not save or connect an account");
  return { profile, scopeCount: SLACK_ACCESS_PROFILES.find(item => item.id === profile)!.scopes.length };
};

scope.submitSlackRegistration = async () => {
  const firstForm = control().querySelector("form")!;
  firstForm.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  await waitFor(() => !control().querySelector("form"), "Cancel closes the form");
  check(requests.length === 0, "Cancel contacts neither Slack nor local configure");
  control().querySelector<HTMLButtonElement>("button")!.click();
  await waitFor(() => Boolean(control().querySelector("form")), "registration reopens");
  const form = control().querySelector("form")!;
  const clientId = form.querySelector<HTMLInputElement>('input[name="clientId"]')!;
  const port = form.querySelector<HTMLInputElement>('input[name="redirectPort"]')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  clientId.value = "not-a-client-id";
  submit.click();
  await pause();
  check(requests.length === 0, "invalid client ID cannot reach local configure");
  clientId.value = "123456789.987654321";
  port.value = "80";
  submit.click();
  await pause();
  check(requests.length === 0, "out-of-range port cannot reach local configure");
  port.value = "49152";
  submit.click();
  await waitFor(() => finishConfigure !== null, "first local configure request starts");
  check(JSON.stringify(requests[0]) === JSON.stringify({ route:
    "/__api/plugins/slack-registration-configure", method: "POST",
    body: { clientId: "123456789.987654321", redirectPort: 49152,
      scopes: ["search:read.public"] } }), "request contains only public client registration fields");
  finishConfigure!(Response.json({ canceled: true, configured: false, restartRequired: false }));
  finishConfigure = null;
  await waitFor(() => control().textContent?.includes("configuration canceled"),
    "canceled registration is shown");
  check(Boolean(control().querySelector("form")), "canceled registration remains editable");
  const profileSelect = form.querySelector<HTMLSelectElement>('select[name="accessProfile"]')!;
  profileSelect.value = "workspace-write";
  profileSelect.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => control().textContent?.includes("canvases:write"), "explicit write scope selection renders");
  submit.click();
  await waitFor(() => finishConfigure !== null, "explicit second configure request starts");
  check(profileSelect.disabled, "permissions cannot change while saving");
  check(JSON.stringify((requests[1].body as any).scopes) === JSON.stringify(SLACK_ACCESS_PROFILES[2].scopes),
    "saving sends exactly the explicitly selected write profile");
  configured = true;
  configuredProfile = "workspace-write";
  finishConfigure!(Response.json({ canceled: false, configured: true, restartRequired: true }));
  finishConfigure = null;
  await waitFor(() => control().textContent?.includes("Restart Shoggoth"),
    "success asks for a restart");
  check(!control().querySelector("button") && !control().querySelector("form"),
    "configured registration has no overwrite action");
  check(requests.length === 2 && unexpected.length === 0,
    "only explicit fixture actions occurred");
  return { canceledBeforeRequest: true, canceledReceipt: true, configureRequests: 2,
    firstBody: requests[0].body, body: requests[1].body, restartPrompt: true };
};

scope.openSlackInstallPreview = async () => {
  dialog().querySelector<HTMLButtonElement>("footer button:last-child")!.click();
  await waitFor(() => previewRequests === 1 && !document.querySelector('[class*="embedded"]') && Boolean(document.querySelector('[role="dialog"]'))
    && Boolean(document.querySelector("[data-slack-registration]")),
  "installer stays open for the Slack preview");
  const previewControl = document.querySelector<HTMLElement>("[data-slack-registration]")!;
  await waitFor(() => previewControl.textContent?.includes("Restart Shoggoth"),
    "preview shares configured restart status");
  check(SLACK_ACCESS_PROFILES[2].scopes.every(scope => previewControl.textContent?.includes(scope)),
    "preview preserves the saved write scope without reverting to default");
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
