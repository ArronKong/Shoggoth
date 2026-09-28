"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { E5_MODEL, e5AssetDirectory, e5Identity } = require("./e5-model-contract");

const E5_RUNTIME = Object.freeze({ onnx: "1.22.0", tokenizer: "0.2.0" });
const MAX_TEXT_BYTES = 1024 * 1024;

function embeddingError(code) { return Object.assign(new Error(code), { code }); }
function hashText(text) { return crypto.createHash("sha256").update(text).digest("hex"); }

function dependencyVersion(name) {
  let directory = path.dirname(require.resolve(name));
  for (let step = 0; step < 5; step++, directory = path.dirname(directory)) {
    const file = path.join(directory, "package.json");
    if (!fs.existsSync(file)) continue;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.name === name) return value.version;
  }
  throw embeddingError("E5_RUNTIME_IDENTITY_INVALID");
}

function validateAssets(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.modelId !== E5_MODEL.modelId || manifest.revision !== E5_MODEL.revision
    || JSON.stringify(manifest.files) !== JSON.stringify(E5_MODEL.files)) {
    throw embeddingError("E5_ASSET_IDENTITY_INVALID");
  }
  for (const entry of E5_MODEL.files) {
    const file = path.join(directory, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== entry.bytes) {
      throw embeddingError("E5_ASSET_IDENTITY_INVALID");
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const digest = crypto.createHash("sha256");
    try {
      for (;;) {
        const count = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!count) break;
        digest.update(buffer.subarray(0, count));
      }
    } finally { fs.closeSync(fd); }
    if (digest.digest("hex") !== entry.sha256) throw embeddingError("E5_ASSET_IDENTITY_INVALID");
  }
}

class E5Encoder {
  constructor({ assetDirectory = e5AssetDirectory() } = {}) {
    this.assetDirectory = assetDirectory;
    this.session = null;
    this.tokenizer = null;
    this.initialization = null;
    this.identity = e5Identity(E5_RUNTIME.onnx, E5_RUNTIME.tokenizer);
    this.queryCache = new Map();
  }

