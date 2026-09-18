#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8").catch(() => "");

async function readSourceTree(path) {
  const entries = await readdir(new URL(path, root), { withFileTypes: true });
  const contents = await Promise.all(entries.map(async (entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) return readSourceTree(child);
    if (!/\.(?:css|ts|tsx)$/.test(entry.name)) return "";
    return read(child);
  }));
  return contents.flat().join("\n");
}

async function exists(path) {
  try {
    await access(new URL(path, root));
    return true;
  } catch {
    return false;
  }
}

// 用括号深度截取 CSS 块，避免非贪婪正则在首个关键帧声明处提前结束。
function blocksAfter(source, marker) {
  const blocks = [];
  let cursor = 0;
  while ((cursor = source.indexOf(marker, cursor)) !== -1) {
    const open = source.indexOf("{", cursor + marker.length);
    if (open === -1) break;
    let depth = 1;
    let end = open + 1;
    while (end < source.length && depth > 0) {
      if (source[end] === "{") depth += 1;
      if (source[end] === "}") depth -= 1;
      end += 1;
    }
    if (depth === 0) blocks.push(source.slice(open + 1, end - 1));
    cursor = end;
  }
  return blocks;
}

function keyframesOnlyTransform(source) {
  const blocks = blocksAfter(source, "@keyframes");
  if (!blocks.length) return false;
  const properties = blocks.flatMap((block) =>
    [...block.matchAll(/(?:^|[;{])\s*([\w-]+)\s*:/gm)].map((match) => match[1]),
  );
  return properties.length > 0 && properties.every((property) => property === "transform");
}

function reducedMotionStopsAnimation(source) {
  return blocksAfter(source, "@media (prefers-reduced-motion: reduce)")
    .some((block) => /animation:\s*none\s*;/.test(block));
}

function firstBlock(source, marker) {
  return blocksAfter(source, marker)[0] || "";
}

const [
  component,
  styles,
  legacyComponent,
  legacyStyles,
  gallery,
  chat,
  chatStyles,
  modelMenu,
  activityFeed,
  tasksPage,
  sourceTree,
  legacyComponentExists,
  legacyStylesExist,
  zh,
  en,
] = await Promise.all([
  read("app/manage-ui/src/components/FusionLoader.tsx"),
  read("app/manage-ui/src/components/FusionLoader.module.css"),
  read("app/manage-ui/src/components/DotLoader.tsx"),
  read("app/manage-ui/src/components/DotLoader.module.css"),
  read("app/manage-ui/src/pages/ComponentsPage.tsx"),
  read("app/manage-ui/src/pages/ChatPage.tsx"),
  read("app/manage-ui/src/pages/ChatPage.css"),
  read("app/manage-ui/src/pages/ChatModelMenu.tsx"),
  read("app/manage-ui/src/pages/dashboard/ActivityFeed.tsx"),
  read("app/manage-ui/src/pages/TasksPage.tsx"),
  readSourceTree("app/manage-ui/src"),
  exists("app/manage-ui/src/components/DotLoader.tsx"),
  exists("app/manage-ui/src/components/DotLoader.module.css"),
  read("app/manage-ui/src/i18n/locales/zh-CN.ts"),
  read("app/manage-ui/src/i18n/locales/en.ts"),
]);

const orbitBlock = firstBlock(styles, "@keyframes orbit");
const trackRule = firstBlock(styles, ".leftTrack,\n.rightTrack");
const reducedMotionBlock = firstBlock(styles, "@media (prefers-reduced-motion: reduce)");
const orbitTranslations = [...orbitBlock.matchAll(/translate\(([^,]+),\s*([^)]+)\)/g)];

