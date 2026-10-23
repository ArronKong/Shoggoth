"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { core } = require("./host.cjs");
const { withMemoryObserverCleanup } = require("./host-bridge.cjs");

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const denied = () => Object.assign(new Error("Memory file is outside the configured sources"), { code: "MEMORY_PATH_NOT_ALLOWED" });
const changed = () => Object.assign(new Error("Memory file changed during reading"), { code: "MEMORY_SOURCE_CHANGED" });
const missing = error => ["ENOENT", "ENOTDIR"].includes(error?.code);
const owned = stat => (typeof process.getuid !== "function" || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const byteIdentity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size,
  mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode, uid: stat.uid, nlink: stat.nlink });
const sameIdentity = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function safeParents(root, target) {
  for (let directory = path.dirname(target); inside(root, directory); directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || !owned(stat)) return false;
    if (directory === root) break;
  }
  return true;
}

// Additional libraries are explicit, read-only inputs. The upstream resolver,
// discovery and glob matcher own selection; Product owns filesystem authority.
class MemorySourceFiles {
  constructor(host, getConfig) { this.host = host; this.getConfig = getConfig; }
  settings() {
    return this.host.run(() => {
      const cfg = this.getConfig(), settings = core.resolveMemorySearchIndexConfig(cfg, this.host.profileId);
      if (!settings) return null;
      const defaults = cfg.memory?.search, overrides = this.host.resolveAgentConfig(cfg, this.host.profileId)?.memory?.search;
      return { ...settings, multimodal: core.normalizeMemoryMultimodalSettings({
        enabled: overrides?.multimodal?.enabled ?? defaults?.multimodal?.enabled,
        modalities: overrides?.multimodal?.modalities ?? defaults?.multimodal?.modalities,
        maxFileBytes: overrides?.multimodal?.maxFileBytes ?? defaults?.multimodal?.maxFileBytes,
      }) };
    });
  }
  settingsStamp(settings) {
    return JSON.stringify([settings?.sources || [],
      core.normalizeExtraMemoryPathEntries(this.host.workspaceDir, settings?.extraPaths),
      settings?.multimodal || { enabled: false, modalities: [], maxFileBytes: 10 * 1024 * 1024 }]);
  }
  captureSettings(settings) {
    const stamp = this.settingsStamp(settings);
    if (stamp !== this.settingsStamp(this.settings())) throw changed();
    return stamp;
  }
  assertSettings(stamp) {
    this.host.assertWorkspace(this.host.workspaceDir);
    if (stamp !== this.settingsStamp(this.settings())) throw changed();
  }
  protectedPath(target) {
    if (this.host.roster().filter(profile => profile.id !== this.host.profileId)
      .some(profile => inside(path.resolve(profile.workspace), target))) return true;
    const roots = [this.host.paths.stateDir, this.host.paths.profileDir, this.host.paths.cacheDir, this.host.paths.runtimeDir];
    return roots.filter(Boolean).some(value => {
      const root = path.resolve(value);
      if (!inside(root, target)) return false;
      // Canonical memory-workspace lives below stateDir/agents. Permit only
      // that owned subtree of an enclosing Service root, never a Service root
      // nested inside the memory workspace or another Profile's subtree.
      return !(root !== this.host.workspaceDir && inside(root, this.host.workspaceDir)
        && inside(this.host.workspaceDir, target));
    });
  }
  relative(target) { return path.relative(this.host.workspaceDir, target).replaceAll(path.sep, "/"); }
  isManaged(relative) {
    return typeof relative === "string" && !path.isAbsolute(relative) && !relative.includes("\\")
      && path.posix.normalize(relative) === relative && inside(this.host.workspaceDir, path.resolve(this.host.workspaceDir, relative))
      && relative.endsWith(".md") && core.isMemoryPath(relative);
  }
  classify(relative, settings = this.settings()) {
    this.host.assertWorkspace(this.host.workspaceDir);
    if (typeof relative !== "string" || !relative || relative.includes("\0") || relative.includes("\\")
      || path.isAbsolute(relative) || path.posix.normalize(relative) !== relative) return null;
    const target = path.resolve(this.host.workspaceDir, relative);
    if (this.protectedPath(target)) return null;
    if (this.isManaged(relative)) {
      try { return safeParents(this.host.workspaceDir, target) ? { kind: "memory", target } : null; }
      catch (error) { if (missing(error)) return null; throw error; }
    }
    if (!settings?.sources.includes("memory")) return null;
    const modality = target.endsWith(".md") ? null
      : settings.multimodal?.enabled ? core.classifyMemoryMultimodalPath(target, settings.multimodal) : null;
    if (!target.endsWith(".md") && !modality) return null;
    for (const entry of core.normalizeExtraMemoryPathEntries(this.host.workspaceDir, settings.extraPaths)) {
      if (!inside(entry.path, target) || this.protectedPath(entry.path)) continue;
      try {
        const stat = fs.lstatSync(entry.path);
        if (!owned(stat) || stat.isSymbolicLink() || fs.realpathSync.native(entry.path) !== entry.path) continue;
        if (stat.isFile() && entry.path === target && safeParents(path.dirname(entry.path), target)
          || stat.isDirectory() && safeParents(entry.path, target)
          && core.matchesExtraMemoryPathEntry(entry, target)) {
          return { kind: "extra", target, ...(modality ? { modality } : {}) };
        }
      } catch (error) { if (!missing(error)) throw error; }
    }
    return null;
  }
  isExtra(relative) { return this.classify(relative)?.kind === "extra"; }
  async list(settings) {
    if (!settings?.sources.includes("memory")) return [];
    const stamp = this.captureSettings(settings);
    const extraPaths = core.normalizeExtraMemoryPathEntries(this.host.workspaceDir, settings.extraPaths).filter(entry => {
      if (this.protectedPath(entry.path)) return false;
      try { const stat = fs.lstatSync(entry.path); return owned(stat) && !stat.isSymbolicLink() && fs.realpathSync.native(entry.path) === entry.path; }
      catch (error) { if (missing(error)) return false; throw error; }
    });
    const files = await core.listMemoryFiles(this.host.workspaceDir, extraPaths, settings.multimodal);
    // The pinned default enumerator omits root Dreaming reports. Product owns
    // this discovery addition, using the same admission as every managed file.
    for (const name of ["DREAMS.md", "dreams.md"]) {
      const target = path.join(this.host.workspaceDir, name);
      try { if (fs.lstatSync(target).isFile() && fs.realpathSync.native(target) === target && this.classify(name, settings)) files.push(target); }
      catch (error) { if (!missing(error)) throw error; }
    }
    this.assertSettings(stamp);
    return [...new Set(files)].filter(file => this.classify(this.relative(file), settings));
  }
  watch(request, onEvent, signal) {
    // Keep the pinned watcher policy, metadata settling and physical retirement.
    // Product adds admission to its roots and never supplies file contents here.
    let resolve, reject, readyResolve, readyReject, watcher, monitor, stopping;
    let stopped = false;
    const retirement = new Promise((yes, no) => { resolve = yes; reject = no; });
    const ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no; });
    ready.catch(() => {});
    Object.defineProperty(retirement, "ready", { value: ready });
    const run = action => this.host.run(action);
    const cleanup = action => withMemoryObserverCleanup(this.host, action);
    const onAbort = () => stop();
    const stop = error => {
      if (stopping) return stopping;
      stopped = true;
      clearInterval(monitor);
      signal?.removeEventListener("abort", onAbort);
      stopping = Promise.resolve().then(() => cleanup(() => watcher?.close())).then(() => {
        readyResolve();
        // Authority/configuration failure can race caller shutdown. A clean
        // physical join is cancellation success; only cleanup failures below
        // must survive an aborted subscription as transport retirement errors.
        if (error && !signal?.aborted) reject(error); else resolve();
      }, closeError => {
        readyReject(closeError);
        reject(error ? new AggregateError([error, closeError], "Memory watcher cleanup failed") : closeError);
      });
      return stopping;
    };
    Promise.resolve().then(() => run(async () => {
      if (signal?.aborted) { stop(); return; }
      const settings = this.settings();
      if (request?.agentId !== this.host.profileId || !settings?.sources.includes("memory")
        || typeof onEvent !== "function") throw denied();
      const stamp = this.captureSettings(settings);
      const requested = { ...settings, extraPaths: request.settings?.extraPaths, multimodal: request.settings?.multimodal };
      if (stamp !== this.settingsStamp(requested)
        || request.settings?.sync?.watchDebounceMs !== settings.sync.watchDebounceMs) throw changed();
      const targets = ["MEMORY.md", "USER.md", "memory"].map(name => ({
        path: path.join(this.host.workspaceDir, name), boundary: path.dirname(this.host.workspaceDir),
      }));
      // Root reports enter the pinned watcher as explicit file libraries. Its
      // policy observes those libraries from their immediate parent, so retain
      // that exact workspace identity alongside the canonical core boundary.
      for (const name of ["DREAMS.md", "dreams.md"]) {
        targets.push({ path: path.join(this.host.workspaceDir, name), boundary: this.host.workspaceDir });
      }
      for (const entry of core.normalizeExtraMemoryPathEntries(this.host.workspaceDir, settings.extraPaths)) {
        targets.push({ path: entry.path, boundary: path.dirname(entry.path) });
      }
      const roots = new Map();
      const inspect = target => {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !owned(stat) || fs.realpathSync.native(target) !== target
          || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw denied();
        return stat;
      };
      const admission = () => {
        this.assertSettings(stamp);
        if (this.settings().sync.watchDebounceMs !== settings.sync.watchDebounceMs) throw changed();
        for (const target of targets) {
          if (this.protectedPath(target.path)) throw denied();
          try {
            const stat = fs.lstatSync(target.path), actual = fs.realpathSync.native(target.path);
            const dreamTargets = ["DREAMS.md", "dreams.md"].map(name => path.join(this.host.workspaceDir, name));
            // Both spellings must be watched before creation. On a case-insensitive
            // volume the newly created file makes the other spelling an alias;
            // observe its canonical identity without admitting alias reads.
            if (!stat.isSymbolicLink() && dreamTargets.includes(target.path) && dreamTargets.includes(actual)) inspect(actual);
            else inspect(target.path);
          } catch (error) { if (error.code !== "ENOENT") throw error; }
          let boundary = target.boundary;
          for (;;) {
            try {
              const stat = inspect(boundary);
              if (!stat.isDirectory()) throw denied();
              if (!roots.size || !roots.has(boundary)) {
                // Original observation admission may keep a stable missing-prefix
                // ancestor after creation. Capture that authority before start.
                if (!watcher) roots.set(boundary, { dev: stat.dev, ino: stat.ino });
              }
              break;
            } catch (error) {
              if (error.code !== "ENOENT" || path.dirname(boundary) === boundary) throw error;
              boundary = path.dirname(boundary);
            }
          }
        }
        for (const [root, identity] of roots) {
          const stat = inspect(root);
          if (!stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw changed();
        }
      };
      admission();
      const guarded = action => {
        if (stopped) return;
        try { return run(() => { admission(); return action(); }); }
        catch (error) { stop(error); }
      };
      watcher = new core.MemoryFileWatcher({ workspaceDir: this.host.workspaceDir, agentId: this.host.profileId,
        settings: { extraPaths: [...(settings.extraPaths || []), path.join(this.host.workspaceDir, "DREAMS.md"), path.join(this.host.workspaceDir, "dreams.md")], multimodal: settings.multimodal,
          sync: { watchDebounceMs: settings.sync.watchDebounceMs } },
        onDirty: () => guarded(() => {}),
        onChange: () => guarded(() => onEvent("change")),
        // Unavailable is a metadata fact, not resource cancellation. The pinned
        // watcher owns retirement, bounded retries and sticky capacity failure.
        onUnavailable: () => guarded(() => onEvent("unavailable")),
      });
      // Native background callbacks deliberately shed turn context. Bind the
      // actual resource operations to this captured Product host instead.
      for (const method of ["refresh", "dirty"]) {
        const original = watcher[method];
        watcher[method] = (...args) => {
          if (stopped) return method === "refresh" ? Promise.resolve() : undefined;
          try { return run(() => original.apply(watcher, args)); }
          catch (error) { stop(error); return method === "refresh" ? Promise.resolve() : undefined; }
        };
      }
      for (const method of ["onHealth", "unavailable", "retire"]) {
        const original = watcher[method];
        watcher[method] = (...args) => {
          if (stopped) return cleanup(() => original.apply(watcher, args));
          let entered = false;
          try { return run(() => { entered = true; return original.apply(watcher, args); }); }
          catch (error) {
            stop(error);
            // An authority failure at scope entry may still release retained
            // handles. Never replay a native operation that already started.
            if (!entered) return cleanup(() => original.apply(watcher, args));
            return method === "retire" ? Promise.reject(error) : undefined;
          }
        };
      }
      const policy = watcher.policy, observations = policy.observations.bind(policy);
      policy.observations = async abort => run(async () => {
        if (stopped) return [];
        admission();
        const groups = await observations(abort);
        if (stopped) return [];
        admission();
        for (const group of groups) if (!roots.has(group.root.rootDir)) throw denied();
        return groups;
      });
      const excluded = policy.exclude.bind(policy), select = policy.select.bind(policy);
      const permitted = absolute => {
        if (this.protectedPath(absolute)) return false;
        try { inspect(absolute); return true; }
        catch (error) {
          if (error.code === "ENOENT") return true;
          if (error.code === "MEMORY_PATH_NOT_ALLOWED") return false;
          throw error;
        }
      };
      policy.exclude = (group, entry) => {
        if (stopped) return true;
        try {
          return run(() => {
            admission();
            const absolute = path.resolve(group.root.rootDir, entry.path);
            const prefix = entry.kind === "directory" && targets.some(target => absolute !== target.path && inside(absolute, target.path));
            if (prefix) { inspect(absolute); return excluded(group, entry); }
            return excluded(group, entry) || !permitted(absolute);
          });
        } catch (error) { stop(error); return true; }
      };
      policy.select = (group, relative, structural) => {
        if (stopped) return undefined;
        try { return run(() => {
          admission();
          return permitted(path.resolve(group.root.rootDir, relative)) ? select(group, relative, structural) : undefined;
        }); } catch (error) { stop(error); return undefined; }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { stop(); return; }
      // This only checks ownership/configuration and root metadata. The original
      // observer alone owns directory scanning, event settling and debounce.
      monitor = setInterval(() => guarded(() => {}), 1000);
      monitor.unref();
      await watcher.start();
    })).then(() => readyResolve(), error => { readyReject(error); stop(error); });
    return retirement;
  }
  readBytes(relative, settings, maxBytes, stamp) {
    const selected = this.classify(relative, settings);
    if (!selected) throw denied();
    const { target } = selected;
    if (fs.realpathSync.native(target) !== target) throw denied();
    const before = fs.lstatSync(target);
    if (!before.isFile() || !owned(before) || before.nlink !== 1 || !Number.isSafeInteger(before.size)
      || before.size < 0 || before.size > maxBytes) throw denied();
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || !sameIdentity(byteIdentity(opened), byteIdentity(before))) throw changed();
      // A concurrently growing file cannot make readFileSync allocate unbounded data.
      const buffer = Buffer.alloc(before.size + 1); let bytes = 0;
      while (bytes < buffer.length) {
        const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (!count) break;
        bytes += count;
      }
      const after = fs.fstatSync(fd), current = fs.lstatSync(target);
      if (bytes !== before.size || !sameIdentity(byteIdentity(after), byteIdentity(before))
        || !sameIdentity(byteIdentity(current), byteIdentity(after)) || !owned(after)
        || fs.realpathSync.native(target) !== target || !this.classify(relative, settings)) throw changed();
      this.assertSettings(stamp);
      return { buffer: buffer.subarray(0, bytes), identity: byteIdentity(after), selected };
    } finally { fs.closeSync(fd); }
  }
  read(relative) {
    // Product getFile, maintenance and Dreaming remain text-only even when the
    // same configured library also supplies media for semantic indexing.
    if (typeof relative !== "string" || !relative.endsWith(".md")) throw denied();
    const settings = this.settings(), stamp = this.captureSettings(settings);
    const { buffer, identity, selected } = this.readBytes(relative, settings, MAX_SOURCE_BYTES, stamp);
    return { text: buffer.toString("utf8"), mtime: identity.mtimeMs,
      size: buffer.length, mode: identity.mode, kind: selected.kind };
  }
  async readForIndexing(relative, settings = this.settings()) {
    try { return await this.inspectForIndexing(relative, settings); }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  async inspectForIndexing(relative, settings) {
    const stamp = this.captureSettings(settings), selected = this.classify(relative, settings);
    if (!selected) throw denied();
    const modality = selected.modality;
    const maxBytes = modality ? settings.multimodal.maxFileBytes : MAX_SOURCE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw denied();
    if (modality) {
      if (fs.realpathSync.native(selected.target) !== selected.target) throw denied();
      const stat = fs.lstatSync(selected.target);
      if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw denied();
      if (stat.size > maxBytes) { this.assertSettings(stamp); return null; }
    }
    const { buffer, identity } = this.readBytes(relative, settings, maxBytes, stamp);
    const authorityStamp = digest(JSON.stringify([this.host.profileId, this.host.workspaceDir,
      stamp, selected.kind, relative, identity]));
    const common = { path: relative, absPath: selected.target, mtimeMs: identity.mtimeMs,
      mtime: identity.mtimeMs, size: buffer.length, mode: identity.mode, byteIdentity: identity,
      authorityStamp, sourceKind: selected.kind };
    if (!modality) {
      const text = buffer.toString("utf8");
      return { ...common, text, hash: core.hashText(text), kind: selected.kind };
    }
    const mimeType = await core.detectMime({ buffer: buffer.subarray(0, 512), filePath: selected.target });
    this.assertSettings(stamp);
    // MIME detection can yield. Revalidate identity/authorization after that
    // yield; an obsolete read cannot become the current source snapshot.
    const current = fs.lstatSync(selected.target);
    if (!sameIdentity(byteIdentity(current), identity) || fs.realpathSync.native(selected.target) !== selected.target
      || !this.classify(relative, settings)) throw changed();
    if (!mimeType || !mimeType.startsWith(`${modality}/`)) return null;
    const contentText = core.buildMemoryMultimodalLabel(modality, relative), dataHash = digest(buffer);
    return { ...common, kind: "multimodal", contentText, text: contentText, modality, mimeType, dataHash,
      hash: core.hashText(JSON.stringify({ path: relative, contentText, mimeType, dataHash })) };
  }
  snapshotCurrent(snapshot, settings = this.settings()) {
    // Request authority and SQLite publication callbacks are synchronous. This
    // validator only verifies a previously inspected source; it never creates
    // inline payloads, invokes providers or writes derived state.
    try {
      if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.hash !== "string"
        || !snapshot.byteIdentity || typeof snapshot.authorityStamp !== "string") return false;
      const stamp = this.captureSettings(settings), selected = this.classify(snapshot.path, settings);
      if (!selected || selected.target !== snapshot.absPath || selected.kind !== snapshot.sourceKind) return false;
      const media = snapshot.kind === "multimodal";
      if (media ? !selected.modality || selected.modality !== snapshot.modality : selected.modality
        || !["memory", "extra"].includes(snapshot.kind)) return false;
      const maxBytes = media ? settings.multimodal.maxFileBytes : MAX_SOURCE_BYTES;
      const { buffer, identity } = this.readBytes(snapshot.path, settings, maxBytes, stamp);
      if (!sameIdentity(identity, snapshot.byteIdentity) || snapshot.size !== buffer.length
        || snapshot.mtimeMs !== identity.mtimeMs || snapshot.mtime !== identity.mtimeMs || snapshot.mode !== identity.mode) return false;
      const authorityStamp = digest(JSON.stringify([this.host.profileId, this.host.workspaceDir,
        stamp, selected.kind, snapshot.path, identity]));
      if (authorityStamp !== snapshot.authorityStamp) return false;
      if (!media) {
        const text = buffer.toString("utf8");
        return (snapshot.text === undefined || snapshot.text === text) && snapshot.hash === core.hashText(text);
      }
      const dataHash = digest(buffer), contentText = core.buildMemoryMultimodalLabel(selected.modality, snapshot.path);
      return snapshot.dataHash === dataHash && snapshot.contentText === contentText && snapshot.text === contentText
        && typeof snapshot.mimeType === "string" && snapshot.mimeType.startsWith(`${selected.modality}/`)
        && snapshot.hash === core.hashText(JSON.stringify({ path: snapshot.path, contentText, mimeType: snapshot.mimeType, dataHash }));
    } catch (error) {
      if (missing(error) || ["ELOOP", "MEMORY_PATH_NOT_ALLOWED", "MEMORY_SOURCE_CHANGED"].includes(error.code)) return false;
      throw error;
    }
  }
  async buildMultimodalChunk(snapshot, settings = this.settings()) {
    if (!snapshot || snapshot.kind !== "multimodal" || snapshot.sourceKind !== "extra") return null;
    const current = await this.readForIndexing(snapshot.path, settings);
    if (!current || current.kind !== "multimodal" || current.absPath !== snapshot.absPath
      || current.hash !== snapshot.hash || current.dataHash !== snapshot.dataHash
      || current.authorityStamp !== snapshot.authorityStamp || !sameIdentity(current.byteIdentity, snapshot.byteIdentity)) return null;
    const stamp = this.captureSettings(settings);
    const { buffer, identity } = this.readBytes(snapshot.path, settings, settings.multimodal.maxFileBytes, stamp);
    if (!sameIdentity(identity, snapshot.byteIdentity) || digest(buffer) !== snapshot.dataHash) return null;
    const embeddingInput = { text: current.contentText, parts: [
      { type: "text", text: current.contentText },
      { type: "inline-data", mimeType: current.mimeType, data: buffer.toString("base64") },
    ] };
    this.assertSettings(stamp);
    return { chunk: { startLine: 1, endLine: 1, text: current.contentText, hash: current.hash, embeddingInput },
      structuredInputBytes: core.estimateStructuredEmbeddingInputBytes(embeddingInput), canonicalRelativePath: snapshot.path };
  }
}

module.exports = { MemorySourceFiles };
