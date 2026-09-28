"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

// Runtime code, build preparation and fixtures share the same pinned identity.
// No Hub lookup or environment-selected model is permitted in the App.
const E5_MODEL = Object.freeze({
  schemaVersion: 1,
  modelId: "intfloat/multilingual-e5-small",
  revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
  license: "MIT",
  dimensions: 384,
  maxTokens: 512,
  queryPrefix: "query: ",
  passagePrefix: "passage: ",
  pooling: "attention-mask-mean-l2",
  chunking: "source-utf16-token384-overlap64-window4096-v2",
  encoding: "single-sequence-unpadded-v1",
  sourceMetadata: "language-bucket-v1",
  weight: "onnx/model_qint8_avx512_vnni.onnx",
  files: Object.freeze([
    { name: "onnx/model_qint8_avx512_vnni.onnx", bytes: 118346824,
      sha256: "dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88" },
    { name: "config.json", bytes: 655,
      sha256: "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959" },
    { name: "tokenizer.json", bytes: 17082730,
      sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39" },
    { name: "tokenizer_config.json", bytes: 443,
      sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b" },
    { name: "special_tokens_map.json", bytes: 167,
      sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7" },
    { name: "1_Pooling/config.json", bytes: 200,
      sha256: "987f7a67a38fa564c849bb5d277c52ab9088a84368fc0be31a354125aebb12a0" },
    { name: "modules.json", bytes: 387,
      sha256: "c6e29747481e8b5dd2b58401966aeac910de39092f90cda9a704b1545f902b04" },
    { name: "README.md", bytes: 497538,
      sha256: "0038de97aee16258cecbad7ffda4b4febd6953e747a00e0ddbc8e6ed241e9c1c" },
  ].map(Object.freeze)),
});

function e5AssetDirectory() {
  return __dirname.includes(`${path.sep}app.asar${path.sep}`)
    ? path.resolve(__dirname, "../../../embedding/model")
    : path.resolve(__dirname, "../../.vendor/embedding/model");
}

function e5Identity(runtimeVersion, tokenizerVersion, arch = process.arch) {
  return crypto.createHash("sha256").update(JSON.stringify({
    contract: E5_MODEL, runtimeVersion, tokenizerVersion, arch,
  })).digest("hex");
}

module.exports = { E5_MODEL, e5AssetDirectory, e5Identity };
