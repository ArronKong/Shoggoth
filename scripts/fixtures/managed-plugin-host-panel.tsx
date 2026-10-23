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
function Fixture() {
  const [generation, setGeneration] = useState(0);
  scope.remountManagedHostPanel = () => setGeneration(value => value + 1);
  return <main className="page management-page settings-page" style={{ maxWidth: 880, padding: 24, margin: "0 auto" }}>
    <ManagedPluginHostPanel key={generation} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
scope.captureManagedHostPanel = async (theme: string) => {
  document.documentElement.dataset.theme = theme;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const section = document.querySelector("section")?.getBoundingClientRect();
  return { theme, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.querySelector("main")!).backgroundColor,
    section: section && { left: section.left, right: section.right, top: section.top, bottom: section.bottom },
    buttons: Array.from(document.querySelectorAll<HTMLButtonElement>("section button")).map(button => ({
      name: button.textContent, disabled: button.disabled, width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
    })), errors: scope.fixtureErrors };
};
