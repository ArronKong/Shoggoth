import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modalPath = path.join(root, "app/manage-ui/src/components/Modal.tsx");
const modalCssPath = path.join(root, "app/manage-ui/src/components/Modal.module.css");
const dashboardPath = path.join(root, "app/manage-ui/src/pages/DashboardPage.tsx");
const stylesPath = path.join(root, "app/manage-ui/src/styles.css");
const uiPath = path.join(root, "app/manage-ui/src/components/ui.tsx");
const uiCssPath = path.join(root, "app/manage-ui/src/components/ui.module.css");
const endpointsPath = path.join(root, "app/manage-ui/src/pages/models/CustomEndpointsPanel.tsx");
const endpointModalPath = path.join(root, "app/manage-ui/src/pages/models/EndpointModal.tsx");
const modelsPath = path.join(root, "app/manage-ui/src/pages/ModelsPage.tsx");
const editorPath = path.join(root, "app/manage-ui/src/pages/models/ModelEditorDrawer.tsx");
const workboardPath = path.join(root, "app/manage-ui/src/pages/workboard/WorkboardView.tsx");

const modal = fs.readFileSync(modalPath, "utf8");
const modalCss = fs.readFileSync(modalCssPath, "utf8");
const dashboard = fs.readFileSync(dashboardPath, "utf8");
const globalStyles = fs.readFileSync(stylesPath, "utf8");
const ui = fs.readFileSync(uiPath, "utf8");
const uiCss = fs.readFileSync(uiCssPath, "utf8");
const endpoints = fs.readFileSync(endpointsPath, "utf8");
const endpointModal = fs.readFileSync(endpointModalPath, "utf8");
const models = fs.readFileSync(modelsPath, "utf8");
const editor = fs.readFileSync(editorPath, "utf8");
const workboard = fs.readFileSync(workboardPath, "utf8");

// Base UI 的完成回调是页面延后加载/清理内容的唯一时序边界。
assert.match(modal, /onOpenChangeComplete\?: \(open: boolean\) => void;/);
assert.match(modal, /<Dialog\.Root[\s\S]*?onOpenChangeComplete=\{handleOpenChangeComplete\}/);

// 公共组件必须承担退出内容保留，但不能在 callback ref 中同步测量并锁死临时高度；
// 大型 flex/overflow 内容在该提交边界可能返回收缩值，反而制造先小后大。
assert.match(modal, /useLayoutEffect/);
assert.match(modal, /retainedContent/);
assert.doesNotMatch(modal, /entryHeight|handlePanelRef|offsetHeight/);
assert.doesNotMatch(modal, /ref=\{handlePanelRef\}/);

