#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectThirdPartyLicenses } from "./third-party-licenses.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
const codex = JSON.parse(fs.readFileSync(path.join(repoRoot, "build", "codex-runtime-manifest.json"), "utf8"));
const cua = JSON.parse(fs.readFileSync(path.join(repoRoot, "build", "cua-driver-manifest.json"), "utf8"));

function purlName(name) {
  if (!name.startsWith("@")) return name;
  const [scope, leaf] = name.slice(1).split("/");
  return `%40${encodeURIComponent(scope)}/${encodeURIComponent(leaf)}`;
}

function hashFromIntegrity(integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error("RELEASE_LOCK_INTEGRITY_MISSING");
  }
  return { alg: "SHA-512", content: Buffer.from(integrity.slice(7), "base64").toString("hex") };
}

function licenses(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("RELEASE_LICENSE_MISSING");
  if (value.startsWith("SEE LICENSE") || value.startsWith("LicenseRef-")) return [{ license: { name: value } }];
  return value.includes(" AND ") || value.includes(" OR ") || value.includes(" WITH ")
    ? [{ expression: value }]
    : [{ license: { id: value } }];
}

const components = new Map();
function addNpm(name, packagePath, properties = []) {
  const entry = lock.packages[packagePath];
  if (!entry?.version) throw new Error(`RELEASE_PACKAGE_MISSING:${name}`);
  const purl = `pkg:npm/${purlName(name)}@${entry.version}`;
  components.set(purl, {
    type: "library",
    name,
    version: entry.version,
    "bom-ref": purl,
    hashes: [hashFromIntegrity(entry.integrity)],
    licenses: licenses(entry.license),
    purl,
    ...(properties.length > 0 ? { properties } : {}),
  });
  return purl;
}

const electronRef = addNpm("electron", "node_modules/electron", [
  { name: "shoggoth:role", value: "desktop-runtime" },
]);
const wsRef = addNpm("ws", "node_modules/ws");
const ptyRef = addNpm("node-pty", "node_modules/node-pty");
const xtermRef = addNpm("@xterm/headless", "node_modules/@xterm/headless");
const fflateRef = addNpm("fflate", "node_modules/fflate", [
  { name: "shoggoth:role", value: "inspiration-archive;plugin-git-archive" },
]);
const mcpClientRef = addNpm("@modelcontextprotocol/client", "node_modules/@modelcontextprotocol/client", [
  { name: "shoggoth:role", value: "plugin-mcp-client" },
]);
const mcpCoreRef = addNpm("@modelcontextprotocol/core", "node_modules/@modelcontextprotocol/core");
const mcpClientDependencyRefs = [
  addNpm("cross-spawn", "node_modules/cross-spawn"),
  addNpm("eventsource", "node_modules/eventsource"),
  addNpm("eventsource-parser", "node_modules/eventsource-parser"),
  addNpm("jose", "node_modules/jose"),
  addNpm("pkce-challenge", "node_modules/pkce-challenge"),
  addNpm("zod", "node_modules/zod"),
];
const cronRef = addNpm("cron-parser", "node_modules/cron-parser");
const sqlite = JSON.parse(fs.readFileSync(path.join(repoRoot, "build/inspiration-sqlite-manifest.json")));
const sqliteRef = addNpm("better-sqlite3", "node_modules/better-sqlite3", [
  { name: "shoggoth:role", value: "inspiration-storage" },
  { name: "shoggoth:sqlite-version", value: sqlite.sqliteVersion },
  ...Object.entries(sqlite.architectures).map(([arch, entry]) => ({ name: `shoggoth:electron-native-${arch}-sha256`, value: entry.binarySha256 })),
]);
const luxonRef = addNpm("luxon", "node_modules/luxon");
const cuaSdkRef = addNpm("@trycua/cua-driver", "node_modules/@trycua/cua-driver", [
  { name: "shoggoth:role", value: "computer-use-sdk" },
]);
const ubjsCoreRef = addNpm("@ubjs/core", "node_modules/@ubjs/core");
const ubjsNodeRef = addNpm("@ubjs/node", "node_modules/@ubjs/node");
const nativeRefs = cua.nodePackages.map((entry) => {
  const purl = `pkg:npm/${purlName(entry.name)}@${entry.version}`;
  const lockEntry = lock.packages[`node_modules/${entry.name}`];
  if (!lockEntry || lockEntry.version !== entry.version) throw new Error("RELEASE_CUA_LOCK_MISMATCH");
  components.set(purl, {
    type: "library",
    name: entry.name,
    version: entry.version,
    "bom-ref": purl,
    hashes: [{ alg: "SHA-256", content: entry.archiveSha256 }],
    licenses: licenses(lockEntry.license),
    purl,
    properties: [
      { name: "shoggoth:target-arch", value: entry.arch },
      { name: "shoggoth:archive-url", value: entry.archiveUrl },
    ],
  });
  return purl;
});

