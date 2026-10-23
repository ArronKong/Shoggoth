"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWritePrivateFile, readPrivateFile, preparePrivateParent, fsyncPrivateParent } = require("../private-file");
const { ensurePrivateDirectoryTree } = require("../security");

const REVISION = "c10679395819ede78bb073f979f95c157e165bfa";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const sha256 = content => crypto.createHash("sha256").update(content).digest("hex");
const exists = target => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const writeJson = (target, value, paths) => atomicWritePrivateFile(target, JSON.stringify(value, null, 2) + "\n", { trustedRoot: paths.trustedRoot });
const readJson = target => JSON.parse(readPrivateFile(target, { maxBytes: 512 * 1024 * 1024 }).toString("utf8"));

function renderMemoryEntry(item) {
  if (!ID.test(item.id)) throw new Error("Invalid migrated memory identity");
  // The delimiter belongs to the storage adapter. Authored text cannot close it.
  const text = item.content.replace(/<!--\s*\/?shoggoth-memory-entry\b/gi, "&lt;!-- shoggoth-memory-entry");
  const lines = text.split("\n");
  const annotation = ["project", "workspace"].includes(item.scope)
    ? item.sourceRefs.find(ref => ref.startsWith("workspace:")) : null;
  return [
    `<!-- shoggoth-memory-entry:${item.id} -->`,
    `- ${lines[0]}${annotation ? ` <!-- project:${annotation} -->` : ""}`,
    ...lines.slice(1).map(line => `  ${line}`),
    "<!-- /shoggoth-memory-entry -->", "",
  ].join("\n");
}

// This migration never writes to the legacy store. Its complete authority files
// and a decoded snapshot survive beside the new workspace for explicit rollback.
class ShoggothMemoryMigration {
  constructor({ paths, now = Date.now, readLegacy, assertLegacyCurrent, fault = () => {} }) {
    this.paths = paths;
    this.now = now;
    this.readLegacy = readLegacy;
    this.assertLegacyCurrent = assertLegacyCurrent;
    this.fault = fault;
  }

  locations(profileId) {
    if (!ID.test(profileId)) throw new Error("Invalid migration Profile");
    const profileDir = path.join(this.paths.agentsDir, profileId);
    const directory = path.join(profileDir, "memory-migration-shoggoth-v1");
    return { profileDir, directory, manifest: path.join(directory, "manifest.json"),
      snapshot: path.join(directory, "legacy-snapshot.json"),
      staging: path.join(directory, "workspace-staging"),
      workspace: path.join(profileDir, "memory-workspace") };
  }

  verifyBackups(locations, manifest) {
    if (manifest.schemaVersion !== 1 || manifest.upstreamRevision !== REVISION) throw new Error("Unsupported memory migration checkpoint");
    for (const file of manifest.backupFiles) {
      if (!/^[A-Za-z0-9_.-]+$/.test(file.name)) throw new Error("Invalid memory backup path");
      const data = readPrivateFile(path.join(locations.directory, "backup", file.name), { maxBytes: 512 * 1024 * 1024 });
      if (data.length !== file.bytes || sha256(data) !== file.sha256) throw new Error("Memory migration backup verification failed");
    }
    if (sha256(readPrivateFile(locations.snapshot, { maxBytes: 512 * 1024 * 1024 })) !== manifest.snapshotHash) throw new Error("Memory migration snapshot verification failed");
    return readJson(locations.snapshot);
  }

