import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../app/manage-ui/package.json', import.meta.url));
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(new URL('../app/manage-ui/src/pages/inspiration-fonts.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = () => new Promise(setImmediate);
function fixture(lang, load) {
  const exports = {}, requests = [];
  vm.runInNewContext(code, { exports, require: () => ({}), document: {
    documentElement: { lang }, fonts: { load: (face, text) => { requests.push({ face, text }); return load(face); } },
  } });
  return { load: exports.loadInspirationFonts, requests };
}
for (const lang of ['zh', 'zh-CN', 'en']) {
  const pending = [];
  const f = fixture(lang, () => new Promise(resolve => pending.push(resolve)));
  let ready = false;
  const loading = f.load().then(() => { ready = true; });
  await flush();
  assert.equal(ready, false, 'a cold route waits for its fonts instead of painting the serif fallback');
  assert.deepEqual(f.requests.map(item => item.face),
    ['400 12px "Courier Prime"', '700 12px "Courier Prime"', '400 12px "ChillKai"'],
    'mixed-language notes load both paper faces regardless of the UI locale');
  for (const resolve of pending) resolve([]);
  await loading;
  assert.equal(ready, true);
}
{
  const f = fixture('zh-CN', () => Promise.reject(new Error('Font unavailable')));
  await f.load(); // A missing font must not make notes inaccessible.
}
console.log('PASS Inspiration fonts: every UI locale waits for both paper faces, missing fonts leave the page usable');