const cuaBinaryRef = `pkg:generic/cua-driver@${cua.version}`;
components.set(cuaBinaryRef, {
  type: "application",
  name: "cua-driver",
  version: cua.version,
  "bom-ref": cuaBinaryRef,
  hashes: [{ alg: "SHA-256", content: cua.binarySha256 }],
  licenses: licenses("MIT"),
  purl: cuaBinaryRef,
  externalReferences: [{ type: "distribution", url: cua.archiveUrl }],
  properties: [
    { name: "shoggoth:contract-version", value: cua.contractVersion },
    { name: "shoggoth:architectures", value: cua.architectures.join(",") },
    { name: "shoggoth:update-policy", value: "release-only; runtime self-update disabled" },
  ],
});

const codexRefs = Object.entries(codex.platforms).map(([platform, entry]) => {
  const ref = `pkg:generic/openai-codex@${codex.runtime.version}?platform=${platform}`;
  components.set(ref, {
    type: "application",
    name: "OpenAI Codex",
    version: codex.runtime.version,
    "bom-ref": ref,
    hashes: [{ alg: "SHA-256", content: entry.archiveSha256 }],
    licenses: licenses(codex.runtime.license),
    purl: ref,
    externalReferences: [{ type: "distribution", url: entry.archiveUrl }],
    properties: [{ name: "shoggoth:target-arch", value: entry.arch }],
  });
  return ref;
});

const check = process.argv.includes("--check");
const inventory = collectThirdPartyLicenses(repoRoot, { check });
const inventoryRefs = inventory.npm.map((entry) => {
  const purl = `pkg:npm/${purlName(entry.name)}@${entry.version}`;
  const existing = components.get(purl);
  components.set(purl, {
    type: "library", name: entry.name, version: entry.version, "bom-ref": purl, purl,
    hashes: [hashFromIntegrity(entry.integrity)],
    licenses: licenses(entry.selectedLicense || entry.license),
    ...existing,
    properties: [
      ...(existing?.properties || []),
      { name: "shoggoth:dependency-scopes", value: entry.scopes.join(",") },
      { name: "shoggoth:distribution", value: entry.distributed ? "macos-production-input" : "development-or-other-platform" },
    ],
  });
  return purl;
});
for (const entry of inventory.sources) {
  const ref = `source:${entry.name}`;
  components.set(ref, {
    type: entry.license === "OFL-1.1" ? "file" : "library",
    name: entry.name, version: entry.revision, "bom-ref": ref,
    licenses: licenses(entry.license),
    properties: [{ name: "shoggoth:local-files", value: entry.localFiles.join(",") }],
  });
  inventoryRefs.push(ref);
}

const rootRef = `pkg:generic/shoggoth@${packageJson.version}`;
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: {
      type: "application",
      name: packageJson.productName,
      version: packageJson.version,
      licenses: licenses(packageJson.license),
      "bom-ref": rootRef,
      purl: rootRef,
      properties: [{ name: "shoggoth:release-metadata", value: "source-and-build-inventory; distribution scope recorded per component" }],
    },
  },
  components: [...components.values()].sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"])),
  dependencies: [
    { ref: rootRef, dependsOn: [
      electronRef, wsRef, ptyRef, xtermRef, fflateRef, mcpClientRef, cronRef, sqliteRef, cuaSdkRef, cuaBinaryRef, ...codexRefs, ...inventoryRefs,
    ].filter((ref, index, refs) => refs.indexOf(ref) === index).sort() },
    { ref: mcpClientRef, dependsOn: [mcpCoreRef, ...mcpClientDependencyRefs].sort() },
    { ref: mcpCoreRef, dependsOn: [mcpClientDependencyRefs.at(-1)] },
    { ref: cronRef, dependsOn: [luxonRef] },
    { ref: cuaSdkRef, dependsOn: [ubjsCoreRef, ubjsNodeRef, ...nativeRefs].sort() },
    { ref: ubjsNodeRef, dependsOn: nativeRefs.filter((ref) => ref.includes("%40ubjs/")) },
  ],
};

const sbomPath = path.join(repoRoot, "build", "release-sbom.cdx.json");
const sbomText = `${JSON.stringify(bom, null, 2)}\n`;
if (check) {
  if (fs.readFileSync(sbomPath, "utf8") !== sbomText) throw new Error("SBOM out of date; run npm run release:metadata");
} else fs.writeFileSync(sbomPath, sbomText, "utf8");
process.stdout.write(`Release metadata ${check ? "verified" : "generated"}: ${bom.components.length} components\n`);