  async open() {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      validateAssets(this.assetDirectory);
      if (dependencyVersion("onnxruntime-node") !== E5_RUNTIME.onnx
        || dependencyVersion("@huggingface/tokenizers") !== E5_RUNTIME.tokenizer) {
        throw embeddingError("E5_RUNTIME_IDENTITY_INVALID");
      }
      this.ort = require("onnxruntime-node");
      const { Tokenizer } = require("@huggingface/tokenizers");
      this.tokenizer = new Tokenizer(
        JSON.parse(fs.readFileSync(path.join(this.assetDirectory, "tokenizer.json"))),
        JSON.parse(fs.readFileSync(path.join(this.assetDirectory, "tokenizer_config.json"))),
      );
      this.session = await this.ort.InferenceSession.create(path.join(this.assetDirectory, E5_MODEL.weight), {
        executionProviders: ["cpu"], intraOpNumThreads: 1, interOpNumThreads: 1,
        executionMode: "sequential", logSeverityLevel: 3,
        extra: { session: { intra_op: { allow_spinning: "0" }, inter_op: { allow_spinning: "0" } } },
      });
      if (!this.session.inputNames.includes("input_ids") || !this.session.inputNames.includes("attention_mask")
        || this.session.inputNames.some(name => !["input_ids", "attention_mask", "token_type_ids"].includes(name))
        || !this.session.outputNames.includes("last_hidden_state")) throw embeddingError("E5_MODEL_CONTRACT_INVALID");
      return { modelId: E5_MODEL.modelId, identity: this.identity, dimensions: E5_MODEL.dimensions,
        runtimeVersion: E5_RUNTIME.onnx, tokenizerVersion: E5_RUNTIME.tokenizer, arch: process.arch };
    })();
    return this.initialization;
  }

  tokenize(text, kind = "passage") {
    if (!this.tokenizer || !["query", "passage"].includes(kind) || typeof text !== "string"
      || !text.isWellFormed() || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      throw embeddingError("E5_TEXT_INVALID");
    }
    const encoded = this.tokenizer.encode((kind === "query" ? E5_MODEL.queryPrefix : E5_MODEL.passagePrefix) + text);
    if (!Array.isArray(encoded.ids) || !encoded.ids.length
      || encoded.ids.some(id => !Number.isSafeInteger(id) || id < 0)) throw embeddingError("E5_TOKENIZER_INVALID");
    return encoded.ids;
  }

  // Keep ranges in the original JS string. Token decoding is never an original
  // quote, and splitting at UTF-16 surrogate halves would invalidate a source.
  *sourceRanges(text) {
    if (typeof text !== "string" || !text.trim() || !text.isWellFormed()
      || Buffer.byteLength(text)>MAX_TEXT_BYTES) throw embeddingError("E5_TEXT_INVALID");
    if (text.length <= 4096 && this.tokenize(text).length <= 384) {
      yield { start: 0, end: text.length }; return;
    }
    const boundaries = [0];
    for (const point of text) boundaries.push(boundaries.at(-1) + point.length);
    let start = 0;
    while (start < boundaries.length - 1) {
      // A bounded source window prevents quadratic retokenization of a large
      // transcript. Yield one range so the worker can preempt between chunks.
      let low = start + 1, high = Math.min(start + 4096, boundaries.length - 1);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (this.tokenize(text.slice(boundaries[start], boundaries[mid])).length <= 384) low = mid;
        else high = mid - 1;
      }
      const end = low;
      yield { start: boundaries[start], end: boundaries[end] };
      if (end === boundaries.length - 1) break;
      // Largest suffix whose prefixed encoding occupies at most 64 tokens.
      low = start + 1; high = end;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (this.tokenize(text.slice(boundaries[mid], boundaries[end])).length <= 64) high = mid;
        else low = mid + 1;
      }
      start = Math.max(start + 1, low);
    }
  }
  splitText(text) { return [...this.sourceRanges(text)]; }

  async encode(text, kind = "passage") {
    await this.open();
    const cacheKey = kind === "query" ? hashText(text) : null;
    if (cacheKey && this.queryCache.has(cacheKey)) {
      const vector = this.queryCache.get(cacheKey);
      this.queryCache.delete(cacheKey); this.queryCache.set(cacheKey, vector);
      return new Float32Array(vector);
    }
    const ids = this.tokenize(text, kind);
    if (ids.length > E5_MODEL.maxTokens) throw embeddingError("E5_INPUT_TOO_LONG");
    const inputs = {
      input_ids: new this.ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
      attention_mask: new this.ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
    };
    if (this.session.inputNames.includes("token_type_ids")) {
      inputs.token_type_ids = new this.ort.Tensor("int64", new BigInt64Array(ids.length), [1, ids.length]);
    }
    const outputs = await this.session.run(inputs);
    const hidden = outputs.last_hidden_state;
    if (JSON.stringify(hidden.dims) !== JSON.stringify([1, ids.length, E5_MODEL.dimensions])) {
      throw embeddingError("E5_MODEL_OUTPUT_INVALID");
    }
    const vector = new Float32Array(E5_MODEL.dimensions);
    let norm = 0;
    for (let dimension = 0; dimension < vector.length; dimension++) {
      let sum = 0;
      for (let token = 0; token < ids.length; token++) sum += hidden.data[token * vector.length + dimension];
      vector[dimension] = sum / ids.length;
      norm += vector[dimension] ** 2;
    }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) throw embeddingError("E5_MODEL_OUTPUT_INVALID");
    for (let dimension = 0; dimension < vector.length; dimension++) vector[dimension] /= norm;
    if (cacheKey) {
      this.queryCache.set(cacheKey, vector);
      if (this.queryCache.size > 64) this.queryCache.delete(this.queryCache.keys().next().value);
    }
    return vector;
  }

  async close() {
    this.queryCache.clear();
    const session = this.session;
    this.session = null; this.tokenizer = null;
    if (session) await session.release();
  }
}

module.exports = { E5Encoder, E5_RUNTIME, validateAssets, hashText, embeddingError };
