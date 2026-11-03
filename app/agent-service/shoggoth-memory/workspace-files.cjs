"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { core } = require("./host.cjs");
const { readPrivateFile } = require("../private-file");
const { ensurePrivateDirectoryTree } = require("../security");

const denied = () => Object.assign(new Error("Memory maintenance path is not owned by this Profile"), { code: "MEMORY_PATH_NOT_ALLOWED" });
const absent = () => Object.assign(new Error("Memory source is unavailable"), { code: "ENOENT" });

// The original maintenance interface separates reads from mutations. Libraries
// can supply promotion evidence, while native write helpers receive only paths
// in this Profile's canonical workspace. All algorithm bodies stay upstream.
class MemoryWorkspaceFiles {
  constructor(host) {
    this.host = host;
    this.readTarget = new AsyncLocalStorage();
    this.maintenance = {
      readFile: async target => this.read(target),
      stat: async target => this.stat(target),
      listDirectory: async target => fs.readdirSync(this.owned(target, true), { withFileTypes: true }).map(entry => ({
        name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink(),
      })),
      mkdir: async target => this.ensureDirectory(target),
      rename: async (from, to) => {
        this.checkSources();
        const source = this.owned(from), destination = this.owned(to, false, true);
        this.ensureDirectory(path.dirname(destination));
        this.host.beforeDreamWrite(destination);
        fs.renameSync(source, destination);
        this.checkSources();
      },
      resolveWritePath: async target => this.owned(await core.resolveMemoryWritePath(this.owned(target, false, true)), false, true),
      commitContent: request => this.write(request.filePath,
        () => core.commitMemoryContent({ ...request, workspaceDir: undefined }), request),
      resolveDreamsPath: async () => {
        for (const name of core.DREAMS_FILENAMES) {
          const target = this.owned(path.join(host.workspaceDir, name), false, true);
          if (fs.existsSync(target)) return target;
        }
        return path.join(host.workspaceDir, core.DREAMS_FILENAMES[0]);
      },
      readDreams: target => core.readDreamsFile(this.owned(target, false, true)),
      writeDreams: (target, content) => this.write(target, () => core.writeDreamsFileAtomic(target, content)),
      replaceReport: (target, content) => this.write(target, () => core.replaceDreamingMarkdownFile(target, content)),
      appendCorpus: (target, content) => this.write(target, () => core.appendSessionCorpusText(target, content)),
      verifiedHistoryPromotion: candidate => this.verifiedHistoryPromotion(candidate),
    };
  }
  verifiedHistoryPromotion(candidate) {
    if (candidate.startLine !== candidate.endLine || !(candidate.recallCount > 0)) return null;
    try {
      const { host } = this, relative = candidate.path;
      const line = this.read(path.join(host.workspaceDir, relative)).toString("utf8").split("\n")[candidate.startLine - 1];
      const citation = /^(?<ref>\[(?<owner>[^/\s\]]+)\/sessions\/(?:(?<agent>[^/\s]+)\/)?(?<session>[^#\s\]]+)#L\d+\])\s+(?<text>.+)$/u.exec(line)?.groups;
      if (!citation || citation.owner !== host.profileId || (citation.agent && citation.agent !== host.profileId)) return null;
      const session = host.sessions.current(host.profileId, citation.session);
      const turn = /^(?:User|Assistant): (.+)$/u.exec(candidate.snippet);
      const corpusExcerpt = citation.text.replace(/…$/u, "").trimEnd();
      if (!turn || !candidate.snippet.replace(/…$/u, "").startsWith(corpusExcerpt)) return null;
      const evidence = `${relative}#L${candidate.startLine}-L${candidate.endLine}\n${citation.ref} ${candidate.snippet}`;
      if (!host.sourceSessionsVisible(evidence, session.workspace)) return null;
      return { ...candidate, snippet: turn[1] };
    } catch { return null; }
  }
  rehydrateExact(candidate) {
    return this.readTarget.run(path.resolve(this.host.workspaceDir, candidate.path),
      () => core.rehydratePromotionCandidate(this.host.workspaceDir, candidate));
  }
  ensureDirectory(target) {
    this.owned(target, true, true);
    if (target !== this.host.workspaceDir) ensurePrivateDirectoryTree(target, this.host.workspaceDir);
    else if (fs.lstatSync(target).mode & 0o077) throw denied();
  }
  checkSources() { this.host.assertCurrent(); this.host.assertFileSources(); }
  owned(target, directory = false, allowMissing = false) {
    this.host.assertWorkspace(this.host.workspaceDir);
    if (typeof target !== "string" || target.includes("\0") || target.includes("\\") || path.resolve(target) !== target) throw denied();
    const relative = path.relative(this.host.workspaceDir, target).replaceAll(path.sep, "/");
    if (relative.startsWith("../") || path.isAbsolute(relative)) throw denied();
    if (directory ? relative && relative !== "memory" && !relative.startsWith("memory/")
      : !/^(?:USER|MEMORY|memory|DREAMS|dreams)\.md$/u.test(relative) && !/^memory\/.*\.(?:md|txt)$/u.test(relative)) throw denied();
    // Every existing ancestor must resolve to itself; a missing suffix may be
    // created only by a later write admitted against the same workspace.
    let existing = target;
    while (!fs.existsSync(existing)) {
      try { fs.lstatSync(existing); throw denied(); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!allowMissing) throw absent();
      existing = path.dirname(existing);
    }
    if (fs.realpathSync.native(existing) !== existing) throw denied();
    const stat = fs.lstatSync(existing);
    if (stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.mode & 0o022
      || existing === target && (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw denied();
    return target;
  }
  external(target) {
    const sources = this.host.searchIndex?.sourceFiles;
    const relative = sources?.relative(target);
    if (!sources || !sources.isExtra(relative)) throw absent();
    const value = sources.read(relative);
    this.host.rememberFileSource(relative, value.text);
    return value;
  }
  read(target) {
    if (typeof target !== "string" || path.resolve(target) !== target || target.includes("\0") || target.includes("\\")) throw denied();
    if (this.readTarget.getStore() && this.readTarget.getStore() !== target) throw absent();
    if (!target.startsWith(this.host.workspaceDir + path.sep)
      || this.host.searchIndex?.sourceFiles.isExtra(this.host.searchIndex.sourceFiles.relative(target))) return Buffer.from(this.external(target).text);
    return readPrivateFile(this.owned(target), { maxBytes: 16 * 1024 * 1024 });
  }
  stat(target) {
    if (typeof target !== "string" || path.resolve(target) !== target || target.includes("\0") || target.includes("\\")) throw denied();
    if ((!target.startsWith(this.host.workspaceDir + path.sep) && target !== this.host.workspaceDir)
      || this.host.searchIndex?.sourceFiles.isExtra(this.host.searchIndex.sourceFiles.relative(target))) {
      const source = this.external(target);
      return { isFile: true, isDirectory: false, isSymbolicLink: false, size: source.size, mtimeMs: source.mtime, mode: source.mode };
    }
    const stat = fs.lstatSync(target);
    this.owned(target, stat.isDirectory());
    return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymbolicLink: false, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode };
  }
  async write(target, action, request) {
    this.checkSources(); this.owned(target, false, true);
    this.ensureDirectory(path.dirname(target));
    this.host.beforeDreamWrite(target, request);
    const result = await action();
    try { this.checkSources(); }
    catch (error) { error.publication = "committed"; throw error; }
    return result;
  }
  async listFiles(workspace, ...args) {
    this.host.assertWorkspace(workspace);
    // Maintenance owns canonical files. External libraries are indexed by the
    // search owner and may be cited, but forgetting must not rewrite them.
    const files = await core.listMemoryFiles(workspace, ...args);
    this.host.assertCurrent();
    return files.filter(file => file.startsWith(workspace + path.sep)
      && core.isMemoryPath(path.relative(workspace, file)) && this.owned(file));
  }
}

module.exports = { MemoryWorkspaceFiles };
