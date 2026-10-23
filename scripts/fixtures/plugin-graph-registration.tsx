import React from "react";
import { createRoot } from "react-dom/client";
import { PluginGraphRegistration } from "../../app/manage-ui/src/pages/PluginGraphRegistration";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
const CLIENT_ID = "12345678-1234-1234-1234-123456789abc";
const packages = ["sharepoint", "outlook-calendar", "outlook-email", "teams"] as const;
const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
let configured = false;
let orphanedAccount = false;
let complete: ((response: Response) => void) | null = null;
scope.fixtureErrors = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
window.fetch = async (input, init) => {
  const route = String(input);
  if (route === "/__api/plugins/graph-registration-status" && init?.method === "POST"
    && init.body === "{}") return orphanedAccount
      ? Response.json({ code: "GRAPH_REGISTRATION_CONFLICT" }, { status: 409 })
      : Response.json({ configured, restartRequired: configured });
  if (route === "/__api/plugins/graph-registration-configure" && init?.method === "POST") {
    requests.push({ route, body: JSON.parse(String(init.body)) });
    return new Promise<Response>(resolve => { complete = resolve; });
  }
  throw Error(`Unexpected request: ${route}`);
};
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function wait(predicate: () => unknown, message: string) {
  const deadline = performance.now() + 4000;
  while (!predicate()) { if (performance.now() > deadline) throw Error(message); await pause(); }
}
function control(packageId: string, group = "preview") {
  return document.querySelector<HTMLElement>(`#${group} [data-graph-registration][data-package-id="${packageId}"]`)!;
}
function check(value: unknown, message: string) { if (!value) throw Error(message); }

scope.prepareGraphRegistration = async () => {
  await wait(() => packages.every(id => control(id)?.querySelector("button")), "four preview controls load status");
  for (const [id, permission] of Object.entries({ sharepoint: "Sites.Read.All",
    "outlook-calendar": "Calendars.Read", "outlook-email": "Mail.ReadBasic",
    teams: "Chat.ReadBasic" })) {
    const card = control(id);
    check(card.textContent?.includes(permission), `${id} functional permission is visible`);
    check(card.textContent?.includes("http://localhost"), `${id} desktop redirect is fixed`);
  }
  check(control("sharepoint").textContent?.includes("every site"), "broad Sites.Read.All scope is explicit");
  control("sharepoint").querySelector<HTMLButtonElement>("button")!.click();
  await wait(() => !!control("sharepoint").querySelector("form"), "Graph registration form opens");
  check(control("sharepoint").querySelectorAll("form input").length === 1, "only the public ID is input");
  check(control("sharepoint").querySelector<HTMLInputElement>("form input")?.name === "clientId",
    "client ID field is the only input");
  return true;
};

scope.graphGeometry = async (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
  await new Promise(resolve => setTimeout(resolve, 250));
  const fields = [...document.querySelectorAll<HTMLElement>("[data-graph-registration] button, [data-graph-registration] input, [data-graph-registration] code")];
  const maxRight = Math.max(...fields.map(node => node.getBoundingClientRect().right));
  const minLeft = Math.min(...fields.map(node => node.getBoundingClientRect().left));
  return { theme, viewport: window.innerWidth, fullWidth: document.documentElement.scrollWidth,
    maxRight, minLeft, formVisible: !!control("sharepoint").querySelector("form"),
    background: getComputedStyle(control("sharepoint")).backgroundColor };
};

scope.submitGraphRegistration = async () => {
  const card = control("sharepoint");
  const input = card.querySelector<HTMLInputElement>("form input")!;
  const submit = card.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
  input.value = "not-a-guid";
  submit.click();
  await pause();
  check(requests.length === 0, "invalid ID is rejected before the request");
  input.value = CLIENT_ID;
  submit.click();
  await wait(() => complete !== null, "first confirmation request starts");
  check(JSON.stringify(requests[0].body) === JSON.stringify({ clientId: CLIENT_ID }),
    "request contains only the public client ID");
  complete!(Response.json({ canceled: true, configured: false, restartRequired: false }));
  complete = null;
  await wait(() => card.textContent?.includes("Registration canceled"), "cancel remains visible");
  check(!!card.querySelector("form"), "canceled registration remains editable");
  submit.click();
  await wait(() => complete !== null, "explicit second confirmation request starts");
  configured = true;
  complete!(Response.json({ canceled: false, configured: true, restartRequired: true }));
  complete = null;
  await wait(() => [...document.querySelectorAll("[data-graph-registration]")].every(node =>
    node.textContent?.includes("Restart Shoggoth")), "all preview and installed controls share status");
  check([...document.querySelectorAll("[data-graph-registration]")].every(node =>
    !node.querySelector("button")), "configured registration has no overwrite action");
  return { requests: requests.length, sharedControls: document.querySelectorAll("[data-graph-registration]").length };
};

scope.verifyOrphanedGraphAccount = async () => {
  orphanedAccount = true;
  const container = document.createElement("div");
  container.id = "orphaned-account";
  document.body.append(container);
  createRoot(container).render(<PluginGraphRegistration packageId="teams" />);
  await wait(() => container.textContent?.includes("saved account already exists"),
    "orphaned account conflict is shown at first status read");
  check(!container.querySelector("button"), "orphaned account cannot open registration form");
  check(requests.length === 2, "orphaned account never sends configure request");
  return true;
};

void applyConfiguredLocale("en").then(() => {
  document.documentElement.dataset.theme = "light";
  createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: 850,
    margin: "0 auto", padding: "16px", display: "grid", gap: 20 }}>
    <section id="preview" style={{ display: "grid", gap: 12 }}>
      <h1 style={{ fontSize: 19, margin: 0 }}>Graph card preview</h1>
      {packages.map(id => <PluginGraphRegistration key={id} packageId={id} />)}
    </section>
    <section id="installed" style={{ display: "grid", gap: 12 }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Installed Graph entry</h2>
      <PluginGraphRegistration packageId="sharepoint" />
    </section>
  </main>);
});
