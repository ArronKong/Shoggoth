"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { PluginOAuthProviderRegistry } = require("./plugin-oauth-provider-registry");
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const fail = () => { throw serviceError("PLUGIN_OAUTH_CONFIG_INVALID", "插件认证服务配置无效"); };

// This private, user-managed file is outside every installed package. It only
// selects data for a built-in identity probe; it cannot load code or credentials.
function loadPluginOAuthProviders(paths) {
  const file = path.join(paths.pluginsDir, "oauth-providers.json");
  let fd;
  try {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const parent = fs.lstatSync(paths.pluginsDir);
    if (parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o077)
      || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
      || stat.size > 32 * 1024 || (typeof process.getuid === "function"
        && (stat.uid !== process.getuid() || parent.uid !== process.getuid()))) fail();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) fail();
    const bytes = Buffer.alloc(32 * 1024 + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size !== stat.size || size > 32 * 1024) fail();
    const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    if (!exact(config, ["version", "providers"]) || config.version !== 1
      || !Array.isArray(config.providers) || config.providers.length > 32) fail();
    const providers = config.providers.map(item => {
      if (!exact(item, ["id", "name", "serverUrl", "issuer", "audience", "authorizationEndpoint",
        "tokenEndpoint", "clientId", "scopes", "metadataUrls", "identity"])
        || !exact(item.identity, ["url", "subjectField"])
        || !["sub", "id"].includes(item.identity.subjectField)) fail();
      const identityUrl = new URL(item.identity.url);
      if (identityUrl.protocol !== "https:" || identityUrl.username || identityUrl.password
        || identityUrl.hash || identityUrl.search) fail();
      const subjectField = item.identity.subjectField;
      return { ...item, identityUrls: [identityUrl.href],
        verifyPrincipal: async ({ accessToken, issuer, fetchImpl }) => {
          const response = await fetchImpl(identityUrl.href, { headers: {
            Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
          if (!response.ok) fail();
          const value = await response.json();
          const subject = value?.[subjectField];
          if (!((typeof subject === "string" && subject.length > 0 && subject.length <= 512
            && !/[\x00-\x1f\x7f]/u.test(subject)) || (Number.isSafeInteger(subject) && subject >= 0))) fail();
          return `oauth:${item.id}:${crypto.createHash("sha256").update(JSON.stringify([issuer, subject])).digest("hex")}`;
        } };
    });
    // Validate the complete registry without contacting the provider.
    new PluginOAuthProviderRegistry({ providers });
    return providers;
  } catch (error) { if (error.code === "PLUGIN_OAUTH_CONFIG_INVALID") throw error; fail(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { loadPluginOAuthProviders };