const checks = [
  ["component exports FusionLoader", /export default function FusionLoader/.test(component)],
  ["component exposes small and medium optical sizes", /export type FusionLoaderSize = "sm" \| "md"/.test(component) && /size\?: FusionLoaderSize/.test(component)],
  ["medium remains the default size", /\{\s*size = "md",[^}]*\}/.test(component) && /styles\[size\]/.test(component)],
  ["component exposes visible and screen-reader-only status labels", /ariaLabel\?:\s*string/.test(component) && /role:\s*"status"/.test(component) && /aria-live/.test(component) && /"aria-label":\s*ariaLabel/.test(component) && /\{label \? <span[^>]*>\{label\}<\/span> : null\}/.test(component)],
  ["component uses two SVG balls on one shared orbit origin", (component.match(/<circle\b/g) || []).length === 2 && (component.match(/cx="36"/g) || []).length === 2],
  ["component uses a gooey alpha filter", /feGaussianBlur/.test(component) && /feColorMatrix/.test(component)],
  ["goo filter is strong enough to form a visible bridge", /stdDeviation="4\.2"/.test(component) && /0 0 0 24 -10/.test(component)],
  ["motion only changes transforms", keyframesOnlyTransform(styles)],
  ["keyframe inspector rejects non-transform animation", !keyframesOnlyTransform("@keyframes bad { from { transform: none; opacity: 0; } }")],
  ["orbit keyframes reach both left and right positions", /translate\(-18px,\s*0\)/.test(orbitBlock) && /translate\(18px,\s*0\)/.test(orbitBlock)],
  ["both balls stay on one horizontal line", orbitTranslations.length > 0 && orbitTranslations.every((match) => match[2].trim() === "0")],
  ["horizontal orbit still has visible back and front depth", /translate\(0,\s*0\)\s*scale\(0\.84\)/.test(orbitBlock) && /translate\(0,\s*0\)\s*scale\(1\.16\)/.test(orbitBlock)],
  ["shared track rule defines a 1.6-second infinite linear cycle", /animation-duration:\s*1\.6s/.test(trackRule) && /animation-timing-function:\s*linear/.test(trackRule) && /animation-iteration-count:\s*infinite/.test(trackRule)],
  ["second ball stays exactly half a cycle ahead", blocksAfter(styles, ".rightTrack").some((block) => /animation-delay:\s*-0\.8s/.test(block))],
  ["exchange loops forward without reversing", !/animation-direction:\s*alternate/.test(styles)],
  ["reduced motion disables animation", reducedMotionStopsAnimation(styles)],
  ["reduced motion preserves separated horizontal balls", /\.leftTrack\s*\{\s*transform:\s*translate\(-18px,\s*0\)/.test(reducedMotionBlock) && /\.rightTrack\s*\{\s*transform:\s*translate\(18px,\s*0\)/.test(reducedMotionBlock)],
  ["reduced-motion inspector rejects an unscoped stop", !reducedMotionStopsAnimation(".ball { animation: none; } @media (prefers-reduced-motion: reduce) { .ball { color: red; } }")],
  ["small size is a 36 by 18 inline loader", /\.sm\s*\{[^}]*flex-direction:\s*row/.test(styles) && /\.sm\s+\.motion\s*\{[^}]*width:\s*36px[^}]*height:\s*18px/.test(styles)],
  ["medium size preserves the 72 by 36 card loader", /\.md\s+\.motion\s*\{[^}]*width:\s*72px[^}]*height:\s*36px/.test(styles)],
  ["loader color inherits from its current surface", /fill:\s*var\(--fusion-loader-color,\s*currentColor\)/.test(styles)],
  ["gallery imports FusionLoader", /import FusionLoader from "\.\.\/components\/FusionLoader"/.test(gallery)],
  ["gallery renders only both fusion loader sizes", /data-gallery="fusion-loader"/.test(gallery) && !/data-gallery="dot-loader"/.test(gallery) && /<FusionLoader size="sm" label=\{t\("common\.loading"\)\}/.test(gallery) && /<FusionLoader label=\{t\("componentsGallery\.fusionLoaderLabel"\)\}/.test(gallery)],
  ["chat uses the small fusion loader in the agent list and first-byte state", !/DotLoader/.test(chat) && (chat.match(/<FusionLoader(?:\s+size="sm")?/g) || []).length === 2 && (chat.match(/size="sm"/g) || []).length >= 2],
  ["first-byte chat loader announces thinking without visible copy", /<FusionLoader size="sm" ariaLabel=\{t\("chat\.liveStatus\.running"\)\} \/>/.test(chat)],
  ["agent-list thinking loader inherits pure black", /FusionLoader 双球/.test(chatStyles) && /\.chat-thinking-dots\s*\{\s*color:\s*#000\s*;/.test(chatStyles)],
  ["model menu uses the small fusion loader", !/DotLoader/.test(modelMenu) && /<FusionLoader size="sm" label=\{t\("chat\.loadingModels"\)\}/.test(modelMenu)],
  ["activity feed uses the small fusion loader", !/DotLoader/.test(activityFeed) && /<FusionLoader size="sm" label=\{t\("common\.loading"\)\}/.test(activityFeed)],
  ["tasks page uses the medium fusion loader", !/DotLoader/.test(tasksPage) && /<FusionLoader size="md" label=\{t\("common\.loading"\)\}/.test(tasksPage)],
  ["legacy dot loader implementation is removed", legacyComponent === "" && legacyStyles === "" && !legacyComponentExists && !legacyStylesExist],
  ["entire frontend source tree has no legacy dot loader references", !/DotLoader/.test(sourceTree)],
  ["gallery copy no longer advertises the dot matrix", !/dotLoaderName:/.test(zh) && !/dotLoaderName:/.test(en) && /loaderDescription:\s*"双球融合加载动画的两种尺寸"/.test(zh) && /loaderDescription:\s*"Two sizes of the liquid two-ball loader"/.test(en)],
  ["Chinese copy describes the fusion loader", /fusionLoaderLabel:\s*"双球融合加载中"/.test(zh)],
  ["English copy describes the fusion loader", /fusionLoaderLabel:\s*"Fusion loading"/.test(en)],
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
if (failed.length) process.exitCode = 1;
else console.log(`[fusion-loader-contract] PASS ${checks.length}/${checks.length}`);
