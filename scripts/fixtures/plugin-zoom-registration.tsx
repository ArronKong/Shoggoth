import React from "react";
import { createRoot } from "react-dom/client";
import { PluginZoomRegistration } from "../../app/manage-ui/src/pages/PluginZoomRegistration";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
const secret = "fixture-zoom-client-secret-v1";
let resolveConfigure: ((response: Response) => void) | null = null;
let submitted: Record<string, unknown> | null = null;
scope.fetch = async (url: string, init?: RequestInit) => {
  if (url.endsWith("/zoom-registration-status")) {
    return Response.json({ configured: false, restartRequired: false });
  }
  if (url.endsWith("/zoom-registration-configure")) {
    submitted = JSON.parse(String(init?.body));
    return new Promise<Response>(resolve => { resolveConfigure = resolve; });
  }
  throw Error("unexpected fixture request");
};
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await pause();
  }
  throw Error("Zoom UI fixture timed out");
}

scope.prepareZoomRegistration = async () => {
  await waitFor(() => Boolean(document.querySelector("[data-zoom-registration] button")));
  const button = document.querySelector<HTMLButtonElement>("[data-zoom-registration] button")!;
  button.click();
  await waitFor(() => Boolean(document.querySelector("#plugin-zoom-client-secret")));
  const set = (id: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(id)!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set("#plugin-zoom-client-id", "shoggoth-zoom-fixture-client");
  set("#plugin-zoom-client-secret", secret);
  set("#plugin-zoom-redirect-port", "39742");
  document.querySelector<HTMLInputElement>('input[value="meeting:read:search"]')!.click();
  return scope.zoomGeometry();
};
scope.zoomGeometry = () => {
  const control = document.querySelector<HTMLElement>("[data-zoom-registration]")!;
  const form = control.querySelector("form");
  const fields = [...control.querySelectorAll<HTMLElement>("button, input, label, fieldset")];
  const fullWidth = document.documentElement.scrollWidth;
  const maxRight = Math.max(...fields.map(node => node.getBoundingClientRect().right));
  return { viewport: window.innerWidth, fullWidth, maxRight,
    formVisible: Boolean(form), passwordMasked: control.querySelector<HTMLInputElement>(
      "#plugin-zoom-client-secret")?.type === "password" };
};
scope.submitZoomRegistration = async () => {
  document.querySelector<HTMLButtonElement>('form button[type="submit"]')!.click();
  await waitFor(() => resolveConfigure !== null);
  const cleared = [...document.querySelectorAll<HTMLInputElement>("form input")]
    .every(input => input.type === "checkbox" ? !input.checked : input.value === "");
  const data = submitted!;
  if (data.clientSecret !== secret || data.clientId !== "shoggoth-zoom-fixture-client"
    || data.redirectPort !== 39742 || !Array.isArray(data.scopes)
    || data.scopes.join(" ") !== "user:read:user meeting:read:search") {
    throw Error("Zoom UI request shape differs from production contract");
  }
  resolveConfigure!(Response.json({ configured: true, restartRequired: true }));
  await waitFor(() => document.querySelector("[data-zoom-registration] form") === null);
  const control = document.querySelector<HTMLElement>("[data-zoom-registration]")!;
  return { cleared, configured: control.textContent?.includes("Zoom client saved") === true,
    noOverwrite: control.querySelector("button") === null,
    secretAbsent: !control.textContent?.includes(secret) };
};

void applyConfiguredLocale("en").then(() => {
  createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: 900,
    margin: "20px auto", padding: "16px", border: "1px solid var(--ui-hairline)",
    borderRadius: 10 }}><PluginZoomRegistration /></main>);
});