  previewRollback(profileId, { assertServiceStopped, assertNewStateUnchanged } = {}) {
    if (typeof assertServiceStopped !== "function" || typeof assertNewStateUnchanged !== "function") throw new Error("Rollback preview requires stopped-Service and new-state proofs");
    assertServiceStopped();
    const locations = this.locations(profileId), manifest = readJson(locations.manifest);
    this.verifyBackups(locations, manifest);
    if (manifest.phase !== "active") throw new Error("Only an activated migration can be evaluated for rollback");
    assertNewStateUnchanged(manifest);
    for (const file of manifest.backupFiles) {
      if (sha256(readPrivateFile(file.source, { maxBytes: 512 * 1024 * 1024 })) !== file.sha256) throw new Error("Rollback refused: legacy policy or records changed after migration");
    }
    const actual = [];
    const walk = directory => {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, item.name);
        if (item.isSymbolicLink()) throw new Error("Rollback refused: workspace path changed");
        if (item.isDirectory()) walk(target);
        else actual.push(path.relative(locations.workspace, target));
      }
    };
    walk(locations.workspace);
    if (actual.length !== Object.keys(manifest.initialFiles).length || actual.some(name => !manifest.initialFiles[name]
      || sha256(readPrivateFile(path.join(locations.workspace, name), { maxBytes: 512 * 1024 * 1024 })) !== manifest.initialFiles[name])) {
      throw new Error("Rollback refused: new file memories must be preserved and reconciled first");
    }
    // Legacy authority was retained in place. Switching the stopped Service's
    // writer is sufficient; neither side needs deletion, replacement or rename.
    return { safeToSelectLegacyWriter: true, profileId, legacyDirectory: path.join(locations.profileDir, "memory"),
      retainedWorkspace: locations.workspace, backupDirectory: locations.directory, snapshotHash: manifest.snapshotHash };
  }

  // Planning can capture new facts, but never authorizes the old writer. The
  // planner reports semantics that the legacy format cannot represent.
  planRollback(profileId, options) {
    const { StoppedMemoryRollbackPlanner } = require("./rollback-planner.cjs");
    return new StoppedMemoryRollbackPlanner({ migration: this, paths: this.paths, fault: this.fault }).plan(profileId, options);
  }

  verifyRollbackPlan(profileId, options) {
    const { StoppedMemoryRollbackPlanner } = require("./rollback-planner.cjs");
    return new StoppedMemoryRollbackPlanner({ migration: this, paths: this.paths, fault: this.fault }).verify(profileId, options);
  }

  prepareRollbackApply(profileId, options) {
    const { StoppedMemoryRollbackApply } = require("./rollback-apply.cjs");
    return new StoppedMemoryRollbackApply({ migration: this, paths: this.paths, fault: this.fault }).prepare(profileId, options);
  }

  applyRollback(profileId, options) {
    const { StoppedMemoryRollbackApply } = require("./rollback-apply.cjs");
    return new StoppedMemoryRollbackApply({ migration: this, paths: this.paths, fault: this.fault }).apply(profileId, options);
  }

  recoverRollbackApply(profileId, options) {
    const { StoppedMemoryRollbackApply } = require("./rollback-apply.cjs");
    return new StoppedMemoryRollbackApply({ migration: this, paths: this.paths, fault: this.fault }).recover(profileId, options);
  }

  verifyRollbackApplied(profileId, options) {
    const { StoppedMemoryRollbackApply } = require("./rollback-apply.cjs");
    return new StoppedMemoryRollbackApply({ migration: this, paths: this.paths, fault: this.fault }).verify(profileId, options);
  }

  run(profileId) {
    const locations = this.locations(profileId);
    ensurePrivateDirectoryTree(locations.directory, this.paths.trustedRoot);
    let manifest;
    if (exists(locations.manifest)) {
      manifest = readJson(locations.manifest);
      if (manifest.profileId !== profileId) throw new Error("Migration checkpoint belongs to another Profile");
      this.verifyBackups(locations, manifest);
      if (manifest.phase === "active") {
        if (!exists(locations.workspace)) throw new Error("Published memory workspace is missing");
        return { ...manifest, workspace: locations.workspace };
      }
      if (manifest.phase !== "prepared") throw new Error("Memory migration is not resumable");
    } else {
      if (exists(locations.workspace)) throw new Error("Unowned memory workspace exists; refusing to overwrite it");
      const legacy = this.readLegacy(profileId);
      const backupFiles = [];
      const names = new Set();
      for (const file of legacy.files) {
        if (!/^[A-Za-z0-9_.-]+$/.test(file.name) || names.has(file.name)) throw new Error("Invalid or duplicate migration backup name");
        names.add(file.name);
        const data = readPrivateFile(file.path, { maxBytes: 512 * 1024 * 1024 });
        const target = path.join(locations.directory, "backup", file.name);
        if (exists(target)) {
          if (!readPrivateFile(target, { maxBytes: 512 * 1024 * 1024 }).equals(data)) throw new Error("Memory migration backup conflicts with its source");
        } else atomicWritePrivateFile(target, data, { trustedRoot: this.paths.trustedRoot });
        backupFiles.push({ name: file.name, source: file.path, sha256: sha256(data), bytes: data.length });
      }
      const snapshot = { schemaVersion: 1, profileId, revision: legacy.revision, recallRevision: legacy.recallRevision,
        records: legacy.records, historicalSourceItems: legacy.historicalSourceItems || [],
        contentRevisions: legacy.contentRevisions || {},
        visibleIds: legacy.visibleIds, provenance: legacy.provenance || null, createdAt: this.now() };
      if (snapshot.records.some(item => item.profileId !== profileId || !ID.test(item.id))) throw new Error("Legacy memory ownership is invalid");
      this.assertLegacyCurrent(profileId, snapshot, backupFiles);
      writeJson(locations.snapshot, snapshot, this.paths);
      manifest = { schemaVersion: 1, profileId, upstreamRevision: REVISION, phase: "prepared", createdAt: this.now(),
        legacyRevision: legacy.revision, recallRevision: legacy.recallRevision,
        snapshotHash: sha256(readPrivateFile(locations.snapshot, { maxBytes: 512 * 1024 * 1024 })), backupFiles };
      writeJson(locations.manifest, manifest, this.paths);
      this.fault("after-prepared", profileId);
    }

    const snapshot = this.verifyBackups(locations, manifest);
    this.assertLegacyCurrent(profileId, snapshot, manifest.backupFiles);
    const visible = new Set(snapshot.visibleIds);
    const active = snapshot.records.filter(item => visible.has(item.id) && item.status === "active"
      && item.validFrom <= this.now() && (item.validUntil === null || item.validUntil > this.now()));
    const user = active.filter(item => item.scope === "user"), memory = active.filter(item => item.scope !== "user");
    const generated = {
      "USER.md": "# User\n\n" + user.map(renderMemoryEntry).join("\n"),
      "MEMORY.md": "# Memory\n\n" + memory.map(renderMemoryEntry).join("\n"),
      ".shoggoth-memory-migration.json": JSON.stringify({ schemaVersion: 1, profileId, snapshotHash: manifest.snapshotHash, upstreamRevision: REVISION }) + "\n",
    };
    if (!exists(locations.workspace)) {
      ensurePrivateDirectoryTree(path.join(locations.staging, "memory"), this.paths.trustedRoot);
      for (const [name, content] of Object.entries(generated)) {
        const target = path.join(locations.staging, name);
        if (exists(target) && readPrivateFile(target, { maxBytes: 512 * 1024 * 1024 }).toString("utf8") !== content) throw new Error("Migration staging changed outside this transaction");
        if (!exists(target)) atomicWritePrivateFile(target, content, { trustedRoot: this.paths.trustedRoot });
      }
      this.fault("after-staged", profileId);
      this.assertLegacyCurrent(profileId, snapshot, manifest.backupFiles);
      preparePrivateParent(locations.workspace, this.paths.trustedRoot);
      if (exists(locations.workspace)) throw new Error("Memory workspace appeared during migration");
      fs.renameSync(locations.staging, locations.workspace);
      fsyncPrivateParent(locations.profileDir);
      this.fault("after-published", profileId);
    } else {
      // A crash after directory publication is recoverable only while its exact
      // initial bytes prove that no later writer has acquired this workspace.
      for (const [name, content] of Object.entries(generated)) {
        if (readPrivateFile(path.join(locations.workspace, name), { maxBytes: 512 * 1024 * 1024 }).toString("utf8") !== content) throw new Error("Published migration is ambiguous; preserving both stores");
      }
    }
    manifest = { ...manifest, phase: "active", activatedAt: this.now(), imported: active.length,
      retained: snapshot.records.length - active.length,
      initialFiles: Object.fromEntries(Object.entries(generated).map(([name, content]) => [name, sha256(content)])) };
    writeJson(locations.manifest, manifest, this.paths);
    return { ...manifest, workspace: locations.workspace };
  }
}

module.exports = { ShoggothMemoryMigration, renderMemoryEntry, sha256 };
