import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(projectRoot, "app/manage-ui/dist");
const htmlPath = path.join(distDir, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const entryMatch = /<script[^>]+type="module"[^>]+src="([^"]+\.js)"/.exec(html)
  || /<script[^>]+src="([^"]+\.js)"[^>]+type="module"/.exec(html);
assert.ok(entryMatch, "构建产物 index.html 中缺少 module entry");

const initialAssets = new Set([entryMatch[1]]);
for (const match of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g)) {
  initialAssets.add(match[1]);
}
const assetSizes = [...initialAssets].map((asset) => {
  const assetPath = path.join(distDir, asset.replace(/^\//, ""));
  return { asset, bytes: fs.statSync(assetPath).size };
});
const initialBytes = assetSizes.reduce((total, item) => total + item.bytes, 0);
const auditedBaselineBytes = 1_924_760;
const maxInitialBytes = Math.floor(auditedBaselineBytes * 0.6);

assert.ok(initialBytes <= maxInitialBytes,
  `Manage initial JS ${initialBytes} bytes 超过预算 ${maxInitialBytes} bytes（entry + modulepreload，须较 1,924,760 baseline 至少下降 40%）`);

console.log(`PASS manage initial JS budget: ${initialBytes} <= ${maxInitialBytes} bytes`);
for (const item of assetSizes) console.log(`  ${item.asset}: ${item.bytes} bytes`);
