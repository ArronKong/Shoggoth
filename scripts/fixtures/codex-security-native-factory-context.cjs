'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { resolveServicePaths } = require('../../app/agent-service/paths');
const { JsonlProductStore } = require('../../app/agent-service/product-store');
const { createWorkDispatcher, ACTIVE_WORK_RUN_STATUSES } = require('../../app/agent-service/work-run');
const { HostCapabilityIssuer } = require('../../app/agent-service/host-capability-issuer');
const { RuntimeAccountAdmission } = require('../../app/agent-service/runtime-account-admission');
const { RuntimeAccountResolver } = require('../../app/agent-service/runtime-account-resolver');
const { BundledPluginCatalog } = require('../../app/core/bundled-plugin-catalog');
const { PluginStore } = require('../../app/agent-service/plugin-store');
const { PluginPackageInstaller } = require('../../app/agent-service/plugin-package-installer');
const { PluginComponentResolver } = require('../../app/agent-service/plugin-component-resolver');
const { CodexSecurityNativeJobStore } = require('../../app/agent-service/codex-security-native-job-store');
const { CodexSecurityNativeHostPlanFactory } = require('../../app/agent-service/codex-security-native-host-plan');
const { inspectExecutable } = require('../../app/agent-service/plugin-dependency-registry');
const repoRoot = path.resolve(__dirname, '../..');
function removeFixtureRoot(root) {
  if (fs.realpathSync(root) !== root || !/^\/private\/tmp\/sg-security-native-factory-[A-Za-z0-9]+$/u.test(root)) throw new Error('Exact owned fixture root required');
  const walk = directory => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Unsafe fixture cleanup');
    fs.chmodSync(directory, 0o700);
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name), child = fs.lstatSync(target);
      if (child.isDirectory() && !child.isSymbolicLink()) walk(target);
      else if (child.isSymbolicLink() && child.uid === process.getuid()
        && /^[a-zA-Z0-9._/-]*\/home\/tmp\/arg0\/codex-arg0[a-zA-Z0-9]+\/(?:apply_patch|applypatch|codex-execve-wrapper)$/u.test(path.relative(root, target))
        && fs.readlinkSync(target) === path.join(repoRoot, '.vendor/codex', process.arch, 'package/bin/codex')) {
        // Exact native-created helper aliases: unlink the leaf, never follow its target.
        fs.unlinkSync(target);
      } else if (!child.isFile() || child.isSymbolicLink() || child.uid !== process.getuid()) throw new Error('Unsafe fixture cleanup');
    }
  };
  walk(root); fs.rmSync(root, { recursive: true, force: false });
}
function createContext({ onNativeHost = null, maxPending = 64 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-security-native-factory-')); fs.chmodSync(root, 0o700);
  const home = path.join(root, 'fixture-home'); fs.mkdirSync(home, { mode: 0o700 });
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace, { mode: 0o700 });
  const paths = resolveServicePaths({ trustedRoot: root, userDataRoot: path.join(root, 'app'),
    homeDir: home, stateRoot: path.join(root, 'state'), cacheRoot: path.join(root, 'cache') });
  const productStore = new JsonlProductStore({ paths }); productStore.open();
  const profile = productStore.listAgentProfiles()[0];
  const dispatcher = createWorkDispatcher({ store: productStore });
  const run = dispatcher.enqueue({ id: 'security-metadata-owning-run', source: 'chat', sourceId: 'local-security-metadata',
    idempotencyKey: 'local-security-metadata', profileId: profile.id, workspace });
  dispatcher.admit(run.id, { writable: false });
  const admittedRun = dispatcher.getRun(run.id);
  const admission = new RuntimeAccountAdmission({ runtimeAccountLookup: id => productStore.getRuntimeAccount(id) });
  const accountAdmission = admission.admit({ runtimeAccountId: profile.runtimeAccountId, runId: run.id });
  const issuer = new HostCapabilityIssuer();
  const identity = { runId: run.id, profileId: profile.id, bindingId: profile.defaultBindingId, runtime: 'codex',
    runtimeAccountId: profile.runtimeAccountId, attemptId: 'security-metadata-attempt', workspace,
    accountGeneration: accountAdmission.generation };
  const lease = issuer.issue({ identity, grants: ['mcp'], validate: captured => ACTIVE_WORK_RUN_STATUSES.has(dispatcher.getRun(captured.runId)?.status) });
  const catalog = new BundledPluginCatalog(path.join(repoRoot, 'resources/bundled-plugins'));
  const store = new PluginStore({ paths }).open();
  const installer = new PluginPackageInstaller({ store, bundledCatalog: catalog });
  const preview = installer.previewBundled('codex-security');
  const installation = installer.installBundled({ packageId: 'codex-security', previewDigest: preview.contentDigest,
    operationId: 'frozen-security-release', expectedRevision: 0 });
  const resolver = new PluginComponentResolver({ store });
  const runtimeResolver = new RuntimeAccountResolver({ paths, repoRoot, homedir: home,
    parentEnv: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: root } });
  // Explicit local executable choices, never PATH discovery or dependency copying.
  const nodePath = fs.realpathSync(process.execPath);
  const pythonPath = ['/opt/homebrew/bin/python3', '/Library/Developer/CommandLineTools/usr/bin/python3']
    .find(file => { try { inspectExecutable(file); return true; } catch { return false; } });
  if (!pythonPath) throw new Error('No supported local regular Python executable; no download/fallback allowed');
  const jobs = new CodexSecurityNativeJobStore({ paths, maxPending }).open();
  const factory = new CodexSecurityNativeHostPlanFactory({ paths, store, resolver, bundledCatalog: catalog,
    productStore, dispatcher, capabilityIssuer: issuer, runtimeAccountAdmission: admission,
    runtimeAccountResolver: runtimeResolver, jobStore: jobs, nodePath, pythonPath, repoRoot, onNativeHost });
  const owner = { runId: run.id, profileId: profile.id, bindingId: profile.defaultBindingId,
    runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
    attemptId: identity.attemptId, accountGeneration: accountAdmission.generation,
    workspace, contextSnapshotId: admittedRun.contextSnapshotId };
  return { root, home, workspace, paths, productStore, profile, dispatcher, run, admission, issuer, identity, lease,
    store, installer, resolver, catalog, runtimeResolver, installation, jobs, factory, owner,
    async close({ cleanup = true } = {}) {
      await factory.close(); issuer.close(); jobs.close(); store.close(); productStore.close();
      if (cleanup) removeFixtureRoot(root);
    } };
}
module.exports = { createContext, repoRoot, removeFixtureRoot };
