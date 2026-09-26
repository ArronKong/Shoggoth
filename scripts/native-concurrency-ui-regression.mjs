import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), "native-concurrency-ui-"));
fs.mkdirSync(output, { recursive: true });
execFileSync(path.join(root, "app/manage-ui/node_modules/.bin/esbuild"), [
  path.join(root, "scripts/fixtures/native-concurrency-ui.tsx"), "--bundle", "--format=esm", "--platform=browser",
  "--jsx=automatic", "--loader:.webp=dataurl", "--loader:.png=dataurl", "--loader:.svg=dataurl", `--outfile=${path.join(output, "fixture.js")}`,
], { stdio: "pipe", env: { ...process.env, NODE_PATH: path.join(root, "app/manage-ui/node_modules") } });
fs.writeFileSync(path.join(output, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
fs.writeFileSync(path.join(output, "runner.cjs"), `const {app,BrowserWindow}=require("electron");const fs=require("node:fs");app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1000,height:760});try{await w.loadFile(${JSON.stringify(path.join(output, "index.html"))});for(const width of [1000,600]){w.setContentSize(width,760);console.log(await w.webContents.executeJavaScript("window.runNativeConcurrencyUi()"));fs.writeFileSync(${JSON.stringify(output)}+"/wait-"+width+".png",(await w.webContents.capturePage()).toPNG());}}finally{w.destroy();app.quit();}}).catch(e=>{console.error(e);app.exit(1)});`);
if (!process.argv.includes("--preview-only")) {
  const result = spawnSync(path.join(root, "node_modules/.bin/electron"), [path.join(output, "runner.cjs")], { stdio: "inherit" });
  if (result.status !== 0) process.exit(1);
}
console.log(output);
