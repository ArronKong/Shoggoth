import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareE5Model } from "./fetch-e5-model.mjs";

const bytes = Buffer.from("pinned E5 fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const first = "config.json";
const second = "onnx/model.onnx";
const model = {
  modelId: "fixtures/e5", revision: "pinned-revision",
  files: [first, second].map(name => ({ name, bytes: bytes.length, sha256 })),
};

function fixture(t, modelInput = model) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-e5-download-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "model");
  const calls = [], delays = [];
  const run = (fetchAsset, checkOnly = false) => prepareE5Model({
    model: modelInput, destination, cache: path.join(root, "cache"), checkOnly,
  }, {
    fetcher: (url, { signal }) => {
      const prefix = `https://huggingface.co/${model.modelId}/resolve/${model.revision}/`;
      assert.ok(url.startsWith(prefix));
      assert.ok(signal instanceof AbortSignal);
      const file = url.slice(prefix.length);
      calls.push(file);
      return fetchAsset(file);
    },
    pause: async ms => delays.push(ms), warn: () => {},
  });
  return { run, destination, calls, delays };
}

test("the observed E5 timeout retries only the interrupted file and keeps verified bytes", async t => {
  const f = fixture(t);
  let attempts = 0;
  const manifest = await f.run(file => {
    if (file === first) return new Response(bytes);
    if (++attempts === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (attempts === 2) return new Response("unavailable", { status: 503 });
    return new Response(bytes);
  });
  assert.deepEqual(f.calls, [first, second, second, second]);
  assert.deepEqual(f.delays, [5000, 15000]);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, second)), bytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.destination, "manifest.json"))), manifest);
  await f.run(() => assert.fail("Check mode must not download"), true);
});

test("a truncated transport stream restarts that file with a clean temporary file", async t => {
  const f = fixture(t, { ...model, files: [model.files[1]] });
  await f.run(() => {
    if (f.calls.length === 1) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 3)); },
      pull(controller) { controller.error(new DOMException("Timed out", "TimeoutError")); },
    }));
    return new Response(bytes);
  });
  assert.deepEqual(f.calls, [second, second]);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, second)), bytes);
  assert.ok(fs.readdirSync(f.destination).every(name => !name.startsWith(".preparing-")));
});

test("permanent HTTP errors and invalid bytes stop without weakening size or SHA-256 checks", async t => {
  for (const [label, fetchAsset, error] of [
    ["HTTP 404", () => new Response(null, { status: 404 }), /E5_ASSET_DOWNLOAD_FAILED:404/u],
    ["oversize", () => new Response(Buffer.concat([bytes, bytes])), /E5_ASSET_SIZE_INVALID/u],
    ["hash", () => new Response(Buffer.alloc(bytes.length)), /E5_ASSET_IDENTITY_INVALID/u],
  ]) await t.test(label, async t => {
    const f = fixture(t);
    await assert.rejects(f.run(fetchAsset), error);
    assert.deepEqual(f.calls, [first]);
    assert.deepEqual(f.delays, []);
    assert.deepEqual(fs.readdirSync(f.destination), []);
  });
});

test("an exhausted download leaves verified files reusable in the next invocation", async t => {
  const f = fixture(t);
  await assert.rejects(f.run(file => {
    if (file === first) return new Response(bytes);
    return new Response(null, { status: 502 });
  }), /E5_ASSET_DOWNLOAD_RETRIES_EXHAUSTED:onnx\/model\.onnx/u);
  assert.deepEqual(f.calls, [first, second, second, second]);
  assert.deepEqual(fs.readdirSync(f.destination), [first]);
  await f.run(file => {
    assert.equal(file, second);
    return new Response(bytes);
  });
  assert.deepEqual(f.calls, [first, second, second, second, second]);
});
