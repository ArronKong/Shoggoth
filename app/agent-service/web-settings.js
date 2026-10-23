"use strict";
const path = require("node:path");
const { lstatIfExists } = require("./security");
const { readPrivateFile, atomicWritePrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const p = require("./web-settings-protocol");
const { agentConfig, validateWebPreferenceArguments } = require("./web-preference-tools");
const KIND = "web-provider-api-key";
const credentialRef = provider => `web-provider-${provider}`;
// Service owns the selectors; keys remain separate entries in its encrypted
// store so each key also participates in the existing plaintext canary.
class WebSettings {
  constructor({ paths, secretStore }) {
    this.paths = paths; this.secrets = secretStore; this.file = path.join(paths.stateDir, "web-settings.json");
    this.value = null; this.uncertain = false; this.uncertainProfiles = new Set(); this.tail = Promise.resolve();
  }
  async close() { await this.tail; this.value = null; this.uncertain = false; this.uncertainProfiles.clear(); }
  enqueue(action) { const next = this.tail.then(action); this.tail = next.catch(() => {}); return next; }
  load() {
    if (this.uncertain) p.fail("WEB_SETTINGS_UNCERTAIN");
    if (this.value) return this.value;
    try {
      if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") p.fail("WEB_SETTINGS_UNCERTAIN");
      const value = lstatIfExists(this.file) ? JSON.parse(readPrivateFile(this.file, { maxBytes: 4096 }).toString("utf8"))
        : { revision: 0, config: { searchProvider: "exa", fetchProvider: "direct" } };
      if (!p.exact(value, ["revision", "config"]) || !p.revision(value.revision)) p.fail();
      this.value = { revision: value.revision, config: p.config(value.config) };
      return this.value;
    } catch (error) {
      this.uncertain = true;
      p.fail(error?.code === "WEB_SETTINGS_UNCERTAIN" ? error.code : "WEB_SETTINGS_UNAVAILABLE");
    }
  }
  agentFile(profileId) {
    if (typeof profileId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(profileId)) p.fail();
    return path.join(this.paths.agentsDir || path.join(this.paths.stateDir, "agents"), profileId, "web-settings.json");
  }
  loadAgent(profileId) {
    const file = this.agentFile(profileId);
    if (this.uncertainProfiles.has(profileId)) p.fail("WEB_SETTINGS_UNCERTAIN");
    try {
      if (recoverInterruptedPrivateFile(file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") p.fail("WEB_SETTINGS_UNCERTAIN");
      const value = lstatIfExists(file) ? JSON.parse(readPrivateFile(file, { maxBytes: 4096 }).toString("utf8"))
        : { revision: 0, config: { searchProvider: null, fetchProvider: null } };
      if (!p.exact(value, ["revision", "config"]) || !p.revision(value.revision)) p.fail();
      return { revision: value.revision, config: agentConfig(value.config) };
    } catch (error) {
      this.uncertainProfiles.add(profileId);
      p.fail(error?.code === "WEB_SETTINGS_UNCERTAIN" ? error.code : "WEB_SETTINGS_UNAVAILABLE");
    }
  }
  saveConfig(expectedRevision, config, profileId = null) {
    const current = profileId === null ? this.load() : this.loadAgent(profileId);
    if (expectedRevision !== current.revision) p.fail("WEB_SETTINGS_CONFLICT");
    if (current.revision === Number.MAX_SAFE_INTEGER) p.fail();
    const next = { revision: current.revision + 1, config };
    try { atomicWritePrivateFile(profileId === null ? this.file : this.agentFile(profileId), `${JSON.stringify(next)}\n`, { trustedRoot: this.paths.trustedRoot }); }
    catch {
      if (profileId === null) this.uncertain = true; else this.uncertainProfiles.add(profileId);
      p.fail("WEB_SETTINGS_UNCERTAIN");
    }
    if (profileId === null) this.value = next;
  }
  agentSnapshot(profileId) {
    const { revision, config, credentials } = this.snapshot(), agent = this.loadAgent(profileId);
    const effective = {}, source = {};
    for (const key of ["searchProvider", "fetchProvider"]) {
      effective[key] = agent.config[key] ?? config[key];
      source[key] = agent.config[key] === null ? "global" : "agent";
    }
    return { defaults: { revision, config }, agent, effective, source,
      credentials: Object.fromEntries(p.PROVIDERS.map(provider => [provider, { configured: credentials[provider].configured }])) };
  }
  handleTool(name, profileId, args, { assertCurrent }) {
    if (!validateWebPreferenceArguments(name, args)) p.fail();
    this.agentFile(profileId);
    const params = name === "web_settings_get" ? {} : { expectedRevision: args.expectedRevision, config: { ...args.config } };
    return this.enqueue(async () => {
      // A canceled Run, disabled Profile or revoked tool may have waited behind
      // a credential write. Revalidate inside the queue, immediately before IO.
      assertCurrent();
      const before = this.agentSnapshot(profileId);
      if (name !== "web_settings_get") {
        const own = name === "web_settings_set";
        const current = own ? before.agent : before.defaults;
        const config = { ...current.config, ...params.config };
        assertCurrent();
        this.saveConfig(params.expectedRevision, own ? agentConfig(config) : p.config(config), own ? profileId : null);
      }
      return name === "web_settings_get" ? before : this.agentSnapshot(profileId);
    });
  }
  snapshot() {
    const value = this.load();
    return p.validateResult({ ...value, credentials: Object.fromEntries(p.PROVIDERS.map(provider => {
      const revision = this.secrets.getCredentialRevision(credentialRef(provider));
      return [provider, { configured: revision !== null, revision }];
    })) });
  }
  handle(method, input) {
    const params = p.validateParams(method, input);
    return this.enqueue(async () => {
      this.load();
      if (method === "web.settings.set") {
        this.saveConfig(params.expectedRevision, params.config);
      } else if (method !== "web.settings.get") {
        const ref = credentialRef(params.provider);
        if (this.secrets.getCredentialRevision(ref) !== params.expectedRevision) p.fail("WEB_SETTINGS_CONFLICT");
        if (method === "web.credentials.set") await this.secrets.putIfRevision(ref, params.apiKey, { kind: KIND }, params.expectedRevision);
        else if (params.expectedRevision !== null) await this.secrets.deleteIfFingerprint(ref, {
          kind: KIND, fingerprint: this.secrets.getCredentialFingerprint(ref),
        });
      }
      return this.snapshot();
    });
  }
  resolve(name, profileId = null) {
    return this.enqueue(async () => {
      const key = name === "web_search" ? "searchProvider" : "fetchProvider";
      const value = this.load(), agent = profileId === null ? null : this.loadAgent(profileId);
      const provider = agent?.config[key] ?? value.config[key];
      const apiKey = provider === "direct" ? null : await this.secrets.get(credentialRef(provider));
      return { provider, apiKey };
    });
  }
  assertSafe(value) {
    if (this.secrets.withPlaintextMatcher(matches => matches(value))) throw Object.assign(Error("Invalid web response"), { code: "WEB_RESPONSE_INVALID" });
  }
}
module.exports = { WebSettings, WEB_SECRET_KIND: KIND, credentialRef };
