import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manageUi = path.join(root, "app/manage-ui");
const uiCss = fs.readFileSync(path.join(manageUi, "src/components/ui.module.css"), "utf8");
assert.doesNotMatch(uiCss, /@keyframes\s+fade/, "AlertDialog must not keep its old enter-only animation");
assert.match(
  uiCss,
  /\.modalOverlay\s*\{[\s\S]*?transition:\s*opacity var\(--ui-motion-modal-enter\) var\(--ui-motion-modal-ease\);/,
);
assert.match(
  uiCss,
  /\.modalPanel\s*\{[\s\S]*?opacity var\(--ui-motion-modal-enter\) var\(--ui-motion-modal-ease\),\s*transform var\(--ui-motion-modal-enter\) var\(--ui-motion-modal-ease\);/,
);
assert.match(uiCss, /\.modalOverlay\[data-starting-style\],[\s\S]*?\.modalOverlay\[data-ending-style\]/);
assert.match(uiCss, /\.modalPanel\[data-starting-style\],[\s\S]*?\.modalPanel\[data-ending-style\]/);
const endingOverlayRule = uiCss.match(
  /\.modalOverlay\[data-ending-style\]\s*\{(\s*transition-duration:[^}]*)\}/,
)?.[1] ?? "";
assert.ok(endingOverlayRule, "the exit backdrop must define its shared exit duration");
assert.doesNotMatch(
  endingOverlayRule,
  /pointer-events:\s*none/,
  "the visible exit backdrop must keep intercepting clicks until it unmounts",
);
assert.match(
  uiCss,
  /\.modalPanel\[data-ending-style\]\s*\{[\s\S]*?transition-duration:\s*var\(--ui-motion-modal-exit\);[\s\S]*?pointer-events:\s*none;/,
);
assert.match(
  uiCss,
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.modalPanel\[data-ending-style\][\s\S]*?transform:\s*translate\(-50%, -50%\);/,
);
const require = createRequire(path.join(manageUi, "package.json"));
const esbuild = require("esbuild");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-ui-dialog-lifecycle-"));
const entryPath = path.join(tempDir, "entry.tsx");
const outputPath = path.join(tempDir, "test.cjs");

const alertDialogMock = `
import React, { forwardRef } from "react";
export const AlertDialog = {
  Root(props) { return <alert-root {...props}>{props.children}</alert-root>; },
  Portal({ children }) { return <>{children}</>; },
  Backdrop(props) { return <backdrop-node {...props} />; },
  Popup: forwardRef(function Popup(props, ref) { return <popup-node ref={ref} {...props} />; }),
  Title(props) { return <title-node {...props} />; },
};
`;

const toastMock = `
const manager = { add() {}, toasts: [] };
export const Toast = {
  Provider({ children }) { return <>{children}</>; },
  Portal({ children }) { return <>{children}</>; },
  Viewport({ children }) { return <>{children}</>; },
  Root({ children }) { return <>{children}</>; },
  Title() { return null; },
  useToastManager() { return manager; },
};
`;

const i18nMock = `
export function useTranslation() {
  return { t(key) { return key; } };
}
`;

fs.writeFileSync(entryPath, `
import assert from "node:assert/strict";
import React, { useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { UiProvider, useUi } from ${JSON.stringify(path.join(manageUi, "src/components/ui.tsx"))};

function Harness() {
  const api = useUi();
  useEffect(() => { globalThis.__uiApi = api; }, [api]);
  return <main>host</main>;
}

async function main() {
let renderer;
act(() => {
  renderer = TestRenderer.create(<UiProvider><Harness /></UiProvider>);
});

const roots = () => renderer.root.findAllByType("alert-root");
const popupFor = (index) => roots()[index].findByType("popup-node");
const text = () => JSON.stringify(renderer.toJSON());
const flush = () => new Promise((resolve) => queueMicrotask(resolve));

let confirmResolutions = 0;
let confirmResult;
let confirmPromise;
act(() => {
  confirmPromise = globalThis.__uiApi.confirm({
    title: "confirm-first",
    message: "confirm-body",
    confirmLabel: "accept-first",
  });
  confirmPromise.then((value) => { confirmResolutions += 1; confirmResult = value; });
});
assert.equal(roots()[0].props.open, true);
assert.equal(popupFor(0).props.inert, undefined, "open confirm must omit inert");
assert.ok(popupFor(0).props.initialFocus, "confirm must keep its initial focus target");
const oldConfirmComplete = roots()[0].props.onOpenChangeComplete;
const confirmButton = renderer.root.findAllByType("button").find((node) => node.children.includes("accept-first"));
act(() => confirmButton.props.onClick());
await flush();
assert.equal(confirmResult, true);
assert.equal(confirmResolutions, 1, "confirm must resolve immediately once");
assert.equal(roots()[0].props.open, false);
assert.equal(popupFor(0).props.inert, "", "closing confirm must be inert");
assert.match(text(), /confirm-first/);
assert.match(text(), /confirm-body/, "confirm payload must survive until exit completes");
assert.match(
  renderToStaticMarkup(React.createElement("div", { inert: popupFor(0).props.inert })),
  / inert=""/,
  "the runtime inert value must produce an empty inert attribute in React 18 DOM output",
);
act(() => roots()[0].props.onOpenChange(false));
await flush();
assert.equal(confirmResolutions, 1, "Base UI close after a button click must not resolve twice");

let reopenedResult;
act(() => {
  globalThis.__uiApi.confirm({ title: "confirm-reopened", message: "new-body" })
    .then((value) => { reopenedResult = value; });
});
assert.equal(roots()[0].props.open, true);
assert.equal(popupFor(0).props.inert, undefined);
act(() => oldConfirmComplete(false));
assert.equal(roots()[0].props.open, true, "an obsolete close completion must not close a reopened confirm");
assert.match(text(), /confirm-reopened/, "an obsolete close completion must not clear new payload");
act(() => roots()[0].props.onOpenChange(false));
await flush();
assert.equal(reopenedResult, false);
act(() => roots()[0].props.onOpenChangeComplete(false));
assert.doesNotMatch(text(), /confirm-reopened/, "current false completion must clear confirm payload");

let promptResolutions = 0;
let promptResult;
act(() => {
  globalThis.__uiApi.prompt({
    title: "prompt-first",
    message: "prompt-body",
    defaultValue: "   ",
    required: true,
    confirmLabel: "submit-prompt",
  }).then((value) => { promptResolutions += 1; promptResult = value; });
});
assert.equal(roots()[1].props.open, true);
assert.equal(popupFor(1).props.inert, undefined, "open prompt must omit inert");
assert.ok(popupFor(1).props.initialFocus, "prompt must keep its initial focus target");
const oldPromptComplete = roots()[1].props.onOpenChangeComplete;
let promptButton = renderer.root.findAllByType("button").find((node) => node.children.includes("submit-prompt"));
assert.equal(promptButton.props.disabled, true, "required prompt must reject whitespace-only input");
const promptInput = renderer.root.findByType("input");
act(() => promptInput.props.onChange({ target: { value: "  accepted value  " } }));
promptButton = renderer.root.findAllByType("button").find((node) => node.children.includes("submit-prompt"));
assert.equal(promptButton.props.disabled, false);
act(() => renderer.root.findByType("input").props.onKeyDown({ key: "Enter" }));
await flush();
assert.equal(promptResult, "accepted value", "Enter must submit the trimmed prompt value");
assert.equal(promptResolutions, 1);
assert.equal(roots()[1].props.open, false);
assert.equal(popupFor(1).props.inert, "", "closing prompt must be inert");
assert.match(text(), /prompt-body/, "prompt payload must survive until exit completes");
assert.equal(renderer.root.findByType("input").props.value, "  accepted value  ");
act(() => roots()[1].props.onOpenChange(false));
await flush();
assert.equal(promptResolutions, 1, "prompt close events must not resolve twice");

let reopenedPromptResult = Symbol("pending");
act(() => {
  globalThis.__uiApi.prompt({ title: "prompt-reopened", defaultValue: "new prompt" })
    .then((value) => { reopenedPromptResult = value; });
});
act(() => oldPromptComplete(false));
assert.equal(roots()[1].props.open, true, "an obsolete close completion must not close a reopened prompt");
assert.match(text(), /prompt-reopened/, "an obsolete close completion must not clear new prompt payload");
act(() => roots()[1].props.onOpenChange(false));
await flush();
assert.equal(reopenedPromptResult, null);
act(() => roots()[1].props.onOpenChangeComplete(false));
assert.doesNotMatch(text(), /prompt-reopened/, "current false completion must clear prompt payload");

let multilineResult = Symbol("pending");
act(() => {
  globalThis.__uiApi.prompt({ title: "prompt-multiline", multiline: true, defaultValue: "draft" })
    .then((value) => { multilineResult = value; });
});
assert.equal(renderer.root.findByType("textarea").props.value, "draft");
assert.ok(popupFor(1).props.initialFocus);
act(() => roots()[1].props.onOpenChange(false));
await flush();
assert.equal(multilineResult, null);
assert.match(text(), /prompt-multiline/, "multiline prompt payload must remain during exit");
act(() => roots()[1].props.onOpenChangeComplete(false));
assert.doesNotMatch(text(), /prompt-multiline/, "multiline prompt payload must clear after exit");

console.log("ui alert dialog lifecycle regression: PASS");
}

export default main();
`);

try {
  await esbuild.build({
    entryPoints: [entryPath],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    logLevel: "silent",
    plugins: [{
      name: "ui-dialog-test-boundaries",
      setup(build) {
        build.onResolve({ filter: /^@base-ui\/react\/alert-dialog$/ }, () => ({ path: "alert-dialog-mock", namespace: "ui-test" }));
        build.onResolve({ filter: /^@base-ui\/react\/toast$/ }, () => ({ path: "toast-mock", namespace: "ui-test" }));
        build.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "i18n-mock", namespace: "ui-test" }));
        build.onResolve({ filter: /^react$/ }, () => ({ path: require.resolve("react") }));
        build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: require.resolve("react/jsx-runtime") }));
        build.onResolve({ filter: /^react-dom\/server$/ }, () => ({ path: require.resolve("react-dom/server") }));
        build.onResolve({ filter: /^react-test-renderer$/ }, () => ({ path: require.resolve("react-test-renderer") }));
        build.onLoad({ filter: /.*/, namespace: "ui-test" }, (args) => ({
          contents: args.path === "alert-dialog-mock"
            ? alertDialogMock
            : args.path === "toast-mock" ? toastMock : i18nMock,
          loader: "tsx",
          resolveDir: manageUi,
        }));
        build.onLoad({ filter: /\.module\.css$/ }, () => ({
          contents: "export default { modalOverlay: 'modalOverlay', modalPanel: 'modalPanel', modalTitle: 'modalTitle', modalBody: 'modalBody', modalFoot: 'modalFoot', toastStack: 'toastStack' };",
          loader: "js",
        }));
      },
    }],
  });
  await require(outputPath).default;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