// Dashboard 必须把“弹窗是否可见”和“当前展示哪条 run”分开：关闭先播动画，
// 只有 ending transition 完成后才清空正文，避免高度在退场首帧坍缩。
assert.match(dashboard, /const \[runModalOpen, setRunModalOpen\] = useState\(false\);/);
const closeRunModalBody = dashboard.match(/const closeRunModal = \(\) => \{([\s\S]*?)\n  \};/)?.[1] || "";
assert.match(closeRunModalBody, /runDeliveryRequestRef\.current \+= 1;/);
assert.match(closeRunModalBody, /setRunModalOpen\(false\);/);
assert.doesNotMatch(closeRunModalBody, /setOpenRun\(null\)|setDelivery\(null\)|setDeliveryLoading\(false\)/);
assert.match(
  dashboard,
  /const handleRunModalOpenChangeComplete = \(open: boolean\) => \{[\s\S]*?if \(open\) \{[\s\S]*?return;[\s\S]*?setOpenRun\(null\);[\s\S]*?setDelivery\(null\);[\s\S]*?setDeliveryLoading\(false\);/,
);
assert.match(dashboard, /open=\{runModalOpen\}/);
assert.match(dashboard, /onOpenChangeComplete=\{handleRunModalOpenChangeComplete\}/);

// 全文请求只能在入场动画结束后启动，已有摘要在 loading 时仍继续渲染。
const openRunModalBody = dashboard.match(/const openRunModal = \(run: DashboardRunEntry\) => \{([\s\S]*?)\n  \};/)?.[1] || "";
assert.doesNotMatch(openRunModalBody, /getCronLatestDelivery/);
assert.match(
  dashboard,
  /if \(open\) \{[\s\S]*?getCronLatestDelivery\(run\.jobId, run\.startedAt \?\? undefined\)/,
);
assert.match(
  dashboard,
  /\.then\(\(nextDelivery\) => \{\s*if \(runDeliveryRequestRef\.current === requestId\) setDelivery\(nextDelivery\);/,
);
assert.match(
  dashboard,
  /\.catch\(\(\) => \{\s*if \(runDeliveryRequestRef\.current === requestId\) setDelivery\(null\);/,
);
assert.match(
  dashboard,
  /\.finally\(\(\) => \{\s*if \(runDeliveryRequestRef\.current === requestId\) setDeliveryLoading\(false\);/,
);
assert.match(dashboard, /const runHandoff = selectCronRunHandoffSource\(openRun, delivery\);/);
assert.match(dashboard, /const visibleRunText = runHandoff\.report;/);
assert.doesNotMatch(dashboard, /!deliveryLoading && visibleRunText/);

// 入场保持舒展，退场更快；两者都只过渡合成友好的 opacity/transform。
assert.match(globalStyles, /--ui-motion-modal-enter:\s*220ms;/);
assert.match(globalStyles, /--ui-motion-modal-exit:\s*160ms;/);
assert.match(globalStyles, /--ui-motion-modal-ease:\s*cubic-bezier\(0\.22, 1, 0\.36, 1\);/);
assert.doesNotMatch(modalCss, /--modal-(?:enter-duration|exit-duration|motion-ease):/);
assert.match(modalCss, /\.overlay\[data-ending-style\][\s\S]*?transition-duration:\s*var\(--ui-motion-modal-exit\);/);
assert.match(modalCss, /\.panel\[data-ending-style\][\s\S]*?transition-duration:\s*var\(--ui-motion-modal-exit\);/);
assert.match(modalCss, /\.overlay\s*\{[\s\S]*?transition:\s*opacity var\(--ui-motion-modal-enter\) var\(--ui-motion-modal-ease\);/);
assert.match(
  modalCss,
  /\.panel\s*\{[\s\S]*?transition:\s*opacity var\(--ui-motion-modal-enter\) var\(--ui-motion-modal-ease\),\s*transform var\(--ui-motion-modal-enter\) var\(--ui-motion-modal-ease\);/,
);
assert.doesNotMatch(
  modalCss,
  /transition\s*:[^;]*(?:\ball\b|filter|box-shadow|width|height|top|left|margin|padding)/,
);

// 面板首个可见帧必须保持最终宽高；scale 入场会把 800px 面板先画成 776px，
// 被感知为“先出现小弹窗，再切成详情弹窗”。只允许 opacity + 位移。
const modalPanelLifecycleRule = modalCss.match(
  /\.panel\[data-starting-style\],\s*\.panel\[data-ending-style\]\s*\{([^}]*)\}/,
)?.[1] || "";
assert.match(modalPanelLifecycleRule, /transform:\s*translate\(-50%,\s*-48%\);/);
assert.doesNotMatch(modalPanelLifecycleRule, /scale\(/);

// AlertDialog 与内容弹窗共用生命周期 token，退出时延后释放 payload。
assert.match(ui, /const \[confirmOpen, setConfirmOpen\] = useState\(false\);/);
assert.match(ui, /const \[promptOpen, setPromptOpen\] = useState\(false\);/);
assert.match(ui, /settledConfirmIds\.current\.has\(requestId\)/);
assert.match(ui, /settledPromptIds\.current\.has\(requestId\)/);
assert.match(ui, /if \(open \|\| confirmOpenRef\.current\) return;/);
assert.match(ui, /if \(open \|\| promptOpenRef\.current\) return;/);
assert.match(ui, /setConfirmState\(\(current\) => current\?\.requestId === requestId \? null : current\);/);
assert.match(ui, /setPromptState\(\(current\) => current\?\.requestId === requestId \? null : current\);/);
assert.match(ui, /onOpenChangeComplete=\{\(open\) => completeConfirmTransition\(confirmState\?\.requestId, open\)\}/);
assert.match(ui, /onOpenChangeComplete=\{\(open\) => completePromptTransition\(promptState\?\.requestId, open\)\}/);
assert.match(ui, /confirmOpen \? \{\} : \{ inert: "" \}/);
assert.match(ui, /promptOpen \? \{\} : \{ inert: "" \}/);
assert.match(uiCss, /\.modalOverlay\[data-starting-style\],[\s\S]*?\.modalOverlay\[data-ending-style\]/);
assert.match(uiCss, /\.modalPanel\[data-starting-style\],[\s\S]*?\.modalPanel\[data-ending-style\]/);
assert.match(uiCss, /var\(--ui-motion-modal-enter\)/);
assert.match(uiCss, /var\(--ui-motion-modal-exit\)/);
assert.match(uiCss, /\.modalPanel\[data-ending-style\][\s\S]*?pointer-events:\s*none;/);
assert.doesNotMatch(uiCss, /@keyframes\s+fade/);
const alertPanelLifecycleRule = uiCss.match(
  /\.modalPanel\[data-starting-style\],\s*\.modalPanel\[data-ending-style\]\s*\{([^}]*)\}/,
)?.[1] || "";
assert.match(alertPanelLifecycleRule, /transform:\s*translate\(-50%,\s*-48%\);/);
assert.doesNotMatch(alertPanelLifecycleRule, /scale\(/);

// 条件包装弹窗必须保持挂载到退场完成，Workboard 不再旁路公共 Modal。
assert.match(endpoints, /<EndpointModal[\s\S]*?open=\{modalOpen\}[\s\S]*?onOpenChangeComplete=/);
assert.match(endpointModal, /onOpenChangeComplete[\s\S]*?<Modal[\s\S]*?open=\{open\}[\s\S]*?onOpenChangeComplete=\{onOpenChangeComplete\}/);
assert.match(models, /<ModelEditorDrawer[\s\S]*?open=\{editorOpen\}[\s\S]*?onOpenChangeComplete=/);
assert.match(editor, /onOpenChangeComplete[\s\S]*?<Modal[\s\S]*?onOpenChangeComplete=\{onOpenChangeComplete\}/);

// 条件包装层必须把 payload 与 visible 分开：打开入口同时写入两者，普通关闭/保存
// 只关闭 visible，payload 只能由完成回调（或后端强制切换）释放。
assert.match(
  endpoints,
  /const openModal = \(endpoint: CustomEndpoint \| null\) => \{\s*const generation = \+\+modalGeneration\.current;\s*setModal\(\{ endpoint, generation \}\);\s*setModalOpen\(true\);\s*\};/,
);
assert.match(endpoints, /<EndpointModal\s+key=\{modal\.generation\}/);
assert.match(endpoints, /onClose=\{\(\) => setModalOpen\(false\)\}/);
assert.match(endpoints, /onOpenChangeComplete=\{\(open\) => \{\s*if \(!open\) setModal\(null\);\s*\}\}/);
const endpointSavedBody = endpoints.match(/onSaved=\{\(next\) => \{([\s\S]*?)\n\s*\}\}/)?.[1] || "";
assert.match(endpointSavedBody, /setModalOpen\(false\);/);
assert.doesNotMatch(endpointSavedBody, /setModal\(null\)/);
assert.equal(
  [...endpoints.matchAll(/setModal\(null\)/g)].length,
  2,
  "endpoint payload 只能在 controller 强制切换或退场完成后清理",
);

assert.match(
  models,
  /const showEditor = \(next: Omit<ModelEditorSession, "generation">\) => \{\s*const generation = \+\+editorGeneration\.current;\s*setEditor\(\{ \.\.\.next, generation \}\);\s*setEditorOpen\(true\);\s*\};/,
);
assert.match(models, /<ModelEditorDrawer\s+key=\{editor\.generation\}/);
assert.match(models, /onRequestClose=\{\(\) => setEditorOpen\(false\)\}/);
assert.match(models, /onOpenChangeComplete=\{\(open\) => \{\s*if \(!open\) setEditor\(null\);\s*\}\}/);
assert.match(
  models,
  /const handleBackendChange[\s\S]*?setEditorOpen\(false\);\s*setEditor\(null\);/,
);
assert.equal(
  [...models.matchAll(/setEditor\(null\)/g)].length,
  2,
  "editor payload 只能在 backend 强制切换或退场完成后清理",
);
assert.doesNotMatch(workboard, /Dialog\.Root/);
assert.match(workboard, /<Modal[\s\S]*?open=\{draft\.open\}[\s\S]*?width=\{920\}/);

console.log("modal motion regression: PASS");
