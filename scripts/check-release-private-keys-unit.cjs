"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");
const { scanDirectory } = require("./check-release-private-keys.cjs");

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-private-key-check-"));
  try {
    const source = path.join(scratch, "source");
    fs.mkdirSync(source);
    const begin = `-----BEGIN ${"PRIVATE KEY"}-----`;
    const end = `-----END ${"PRIVATE KEY"}-----`;
    fs.writeFileSync(path.join(source, "parser.js"), `const marker = ${JSON.stringify(begin)};\n`);
    fs.writeFileSync(path.join(source, "fixture.js"),
      `const fake = ${JSON.stringify(`${begin}\nfixture-private-material\n${end}`)};\n`);
    assert.equal(scanDirectory(source).fileCount, 2, "format parsers and synthetic fixtures are allowed");

    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" });
    const leaked = path.join(source, "notes.txt");
    fs.writeFileSync(leaked, pem);
    assert.throws(() => scanDirectory(source), /PRIVATE_KEY_MATERIAL_FOUND.*notes\.txt.*private key block/u);
    fs.rmSync(leaked);

    const env = path.join(source, ".env");
    fs.writeFileSync(env, "PLACEHOLDER=true\n");
    assert.throws(() => scanDirectory(source), /PRIVATE_KEY_MATERIAL_FOUND.*\.env.*credential file name/u);
    fs.rmSync(env);

    const linkedKey = path.join(source, "id_ed25519");
    fs.symlinkSync("missing-local-key", linkedKey);
    assert.throws(() => scanDirectory(source), /PRIVATE_KEY_MATERIAL_FOUND.*id_ed25519.*credential symlink name/u);
    fs.rmSync(linkedKey);

    const jwk = path.join(source, "private.jwk");
    fs.writeFileSync(jwk, JSON.stringify(privateKey.export({ format: "jwk" })));
    assert.throws(() => scanDirectory(source), /PRIVATE_KEY_MATERIAL_FOUND.*private\.jwk.*private JWK/u);
    fs.rmSync(jwk);

    const der = path.join(source, "private.der");
    fs.writeFileSync(der, privateKey.export({ format: "der", type: "pkcs8" }));
    assert.throws(() => scanDirectory(source), /PRIVATE_KEY_MATERIAL_FOUND.*private\.der.*DER private key/u);
    fs.rmSync(der);

    const app = path.join(scratch, "Shoggoth.app", "Contents", "Resources");
    fs.mkdirSync(app, { recursive: true });
    const template = path.join(app, "bundled-plugins", "packages", "product-design",
      "templates", "prototype", ".npmrc");
    fs.mkdirSync(path.dirname(template), { recursive: true });
    const safeTemplate = "cache=.npm-cache\nfund=false\naudit=false\n";
    fs.writeFileSync(template, safeTemplate);
    const archive = path.join(app, "app.asar");
    await asar.createPackage(source, archive);
    assert.equal(scanDirectory(path.join(scratch, "Shoggoth.app")).fileCount, 3);
    fs.appendFileSync(template, "# changed\n");
    assert.throws(() => scanDirectory(path.join(scratch, "Shoggoth.app")),
      /PRIVATE_KEY_MATERIAL_FOUND.*prototype\/\.npmrc.*credential file name/u);
    fs.writeFileSync(template, safeTemplate);
    fs.writeFileSync(leaked, pem);
    const blockedApp = path.join(scratch, "Blocked.app", "Contents", "Resources");
    fs.mkdirSync(blockedApp, { recursive: true });
    await asar.createPackage(source, path.join(blockedApp, "app.asar"));
    assert.throws(() => scanDirectory(path.join(scratch, "Blocked.app")),
      /PRIVATE_KEY_MATERIAL_FOUND.*app\.asar:notes\.txt.*private key block/u);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log("Release private-key source and App gate: PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });
