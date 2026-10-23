import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ManagedPluginHostPanel } from "../../app/manage-ui/src/components/ManagedPluginHostPanel";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
scope.fixtureErrors = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
applyConfiguredLocale("zh-CN");
scope.setManagedHostLocale = applyConfiguredLocale;
function Fixture() {
  const [generation, setGeneration] = useState(0), [backend, setBackend] = useState<"both" | "openclaw" | "hermes">("both");
  scope.remountManagedHostPanels = () => setGeneration(value => value + 1);
  scope.showManagedHostPanels = (value: "both" | "openclaw" | "hermes") => setBackend(value);
  return <main className="page management-page settings-page" style={{ maxWidth: 880, padding: 24, margin: "0 auto" }}>
    <div className="settings-managed-plugin-hosts">
      {backend === "both" ? <>
        <ManagedPluginHostPanel key={`oc-${generation}`} backendId="openclaw" />
        <ManagedPluginHostPanel key={`hermes-${generation}`} backendId="hermes" />
      </> : <ManagedPluginHostPanel key={`single-${generation}`} backendId={backend} />}
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
scope.captureManagedHostPanels = async (theme: string) => {
  document.documentElement.dataset.theme = theme;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { theme, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    sections: Array.from(document.querySelectorAll<HTMLElement>("[data-managed-plugin-host]")).map(section => {
      const rect = section.getBoundingClientRect();
      return { backendId: section.dataset.managedPluginHost, title: section.querySelector("h3")?.textContent,
        status: section.querySelector("[role=status]")?.textContent, left: rect.left, right: rect.right,
        labelledBy: section.getAttribute("aria-labelledby"),
        buttons: Array.from(section.querySelectorAll<HTMLButtonElement>("button")).map(button => ({
          name: button.textContent, disabled: button.disabled, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height,
        })) };
    }), errors: scope.fixtureErrors };
};
