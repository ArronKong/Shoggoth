"use strict";

const { digest, fail } = require("./protocol");
const MENTION = /\$([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-])/gu;

class LearnedSkillFacade {
  constructor({ base, store, sources, getRun }) {
    this.base = base; this.store = store; this.sources = sources; this.getRun = getRun;
  }
  _metadata(skill, version) {
    return { id: skill.id, name: skill.name, version: `0.0.0-learned.${version.hash.slice(0, 12)}`,
      contentHash: version.hash, description: version.description, source: "learned",
      requiredTools: [], requiredRuntimeCapabilities: [], sourceCompatibility: ["shoggoth"],
      globalEnabled: false, enabled: true, eligible: true, ineligibleReason: null,
      assessment: "source_verified", files: version.files.map(file => ({ path: file.path, sha256: file.hash })) };
  }
  // Management includes archived entries so the ordinary off filter can show
  // and restore them. It verifies the same provenance as the runtime catalog,
  // without creating a Run lease or recording an Agent read.
  management(profileId) {
    if (!this.store.db) return [];
    return this.store.allSkills(profileId).filter(skill => !skill.revoked).flatMap(skill => {
      try {
        const version = this.store.version(skill.id, skill.head, profileId);
        this.sources.assertRefs(profileId, version.sourceRefs);
        const { files, assessment, ...metadata } = this._metadata(skill, version);
        return [{ ...metadata, title: version.title, learnedRevision: skill.revision,
          enabled: !skill.archived, usageCount: this.store.skillUsage(skill.id).reads }];
      } catch { return []; }
    });
  }
  _items(profileId, options = {}) {
    if (!this.store.db) return [];
    if (options.allowLearnedSkills === false || options.allowPluginSkills === false) return [];
    const all = this.store.allSkills(profileId).filter(skill => !skill.revoked);
    const available = all.filter(skill => !skill.archived);
    let lease = null;
    if (options.runId) {
      const run = this.getRun(options.runId);
      if (!run || run.profileId !== profileId) fail("LEARNING_SOURCE_UNAVAILABLE");
      lease = this.store.captureLease(profileId, options.runId, available);
    }
    const items = [];
    for (const reference of lease ?? available.map(skill => ({ id: skill.id, hash: skill.head }))) {
      const skill = all.find(value => value.id === reference.id);
      if (!skill) continue;
      try {
        const version = this.store.version(skill.id, reference.hash, profileId);
        this.sources.assertRefs(profileId, version.sourceRefs);
        items.push(this._metadata(skill, version));
      } catch (error) {
        if (["LEARNING_SOURCE_UNAVAILABLE", "LEARNING_SOURCE_REVOKED", "LEARNING_PROFILE_UNAVAILABLE", "LEARNING_VERSION_UNAVAILABLE",
          "MEMORY_SESSION_REVOKED", "MEMORY_CANDIDATE_SOURCE_OUTDATED"].includes(error.code)) continue;
        // Optional learned content cannot take the base skill catalog or chat
        // down. Its own read/history API still reports the integrity failure.
        continue;
      }
    }
    return items;
  }
  catalog(profileId, options = {}) {
    const base = this.base.catalog(profileId, options), learned = this._items(profileId, options);
    if (options.runId) for (const item of learned)
      this.store.recordUsage(profileId, options.runId, item.id, item.contentHash, "exposed");
    const existingNames = new Set([...base.items, ...base.ineligible].map(item => item.name));
    if (learned.some(item => existingNames.has(item.name))) fail("LEARNING_CONFLICT");
    if (!learned.length) return base;
    return { ...base, registryRevision: digest([base.registryRevision, learned.map(item => [item.id, item.contentHash])]),
      items: [...base.items, ...learned] };
  }
  select(profileId, query, options = {}) {
    const catalog = this.catalog(profileId, options), mentions = [...String(query || "").matchAll(MENTION)]
      .map(match => match[1]).filter(name => /[a-z]/u.test(name));
    if (new Set(mentions).size > 4) fail("LEARNING_INVALID");
    const learned = new Map(catalog.items.filter(item => item.source === "learned").map(item => [item.name, item]));
    const base = this.base.select(profileId, String(query || "").replace(MENTION, (all, name) => learned.has(name) ? " ".repeat(all.length) : all), options);
    const selected = new Map(base.selected.map(item => [item.name, item]));
    const result = [...new Set(mentions)].map(name => learned.get(name) || selected.get(name)).filter(Boolean);
    if (options.runId) for (const item of result) if (item.source === "learned")
      this.store.recordUsage(profileId, options.runId, item.id, item.contentHash, "selected");
    return { ...catalog, selected: result };
  }
  _learned(input) { return this._items(input.profileId, input).find(item => item.name === input.name); }
  read(input) {
    const item = this._learned(input);
    if (!item) return this.base.read(input);
    if (input.contentHash !== item.contentHash) fail("LEARNING_CONFLICT");
    const value = this.store.readFile(input.profileId, item.id, item.contentHash);
    if (input.recordUsage && input.runId) this.store.recordUsage(input.profileId, input.runId, item.id, item.contentHash);
    return { ...item, content: value.content };
  }
  readFile(input) {
    const item = this._learned(input);
    if (!item) return typeof this.base.readFile === "function" ? this.base.readFile(input) : this.base.readEnabledFile(input);
    if (input.contentHash !== item.contentHash) fail("LEARNING_CONFLICT");
    const value = this.store.readFile(input.profileId, item.id, item.contentHash, input.relativePath);
    if (input.recordUsage && input.runId) this.store.recordUsage(input.profileId, input.runId, item.id, item.contentHash);
    return { ...item, content: value.content, fileHash: value.fileHash, relativePath: input.relativePath };
  }
  readResource(input) { return this.base.readResource(input); }
  installGlobalFromDirectory(input) { return this.base.installGlobalFromDirectory(input); }
}
module.exports = { LearnedSkillFacade };
