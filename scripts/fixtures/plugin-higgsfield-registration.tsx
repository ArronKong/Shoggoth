import React from "react";
import { createRoot } from "react-dom/client";
import { PluginHiggsfieldRegistration } from "../../app/manage-ui/src/pages/PluginHiggsfieldRegistration";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
type Scenario = "unconfigured" | "pending" | "configured" | "unavailable" | "conflict";
let scenario: Scenario = "unconfigured";
let generation = 0;
let configureResolve: ((value: Response) => void) | null = null;
const requests: Array<{ route: string; body: unknown }> = [];
scope.fixtureErrors = [];
scope.fixtureRequests = requests;
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));

window.fetch = async (input, init) => {
  const route = String(input);
  const body = JSON.parse(String(init?.body || "{}"));
  if (init?.method !== "POST") throw Error(`Unexpected method for ${route}`);
  if (route === "/__api/plugins/higgsfield-registration-status") {
    if (JSON.stringify(body) !== "{}") throw Error("Status request must have an empty body");
    if (scenario === "unavailable") return Response.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 });
    if (scenario === "conflict") return Response.json({ code: "HIGGSFIELD_REGISTRATION_CONFLICT" }, { status: 409 });
    return Response.json({ configured: scenario === "configured", restartRequired: scenario === "configured",
      needsVerification: scenario === "pending" });
  }
  if (route === "/__api/plugins/higgsfield-registration-configure") {
    requests.push({ route, body });
    return new Promise<Response>(resolve => { configureResolve = resolve; });
  }
  if (route === "/__api/plugins/higgsfield-registration-reconcile") {
    requests.push({ route, body });
    scenario = "unconfigured";
    return Response.json({ canceled: false, configured: false, restartRequired: false,
      needsVerification: false });
  }
  throw Error(`Unexpected request: ${route}`);
};

const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function wait(predicate: () => unknown, message: string) {
  const deadline = performance.now() + 4000;
  while (!predicate()) { if (performance.now() > deadline) throw Error(message); await pause(); }
}
const root = createRoot(document.getElementById("root")!);
function control() { return document.querySelector<HTMLElement>("[data-higgsfield-registration]"); }
function render() {
  root.render(<main className="management-page" data-fixture-generation={generation}
    style={{ maxWidth: 740, margin: "0 auto", padding: 16 }}>
    <PluginHiggsfieldRegistration key={generation} />
  </main>);
}
scope.setHiggsfieldScenario = async (next: Scenario) => {
  scenario = next;
  generation++;
  render();
  await wait(() => {
    const card = control();
    if (!card || document.querySelector("main")?.dataset.fixtureGeneration !== String(generation)) return false;
    if (next === "unconfigured") return !!card.querySelector("button[aria-expanded]");
    if (next === "pending") return !!card.querySelector("[role=alert]") && !!card.querySelector("button:not([aria-expanded])");
    if (next === "configured") return !!card.querySelector("[role=status]") && !card.querySelector("button");
    return !!card.querySelector("[role=alert]") && !card.querySelector("button");
  }, `${next} state rendered`);
  return { scenario: next, text: control()!.innerText, buttons: control()!.querySelectorAll("button").length };
};
scope.higgsfieldFocusOpen = () => {
  const button = control()?.querySelector<HTMLButtonElement>("button[aria-expanded]");
  if (!button) throw Error("registration disclosure missing");
  button.focus();
  return document.activeElement === button;
};
scope.higgsfieldFocusCancel = () => {
  const button = control()?.querySelector<HTMLButtonElement>('form button[type="button"]');
  if (!button) throw Error("cancel button missing");
  button.focus();
  return document.activeElement === button;
};
scope.higgsfieldFormState = async () => {
  await wait(() => !!control()?.querySelector("form"), "form opened by keyboard");
  const card = control()!;
  const input = card.querySelector<HTMLInputElement>("form input")!;
  const label = card.querySelector<HTMLLabelElement>("form label")!;
  return { expanded: card.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded"),
    labelAssociated: label.control === input, inputType: input.type, min: input.min, max: input.max,
    active: document.activeElement === card.querySelector("button[aria-expanded]") ? "disclosure" : document.activeElement?.tagName };
};
scope.higgsfieldActive = () => {
  const card = control()!;
  const input = card.querySelector("form input");
  const disclosure = card.querySelector("button[aria-expanded]");
  if (document.activeElement === input) return "input";
  if (document.activeElement === disclosure) return "disclosure";
  if (document.activeElement === document.body) return "body";
  return document.activeElement?.tagName || null;
};
scope.higgsfieldSubmit = async () => {
  const card = control()!;
  const input = card.querySelector<HTMLInputElement>("form input")!;
  input.value = "45932";
  card.querySelector<HTMLButtonElement>('form button[type="submit"]')!.click();
  await wait(() => configureResolve !== null, "configure request sent");
  const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")];
  return { requests: requests.length, body: requests.at(-1)?.body,
    pendingButtonsDisabled: buttons.every(button => button.disabled),
    pendingText: card.textContent?.includes("Registering") };
};
scope.higgsfieldInvalidPort = async () => {
  const card = control()!;
  const input = card.querySelector<HTMLInputElement>("form input")!;
  input.value = "1023";
  card.querySelector<HTMLButtonElement>('form button[type="submit"]')!.click();
  await pause();
  return { invalid: input.validity.rangeUnderflow, requests: requests.length };
};
scope.higgsfieldResolveCanceled = async () => {
  configureResolve!(Response.json({ canceled: true, configured: false, restartRequired: false,
    needsVerification: false }));
  configureResolve = null;
  await wait(() => control()?.textContent?.includes("Registration canceled"), "canceled state visible");
  return { formOpen: !!control()?.querySelector("form"), status: control()?.querySelector("[role=status]")?.textContent };
};
scope.higgsfieldReconcile = async () => {
  control()!.querySelector<HTMLButtonElement>("button")!.click();
  await wait(() => !!control()?.querySelector("button[aria-expanded]"), "reconciliation unlocks registration");
  return { body: requests.at(-1)?.body, requests: requests.length };
};
scope.higgsfieldGeometry = async (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
  await new Promise(resolve => setTimeout(resolve, 120));
  const card = control()!;
  const rect = card.getBoundingClientRect();
  const nodes = [...card.querySelectorAll<HTMLElement>("button,input,code")];
  const bounds = nodes.map(node => node.getBoundingClientRect());
  return { scenario, theme, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    cardLeft: rect.left, cardRight: rect.right, cardBottom: rect.bottom,
    minLeft: Math.min(...bounds.map(value => value.left)), maxRight: Math.max(...bounds.map(value => value.right)),
    background: getComputedStyle(card).backgroundColor };
};
void applyConfiguredLocale("en").then(() => {
  document.documentElement.dataset.theme = "light";
  render();
});
