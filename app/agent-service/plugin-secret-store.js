"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { SECRET_NAME } = require("../core/plugin-secret-placeholders");

const KIND = "plugin-secret";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MIN_VALUE_BYTES = 8;
const MAX_VALUE_BYTES = 16 * 1024;

function fail(code, message = "插件凭据请求无效") { throw serviceError(code, message); }

// User-supplied plugin credentials. Values live only in the Service's encrypted
// secret store, scoped to one installation: the same NAME in two plugins is two
// secrets. Their plaintext also joins the Service-wide secret canary, so the
// value is rejected from transcripts, memory and product tool payloads.
class PluginSecretStore {
  #secrets;
  #declarations;

  constructor({ secretStore, declarations }) {
    if (typeof secretStore?.get !== "function" || typeof secretStore?.put !== "function"
      || typeof secretStore?.delete !== "function"
      || typeof secretStore?.getCredentialRevision !== "function"
      || typeof declarations?.component !== "function") {
      throw new TypeError("PluginSecretStore requires the encrypted Service secret store");
    }
    this.#secrets = secretStore;
    this.#declarations = declarations;
  }

  static credentialRef(installationId, name) {
    return `${KIND}-${crypto.createHash("sha256").update(`${installationId}\0${name}`).digest("hex").slice(0, 48)}`;
  }

  declared(releaseDigest, componentName) {
    return this.#declarations.component(releaseDigest, componentName)?.secrets || [];
  }

  configured(installationId, name) {
    try {
      return this.#secrets.getCredentialRevision(PluginSecretStore.credentialRef(installationId, name)) !== null;
    } catch { return false; }
  }

  missing(installationId, releaseDigest, componentName) {
    return [...new Set(this.declared(releaseDigest, componentName).map(item => item.name))]
      .filter(name => !this.configured(installationId, name)).sort();
  }

  // Service-internal only: the value is handed to a launch plan or request header.
  async read(installationId, name) {
    this.#assertKey(installationId, name);
    return this.#secrets.get(PluginSecretStore.credentialRef(installationId, name));
  }

  async put({ installationId, name, value }) {
    this.#assertKey(installationId, name);
    const normalized = typeof value === "string" ? value.trim() : null;
    // Every stored plaintext becomes a Service-wide secret canary. A very short
    // value would also match ordinary conversation text, so it is refused.
    if (!normalized || !normalized.isWellFormed() || /[\0\r\n]/u.test(normalized)
      || Buffer.byteLength(normalized, "utf8") < MIN_VALUE_BYTES
      || Buffer.byteLength(normalized, "utf8") > MAX_VALUE_BYTES) {
      fail("PLUGIN_SECRET_VALUE_INVALID", "凭据需为 8 个字符以上的单行文本，且不超过 16 KiB");
    }
    await this.#secrets.put(PluginSecretStore.credentialRef(installationId, name), normalized, { kind: KIND });
    return Object.freeze({ name, configured: true });
  }

  async delete({ installationId, name }) {
    this.#assertKey(installationId, name);
    await this.#secrets.delete(PluginSecretStore.credentialRef(installationId, name));
    return Object.freeze({ name, configured: false });
  }

  #assertKey(installationId, name) {
    if (typeof installationId !== "string" || !ID.test(installationId)
      || typeof name !== "string" || !SECRET_NAME.test(name)) fail("PLUGIN_SECRET_INVALID");
  }
}

module.exports = { PluginSecretStore, PLUGIN_SECRET_KIND: KIND };
