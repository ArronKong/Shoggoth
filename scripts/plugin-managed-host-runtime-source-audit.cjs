'use strict';
// Read-only real installations. --capture writes only a new, explicit output
// policy; it is local-baseline evidence, not an upstream reproducible-build claim.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { snapshotRuntimeTree, hashFile, patchedTreeDigest, createManagedPluginHostRuntimeManager }
  = require('../app/managed-plugin-host-runtime');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SOURCE_OC = '/opt/homebrew/lib/node_modules/openclaw';
const SOURCE_HERMES = require('node:path').join(require('node:os').homedir(), '.hermes', 'hermes-agent');
const NODE = (process.env.SHOGGOTH_TEST_OPENCLAW_NODE || require('node:path').join(require('node:os').homedir(), '.local', 'share', 'node', 'v24.21.0', 'bin', 'node'));
const PYTHON = path.join(SOURCE_HERMES, 'venv/bin/python');
const resourcesRoot = path.resolve(__dirname, '../resources/external-plugin-host-patches');
const payloadRelative = 'openclaw/2026.9.5';
const payload = path.join(resourcesRoot, payloadRelative);
const manifestFile = 'openclaw-2026.9.5-selection.json';
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 4 || args[0] !== '--capture' || args[2] !== '--evidence')) {
  throw new Error('Usage: node scripts/plugin-managed-host-runtime-source-audit.cjs [--capture NEW_POLICY --evidence NEW_EVIDENCE]');
}
function writeNew(file, value) {
  if (!path.isAbsolute(file)) throw new Error('Output must be absolute');
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
(async () => {
  const initial = snapshotRuntimeTree(SOURCE_OC);
  const verified = require('./openclaw-selection-host-patch.cjs').validatePinnedSource(SOURCE_OC, payload);
  const dependency = snapshotRuntimeTree(path.join(SOURCE_OC, 'node_modules'), { containmentRoot: SOURCE_OC });
  const node = JSON.parse(execFileSync(NODE, ['-p', 'JSON.stringify({version:process.versions.node,architecture:process.arch,platform:process.platform})'], { encoding: 'utf8' }));
  const pin = { version: 1, backendId: 'openclaw', hostVersion: verified.manifest.packageVersion,
    inputTreeSha256: initial.sha256, outputTreeSha256: patchedTreeDigest(initial,
      verified.changes.map(item => ({ path: item.path, bytes: Buffer.from(item.content) }))),
    dependencyTreeSha256: dependency.sha256, payloadTreeSha256: snapshotRuntimeTree(payload).sha256,
    payloadManifestSha256: hashFile(path.join(payload, manifestFile)), identityFile: 'package.json',
    identityFileSha256: hashFile(path.join(SOURCE_OC, 'package.json')), dependencyPath: 'node_modules',
    entryRelative: 'openclaw.mjs', payloadRelative, manifestFile,
    licenseFiles: verified.manifest.licenseFiles, interpreter: { ...node, sha256: hashFile(fs.realpathSync(NODE)) } };
  const pins = { version: 1, hosts: { openclaw: pin }, provenance: {
    scope: 'Exact machine-local installed input baseline; no official full dependency archive reproduction claim',
    hermes: 'Unpinned: full installation contains escaping .venv Python 3.14 links; no candidate or activation allowed',
  } };
  const manager = createManagedPluginHostRuntimeManager({ stateDir: '/private/tmp/unused-managed-host-source-audit-state',
    resourcesRoot, inputPins: pins });
  const openclaw = await manager.inspectSource({ backendId: 'openclaw', sourceRoot: SOURCE_OC,
    interpreterPath: NODE, architecture: node.architecture });
  let hermesTree;
  try { const tree = snapshotRuntimeTree(SOURCE_HERMES); hermesTree = { sha256: tree.sha256, verified: true }; }
  catch (error) { hermesTree = { verified: false, code: error.code, detail: error.message }; }
  const hermesPinnedSources = require('./hermes-selection-host-patch.cjs').verify(SOURCE_HERMES);
  const python = JSON.parse(execFileSync(PYTHON, ['-I', '-B', '-c',
    "import json,sys,platform,importlib.util; print(json.dumps({'version':platform.python_version(),'architecture':platform.machine(),'prefix':sys.prefix,'basePrefix':sys.base_prefix,'uvicorn':importlib.util.find_spec('uvicorn') is not None}))"],
  { encoding: 'utf8' }));
  let hermesDependency;
  try { const tree = snapshotRuntimeTree(path.join(SOURCE_HERMES, 'venv'), { containmentRoot: SOURCE_HERMES });
    hermesDependency = { sha256: tree.sha256, verified: true }; }
  catch (error) { hermesDependency = { verified: false, code: error.code, detail: error.message }; }
  const webDist = snapshotRuntimeTree(path.join(SOURCE_HERMES, 'hermes_cli/web_dist'), { containmentRoot: SOURCE_HERMES });
  if (snapshotRuntimeTree(SOURCE_OC).sha256 !== initial.sha256) throw new Error('Global OpenClaw changed during audit');
  const evidence = { version: 1, observedAt: new Date().toISOString(), status: 'PASS_WITH_EXPLICIT_HERMES_BLOCKER',
    openclaw: { ...openclaw, policySha256: sha(JSON.stringify(pin)), sourceCopyCreated: false,
      coldStartVerified: false, writerHandoffVerified: false },
    hermes: { sourceCommit: hermesPinnedSources.sourceCommit, boundedPatchFilesVerified: hermesPinnedSources.fileCount,
      fullInputTree: hermesTree, dependencyTree: hermesDependency, webDistTreeSha256: webDist.sha256,
      interpreter: { ...python, sha256: hashFile(fs.realpathSync(PYTHON)) },
      fullyPinned: false, borrowedDependencyIsComplete: false, candidateCreated: false, activationVerified: false },
    productionHostStarts: 0, modelRequests: 0, originalGlobalWrites: 0,
    note: 'Pins freeze this exact input baseline and architecture; they are not approval of all upstream redistribution licenses.' };
  if (args.length) { writeNew(args[1], pins); writeNew(args[3], evidence); }
  console.log(JSON.stringify({ status: evidence.status, openclawInputSha256: initial.sha256,
    openclawOutputSha256: pin.outputTreeSha256, openclawFiles: initial.files,
    hermesCode: hermesTree.code, originalGlobalWrites: 0, productionHostStarts: 0 }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
