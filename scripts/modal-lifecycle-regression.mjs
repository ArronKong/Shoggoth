import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manageUi = path.join(root, "app/manage-ui");
const modalSource = fs.readFileSync(path.join(manageUi, "src/components/Modal.tsx"), "utf8");
assert.doesNotMatch(
  modalSource,
  /if \(open\) retainedContent\.current\s*=/,
  "retained content must not be mutated during render",
);
assert.match(
  modalSource,
  /useLayoutEffect\(\(\) => \{[\s\S]*?if \(open\) \{[\s\S]*?retainedContent\.current\s*=\s*currentContent;/,
  "retained content must only cache a committed open render in a layout effect",
);
assert.doesNotMatch(
  modalSource,
  /entryHeight|handlePanelRef|offsetHeight/,
  "large modal entry must use committed natural geometry instead of a provisional inline height lock",
);
const require = createRequire(path.join(manageUi, "package.json"));
const esbuild = require("esbuild");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-modal-lifecycle-"));
const entryPath = path.join(tempDir, "entry.tsx");
const outputPath = path.join(tempDir, "test.cjs");

const dialogMock = `
import React, { forwardRef, useEffect, useState } from "react";
export const Dialog = {
  Root(props) {
    globalThis.__modalRootProps = props;
    const [mounted, setMounted] = useState(props.open);
    useEffect(() => {
      if (props.open) setMounted(true);
    }, [props.open]);
    return <>{mounted || globalThis.__renderClosedDialog ? props.children : null}</>;
  },
  Portal({ children }) { return <>{children}</>; },
  Backdrop(props) { return <backdrop {...props} />; },
  Popup: forwardRef(function Popup(props, ref) { return <div data-popup="true" ref={ref} {...props} />; }),
  Title(props) { return <title-node {...props} />; },
  Description(props) { return <description-node {...props} />; },
  Close(props) { return <close-node {...props} />; },
};
`;

const i18nMock = `
export function useTranslation() {
  return { t(key) { return key; } };
}
`;

fs.writeFileSync(entryPath, `
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import Modal from ${JSON.stringify(path.join(manageUi, "src/components/Modal.tsx"))};

const completed = [];
const popupNode = {
  style: { height: "" },
};
const nodeMock = (element) => element.props?.["data-popup"] === "true" ? popupNode : {};
let renderer;

const findPopup = (target = renderer) => target.root.find((node) => node.props["data-popup"] === "true");

function view(open, label) {
  return (
    <Modal
      open={open}
      title={label ? \`title-\${label}\` : undefined}
      subtitle={label ? \`subtitle-\${label}\` : undefined}
      onClose={() => {}}
      onOpenChangeComplete={(next) => completed.push(next)}
      footer={label ? <button>{\`footer-\${label}\`}</button> : undefined}
    >
      {label ? <span>{\`body-\${label}\`}</span> : undefined}
    </Modal>
  );
}

act(() => {
  renderer = TestRenderer.create(view(true, "first"), { createNodeMock: nodeMock });
});

const originalConsoleError = console.error;
console.error = (...args) => {
  if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) originalConsoleError(...args);
};
let closingMarkup;
let openMarkup;
try {
  globalThis.__renderClosedDialog = true;
  closingMarkup = renderToStaticMarkup(view(false, null));
  openMarkup = renderToStaticMarkup(view(true, "server"));
} finally {
  globalThis.__renderClosedDialog = false;
  console.error = originalConsoleError;
}
assert.match(closingMarkup, /data-popup="true"[^>]*\\sinert=""/, "React's final closing DOM must contain inert");
assert.doesNotMatch(openMarkup, /\\sinert(?:=|\\s|>)/, "React's final open DOM must omit inert");

let popup = findPopup();
assert.equal(popup.props.style.height, undefined, "entry must not lock a provisional inline height");
assert.equal(popup.props.inert, undefined, "an open modal must remain keyboard interactive");

act(() => renderer.update(view(false, null)));
popup = findPopup();
assert.equal(popup.props.style.height, undefined, "closing must keep natural geometry without an inline lock");
assert.equal(popup.props.inert, "", "closing content must not allow keyboard interaction");
assert.match(JSON.stringify(renderer.toJSON()), /body-first/, "a quick close must retain its last live content");

act(() => renderer.update(view(true, "second")));
popup = findPopup();
assert.equal(popup.props.style.height, undefined, "a quick reopen must use the new content's natural height");
assert.equal(popup.props.inert, undefined, "reopened content must restore keyboard interaction");

act(() => globalThis.__modalRootProps.onOpenChangeComplete(false));
popup = findPopup();
assert.deepEqual(completed, [], "an obsolete close completion must not reach the consumer");
assert.equal(popup.props.style.height, undefined, "an obsolete close completion must not introduce geometry state");
assert.match(JSON.stringify(renderer.toJSON()), /body-second/, "an obsolete close completion must not clear reopened content");

act(() => globalThis.__modalRootProps.onOpenChangeComplete(true));
popup = findPopup();
assert.equal(popup.props.style.height, undefined, "open completion must preserve natural geometry");
assert.deepEqual(completed, [true], "consumer should receive Base UI's open completion");

act(() => renderer.update(view(true, "third")));
assert.match(JSON.stringify(renderer.toJSON()), /body-third/, "open modal content must remain live during entry");
assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /body-second/, "open modal must not freeze an old React subtree");

act(() => renderer.update(view(false, null)));
const closingTree = JSON.stringify(renderer.toJSON());
assert.match(closingTree, /title-third/, "title must stay mounted for the entire exit transition");
assert.match(closingTree, /subtitle-third/, "subtitle must stay mounted for the entire exit transition");
assert.match(closingTree, /body-third/, "body must stay mounted for the entire exit transition");
assert.match(closingTree, /footer-third/, "footer must stay mounted for the entire exit transition");

act(() => globalThis.__modalRootProps.onOpenChangeComplete(false));
assert.deepEqual(completed, [true, false], "consumer should receive Base UI's close completion");

let delayedRenderer;
act(() => {
  delayedRenderer = TestRenderer.create(view(false, null), { createNodeMock: nodeMock });
});
act(() => delayedRenderer.update(view(true, "delayed")));
const delayedPopup = findPopup(delayedRenderer);
assert.equal(
  delayedPopup.props.style.height,
  undefined,
  "a delayed Portal mount must still avoid a provisional inline height",
);

console.log("modal lifecycle regression: PASS");
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
      name: "modal-test-boundaries",
      setup(build) {
        build.onResolve({ filter: /^@base-ui\/react\/dialog$/ }, () => ({ path: "dialog-mock", namespace: "modal-test" }));
        build.onResolve({ filter: /^react-i18next$/ }, () => ({ path: "i18n-mock", namespace: "modal-test" }));
        build.onResolve({ filter: /^react$/ }, () => ({ path: require.resolve("react") }));
        build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: require.resolve("react/jsx-runtime") }));
        build.onResolve({ filter: /^react-dom\/server$/ }, () => ({ path: require.resolve("react-dom/server") }));
        build.onResolve({ filter: /^react-test-renderer$/ }, () => ({ path: require.resolve("react-test-renderer") }));
        build.onLoad({ filter: /.*/, namespace: "modal-test" }, (args) => ({
          contents: args.path === "dialog-mock" ? dialogMock : i18nMock,
          loader: "tsx",
          resolveDir: manageUi,
        }));
        build.onLoad({ filter: /\.module\.css$/ }, () => ({
          contents: "export default { overlay: 'overlay', panel: 'panel', head: 'head', titles: 'titles', title: 'title', subtitle: 'subtitle', close: 'close', body: 'body', foot: 'foot' };",
          loader: "js",
        }));
      },
    }],
  });
  require(outputPath);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
